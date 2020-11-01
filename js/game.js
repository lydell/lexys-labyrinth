import { DIRECTIONS } from './defs.js';
import TILE_TYPES from './tiletypes.js';

export class Tile {
    constructor(type, direction = 'south') {
        this.type = type;
        this.direction = direction;
        this.cell = null;

        if (type.is_actor) {
            this.slide_mode = null;
            this.movement_cooldown = 0;
        }

        if (type.has_inventory) {
            this.keyring = {};
            this.toolbelt = [];
        }
    }

    static from_template(tile_template) {
        let type = tile_template.type;
        if (! type) console.error(tile_template);
        let tile = new this(type, tile_template.direction);
        // Copy any extra properties in verbatim
        return Object.assign(tile, tile_template);
    }

    // Gives the effective position of an actor in motion, given smooth scrolling
    visual_position(tic_offset = 0) {
        let x = this.cell.x;
        let y = this.cell.y;
        if (! this.previous_cell) {
            return [x, y];
        }
        else {
            let p = (this.animation_progress + tic_offset) / this.animation_speed;
            return [
                (1 - p) * this.previous_cell.x + p * x,
                (1 - p) * this.previous_cell.y + p * y,
            ];
        }
    }

    blocks(other, direction, level) {
        if (this.type.blocks_all)
            return true;

        if (this.type.thin_walls &&
            this.type.thin_walls.has(DIRECTIONS[direction].opposite))
            return true;

        if (other.type.is_player && this.type.blocks_players)
            return true;
        if (other.type.is_monster && this.type.blocks_monsters)
            return true;
        if (other.type.is_block && this.type.blocks_blocks)
            return true;

        if (this.type.blocks)
            return this.type.blocks(this, level, other);

        return false;
    }

    ignores(name) {
        if (this.type.ignores && this.type.ignores.has(name))
            return true;

        if (this.toolbelt) {
            for (let item of this.toolbelt) {
                let item_type = TILE_TYPES[item];
                if (item_type.item_ignores && item_type.item_ignores.has(name))
                    return true;
            }
        }

        return false;
    }

    can_push(tile, direction) {
        return (
            this.type.pushes && this.type.pushes[tile.type.name] &&
            (! tile.type.allows_push || tile.type.allows_push(tile, direction)) &&
            ! tile.stuck);
    }

    // Inventory stuff
    has_item(name) {
        if (TILE_TYPES[name].is_key) {
            return this.keyring && (this.keyring[name] ?? 0) > 0;
        }
        else {
            return this.toolbelt && this.toolbelt.some(item => item === name);
        }
    }
}
Tile.prototype.emitting_edges = 0;

export class Cell extends Array {
    constructor(x, y) {
        super();
        this.x = x;
        this.y = y;
    }

    _add(tile, index = null) {
        if (index === null) {
            this.push(tile);
        }
        else {
            this.splice(index, 0, tile);
        }
        tile.cell = this;
    }

    // DO NOT use me to remove a tile permanently, only to move it!
    // Should only be called from Level, which handles some bookkeeping!
    _remove(tile) {
        let index = this.indexOf(tile);
        if (index < 0)
            throw new Error("Asked to remove tile that doesn't seem to exist");

        this.splice(index, 1);
        tile.cell = null;
        return index;
    }

    get_wired_tile() {
        let ret = null;
        for (let tile of this) {
            if (tile.wire_directions || tile.wire_tunnel_directions) {
                ret = tile;
                // Don't break; we want the topmost tile!
            }
        }
        return ret;
    }

    blocks_leaving(actor, direction) {
        for (let tile of this) {
            if (tile !== actor &&
                ! tile.type.is_swivel && tile.type.thin_walls &&
                tile.type.thin_walls.has(direction))
            {
                return true;
            }
        }
        return false;
    }

    blocks_entering(actor, direction, level, ignore_pushables = false) {
        for (let tile of this) {
            if (tile.blocks(actor, direction, level) &&
                ! (ignore_pushables && actor.can_push(tile, direction)))
            {
                return true;
            }
        }
        return false;
    }
}
Cell.prototype.prev_powered_edges = 0;
Cell.prototype.powered_edges = 0;

class GameEnded extends Error {}

export class Level {
    constructor(stored_level, compat = {}) {
        this.stored_level = stored_level;
        this.width = stored_level.size_x;
        this.height = stored_level.size_y;
        this.size_x = stored_level.size_x;
        this.size_y = stored_level.size_y;
        this.restart(compat);
    }

    restart(compat) {
        this.compat = compat;

        // playing: normal play
        // success: has been won
        // failure: died
        // note that pausing is NOT handled here, but by whatever's driving our
        // event loop!
        this.state = 'playing';

        this.cells = [];
        this.player = null;
        this.actors = [];
        this.chips_remaining = this.stored_level.chips_required;
        this.bonus_points = 0;
        this.aid = 0;

        // Time
        if (this.stored_level.time_limit === 0) {
            this.time_remaining = null;
        }
        else {
            this.time_remaining = this.stored_level.time_limit * 20;
        }
        this.timer_paused = false;
        // Note that this clock counts *up*, even on untimed levels, and is unaffected by CC2's
        // clock alteration shenanigans
        this.tic_counter = 0;
        // 0 to 7, indicating the first tic that teeth can move on.
        // 0 is equivalent to even step; 4 is equivalent to odd step.
        // 5 is the default in CC2.  Lynx can use any of the 8.  MSCC uses
        // either 0 or 4, and defaults to 0, but which you get depends on the
        // global clock which doesn't get reset between levels (!).
        this.step_parity = 5;

        this.hint_shown = null;
        // TODO in lynx/steam, this carries over between levels; in tile world, you can set it manually
        this.force_floor_direction = 'north';
        // PRNG is initialized to zero
        this._rng1 = 0;
        this._rng2 = 0;
        if (this.stored_level.blob_behavior === 0) {
            this._blob_modifier = 0x55;
        }
        else {
            // The other two modes are initialized to a random seed
            this._blob_modifier = Math.floor(Math.random() * 256);
        }

        this.undo_stack = [];
        this.pending_undo = [];

        let n = 0;
        let connectables = [];
        this.power_sources = [];
        // FIXME handle traps correctly:
        // - if an actor is in the cell, set the trap to open and unstick everything in it
        for (let y = 0; y < this.height; y++) {
            let row = [];
            this.cells.push(row);
            for (let x = 0; x < this.width; x++) {
                let cell = new Cell(x, y);
                row.push(cell);

                let stored_cell = this.stored_level.linear_cells[n];
                n++;
                let has_cloner, has_trap, has_forbidden;

                for (let template_tile of stored_cell) {
                    let tile = Tile.from_template(template_tile);
                    if (tile.type.is_hint) {
                        // Copy over the tile-specific hint, if any
                        tile.specific_hint = template_tile.specific_hint ?? null;
                    }

                    if (tile.type.is_power_source) {
                        this.power_sources.push(tile);
                    }

                    // TODO well this is pretty special-casey.  maybe come up
                    // with a specific pass at the beginning of the level?
                    // TODO also assumes a specific order...
                    if (tile.type.name === 'cloner') {
                        has_cloner = true;
                    }
                    if (tile.type.name === 'trap') {
                        has_trap = true;
                    }

                    if (tile.type.is_player) {
                        // TODO handle multiple players, also chip and melinda both
                        // TODO complain if no player
                        this.player = tile;
                    }
                    if (tile.type.is_actor) {
                        if (has_cloner) {
                            // TODO is there any reason not to add clone templates to the actor
                            // list?
                            tile.stuck = true;
                        }
                        if (! tile.stuck) {
                            this.actors.push(tile);
                        }
                    }
                    cell._add(tile);

                    if (tile.type.connects_to) {
                        connectables.push(tile);
                    }
                }
            }
        }

        // Connect buttons and teleporters
        let num_cells = this.width * this.height;
        for (let connectable of connectables) {
            let cell = connectable.cell;
            let x = cell.x;
            let y = cell.y;
            // FIXME this is a single string for red/brown buttons (to match iter_tiles_in_RO) but a
            // set for orange buttons (because flame jet states are separate tiles), which sucks ass
            let goals = connectable.type.connects_to;

            // Check for custom wiring, for MSCC .DAT levels
            // TODO would be neat if this applied to orange buttons too
            if (this.stored_level.has_custom_connections) {
                let n = this.stored_level.coords_to_scalar(x, y);
                let target_cell_n = null;
                if (connectable.type.name === 'button_brown') {
                    target_cell_n = this.stored_level.custom_trap_wiring[n] ?? null;
                }
                else if (connectable.type.name === 'button_red') {
                    target_cell_n = this.stored_level.custom_cloner_wiring[n] ?? null;
                }
                if (target_cell_n && target_cell_n < this.width * this.height) {
                    let [tx, ty] = this.stored_level.scalar_to_coords(target_cell_n);
                    for (let tile of this.cells[ty][tx]) {
                        if (goals === tile.type.name) {
                            connectable.connection = tile;
                            break;
                        }
                    }
                }
                continue;
            }

            // Orange buttons do a really weird diamond search
            if (connectable.type.connect_order === 'diamond') {
                for (let cell of this.iter_cells_in_diamond(connectable.cell)) {
                    let target = null;
                    for (let tile of cell) {
                        if (goals.has(tile.type.name)) {
                            target = tile;
                            break;
                        }
                    }
                    if (target !== null) {
                        connectable.connection = target;
                        break;
                    }
                }
                continue;
            }

            // Otherwise, look in reading order
            for (let tile of this.iter_tiles_in_reading_order(cell, goals)) {
                // TODO ideally this should be a weak connection somehow, since dynamite can destroy
                // empty cloners and probably traps too
                connectable.connection = tile;
                // Just grab the first
                break;
            }
        }

        // Finally, let all tiles do any custom init behavior
        for (let row of this.cells) {
            for (let cell of row) {
                for (let tile of cell) {
                    if (tile.type.on_ready) {
                        tile.type.on_ready(tile, this);
                    }
                    if (cell === this.player.cell && tile.type.is_hint) {
                        this.hint_shown = tile.specific_hint ?? this.stored_level.hint;
                    }
                }
            }
        }
    }

    // Lynx PRNG, used unchanged in CC2
    prng() {
        // TODO what if we just saved this stuff, as well as the RFF direction, at the beginning of
        // each tic?
        let rng1 = this._rng1;
        let rng2 = this._rng2;
        this.pending_undo.push(() => {
            this._rng1 = rng1;
            this._rng2 = rng2;
        });

        let n = (this._rng1 >> 2) - this._rng1;
        if (!(this._rng1 & 0x02)) --n;
        this._rng1 = (this._rng1 >> 1) | (this._rng2 & 0x80);
        this._rng2 = (this._rng2 << 1) | (n & 0x01);
        let ret = (this._rng1 ^ this._rng2) & 0xff;
        return ret;
    }

    // Weird thing done by CC2 to make blobs...  more...  random
    get_blob_modifier() {
        let mod = this._blob_modifier;
        this.pending_undo.push(() => this._blob_modifier = mod);

        if (this.stored_level.blob_behavior === 1) {
            // "4 patterns" just increments by 1 every time (but /after/ returning)
            //this._blob_modifier = (this._blob_modifier + 1) % 4;
            mod = (mod + 1) % 4;
            this._blob_modifier = mod;
        }
        else {
            // Other modes do this curious operation
            mod *= 2;
            if (mod < 255) {
                mod ^= 0x1d;
            }
            mod &= 0xff;
            this._blob_modifier = mod;
        }

        return mod;
    }

    // Move the game state forwards by one tic
    advance_tic(p1_primary_direction, p1_secondary_direction) {
        if (this.state !== 'playing') {
            console.warn(`Level.advance_tic() called when state is ${this.state}`);
            return;
        }

        try {
            this._advance_tic(p1_primary_direction, p1_secondary_direction);
        }
        catch (e) {
            if (e instanceof GameEnded) {
                // Do nothing, the game ended and we just wanted to skip the rest
            }
            else {
                throw e;
            }
        }

        // Commit the undo state at the end of each tic
        this.commit();
    }

    _advance_tic(p1_primary_direction, p1_secondary_direction) {
        // Player's secondary direction is set immediately; it applies on arrival to cells even if
        // it wasn't held the last time the player started moving
        this._set_prop(this.player, 'secondary_direction', p1_secondary_direction);

        // Used to check for a monster chomping the player's tail
        this.player_leaving_cell = this.player.cell;
        // Used for visual effect and updated later; don't need to be undoable
        // because they only apply while holding a key down anyway
        // TODO but maybe they should be undone anyway so rewind looks better
        this.player.is_blocked = false;

        this.sfx.set_player_position(this.player.cell);

        // First pass: tick cooldowns and animations; have actors arrive in their cells.  We do the
        // arrival as its own mini pass, for one reason: if the player dies (which will end the game
        // immediately), we still want every time's animation to finish, or it'll look like some
        // objects move backwards when the death screen appears!
        let cell_steppers = [];
        // Note that we iterate in reverse order, DESPITE keeping dead actors around with null
        // cells, to match the Lynx and CC2 behavior.  This is actually important in some cases;
        // check out the start of CCLP3 #54, where the gliders will eat the blue key immediately if
        // they act in forward order!  (More subtly, even the earlier passes do things like advance
        // the RNG, so for replay compatibility they need to be in reverse order too.)
        for (let i = this.actors.length - 1; i >= 0; i--) {
            let actor = this.actors[i];
            // Actors with no cell were destroyed
            if (! actor.cell)
                continue;

            // Clear any old decisions ASAP.  Note that this prop is only used internally within a
            // single tic, so it doesn't need to be undoable
            actor.decision = null;

            // Decrement the cooldown here, but don't check it quite yet,
            // because stepping on cells in the next block might reset it
            if (actor.movement_cooldown > 0) {
                this._set_prop(actor, 'movement_cooldown', actor.movement_cooldown - 1);
            }

            if (actor.animation_speed) {
                // Deal with movement animation
                this._set_prop(actor, 'animation_progress', actor.animation_progress + 1);
                if (actor.animation_progress >= actor.animation_speed) {
                    if (actor.type.ttl) {
                        // This is purely an animation so it disappears once it's played
                        this.remove_tile(actor);
                        continue;
                    }
                    this._set_prop(actor, 'previous_cell', null);
                    this._set_prop(actor, 'animation_progress', null);
                    this._set_prop(actor, 'animation_speed', null);
                    if (! this.compat.tiles_react_instantly) {
                        // We need to track the actor AND the cell explicitly, because it's possible
                        // that one actor's step will cause another actor to start another move, and
                        // then they'd end up stepping on the new cell they're moving to instead of
                        // the one they just landed on!
                        cell_steppers.push([actor, actor.cell]);
                    }
                }
            }
        }
        for (let [actor, cell] of cell_steppers) {
            this.step_on_cell(actor, cell);
        }

        // Now we handle wiring
        this.update_wiring();

        // Only reset the player's is_pushing between movement, so it lasts for the whole push
        if (this.player.movement_cooldown <= 0) {
            this.player.is_pushing = false;
        }

        // Second pass: actors decide their upcoming movement simultaneously
        for (let i = this.actors.length - 1; i >= 0; i--) {
            let actor = this.actors[i];
            if (! actor.cell)
                continue;

            if (actor.movement_cooldown > 0)
                continue;

            // Teeth can only move the first 4 of every 8 tics, though "first"
            // can be adjusted
            if (actor.slide_mode === null &&
                actor.type.uses_teeth_hesitation &&
                (this.tic_counter + this.step_parity) % 8 >= 4)
            {
                continue;
            }

            let direction_preference;
            if (this.compat.sliding_tanks_ignore_button &&
                actor.slide_mode && actor.pending_reverse)
            {
                this._set_prop(actor, 'pending_reverse', false);
            }
            // Blocks that were pushed while sliding will move in the push direction as soon as they
            // stop sliding, regardless of what they landed on
            if (actor.pending_push) {
                actor.decision = actor.pending_push;
                this._set_prop(actor, 'pending_push', null);
                continue;
            }
            else if (actor.slide_mode === 'ice') {
                // Actors can't make voluntary moves on ice; they just slide
                actor.decision = actor.direction;
                continue;
            }
            else if (actor.slide_mode === 'force') {
                // Only the player can make voluntary moves on a force floor,
                // and only if their previous move was an /involuntary/ move on
                // a force floor.  If they do, it overrides the forced move
                // XXX this in particular has some subtleties in lynx (e.g. you
                // can override forwards??) and DEFINITELY all kinds of stuff
                // in ms
                if (actor === this.player &&
                    p1_primary_direction &&
                    actor.last_move_was_force)
                {
                    actor.decision = p1_primary_direction;
                    this._set_prop(actor, 'last_move_was_force', false);
                }
                else {
                    actor.decision = actor.direction;
                    if (actor === this.player) {
                        this._set_prop(actor, 'last_move_was_force', true);
                    }
                }
                continue;
            }
            else if (actor === this.player) {
                if (p1_primary_direction) {
                    actor.decision = p1_primary_direction;
                    this._set_prop(actor, 'last_move_was_force', false);
                }
                continue;
            }
            else if (actor.type.movement_mode === 'forward') {
                // blue tank behavior: keep moving forward, reverse if the flag is set
                let direction = actor.direction;
                if (actor.pending_reverse) {
                    direction = DIRECTIONS[actor.direction].opposite;
                    this._set_prop(actor, 'pending_reverse', false);
                }
                // Tanks are controlled explicitly so they don't check if they're blocked
                // TODO tanks in traps turn around, but tanks on cloners do not, and i use the same
                // prop for both
                if (! actor.cell.some(tile => tile.type.name === 'cloner')) {
                    actor.decision = direction;
                }
                continue;
            }
            else if (actor.type.movement_mode === 'follow-left') {
                // bug behavior: always try turning as left as possible, and
                // fall back to less-left turns when that fails
                let d = DIRECTIONS[actor.direction];
                direction_preference = [d.left, actor.direction, d.right, d.opposite];
            }
            else if (actor.type.movement_mode === 'follow-right') {
                // paramecium behavior: always try turning as right as
                // possible, and fall back to less-right turns when that fails
                let d = DIRECTIONS[actor.direction];
                direction_preference = [d.right, actor.direction, d.left, d.opposite];
            }
            else if (actor.type.movement_mode === 'turn-left') {
                // glider behavior: preserve current direction; if that doesn't
                // work, turn left, then right, then back the way we came
                let d = DIRECTIONS[actor.direction];
                direction_preference = [actor.direction, d.left, d.right, d.opposite];
            }
            else if (actor.type.movement_mode === 'turn-right') {
                // fireball behavior: preserve current direction; if that doesn't
                // work, turn right, then left, then back the way we came
                let d = DIRECTIONS[actor.direction];
                direction_preference = [actor.direction, d.right, d.left, d.opposite];
            }
            else if (actor.type.movement_mode === 'bounce') {
                // bouncy ball behavior: preserve current direction; if that
                // doesn't work, bounce back the way we came
                let d = DIRECTIONS[actor.direction];
                direction_preference = [actor.direction, d.opposite];
            }
            else if (actor.type.movement_mode === 'bounce-random') {
                // walker behavior: preserve current direction; if that doesn't work, pick a random
                // direction, even the one we failed to move in (but ONLY then)
                direction_preference = [actor.direction, 'WALKER'];
            }
            else if (actor.type.movement_mode === 'pursue') {
                // teeth behavior: always move towards the player
                let target_cell = this.player.cell;
                // CC2 behavior (not Lynx (TODO compat?)): pursue the cell the player is leaving, if
                // they're still mostly in it
                if (this.player.previous_cell && this.player.animation_speed &&
                    this.player.animation_progress <= this.player.animation_speed / 2)
                {
                    target_cell = this.player.previous_cell;
                }
                let dx = actor.cell.x - target_cell.x;
                let dy = actor.cell.y - target_cell.y;
                let preferred_horizontal, preferred_vertical;
                if (dx > 0) {
                    preferred_horizontal = 'west';
                }
                else if (dx < 0) {
                    preferred_horizontal = 'east';
                }
                if (dy > 0) {
                    preferred_vertical = 'north';
                }
                else if (dy < 0) {
                    preferred_vertical = 'south';
                }
                // Chooses the furthest direction, vertical wins ties
                if (Math.abs(dx) > Math.abs(dy)) {
                    // Horizontal first
                    direction_preference = [preferred_horizontal, preferred_vertical].filter(x => x);
                }
                else {
                    // Vertical first
                    direction_preference = [preferred_vertical, preferred_horizontal].filter(x => x);
                }
            }
            else if (actor.type.movement_mode === 'random') {
                // blob behavior: move completely at random
                let modifier = this.get_blob_modifier();
                direction_preference = [['north', 'east', 'south', 'west'][(this.prng() + modifier) % 4]];
            }

            // Check which of those directions we *can*, probably, move in
            // TODO i think player on force floor will still have some issues here
            // FIXME probably bail earlier for stuck actors so the prng isn't advanced?  what is the
            // lynx behavior?  also i hear something about blobs on cloners??
            if (direction_preference && ! actor.stuck) {
                let fallback_direction;
                for (let direction of direction_preference) {
                    if (direction === 'WALKER') {
                        // Walkers roll a random direction ONLY if their first attempt was blocked
                        direction = actor.direction;
                        let num_turns = this.prng() % 4;
                        for (let i = 0; i < num_turns; i++) {
                            direction = DIRECTIONS[direction].right;
                        }
                    }
                    fallback_direction = direction;

                    let dest_cell = this.get_neighboring_cell(actor.cell, direction);
                    if (! dest_cell)
                        continue;

                    if (! actor.cell.blocks_leaving(actor, direction) &&
                        ! dest_cell.blocks_entering(actor, direction, this, true))
                    {
                        // We found a good direction!  Stop here
                        actor.decision = direction;
                        break;
                    }
                }

                // If all the decisions are blocked, actors still try the last one (and might even
                // be able to move that way by the time their turn comes around!)
                if (actor.decision === null) {
                    actor.decision = fallback_direction;
                }
            }
        }

        // Third pass: everyone actually moves
        for (let i = this.actors.length - 1; i >= 0; i--) {
            let actor = this.actors[i];
            if (! actor.cell)
                continue;

            // Check this again, because one actor's movement might caused a later actor to move
            // (e.g. by pressing a red or brown button)
            if (actor.movement_cooldown > 0)
                continue;

            if (! actor.decision)
                continue;

            let old_cell = actor.cell;
            let success = this.attempt_step(actor, actor.decision);

            // Track whether the player is blocked, for visual effect
            if (actor === this.player && p1_primary_direction && ! success) {
                this.sfx.play_once('blocked');
                actor.is_blocked = true;
            }

            // Players can also bump the tiles in the cell next to the one they're leaving
            let dir2 = actor.secondary_direction;
            if (actor.type.is_player && dir2 &&
                ! old_cell.blocks_leaving(actor, dir2))
            {
                let neighbor = this.get_neighboring_cell(old_cell, dir2);
                if (neighbor) {
                    let could_push = ! neighbor.blocks_entering(actor, dir2, this, true);
                    for (let tile of Array.from(neighbor)) {
                        if (tile.type.on_bump) {
                            tile.type.on_bump(tile, this, actor);
                        }
                        if (could_push && actor.can_push(tile, dir2)) {
                            // Block slapping: you can shove a block by walking past it sideways
                            // TODO i think cc2 uses the push pose and possibly even turns you here?
                            this.attempt_step(tile, dir2);
                        }
                    }
                }
            }
        }

        // Strip out any destroyed actors from the acting order
        // FIXME this is O(n), where n is /usually/ small, but i still don't love it
        let p = 0;
        for (let i = 0, l = this.actors.length; i < l; i++) {
            let actor = this.actors[i];
            if (actor.cell) {
                if (p !== i) {
                    this.actors[p] = actor;
                }
                p++;
            }
            else {
                let local_p = p;
                this.pending_undo.push(() => this.actors.splice(local_p, 0, actor));
            }
        }
        this.actors.length = p;

        // Advance the clock
        let tic_counter = this.tic_counter;
        this.tic_counter += 1;
        if (this.time_remaining !== null && ! this.timer_paused) {
            let time_remaining = this.time_remaining;
            this.pending_undo.push(() => {
                this.tic_counter = tic_counter;
                this.time_remaining = time_remaining;
            });

            this.time_remaining -= 1;
            if (this.time_remaining <= 0) {
                this.fail('time');
            }
            else if (this.time_remaining % 20 === 0 && this.time_remaining < 30 * 20) {
                this.sfx.play_once('tick');
            }
        }
        else {
            this.pending_undo.push(() => {
                this.tic_counter = tic_counter;
            });
        }
    }

    // Try to move the given actor one tile in the given direction and update
    // their cooldown.  Return true if successful.
    attempt_step(actor, direction) {
        // In mid-movement, we can't even change direction!
        if (actor.movement_cooldown > 0)
            return false;

        this.set_actor_direction(actor, direction);

        if (actor.stuck)
            return false;

        // Record our speed, and halve it below if we're stepping onto a sliding tile
        let speed = actor.type.movement_speed;

        let move = DIRECTIONS[direction].movement;
        if (!actor.cell) console.error(actor);
        let goal_cell = this.get_neighboring_cell(actor.cell, direction);

        // TODO this could be a lot simpler if i could early-return!  should ice bumping be
        // somewhere else?
        let blocked;
        if (goal_cell) {
            // Only bother touching the goal cell if we're not already trapped in this one
            if (actor.cell.blocks_leaving(actor, direction)) {
                blocked = true;
            }

            // (Note that here, and anywhere else that has any chance of
            // altering the cell's contents, we iterate over a copy of the cell
            // to insulate ourselves from tiles appearing or disappearing
            // mid-iteration.)
            // FIXME actually, this prevents flicking!
            if (! blocked) {
                // Try to move into the cell.  This is usually a simple check of whether we can
                // enter it (similar to Cell.blocks_entering), but if the only thing blocking us is
                // a pushable object, we have to do two more passes: one to push anything pushable,
                // then one to check whether we're blocked again.
                let has_slide_tile = false;
                let blocked_by_pushable = false;
                for (let tile of goal_cell) {
                    if (tile.blocks(actor, direction, this)) {
                        if (actor.can_push(tile, direction)) {
                            blocked_by_pushable = true;
                        }
                        else {
                            blocked = true;
                            // Don't break here, because we might still want to bump other tiles
                        }
                    }

                    if (actor.ignores(tile.type.name))
                        continue;

                    if (tile.type.slide_mode) {
                        has_slide_tile = true;
                    }

                    // Bump tiles that we're even attempting to move into; this mostly reveals
                    // invisible walls, blue floors, etc.
                    if (tile.type.on_bump) {
                        tile.type.on_bump(tile, this, actor);
                    }
                }

                if (has_slide_tile) {
                    speed /= 2;
                }

                // If the only thing blocking us can be pushed, give that a shot
                if (! blocked && blocked_by_pushable) {
                    // This time make a copy, since we're modifying the contents of the cell
                    for (let tile of Array.from(goal_cell)) {
                        if (actor.can_push(tile, direction)) {
                            if (! this.attempt_step(tile, direction) &&
                                tile.slide_mode !== null && tile.movement_cooldown !== 0)
                            {
                                // If the push failed and the obstacle is in the middle of a slide,
                                // remember this as the next move it'll make
                                this._set_prop(tile, 'pending_push', direction);
                            }
                            if (actor === this.player) {
                                actor.is_pushing = true;
                            }
                        }
                    }

                    // Now check if we're still blocked
                    blocked = goal_cell.blocks_entering(actor, direction, this);
                }
            }
        }
        else {
            // Hit the edge
            blocked = true;
        }

        if (blocked) {
            if (actor.slide_mode === 'ice') {
                // Actors on ice turn around when they hit something
                this.set_actor_direction(actor, DIRECTIONS[direction].opposite);
            }
            if (actor.slide_mode !== null) {
                // Somewhat clumsy hack: if an actor is sliding and hits something, step on the
                // relevant tile again.  This fixes two problems: if it was on an ice corner then it
                // needs to turn a second time even though it didn't move; and if it was a player
                // overriding a force floor into a wall, then their direction needs to be set back
                // to the force floor direction.
                // (For random force floors, this does still match CC2 behavior: after an override,
                // CC2 will try to force you in the /next/ RFF direction.)
                // FIXME now overriding into a wall doesn't show you facing that way at all!  lynx
                // only changes your direction at decision time by examining the floor tile...
                for (let tile of actor.cell) {
                    if (tile.type.slide_mode === actor.slide_mode && tile.type.on_arrive) {
                        tile.type.on_arrive(tile, this, actor);
                    }
                }
            }
            return false;
        }

        // We're clear!
        this.move_to(actor, goal_cell, speed);

        // Set movement cooldown since we just moved
        this._set_prop(actor, 'movement_cooldown', speed);
        return true;
    }

    // Move the given actor to the given position and perform any appropriate
    // tile interactions.  Does NOT check for whether the move is actually
    // legal; use attempt_step for that!
    move_to(actor, goal_cell, speed) {
        if (actor.cell === goal_cell)
            return;

        this._set_prop(actor, 'previous_cell', actor.cell);
        this._set_prop(actor, 'animation_speed', speed);
        this._set_prop(actor, 'animation_progress', 0);

        let original_cell = actor.cell;
        this.remove_tile(actor);
        this.make_slide(actor, null);
        this.add_tile(actor, goal_cell);

        // Announce we're leaving, for the handful of tiles that care about it
        for (let tile of Array.from(original_cell)) {
            if (tile === actor)
                continue;
            if (actor.ignores(tile.type.name))
                continue;

            if (tile.type.on_depart) {
                tile.type.on_depart(tile, this, actor);
            }
        }

        // Check for a couple effects that always apply immediately
        // TODO do blocks smash monsters?
        if (actor === this.player) {
            this._set_prop(this, 'hint_shown', null);
        }
        for (let tile of goal_cell) {
            if (actor.type.is_player && tile.type.is_monster) {
                this.fail(tile.type.name);
            }
            else if (actor.type.is_monster && tile.type.is_player) {
                this.fail(actor.type.name);
            }
            else if (actor.type.is_block && tile.type.is_player) {
                this.fail('squished');
            }

            if (tile.type.slide_mode && ! actor.ignores(tile.type.name)) {
                this.make_slide(actor, tile.type.slide_mode);
            }

            if (actor === this.player && tile.type.is_hint) {
                this._set_prop(this, 'hint_shown', tile.specific_hint ?? this.stored_level.hint);
            }
        }

        // If we're stepping directly on the player, that kills them too
        // TODO this only works because i have the player move first; in lynx the check is the other
        // way around
        if (actor.type.is_monster && goal_cell === this.player_leaving_cell) {
            this.fail(actor.type.name);
        }

        if (actor === this.player && goal_cell[0].type.name === 'floor') {
            this.sfx.play_once('step-floor');
        }

        if (this.compat.tiles_react_instantly) {
            this.step_on_cell(actor, actor.cell);
        }
    }

    // Step on every tile in a cell we just arrived in
    step_on_cell(actor, cell) {
        let teleporter;
        for (let tile of Array.from(cell)) {
            if (tile === actor)
                continue;
            if (actor.ignores(tile.type.name))
                continue;

            // TODO some actors can pick up some items...
            if (tile.type.is_item &&
                (actor.type.is_player || cell.some(t => t.allows_all_pickup)) &&
                this.attempt_take(actor, tile))
            {
                if (tile.type.is_key) {
                    this.sfx.play_once('get-key', cell);
                }
                else {
                    this.sfx.play_once('get-tool', cell);
                }
            }
            else if (tile.type.teleport_dest_order) {
                teleporter = tile;
            }
            else if (tile.type.on_arrive) {
                tile.type.on_arrive(tile, this, actor);
            }
        }

        // Handle teleporting, now that the dust has cleared
        // FIXME something funny happening here, your input isn't ignored while walking out of it?
        if (teleporter) {
            let original_direction = actor.direction;
            let success = false;
            for (let dest of teleporter.type.teleport_dest_order(teleporter, this, actor)) {
                // Teleporters already containing an actor are blocked and unusable
                if (dest.cell.some(tile => tile.type.is_actor && tile !== actor))
                    continue;

                // Physically move the actor to the new teleporter
                // XXX lynx treats this as a slide and does it in a pass in the main loop
                // XXX not especially undo-efficient
                this.remove_tile(actor);
                this.add_tile(actor, dest.cell);

                // Red and green teleporters attempt to spit you out in every direction before
                // giving up on a destination (but not if you return to the original).
                // Note that we use actor.direction here (rather than original_direction) because
                // green teleporters modify it in teleport_dest_order, to randomize the exit
                // direction
                let direction = actor.direction;
                let num_directions = 1;
                if (teleporter.type.teleport_try_all_directions && dest !== teleporter) {
                    num_directions = 4;
                }
                for (let i = 0; i < num_directions; i++) {
                    if (this.attempt_step(actor, direction)) {
                        success = true;
                        // Sound plays from the origin cell simply because that's where the sfx player
                        // thinks the player is currently; position isn't updated til next turn
                        this.sfx.play_once('teleport', teleporter.cell);
                        break;
                    }
                    else {
                        direction = DIRECTIONS[direction].right;
                    }
                }

                if (success) {
                    break;
                }
                else if (num_directions === 4) {
                    // Restore our original facing before continuing
                    // (For red teleports, we try every possible destination in our original
                    // movement direction, so this is correct.  For green teleports, we only try one
                    // destination and then fall back to walking through the source in our original
                    // movement direction, so this is still correct.)
                    this.set_actor_direction(actor, original_direction);
                }
            }
        }
    }

    // Update the state of all wired tiles in the game.
    // XXX need to be clear on the order of events here.  say everything starts out unpowered.
    // then:
    // 1. you step on a pink button, which flags itself as going to be powered next frame
    // 2. this pass happens.  every unpowered-but-wired cell is inspected.  if a powered one is
    // found, floodfill from there
    // FIXME can probably skip this if we know there are no wires at all, like in a CCL, or just an
    // unwired map
    // FIXME this feels inefficient.  most of the time none of the inputs have changed so none of
    // this needs to happen at all
    // FIXME none of this is currently undoable
    update_wiring() {
        // Gather every tile that's emitting power.  Along the way, check whether any of them have
        // changed since last tic, so we can skip this work entirely if none did
        let neighbors = [];
        let any_changed = false;
        for (let tile of this.power_sources) {
            if (! tile.cell)
                continue;
            let emitting = tile.type.get_emitting_edges(tile, this);
            if (emitting) {
                neighbors.push([tile.cell, emitting]);
            }
            if (emitting !== tile.emitting_edges) {
                any_changed = true;
                tile.emitting_edges = emitting;
            }
        }
        // Also check actors, since any of them might be holding a lightning bolt (argh)
        for (let actor of this.actors) {
            if (! actor.cell)
                continue;
            // Only count when they're on a tile, not in transit!
            let emitting = actor.movement_cooldown === 0 && actor.has_item('lightning_bolt');
            if (emitting) {
                neighbors.push([actor.cell, emitting]);
            }
            if (emitting !== actor.emitting_edges) {
                any_changed = true;
                actor.emitting_edges = emitting;
            }
        }
        // If none changed, we're done
        if (! any_changed)
            return;

        // Turn off power to every cell
        // TODO wonder if i need a linear cell list, or even a flat list of all tiles (that sounds
        // like hell to keep updated though)
        for (let row of this.cells) {
            for (let cell of row) {
                cell.prev_powered_edges = cell.powered_edges;
                cell.powered_edges = 0;
            }
        }

        // Iterate over emitters and flood-fill outwards one edge at a time
        // propagated it via flood-fill through neighboring wires
        while (neighbors.length > 0) {
            let [cell, source_direction] = neighbors.shift();
            let wire = cell.get_wired_tile();

            // Power this cell
            if (typeof(source_direction) === 'number') {
                // This cell is emitting power itself, and the source direction is actually a
                // bitmask of directions
                cell.powered_edges = source_direction;
            }
            else {
                let bit = DIRECTIONS[source_direction].bit;
                if (wire === null || (wire.wire_directions & bit) === 0) {
                    // No wire on this side, so the power doesn't actually propagate, but it DOES
                    // stay on this edge (so if this is e.g. a purple tile, it'll be powered)
                    cell.powered_edges |= bit;
                    continue;
                }

                // Common case: power entering a wired edge and propagating outwards.  The only
                // special case is that four-way wiring is two separate wires, N/S and E/W
                if (wire.wire_directions === 0x0f) {
                    cell.powered_edges |= bit;
                    cell.powered_edges |= DIRECTIONS[DIRECTIONS[source_direction].opposite].bit;
                }
                else {
                    cell.powered_edges = wire.wire_directions;
                }
            }

            // Propagate current to neighbors
            for (let [direction, dirinfo] of Object.entries(DIRECTIONS)) {
                if (direction === source_direction)
                    continue;
                if ((cell.powered_edges & dirinfo.bit) === 0)
                    continue;

                let neighbor, neighbor_wire;
                let opposite_bit = DIRECTIONS[dirinfo.opposite].bit;
                if (wire && (wire.wire_tunnel_directions & dirinfo.bit)) {
                    // Search in the given direction until we find a matching tunnel
                    // FIXME these act like nested parens!
                    let x = cell.x;
                    let y = cell.y;
                    let nesting = 0;
                    while (true) {
                        x += dirinfo.movement[0];
                        y += dirinfo.movement[1];
                        if (! this.is_point_within_bounds(x, y))
                            break;

                        let candidate = this.cells[y][x];
                        neighbor_wire = candidate.get_wired_tile();
                        if (neighbor_wire && ((neighbor_wire.wire_tunnel_directions ?? 0) & opposite_bit)) {
                            neighbor = candidate;
                            break;
                        }
                    }
                }
                else {
                    // No tunnel; this is easy
                    neighbor = this.get_neighboring_cell(cell, direction);
                    neighbor_wire = neighbor.get_wired_tile();
                }

                if (neighbor && (neighbor.powered_edges & opposite_bit) === 0 &&
                    // Unwired tiles are OK; they might be something activated by power.
                    // Wired tiles that do NOT connect to us are ignored.
                    (! neighbor_wire || neighbor_wire.wire_directions & opposite_bit))
                {
                    neighbors.push([neighbor, dirinfo.opposite]);
                }
            }
        }

        // Inform any affected cells of power changes
        for (let row of this.cells) {
            for (let cell of row) {
                if ((cell.prev_powered_edges === 0) !== (cell.powered_edges === 0)) {
                    let method = cell.powered_edges ? 'on_power' : 'on_depower';
                    for (let tile of cell) {
                        if (tile.type[method]) {
                            tile.type[method](tile, this);
                        }
                    }
                }
            }
        }
    }

    // Performs a depth-first search for connected wires and wire objects, extending out from the
    // given starting cell
    *follow_circuit(cell) {
    }

    // -------------------------------------------------------------------------
    // Board inspection

    is_point_within_bounds(x, y) {
        return (x >= 0 && x < this.width && y >= 0 && y < this.height);
    }

    get_neighboring_cell(cell, direction) {
        let move = DIRECTIONS[direction].movement;
        let goal_x = cell.x + move[0];
        let goal_y = cell.y + move[1];
        if (this.is_point_within_bounds(goal_x, goal_y)) {
            return this.cells[goal_y][goal_x];
        }
        else {
            return null;
        }
    }

    // Iterates over the grid in (reverse?) reading order and yields all tiles with the given name.
    // The starting cell is iterated last.
    *iter_tiles_in_reading_order(start_cell, name, reverse = false) {
        let x = start_cell.x;
        let y = start_cell.y;
        while (true) {
            if (reverse) {
                x -= 1;
                if (x < 0) {
                    x = this.width - 1;
                    y = (y - 1 + this.height) % this.height;
                }
            }
            else {
                x += 1;
                if (x >= this.width) {
                    x = 0;
                    y = (y + 1) % this.height;
                }
            }

            let cell = this.cells[y][x];
            for (let tile of cell) {
                if (tile.type.name === name) {
                    yield tile;
                }
            }

            if (cell === start_cell)
                return;
        }
    }

    // Iterates over the grid in a diamond pattern, spreading out from the given start cell (but not
    // including it).  Only used for connecting orange buttons.
    *iter_cells_in_diamond(start_cell) {
        let max_search_radius = Math.max(this.size_x, this.size_y);
        for (let dist = 1; dist <= max_search_radius; dist++) {
            // Start east and move counterclockwise
            let sx = start_cell.x + dist;
            let sy = start_cell.y;
            for (let direction of [[-1, -1], [-1, 1], [1, 1], [1, -1]]) {
                for (let i = 0; i < dist; i++) {
                    if (this.is_point_within_bounds(sx, sy)) {
                        yield this.cells[sy][sx];
                    }
                    sx += direction[0];
                    sy += direction[1];
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Undo handling

    commit() {
        this.undo_stack.push(this.pending_undo);
        this.pending_undo = [];

        // Limit the stack to, idk, 200 tics (10 seconds)
        if (this.undo_stack.length > 200) {
            this.undo_stack.splice(0, this.undo_stack.length - 200);
        }
    }

    undo() {
        this.aid = Math.max(1, this.aid);

        let entry = this.undo_stack.pop();
        // Undo in reverse order!  There's no redo, so it's okay to destroy this
        entry.reverse();
        for (let undo of entry) {
            undo();
        }
    }

    // -------------------------------------------------------------------------
    // Level alteration methods.  EVERYTHING that changes the state of a level,
    // including the state of a single tile, should do it through one of these
    // for undo/rewind purposes

    _set_prop(obj, key, val) {
        let old_val = obj[key];
        if (val === old_val)
            return;
        this.pending_undo.push(() => obj[key] = old_val);
        obj[key] = val;
    }

    collect_chip() {
        let current = this.chips_remaining;
        if (current > 0) {
            this.sfx.play_once('get-chip');
            this.pending_undo.push(() => this.chips_remaining = current);
            this.chips_remaining--;
        }
    }

    adjust_bonus(add, mult = 1) {
        let current = this.bonus_points;
        this.pending_undo.push(() => this.bonus_points = current);
        this.bonus_points = Math.ceil(this.bonus_points * mult) + add;
    }

    pause_timer() {
        if (this.time_remaining === null)
            return;

        this.pending_undo.push(() => this.timer_paused = ! this.timer_paused);
        this.timer_paused = ! this.timer_paused;
    }

    adjust_timer(dt) {
        let current = this.time_remaining;
        this.pending_undo.push(() => this.time_remaining = current);

        // Untimed levels become timed levels with 0 seconds remaining
        this.time_remaining = Math.max(0, (this.time_remaining ?? 0) + dt * 20);
        if (this.time_remaining <= 0) {
            if (this.timer_paused) {
                this.time_remaining = 1;
            }
            else {
                this.fail('time');
            }
        }
    }

    fail(reason) {
        if (reason === 'time') {
            this.sfx.play_once('timeup');
        }
        else {
            this.sfx.play_once('lose');
        }

        this.pending_undo.push(() => {
            this.state = 'playing';
            this.fail_reason = null;
            this.player.fail_reason = null;
        });
        this.state = 'failure';
        this.fail_reason = reason;
        this.player.fail_reason = reason;
        throw new GameEnded;
    }

    win() {
        this.sfx.play_once('win');
        this.pending_undo.push(() => this.state = 'playing');
        this.state = 'success';
        throw new GameEnded;
    }

    get_scorecard() {
        if (this.state !== 'success') {
            return null;
        }

        let time = Math.ceil((this.time_remaining ?? 0) / 20);
        return {
            time: time,
            abstime: this.tic_counter,
            bonus: this.bonus_points,
            score: this.stored_level.number * 500 + time * 10 + this.bonus_points,
            aid: this.aid,
        };
    }

    // Get the next direction a random force floor will use.  They share global
    // state and cycle clockwise.
    get_force_floor_direction() {
        let d = this.force_floor_direction;
        this.force_floor_direction = DIRECTIONS[d].right;
        return d;
    }

    // Tile stuff in particular
    // TODO should add in the right layer?  maybe?

    remove_tile(tile) {
        let cell = tile.cell;
        let index = cell._remove(tile);
        this.pending_undo.push(() => cell._add(tile, index));
    }

    add_tile(tile, cell, index = null) {
        cell._add(tile, index);
        this.pending_undo.push(() => cell._remove(tile));
    }

    add_actor(actor) {
        this.actors.push(actor);
        this.pending_undo.push(() => this.actors.pop());
    }

    spawn_animation(cell, name) {
        let type = TILE_TYPES[name];
        let tile = new Tile(type);
        this._set_prop(tile, 'animation_speed', tile.type.ttl);
        this._set_prop(tile, 'animation_progress', 0);
        cell._add(tile);
        this.actors.push(tile);
        this.pending_undo.push(() => {
            this.actors.pop();
            cell._remove(tile);
        });
    }

    transmute_tile(tile, name) {
        let current = tile.type.name;
        this.pending_undo.push(() => tile.type = TILE_TYPES[current]);
        tile.type = TILE_TYPES[name];

        // For transmuting into an animation, set up the timer immediately
        if (tile.type.ttl) {
            if (! TILE_TYPES[current].is_actor) {
                console.warn("Transmuting a non-actor into an animation!");
            }
            this._set_prop(tile, 'animation_speed', tile.type.ttl);
            this._set_prop(tile, 'animation_progress', 0);
        }
    }

    // Have an actor try to pick up a particular tile; it's prevented if there's a no sign, and the
    // tile is removed if successful
    attempt_take(actor, tile) {
        if (! tile.cell.some(t => t.type.disables_pickup) &&
            this.give_actor(actor, tile.type.name))
        {
            this.remove_tile(tile);
            return true;
        }
        return false;
    }

    // Give an item to an actor, even if it's not supposed to have an inventory
    give_actor(actor, name) {
        if (! actor.type.is_actor)
            return false;

        let type = TILE_TYPES[name];
        if (type.is_key) {
            if (! actor.keyring) {
                actor.keyring = {};
            }
            actor.keyring[name] = (actor.keyring[name] ?? 0) + 1;
            this.pending_undo.push(() => actor.keyring[name] -= 1);
        }
        else {
            // tool, presumably
            if (! actor.toolbelt) {
                actor.toolbelt = [];
            }
            actor.toolbelt.push(name);
            this.pending_undo.push(() => actor.toolbelt.pop());
        }
        return true;
    }

    take_key_from_actor(actor, name) {
        if (actor.keyring && (actor.keyring[name] ?? 0) > 0) {
            if (actor.type.infinite_items && actor.type.infinite_items[name]) {
                // Some items can't be taken away normally, by which I mean, green or yellow keys
                return true;
            }

            this.pending_undo.push(() => actor.keyring[name] += 1);
            actor.keyring[name] -= 1;
            return true;
        }

        return false;
    }

    take_all_keys_from_actor(actor) {
        if (actor.keyring) {
            let keyring = actor.keyring;
            this.pending_undo.push(() => actor.keyring = keyring);
            actor.keyring = {};
        }
    }

    take_all_tools_from_actor(actor) {
        if (actor.toolbelt) {
            let toolbelt = actor.toolbelt;
            this.pending_undo.push(() => actor.toolbelt = toolbelt);
            actor.toolbelt = [];
        }
    }

    // Mark an actor as sliding
    make_slide(actor, mode) {
        let current = actor.slide_mode;
        this.pending_undo.push(() => actor.slide_mode = current);
        actor.slide_mode = mode;
    }

    // Change an actor's direction
    set_actor_direction(actor, direction) {
        let current = actor.direction;
        this.pending_undo.push(() => actor.direction = current);
        actor.direction = direction;
    }

    set_actor_stuck(actor, is_stuck) {
        let current = actor.stuck;
        if (current === is_stuck)
            return;
        this.pending_undo.push(() => actor.stuck = current);
        actor.stuck = is_stuck;
    }
}
