// Small helper classes used by the editor, often with their own UI for the SVG overlay.
import { DIRECTIONS } from '../defs.js';
import { BitVector, mk, mk_svg } from '../util.js';

export class SVGConnection {
    constructor(sx, sy, dx, dy) {
        this.source = mk_svg('circle.-source', {r: 0.5, cx: sx + 0.5, cy: sy + 0.5});
        this.line = mk_svg('line.-arrow', {});
        this.dest = mk_svg('rect.-dest', {x: dx, y: dy, width: 1, height: 1});
        this.element = mk_svg('g.overlay-connection', this.source, this.line, this.dest);
        this.sx = sx;
        this.sy = sy;
        this.dx = dx;
        this.dy = dy;
        this._update_line_endpoints();
    }

    set_source(sx, sy) {
        this.sx = sx;
        this.sy = sy;
        this.source.setAttribute('cx', sx + 0.5);
        this.source.setAttribute('cy', sy + 0.5);
        this._update_line_endpoints();
    }

    set_dest(dx, dy) {
        this.dx = dx;
        this.dy = dy;
        this.dest.setAttribute('x', dx);
        this.dest.setAttribute('y', dy);
        this._update_line_endpoints();
    }

    _update_line_endpoints() {
        // Start the line at the edge of the circle, so, add 0.5 in the direction of the line
        let vx = this.dx - this.sx;
        let vy = this.dy - this.sy;
        let line_length = Math.sqrt(vx*vx + vy*vy);
        let trim_x = 0;
        let trim_y = 0;
        if (line_length >= 1) {
            trim_x = 0.5 * vx / line_length;
            trim_y = 0.5 * vy / line_length;
        }
        this.line.setAttribute('x1', this.sx + 0.5 + trim_x);
        this.line.setAttribute('y1', this.sy + 0.5 + trim_y);
        // Technically this isn't quite right, since the ending is a square and the arrowhead will
        // poke into it a bit from angles near 45°, but that requires a bit more trig than seems
        // worth it, and it looks kinda neat anyway.
        // Also, one nicety: if the cells are adjacent, don't trim the endpoint, or we won't have
        // an arrow at all.
        if (line_length < 2) {
            this.line.setAttribute('x2', this.dx + 0.5);
            this.line.setAttribute('y2', this.dy + 0.5);
        }
        else {
            this.line.setAttribute('x2', this.dx + 0.5 - trim_x);
            this.line.setAttribute('y2', this.dy + 0.5 - trim_y);
        }
    }
}


export class PendingRectangularSelection {
    constructor(owner, mode) {
        this.owner = owner;
        this.mode = mode ?? 'new';  // new, add, subtract
        this.element = mk_svg('rect.overlay-pending-selection');
        this.size_text = mk_svg('text.overlay-edit-tip');
        this.owner.svg_group.append(this.element, this.size_text);
        this.rect = null;
    }

    set_extrema(x0, y0, x1, y1) {
        this.rect = new DOMRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x0 - x1) + 1, Math.abs(y0 - y1) + 1);
        this.element.classList.add('--visible');
        this.element.setAttribute('x', this.rect.x);
        this.element.setAttribute('y', this.rect.y);
        this.element.setAttribute('width', this.rect.width);
        this.element.setAttribute('height', this.rect.height);
        this.size_text.textContent = `${this.rect.width} × ${this.rect.height}`;
        this.size_text.setAttribute('x', this.rect.x + this.rect.width / 2);
        this.size_text.setAttribute('y', this.rect.y + this.rect.height / 2);
    }

    commit() {
        if (this.mode === 'new') {
            this.owner.clear();
            this.owner.add_rect(this.rect);
        }
        else if (this.mode === 'add') {
            this.owner.add_rect(this.rect);
        }
        else if (this.mode === 'subtract') {
            this.owner.subtract_rect(this.rect);
        }
        this.element.remove();
        this.size_text.remove();
    }

    discard() {
        this.element.remove();
        this.size_text.remove();
    }
}

export class Selection {
    constructor(editor) {
        this.editor = editor;

        this.svg_group = mk_svg('g');
        this.editor.svg_overlay.append(this.svg_group);
        // Used for the floating preview and selection rings, which should all move together
        this.selection_group = mk_svg('g');
        this.svg_group.append(this.selection_group);

        // Note that this is a set of the ORIGINAL coordinates of the selected cells.  Moving a
        // floated selection doesn't change this; instead it updates floated_offset
        this.cells = new Set;
        this.bbox = null;
        // I want a black-and-white outline ring so it shows against any background, but the only
        // way to do that in SVG is apparently to just duplicate the path
        this.ring_bg_element = mk_svg('path.overlay-selection-background.overlay-transient');
        this.ring_element = mk_svg('path.overlay-selection.overlay-transient');
        this.selection_group.append(this.ring_bg_element, this.ring_element);

        this.floated_cells = null;
        this.floated_element = null;
        this.floated_canvas = null;
        this.floated_offset = null;
    }

    get is_empty() {
        return this.cells.size === 0;
    }

    get is_floating() {
        return !! this.floated_cells;
    }

    get has_moved() {
        return !! (this.floated_offset && (this.floated_offset[0] || this.floated_offset[0]));
    }

    contains(x, y) {
        // Empty selection means everything is selected?
        if (this.is_empty)
            return true;

        if (this.floated_offset) {
            x -= this.floated_offset[0];
            y -= this.floated_offset[1];
        }

        return this.cells.has(this.editor.stored_level.coords_to_scalar(x, y));
    }

    create_pending(mode) {
        return new PendingRectangularSelection(this, mode);
    }

    add_rect(rect) {
        let old_cells = this.cells;
        // TODO would be nice to only store the difference between the old/new sets of cells?
        this.cells = new Set(this.cells);

        this.editor._do(
            () => this._add_rect(rect),
            () => {
                this._set_from_set(old_cells);
            },
            false,
        );
    }

    _add_rect(rect) {
        let stored_level = this.editor.stored_level;
        for (let y = rect.top; y < rect.bottom; y++) {
            for (let x = rect.left; x < rect.right; x++) {
                this.cells.add(stored_level.coords_to_scalar(x, y));
            }
        }

        if (! this.bbox) {
            this.bbox = rect;
        }
        else {
            // Just recreate it from scratch to avoid mixing old and new properties
            let new_x = Math.min(this.bbox.x, rect.x);
            let new_y = Math.min(this.bbox.y, rect.y);
            this.bbox = new DOMRect(
                new_x, new_y,
                Math.max(this.bbox.right, rect.right) - new_x,
                Math.max(this.bbox.bottom, rect.bottom) - new_y);
        }

        this._update_outline();
    }

    subtract_rect(rect) {
        let old_cells = this.cells;
        this.cells = new Set(this.cells);

        this.editor._do(
            () => this._subtract_rect(rect),
            () => {
                this._set_from_set(old_cells);
            },
            false,
        );
    }

    _subtract_rect(rect) {
        if (this.is_empty)
            // Nothing to do
            return;

        let stored_level = this.editor.stored_level;
        for (let y = rect.top; y < rect.bottom; y++) {
            for (let x = rect.left; x < rect.right; x++) {
                this.cells.delete(stored_level.coords_to_scalar(x, y));
            }
        }

        // TODO shrink bbox?  i guess i only have to check along the edges that the rect intersects?

        this._update_outline();
    }

    _set_from_set(cells) {
        this.cells = cells;

        // Recompute bbox
        if (cells.size === 0) {
            this.bbox = null;
        }
        else {
            let min_x = null;
            let min_y = null;
            let max_x = null;
            let max_y = null;
            for (let n of cells) {
                let [x, y] = this.editor.stored_level.scalar_to_coords(n);
                if (min_x === null) {
                    min_x = x;
                    min_y = y;
                    max_x = x;
                    max_y = y;
                }
                else {
                    min_x = Math.min(min_x, x);
                    max_x = Math.max(max_x, x);
                    min_y = Math.min(min_y, y);
                    max_y = Math.max(max_y, y);
                }
            }

            this.bbox = new DOMRect(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1);
        }

        // XXX ??? if (this.floated_element) {

        this._update_outline();
    }

    // Faster internal version of contains() that ignores the floating offset
    _contains(x, y) {
        let stored_level = this.editor.stored_level;
        return stored_level.is_point_within_bounds(x, y) &&
            this.cells.has(stored_level.coords_to_scalar(x, y));
    }

    _update_outline() {
        if (this.is_empty) {
            this.ring_bg_element.classList.remove('--visible');
            this.ring_element.classList.remove('--visible');
            return;
        }

        // Convert the borders between cells to an SVG path.
        // I don't know an especially clever way to do this so I guess I'll just make it up.  The
        // basic idea is to start with the top-left highlighted cell, start tracing from its top
        // left corner towards the right (which must be a border, because this is the top left
        // selected cell, so nothing above it is selected), then just keep going until we get back
        // to where we started.  Then we...  repeat.
        // But how do we repeat?  My tiny insight is that every island (including holes) must cross
        // the top of at least one cell; the only alternatives are for it to be zero width or only
        // exist in the bottom row, and either way that makes it zero area, which isn't allowed.  So
        // we only have to track and check the top edges of cells, and run through every cell in the
        // grid in order, stopping to draw a new outline when we find a cell whose top edge we
        // haven't yet examined (and whose top edge is in fact a border).  We unfortunately need to
        // examine cells outside the selection, too, so that we can identify holes.  But we can
        // restrict all of this to within the bbox, so that's nice.
        // Also, note that we concern ourselves with /grid points/ here, which are intersections of
        // grid lines, whereas the grid cells are the spaces between grid lines.
        // TODO might be more efficient to store a list of horizontal spans instead of just cells,
        // but of course this would be more complicated
        let seen_tops = new BitVector(this.bbox.width * this.bbox.height);
        // In clockwise order for ease of rotation, starting with right
        let directions = [
            [1, 0],
            [0, 1],
            [-1, 0],
            [0, -1],
        ];

        let segments = [];
        for (let y = this.bbox.top; y < this.bbox.bottom; y++) {
            for (let x = this.bbox.left; x < this.bbox.right; x++) {
                if (seen_tops.get((x - this.bbox.left) + this.bbox.width * (y - this.bbox.top)))
                    // Already traced
                    continue;
                if (this._contains(x, y) === this._contains(x, y - 1))
                    // Not a top border
                    continue;

                // Start a new segment!
                let gx = x;
                let gy = y;
                let dx = 1;
                let dy = 0;
                let d = 0;

                let segment = [];
                segments.push(segment);
                segment.push([gx, gy]);
                while (segment.length < 100) {
                    // At this point we know that d is a valid direction and we've just traced it
                    if (dx === 1) {
                        seen_tops.set((gx - this.bbox.left) + this.bbox.width * (gy - this.bbox.top));
                    }
                    else if (dx === -1) {
                        seen_tops.set((gx - 1 - this.bbox.left) + this.bbox.width * (gy - this.bbox.top));
                    }
                    gx += dx;
                    gy += dy;

                    if (gx === x && gy === y)
                        break;

                    // Now we're at a new point, so search for the next direction, starting from the left
                    // Again, this is clockwise order (tr, br, bl, tl), arranged so that direction D goes
                    // between cells D and D + 1
                    let neighbors = [
                        this._contains(gx, gy - 1),
                        this._contains(gx, gy),
                        this._contains(gx - 1, gy),
                        this._contains(gx - 1, gy - 1),
                    ];
                    let new_d = (d + 1) % 4;
                    for (let i = 3; i <= 4; i++) {
                        let sd = (d + i) % 4;
                        if (neighbors[sd] !== neighbors[(sd + 1) % 4]) {
                            new_d = sd;
                            break;
                        }
                    }
                    if (new_d !== d) {
                        // We're turning, so this is a new point
                        segment.push([gx, gy]);
                        d = new_d;
                        [dx, dy] = directions[d];
                    }
                }
            }
        }
        // TODO do it again for the next region...  but how do i tell where the next region is?

        let pathdata = [];
        for (let subpath of segments) {
            let first = true;
            for (let [x, y] of subpath) {
                if (first) {
                    first = false;
                    pathdata.push(`M${x},${y}`);
                }
                else {
                    pathdata.push(`L${x},${y}`);
                }
            }
            pathdata.push('z');
        }
        this.ring_bg_element.classList.add('--visible');
        this.ring_bg_element.setAttribute('d', pathdata.join(' '));
        this.ring_element.classList.add('--visible');
        this.ring_element.setAttribute('d', pathdata.join(' '));
    }

    move_by(dx, dy) {
        if (this.is_empty)
            return;

        if (! this.floated_cells) {
            console.error("Can't move a non-floating selection");
            return;
        }

        this.floated_offset[0] += dx;
        this.floated_offset[1] += dy;
        this._update_floating_transform();
    }

    _update_floating_transform() {
        let transform = `translate(${this.floated_offset[0]} ${this.floated_offset[1]})`;
        this.selection_group.setAttribute('transform', transform);
    }

    clear() {
        // FIXME behavior when floating is undefined
        if (this.is_empty)
            return;

        let old_cells = this.cells;

        this.editor._do(
            () => this._clear(),
            () => {
                this._set_from_set(old_cells);
            },
            false,
        );
    }

    _clear() {
        this.cells = new Set;
        this.bbox = null;
        this.ring_bg_element.classList.remove('--visible');
        this.ring_element.classList.remove('--visible');
    }

    // Convert this selection into a floating selection, plucking all the selected cells from the
    // level and replacing them with blank cells.
    enfloat(copy = false) {
        if (this.floated_cells) {
            console.error("Trying to float a selection that's already floating");
            return;
        }

        let floated_cells = new Map;
        let stored_level = this.editor.stored_level;
        for (let n of this.cells) {
            let [x, y] = stored_level.scalar_to_coords(n);
            let cell = stored_level.linear_cells[n];
            if (copy) {
                floated_cells.set(n, cell.map(tile => tile ? {...tile} : null));
            }
            else {
                floated_cells.set(n, cell);
                this.editor.replace_cell(cell, this.editor.make_blank_cell(x, y));
            }
        }

        this.editor._do(
            () => {
                this.floated_cells = floated_cells;
                this.floated_offset = [0, 0];
                this._init_floated_canvas();
                this.ring_element.classList.add('--floating');
            },
            () => this._delete_floating(),
        );
    }

    // Create floated_canvas and floated_element, based on floated_cells, or update them if they
    // already exist
    _init_floated_canvas() {
        let tileset = this.editor.renderer.tileset;
        if (! this.floated_canvas) {
            this.floated_canvas = mk('canvas');
        }
        this.floated_canvas.width = this.bbox.width * tileset.size_x;
        this.floated_canvas.height = this.bbox.height * tileset.size_y;
        this.redraw();

        if (! this.floated_element) {
            this.floated_element = mk_svg('g', mk_svg('foreignObject', {
                x: 0,
                y: 0,
                transform: `scale(${1/tileset.size_x} ${1/tileset.size_y})`,
            }, this.floated_canvas));
            // This goes first, so the selection ring still appears on top
            this.selection_group.prepend(this.floated_element);
        }
        let foreign = this.floated_element.querySelector('foreignObject');
        foreign.setAttribute('width', this.floated_canvas.width);
        foreign.setAttribute('height', this.floated_canvas.height);

        // The canvas only covers our bbox, so it needs to start where the bbox does
        this.floated_element.setAttribute('transform', `translate(${this.bbox.x} ${this.bbox.y})`);
    }

    stamp_float(copy = false) {
        if (! this.floated_element)
            return;

        let stored_level = this.editor.stored_level;
        for (let n of this.cells) {
            let [x, y] = stored_level.scalar_to_coords(n);
            x += this.floated_offset[0];
            y += this.floated_offset[1];
            // If the selection is moved so that part of it is outside the level, skip that bit
            if (! stored_level.is_point_within_bounds(x, y))
                continue;

            let cell = this.floated_cells.get(n);
            if (copy) {
                cell = cell.map(tile => tile ? {...tile} : null);
            }
            cell.x = x;
            cell.y = y;

            let n2 = stored_level.coords_to_scalar(x, y);
            this.editor.replace_cell(stored_level.linear_cells[n2], cell);
        }
    }

    // Converts a floating selection back to a regular selection, including stamping it in place
    commit_floating() {
        // This is OK; we're idempotent
        if (! this.floated_element)
            return;

        this.stamp_float();

        // Actually apply the offset, so we can be a regular selection again
        let old_cells = this.cells;
        let old_bbox = DOMRect.fromRect(this.bbox);
        let new_cells = new Set;
        let stored_level = this.editor.stored_level;
        for (let n of old_cells) {
            let [x, y] = stored_level.scalar_to_coords(n);
            x += this.floated_offset[0];
            y += this.floated_offset[1];

            if (stored_level.is_point_within_bounds(x, y)) {
                new_cells.add(stored_level.coords_to_scalar(x, y));
            }
        }

        let old_floated_cells = this.floated_cells;
        let old_floated_offset = this.floated_offset;
        this.editor._do(
            () => {
                this._delete_floating();
                this._set_from_set(new_cells);
            },
            () => {
                // Don't use _set_from_set here; it's not designed for an offset float
                this.cells = old_cells;
                this.bbox = old_bbox;
                this._update_outline();

                this.floated_cells = old_floated_cells;
                this.floated_offset = old_floated_offset;
                this._init_floated_canvas();
                this._update_floating_transform();
                this.ring_element.classList.add('--floating');
            },
            false,
        );
    }

    // Modifies the cells (and their arrangement) within a floating selection
    _rearrange_cells(original_width, convert_coords, upgrade_tile) {
        if (! this.floated_cells)
            return;

        let new_cells = new Set;
        let new_floated_cells = new Map;
        let w = this.editor.stored_level.size_x;
        let h = this.editor.stored_level.size_y;
        for (let n of this.cells) {
            // Alas this needs manually computing since the level may have changed size
            let x = n % original_width;
            let y = Math.floor(n / original_width);
            let [x2, y2] = convert_coords(x, y, w, h);
            let n2 = x2 + w * y2;
            let cell = this.floated_cells.get(n);
            cell.x = x2;
            cell.y = y2;
            for (let tile of cell) {
                if (tile) {
                    upgrade_tile(tile);
                }
            }
            new_cells.add(n2);
            new_floated_cells.set(n2, cell);
        }

        // Track the old and new centers of the bboxes so the transform can be center-relative
        let [cx0, cy0] = convert_coords(
            Math.floor(this.bbox.x + this.bbox.width / 2),
            Math.floor(this.bbox.y + this.bbox.height / 2),
            w, h);

        // Alter the bbox by just transforming two opposite corners
        let [x1, y1] = convert_coords(this.bbox.left, this.bbox.top, w, h);
        let [x2, y2] = convert_coords(this.bbox.right - 1, this.bbox.bottom - 1, w, h);
        let xs = [x1, x2];
        let ys = [y1, y2];
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        this.bbox = new DOMRect(xs[0], ys[0], xs[1] - xs[0] + 1, ys[1] - ys[0] + 1);

        // Now make it center-relative by shifting the offsets
        let [cx1, cy1] = convert_coords(
            Math.floor(this.bbox.x + this.bbox.width / 2),
            Math.floor(this.bbox.y + this.bbox.height / 2),
            w, h);
        this.floated_offset[0] += cx1 - cx0;
        this.floated_offset[1] += cy1 - cy0;
        this._update_floating_transform();

        // No need for undo; this is undone by performing the reverse operation
        this.cells = new_cells;
        this.floated_cells = new_floated_cells;
        this._init_floated_canvas();

        this._update_outline();
    }

    _delete_floating() {
        this.selection_group.removeAttribute('transform');
        this.ring_element.classList.remove('--floating');
        this.floated_element.remove();

        this.floated_cells = null;
        this.floated_offset = null;
        this.floated_element = null;
        this.floated_canvas = null;
    }

    // Redraw the selection canvas from scratch
    redraw() {
        if (! this.floated_canvas)
            return;

        let ctx = this.floated_canvas.getContext('2d');
        for (let n of this.cells) {
            let [x, y] = this.editor.stored_level.scalar_to_coords(n);
            this.editor.renderer.draw_static_generic({
                // Incredibly stupid hack for just drawing one cell
                x0: 0, x1: 0,
                y0: 0, y1: 0,
                width: 1,
                cells: [this.floated_cells.get(n)],
                ctx: ctx,
                destx: x - this.bbox.left,
                desty: y - this.bbox.top,
            });
        }
    }

    // TODO make more stuff respect this (more things should go through Editor for undo reasons anyway)
}

