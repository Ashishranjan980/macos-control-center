import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {TILE_DEFS, DEFAULT_ORDER, DEFAULT_HIDDEN, resolveTiles} from './tiles.js';

const GLASS_STYLES = [
    ['auto', 'Follow the dark / light toggle'],
    ['dark', 'Always dark'],
    ['light', 'Always light'],
];

const toHex = c => '#' + [c.red, c.green, c.blue]
    .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

export default class ControlCenterPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 760);

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // ── appearance ──
        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(look);

        const widthRow = new Adw.ActionRow({title: 'Panel width', subtitle: 'Width of the Control Center'});
        const width = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({lower: 300, upper: 460, step_increment: 10, page_increment: 50}),
            digits: 0, draw_value: true, value_pos: Gtk.PositionType.RIGHT,
            hexpand: true, valign: Gtk.Align.CENTER, width_request: 240,
        });
        width.set_format_value_func((_s, v) => `${Math.round(v)} px`);
        width.set_value(settings.get_int('panel-width'));
        width.connect('value-changed', () => settings.set_int('panel-width', Math.round(width.get_value())));
        widthRow.add_suffix(width);
        look.add(widthRow);

        const backdrop = new Adw.SwitchRow({
            title: 'Show panel backdrop',
            subtitle: 'One glass panel behind all tiles (off = floating tiles)',
        });
        settings.bind('show-backdrop', backdrop, 'active', 0);
        look.add(backdrop);

        const glass = new Adw.ComboRow({
            title: 'Glass style',
            subtitle: 'Light glass is easier to read on bright wallpapers',
            model: Gtk.StringList.new(GLASS_STYLES.map(([, label]) => label)),
        });
        glass.set_selected(Math.max(0, GLASS_STYLES.findIndex(([id]) => id === settings.get_string('glass-style'))));
        glass.connect('notify::selected', () =>
            settings.set_string('glass-style', GLASS_STYLES[glass.get_selected()][0]));
        look.add(glass);

        // live backdrop blur
        const blurRow = new Adw.ActionRow({
            title: 'Background blur',
            subtitle: 'Live blur behind the glass; 0 turns it off',
        });
        const blur = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 40, step_increment: 1, page_increment: 10}),
            digits: 0, draw_value: true, value_pos: Gtk.PositionType.RIGHT,
            hexpand: true, valign: Gtk.Align.CENTER, width_request: 240,
        });
        blur.set_format_value_func((_s, v) => (v < 1 ? 'Off' : `${Math.round(v)} px`));
        blur.set_value(settings.get_int('blur-strength'));
        blur.connect('value-changed', () => settings.set_int('blur-strength', Math.round(blur.get_value())));
        blurRow.add_suffix(blur);
        look.add(blurRow);

        // accent colour of active toggles
        const accentRow = new Adw.ActionRow({title: 'Accent colour'});
        const refreshAccent = () => {
            accentRow.set_subtitle(settings.get_string('accent-color')
                ? 'Colour of active toggles'
                : 'Automatic: white on dark glass, graphite on light glass');
        };
        const dialog = new Gtk.ColorDialog({with_alpha: false, title: 'Accent colour'});
        const picker = new Gtk.ColorDialogButton({dialog, valign: Gtk.Align.CENTER});
        const current = new Gdk.RGBA();
        picker.set_rgba(current.parse(settings.get_string('accent-color') || '#ffffff') ? current : new Gdk.RGBA());
        picker.connect('notify::rgba', () => {
            settings.set_string('accent-color', toHex(picker.get_rgba()));
            refreshAccent();
        });
        const reset = Gtk.Button.new_from_icon_name('edit-undo-symbolic');
        reset.set_valign(Gtk.Align.CENTER);
        reset.set_tooltip_text('Use the automatic colour');
        reset.add_css_class('flat');
        reset.connect('clicked', () => {
            settings.set_string('accent-color', '');
            refreshAccent();
        });
        accentRow.add_suffix(reset);
        accentRow.add_suffix(picker);
        look.add(accentRow);
        refreshAccent();

        // ── tiles: on/off + order ──
        const tiles = new Adw.PreferencesGroup({
            title: 'Tiles',
            description: 'Switch tiles on or off and use the arrows to reorder them. ' +
                'Tiles fill the panel from the top-left in this order.',
        });
        page.add(tiles);

        let rows = [];
        const rebuild = () => {
            for (const r of rows) tiles.remove(r);
            rows = [];
            const hidden = new Set(settings.get_strv('tile-hidden'));
            const {all} = resolveTiles(settings.get_strv('tile-order'), [...hidden]);

            const move = (i, d) => {
                const next = [...all];
                [next[i], next[i + d]] = [next[i + d], next[i]];
                settings.set_strv('tile-order', next);
                rebuild();
            };

            all.forEach((id, i) => {
                const def = TILE_DEFS[id];
                const row = new Adw.ActionRow({title: def.title, subtitle: def.sub ?? ''});
                row.add_prefix(new Gtk.Image({icon_name: def.icon, pixel_size: 16}));

                const up = Gtk.Button.new_from_icon_name('go-up-symbolic');
                const down = Gtk.Button.new_from_icon_name('go-down-symbolic');
                for (const b of [up, down]) {
                    b.set_valign(Gtk.Align.CENTER);
                    b.add_css_class('flat');
                }
                up.set_tooltip_text('Move up');
                down.set_tooltip_text('Move down');
                up.set_sensitive(i > 0);
                down.set_sensitive(i < all.length - 1);
                up.connect('clicked', () => move(i, -1));
                down.connect('clicked', () => move(i, 1));

                const sw = new Gtk.Switch({active: !hidden.has(id), valign: Gtk.Align.CENTER});
                sw.connect('notify::active', () => {
                    const off = new Set(settings.get_strv('tile-hidden'));
                    if (sw.get_active()) off.delete(id);
                    else off.add(id);
                    settings.set_strv('tile-hidden', [...off]);
                });

                row.add_suffix(up);
                row.add_suffix(down);
                row.add_suffix(sw);
                row.set_activatable_widget(sw);
                tiles.add(row);
                rows.push(row);
            });
        };
        rebuild();

        const resetGroup = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({
            title: 'Reset tiles',
            subtitle: 'Restore the default order and which tiles are shown',
        });
        const resetBtn = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        resetBtn.connect('clicked', () => {
            settings.set_strv('tile-order', DEFAULT_ORDER);
            settings.set_strv('tile-hidden', DEFAULT_HIDDEN);
            rebuild();
        });
        resetRow.add_suffix(resetBtn);
        resetGroup.add(resetRow);
        page.add(resetGroup);
    }
}
