import { TransientOverlay } from './main-base.js';
import { mk, mk_svg } from './util.js';

// FIXME could very much stand to have a little animation when appearing
class TileEditorOverlay extends TransientOverlay {
    constructor(conductor) {
        let root = mk('form.editor-popup-tile-editor');
        super(conductor, root);
        this.editor = conductor.editor;
        this.tile = null;
    }

    edit_tile(tile) {
        this.tile = tile;
    }

    static configure_tile_defaults(tile) {
        // FIXME maybe this should be on the tile type, so it functions as documentation there?
    }
}

class LetterTileEditor extends TileEditorOverlay {
    constructor(conductor) {
        super(conductor);

        this.root.append(mk('h3', "Letter tile"));
        let list = mk('ol.editor-letter-tile-picker');
        this.root.append(list);
        this.glyph_elements = {};
        let add = glyph => {
            let input = mk('input', {type: 'radio', name: 'glyph', value: glyph});
            this.glyph_elements[glyph] = input;
            let item = mk('li', mk('label', input, mk('span.-glyph', glyph)));
            list.append(item);
        };
        let arrows = ["⬆", "➡", "⬇", "⬅"];
        for (let c = 32; c < 96; c++) {
            let glyph = String.fromCharCode(c);
            add(glyph);
            // Add the arrows to the ends of the rows
            if (c % 16 === 15) {
                add(arrows[(c - 47) / 16]);
            }
        }

        list.addEventListener('change', ev => {
            if (this.tile) {
                this.tile.overlaid_glyph = this.root.elements['glyph'].value;
                this.editor.mark_tile_dirty(this.tile);
            }
        });
    }

    edit_tile(tile) {
        super.edit_tile(tile);
        this.root.elements['glyph'].value = tile.overlaid_glyph;
    }

    static configure_tile_defaults(tile) {
        tile.type.populate_defaults(tile);
    }
}

class HintTileEditor extends TileEditorOverlay {
    constructor(conductor) {
        super(conductor);

        this.root.append(mk('h3', "Hint text"));
        this.text = mk('textarea.editor-hint-tile-text');
        this.root.append(this.text);
        this.text.addEventListener('input', ev => {
            if (this.tile) {
                this.tile.hint_text = this.text.value;
            }
        });
    }

    edit_tile(tile) {
        super.edit_tile(tile);
        this.text.value = tile.hint_text ?? "";
    }

    static configure_tile_defaults(tile) {
        tile.hint_text = "";
    }
}

class DirectionalBlockTileEditor extends TileEditorOverlay {
    constructor(conductor) {
        super(conductor);

        let svg_icons = [];
        for (let center of [[16, 0], [16, 16], [0, 16], [0, 0]]) {
            let symbol = mk_svg('svg', {viewBox: '0 0 16 16'},
                mk_svg('circle', {cx: center[0], cy: center[1], r: 3}),
                mk_svg('circle', {cx: center[0], cy: center[1], r: 13}),
            );
            svg_icons.push(symbol);
        }
        svg_icons.push(mk_svg('svg', {viewBox: '0 0 16 16'},
            mk_svg('rect', {x: -2, y: 3, width: 20, height: 10}),
        ));
        svg_icons.push(mk_svg('svg', {viewBox: '0 0 16 16'},
            mk_svg('rect', {x: 3, y: -2, width: 10, height: 20}),
        ));

        this.root.append(mk('h3', "Arrows"));
        let arrow_list = mk('ol.editor-directional-block-tile-arrows.editor-tile-editor-svg-parts');
        // Arrange the arrows in a grid
        for (let [direction, icon] of [
                [null, mk_svg('path', {d: 'M 8,16 v -8 h 8'})],
                ['north', mk_svg('path', {d: 'M 0,12 h 16 l -8,-8 z'})],
                [null, mk_svg('path', {d: 'M 0,8 h 8 v 8'})],
                ['west', mk_svg('path', {d: 'M 12,16 v -16 l -8,8 z'})],
                [null, null],
                ['east', mk_svg('path', {d: 'M 4,0 v 16 l 8,-8 z'})],
                [null, mk_svg('path', {d: 'M 16,8 h -8 v -8'})],
                ['south', mk_svg('path', {d: 'M 16,4 h -16 l 8,8 z'})],
                [null, mk_svg('path', {d: 'M 8,0 v 8 h -8'})],
        ]) {
            let li = mk('li');
            let svg;
            if (icon) {
                svg = mk_svg('svg', {viewBox: '0 0 16 16'}, icon);
            }
            if (direction === null) {
                if (svg) {
                    li.append(svg);
                }
            }
            else {
                let input = mk('input', {type: 'checkbox', name: 'direction', value: direction});
                li.append(mk('label', input, svg));
            }
            arrow_list.append(li);
        }
        arrow_list.addEventListener('change', ev => {
            if (! this.tile)
                return;

            if (ev.target.checked) {
                this.tile.arrows.add(ev.target.value);
            }
            else {
                this.tile.arrows.delete(ev.target.value);
            }
            this.editor.mark_tile_dirty(this.tile);
        });
        this.root.append(arrow_list);
    }

    edit_tile(tile) {
        super.edit_tile(tile);

        for (let input of this.root.elements['direction']) {
            input.checked = tile.arrows.has(input.value);
        }
    }

    static configure_tile_defaults(tile) {
    }
}

class RailroadTileEditor extends TileEditorOverlay {
    constructor(conductor) {
        super(conductor);

        let svg_icons = [];
        for (let center of [[16, 0], [16, 16], [0, 16], [0, 0]]) {
            let symbol = mk_svg('svg', {viewBox: '0 0 16 16'},
                mk_svg('circle', {cx: center[0], cy: center[1], r: 3}),
                mk_svg('circle', {cx: center[0], cy: center[1], r: 13}),
            );
            svg_icons.push(symbol);
        }
        svg_icons.push(mk_svg('svg', {viewBox: '0 0 16 16'},
            mk_svg('rect', {x: -2, y: 3, width: 20, height: 10}),
        ));
        svg_icons.push(mk_svg('svg', {viewBox: '0 0 16 16'},
            mk_svg('rect', {x: 3, y: -2, width: 10, height: 20}),
        ));

        this.root.append(mk('h3', "Tracks"));
        let track_list = mk('ul.editor-railroad-tile-tracks.editor-tile-editor-svg-parts');
        // Shown as two rows, this puts the straight parts first and the rest in a circle
        let track_order = [4, 1, 2, 5, 0, 3];
        for (let i of track_order) {
            let input = mk('input', {type: 'checkbox', name: 'track', value: i});
            track_list.append(mk('li', mk('label', input, svg_icons[i])));
        }
        track_list.addEventListener('change', ev => {
            if (this.tile) {
                let bit = 1 << ev.target.value;
                if (ev.target.checked) {
                    this.tile.tracks |= bit;
                }
                else {
                    this.tile.tracks &= ~bit;
                }
                this.editor.mark_tile_dirty(this.tile);
            }
        });
        this.root.append(track_list);

        this.root.append(mk('h3', "Switch"));
        let switch_list = mk('ul.editor-railroad-tile-tracks.--switch');
        for (let i of track_order) {
            let input = mk('input', {type: 'radio', name: 'switch', value: i});
            switch_list.append(mk('li', mk('label', input, svg_icons[i].cloneNode(true))));
        }
        // TODO if they remove a track it should change the switch
        // TODO if they pick a track that's missing it should add it
        switch_list.addEventListener('change', ev => {
            if (this.tile) {
                this.tile.track_switch = ev.target.value;
                this.editor.mark_tile_dirty(this.tile);
            }
        });
        this.root.append(switch_list);

        // TODO need a way to set no actor at all
        // TODO initial actor facing (maybe only if there's an actor in the cell)
    }

    edit_tile(tile) {
        super.edit_tile(tile);

        for (let input of this.root.elements['track']) {
            input.checked = !! (tile.tracks & (1 << input.value));
        }

        if (tile.track_switch === null) {
            this.root.elements['switch'].value = '';
        }
        else {
            this.root.elements['switch'].value = tile.track_switch;
        }
    }

    static configure_tile_defaults(tile) {
    }
}

export const TILES_WITH_PROPS = {
    floor_letter: LetterTileEditor,
    hint: HintTileEditor,
    directional_block: DirectionalBlockTileEditor,
    railroad: RailroadTileEditor,
    // TODO various wireable tiles (hmm not sure how that ui works)
    // TODO initial value of counter
    // TODO cloner arrows
    // TODO later, custom floor/wall selection
};
