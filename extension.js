import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import Pango from 'gi://Pango';
import NM from 'gi://NM';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';

import {TILE_DEFS, resolveTiles} from './tiles.js';
import {makeBlurEffect} from './blur.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const NONE = Gio.DBusCallFlags.NONE;
const CENTER = Clutter.ActorAlign.CENTER;
const PROPS = 'org.freedesktop.DBus.Properties';

const DEFAULT_W = 340; // default inner width of the control centre (prefs can change it)
const ART = 36;        // album-art size
const SW_W = 46;       // on/off switch track size
const SW_H = 26;
const SW_KNOB = 22;
const SW_PAD = 2;      // gap between knob and track edge
const GAP = 10;        // spacing between tiles
const TILE_H = 60;     // height of a standard tile / round button

// ───────────────────────── helpers ─────────────────────────
function box(props = {}, vertical = false) {
    return new St.BoxLayout({
        ...props,
        orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
    });
}

async function getProp(bus, name, path, iface, prop) {
    try {
        const r = await bus.call(name, path, PROPS, 'Get',
            new GLib.Variant('(ss)', [iface, prop]),
            new GLib.VariantType('(v)'), NONE, 1000, null);
        return r.recursiveUnpack()[0];
    } catch (e) {
        return null;
    }
}

async function getAll(bus, name, path, iface) {
    try {
        const r = await bus.call(name, path, PROPS, 'GetAll',
            new GLib.Variant('(s)', [iface]),
            new GLib.VariantType('(a{sv})'), NONE, 1000, null);
        return r.recursiveUnpack()[0];
    } catch (e) {
        return null;
    }
}

async function setProp(bus, name, path, iface, prop, sig, value) {
    try {
        await bus.call(name, path, PROPS, 'Set',
            new GLib.Variant('(ssv)', [iface, prop, new GLib.Variant(sig, value)]),
            null, NONE, 1000, null);
    } catch (e) {
        console.error(`[macOS-CC] set ${prop} failed: ${e.message}`);
    }
}

function spawn(argv) {
    try {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    } catch (e) {
        console.error(`[macOS-CC] spawn ${argv[0]}: ${e.message}`);
    }
}


// ───────────────────────── look: glass variant + accent colour ─────────────────────────
// One shared instance (created in enable()). The glass variant follows the
// system dark/light toggle unless the prefs force one; the accent colour is
// what "active" toggles are filled with.
let LOOK = null;

const GRAPHITE = [0.17, 0.17, 0.19];
const INK = [0.114, 0.114, 0.125];

function parseHex(str) {
    const m = /^#?([0-9a-f]{6})$/i.exec((str ?? '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function rgba(c, a = 1) {
    return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;
}

function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

class Look {
    constructor(settings) {
        this._settings = settings;
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._subs = new Map();
        this._next = 1;
        this.rev = 0;
        this.targets = new Set();     // live blur surfaces, see addBlur()
        this._ids = [
            [settings, settings.connect('changed::glass-style', () => this._update())],
            [settings, settings.connect('changed::accent-color', () => this._update())],
            [settings, settings.connect('changed::blur-strength', () => this._update())],
            [settings, settings.connect('changed::show-backdrop', () => this.syncBlur())],
            [this._iface, this._iface.connect('changed::color-scheme', () => this._update())],
        ];
        this._scaleCtx = St.ThemeContext.get_for_stage(global.stage);
        this._scaleId = this._scaleCtx.connect('notify::scale-factor', () => this.syncBlur());
        this._compute();
    }

    _compute() {
        const style = this._settings.get_string('glass-style');
        const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
        this.light = style === 'light' || (style === 'auto' && !dark);
        this.accent = parseHex(this._settings.get_string('accent-color')) ?? (this.light ? GRAPHITE : [1, 1, 1]);
        const lum = 0.2126 * this.accent[0] + 0.7152 * this.accent[1] + 0.0722 * this.accent[2];
        this.accentFg = lum > 0.6 ? INK : [1, 1, 1];
        this.blur = this._settings.get_int('blur-strength');
    }

    _update() {
        this._compute();
        this.rev++;
        for (const fn of [...this._subs.values()]) fn();
        this.syncBlur();
    }

    subscribe(fn) {
        const id = this._next++;
        this._subs.set(id, fn);
        return id;
    }

    unsubscribe(id) { this._subs.delete(id); }

    // ── live blur ────────────────────────────────────────────────────────
    // Every glass surface registers here, so one pref change (or a monitor
    // scale change) reaches all of them at once. Backend: see blur.js.
    // GROUP decides when a surface is blurred:
    //   'glass'    a surface floating in the Control Center popup — the panel
    //              backdrop blurs the wallpaper for all of them, so they stay
    //              unblurred while the backdrop is shown
    //   'backdrop' the panel backdrop itself — only while it is shown
    //   'always'   a self-contained surface in another popup (battery card)
    addBlur(actor, corner = 0, group = 'glass') {
        const effect = makeBlurEffect(this.blur, corner, this._scaleCtx.scale_factor);
        if (!effect)
            return null;
        actor.add_effect(effect);
        const target = {effect, corner, group};
        this.targets.add(target);
        this._syncTarget(target);
        actor.connect('destroy', () => this.targets.delete(target));
        return effect;
    }

    _syncTarget(t) {
        const backdrop = this._settings.get_boolean('show-backdrop');
        const on = this.blur > 0 &&
            (t.group === 'always' || (t.group === 'backdrop' ? backdrop : !backdrop));
        t.effect.enabled = on;
        if (!on)
            return;
        const scale = this._scaleCtx.scale_factor;
        t.effect.radius = Math.max(0, Math.round(this.blur * scale));
        if (t.corner > 0 && t.effect.corner_radius !== undefined)
            t.effect.corner_radius = t.corner * scale;
    }

    syncBlur() {
        if (!this.targets) return;
        for (const t of [...this.targets]) this._syncTarget(t);
    }

    destroy() {
        for (const [obj, id] of this._ids) obj.disconnect(id);
        this._ids = [];
        if (this._scaleId) this._scaleCtx.disconnect(this._scaleId);
        this._scaleId = 0;
        this._scaleCtx = null;
        this.targets.clear();
        this.targets = null;
        this._subs.clear();
        this._iface = null;
        this._settings = null;
    }
}

function activeCss() {
    return `background-color: ${rgba(LOOK.accent, 0.95)}; color: ${rgba(LOOK.accentFg)};`;
}

// Round buttons: "active" is an accent fill (inline so the accent can change live).
function setRoundActive(btn, on) {
    const key = `${on}:${LOOK.rev}`;
    if (btn._ccKey === key) return;
    btn._ccKey = key;
    if (on) {
        btn.add_style_class_name('active');
        btn.set_style(`background-gradient-direction: none; ${activeCss()}`);
    } else {
        btn.remove_style_class_name('active');
        btn.set_style(null);
    }
}

// ───────────────────────── battery glyph ─────────────────────────
// Glossy battery with the percentage inside: green from 50 %, yellow from 20 %, red below.
const BATT_PAL = {
    green:  {rim: [[0.30, 0.86, 0.42], [0.10, 0.66, 0.24]], fill: [[0.40, 0.93, 0.50], [0.12, 0.72, 0.28]]},
    yellow: {rim: [[0.98, 0.82, 0.28], [0.88, 0.62, 0.05]], fill: [[1.00, 0.90, 0.42], [0.95, 0.70, 0.08]]},
    red:    {rim: [[0.98, 0.42, 0.36], [0.82, 0.14, 0.12]], fill: [[1.00, 0.52, 0.46], [0.88, 0.17, 0.14]]},
};

function battLevel(pct) {
    return pct >= 50 ? 'green' : (pct >= 20 ? 'yellow' : 'red');
}

function rrect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function vGrad(y0, y1, top, bot, a = 1) {
    const g = new Cairo.LinearGradient(0, y0, 0, y1);
    g.addColorStopRGBA(0, top[0], top[1], top[2], a);
    g.addColorStopRGBA(1, bot[0], bot[1], bot[2], a);
    return g;
}

function paintBattery(cr, w, h, pct, charging) {
    const pal = BATT_PAL[battLevel(pct)];
    const bw = w;
    const rr = h * 0.34;
    const ins = h * 0.15;

    // rim
    rrect(cr, 0, 0, bw, h, rr);
    cr.setSource(vGrad(0, h, pal.rim[0], pal.rim[1]));
    cr.fill();

    // pale track
    const tx = ins, ty = ins, tw = bw - ins * 2, th = h - ins * 2;
    rrect(cr, tx, ty, tw, th, rr - ins * 0.6);
    cr.setSourceRGBA(1, 1, 1, 0.55);
    cr.fill();

    // charge fill
    const frac = Math.max(0.08, Math.min(1, pct / 100));
    rrect(cr, tx, ty, tw * frac, th, rr - ins * 0.6);
    cr.setSource(vGrad(ty, ty + th, pal.fill[0], pal.fill[1]));
    cr.fill();

    // gloss on the upper half of the whole body
    cr.save();
    rrect(cr, 0, 0, bw, h, rr);
    cr.clip();
    const gl = new Cairo.LinearGradient(0, 0, 0, h * 0.55);
    gl.addColorStopRGBA(0, 1, 1, 1, 0.50);
    gl.addColorStopRGBA(1, 1, 1, 1, 0.0);
    cr.setSource(gl);
    cr.rectangle(0, 0, bw, h * 0.55);
    cr.fill();
    cr.restore();

    // thin outline
    rrect(cr, 0.5, 0.5, bw - 1, h - 1, rr);
    cr.setSourceRGBA(1, 1, 1, 0.28);
    cr.setLineWidth(1);
    cr.stroke();

    // percentage (+ bolt while charging)
    // 3-digit labels ("100%") get a slightly smaller font so they fit the track
    const fs = Math.max(7, h * (pct >= 100 ? 0.46 : 0.54));
    cr.selectFontFace('sans-serif', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
    cr.setFontSize(fs);
    const label = `${Math.round(pct)}%`;
    const ext = cr.textExtents(label);
    const boltW = charging ? h * 0.30 : 0;
    const gap = charging ? h * 0.08 : 0;
    const total = boltW + gap + ext.width;
    const x0 = (bw - total) / 2;
    cr.setSourceRGBA(0.05, 0.16, 0.08, 0.95);
    if (charging) {
        const bx = x0, by = (h - h * 0.62) / 2, bwid = boltW, bh = h * 0.62;
        const pts = [[0.62, 0], [0, 0.56], [0.46, 0.56], [0.30, 1], [1, 0.40], [0.52, 0.40]];
        cr.newPath();
        pts.forEach(([px, py], i) => {
            if (i === 0) cr.moveTo(bx + px * bwid, by + py * bh);
            else cr.lineTo(bx + px * bwid, by + py * bh);
        });
        cr.closePath();
        cr.fill();
    }
    cr.moveTo(x0 + boltW + gap - ext.xBearing, h / 2 - ext.height / 2 - ext.yBearing);
    cr.showText(label);
}

// ───────────────────────── BlueZ pairing agent ─────────────────────────
// BlueZ refuses to complete pairing unless an org.bluez.Agent1 is registered.
// We register one only while the Bluetooth detail view is open (i.e. while the
// user is actively pairing), and auto-confirm ONLY the device the user started
// pairing on from this panel; any unsolicited request is rejected.
const AGENT_PATH = '/org/gnome/shell/extensions/macos-control-center/agent';
const AGENT_XML = `<node>
  <interface name="org.bluez.Agent1">
    <method name="Release"/>
    <method name="RequestPinCode">
      <arg type="o" direction="in" name="device"/>
      <arg type="s" direction="out" name="pincode"/>
    </method>
    <method name="DisplayPinCode">
      <arg type="o" direction="in" name="device"/>
      <arg type="s" direction="in" name="pincode"/>
    </method>
    <method name="RequestPasskey">
      <arg type="o" direction="in" name="device"/>
      <arg type="u" direction="out" name="passkey"/>
    </method>
    <method name="DisplayPasskey">
      <arg type="o" direction="in" name="device"/>
      <arg type="u" direction="in" name="passkey"/>
      <arg type="u" direction="in" name="entered"/>
    </method>
    <method name="RequestConfirmation">
      <arg type="o" direction="in" name="device"/>
      <arg type="u" direction="in" name="passkey"/>
    </method>
    <method name="RequestAuthorization">
      <arg type="o" direction="in" name="device"/>
    </method>
    <method name="AuthorizeService">
      <arg type="o" direction="in" name="device"/>
      <arg type="s" direction="in" name="uuid"/>
    </method>
    <method name="Cancel"/>
  </interface>
</node>`;

function btReject(what) {
    // Any error is treated by BlueZ as "user declined".
    throw new GLib.Error(Gio.DBusError.quark(), Gio.DBusError.FAILED, `${what} rejected`);
}

function pillPath(cr, x, y, w, h) {
    const r = Math.min(h / 2, w / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// A shell Slider (so dragging / scrolling / keyboard all keep working)
// that paints itself as a macOS-style glass pill.
const GlassSlider = GObject.registerClass(
class GlassSlider extends Slider {
    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const node = this.get_theme_node();
        const r = Math.max(8, node.get_length('-slider-handle-radius'));
        const trackH = Math.min(h, r * 2);
        const y0 = (h - trackH) / 2;
        const v = Math.max(0, Math.min(1, this.value));
        const knobX = r + v * Math.max(0, w - 2 * r);

        const light = LOOK?.light;

        // track
        pillPath(cr, 0, y0, w, trackH);
        cr.setSourceRGBA(0, 0, 0, light ? 0.14 : 0.32);
        cr.fillPreserve();
        if (light) cr.setSourceRGBA(0, 0, 0, 0.12);
        else cr.setSourceRGBA(1, 1, 1, 0.18);
        cr.setLineWidth(1);
        cr.stroke();

        // fill
        pillPath(cr, 0, y0, knobX + r, trackH);
        if (light) cr.setSourceRGBA(GRAPHITE[0], GRAPHITE[1], GRAPHITE[2], 0.9);
        else cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.fill();

        cr.$dispose();
    }
});

// Thin seek bar for the Now Playing tile (same colours as the other sliders).
const SeekBar = GObject.registerClass(
class SeekBar extends Slider {
    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const node = this.get_theme_node();
        const r = Math.max(2, node.get_length('-slider-handle-radius'));
        const trackH = 4;
        const y0 = (h - trackH) / 2;
        const v = Math.max(0, Math.min(1, this.value));
        const knobX = r + v * Math.max(0, w - 2 * r);

        const light = LOOK?.light;
        pillPath(cr, 0, y0, w, trackH);
        cr.setSourceRGBA(0, 0, 0, light ? 0.16 : 0.35);
        cr.fill();

        pillPath(cr, 0, y0, knobX + r, trackH);
        if (light) cr.setSourceRGBA(GRAPHITE[0], GRAPHITE[1], GRAPHITE[2], 0.9);
        else cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.fill();

        cr.$dispose();
    }
});

// Press-down "squish" + springy release for any St.Button.
function tapFeedback(btn, scale = 0.95) {
    btn.set_pivot_point(0.5, 0.5);
    btn.connect('notify::pressed', () => {
        if (btn.pressed) {
            btn.ease({
                scale_x: scale, scale_y: scale, duration: 90,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            btn.ease({
                scale_x: 1, scale_y: 1, duration: 280,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
    });
    btn.connect('destroy', () => btn.remove_all_transitions());
    return btn;
}

function makeSwitch(onToggle) {
    // Drawn with cairo so the knob is exactly SW_PAD from the track edge on
    // both sides (the old CSS version was off by the 1px border).
    const area = new St.DrawingArea();
    area.set_size(SW_W, SW_H);
    const btn = new St.Button({
        style_class: 'cc-switch', child: area,
        can_focus: true, track_hover: true, y_align: CENTER,
        x_expand: false, y_expand: false,
    });
    btn.set_size(SW_W, SW_H);

    let t = 0, target = 0, timer = 0;
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const e = t * t * (3 - 2 * t);               // smoothstep
        const light = LOOK?.light;
        const acc = LOOK?.accent ?? [1, 1, 1];
        const accFg = LOOK?.accentFg ?? INK;
        const off = light ? [0, 0, 0] : [1, 1, 1];

        pillPath(cr, 0.5, 0.5, w - 1, h - 1);
        const tc = mix(off, acc, e);
        cr.setSourceRGBA(tc[0], tc[1], tc[2], (light ? 0.18 : 0.30) + (0.92 - (light ? 0.18 : 0.30)) * e);
        cr.fillPreserve();
        if (light) cr.setSourceRGBA(0, 0, 0, 0.12);
        else cr.setSourceRGBA(1, 1, 1, 0.14 + 0.16 * e);
        cr.setLineWidth(1);
        cr.stroke();

        const r = SW_KNOB / 2;
        const cx = SW_PAD + r + e * (w - 2 * SW_PAD - 2 * r);
        const c = mix([1, 1, 1], accFg, e);          // white → contrast colour of the accent
        cr.newPath();
        cr.arc(cx, h / 2, r, 0, 2 * Math.PI);
        cr.setSourceRGBA(c[0], c[1], c[2], 1);
        cr.fill();
        cr.$dispose();
    });

    btn.repaint = () => area.queue_repaint();
    btn.connect('clicked', () => onToggle());
    btn.setState = (on, animate = true) => {
        target = on ? 1 : 0;
        if (timer) { GLib.source_remove(timer); timer = 0; }
        if (!animate || !btn.mapped) {
            t = target;
            area.queue_repaint();
            return;
        }
        const step = 16 / 150;
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (Math.abs(target - t) <= step) {
                t = target;
                timer = 0;
                area.queue_repaint();
                return GLib.SOURCE_REMOVE;
            }
            t += Math.sign(target - t) * step;
            area.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    };
    btn.connect('destroy', () => { if (timer) GLib.source_remove(timer); timer = 0; });
    return btn;
}

// ───────────────────── blur-my-shell compatibility ─────────────────────
// Blur my Shell blurs every `.popup-menu-content`, i.e. the box behind our
// whole panel, which reads as one big rectangle instead of separate tiles.
// It has no per-popup opt-out, so drop its effect (and any background class
// it adds) from our own menus — ours already blur per tile.
function stripForeignBlur(menu) {
    if (!menu)
        return;
    for (const actor of [menu.box, menu.actor]) {
        if (!actor)
            continue;
        for (const effect of actor.get_effects()) {
            if ((effect.constructor?.$gtype?.name ?? '').startsWith('Bms'))
                actor.remove_effect(effect);
        }
        const classes = actor.get_style_class_name?.();
        if (classes) {
            for (const cls of classes.split(' ').filter(c => c.startsWith('bms-')))
                actor.remove_style_class_name(cls);
        }
    }
}

// Blur my Shell attaches its effect from an idle handler, so check again after
// it has had a chance to run.
function defendMenuFromOtherBlurExtensions(menu) {
    stripForeignBlur(menu);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        stripForeignBlur(menu);
        return GLib.SOURCE_REMOVE;
    });
}

function listRow({icon, fallback = 'image-missing', title, sub = null, trailing = [], onClick}) {
    const btn = new St.Button({style_class: 'cc-row', can_focus: true, track_hover: true, x_expand: true});
    LOOK?.addBlur(btn, 20);
    const row = box({style_class: 'cc-row-inner', y_align: CENTER, x_expand: true});
    row.add_child(new St.Icon({icon_name: icon, fallback_icon_name: fallback, icon_size: 16, y_align: CENTER}));
    const text = box({y_align: CENTER, x_expand: true}, true);
    const t = new St.Label({text: title, style_class: 'cc-row-title'});
    t.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    text.add_child(t);
    if (sub) {
        const s = new St.Label({text: sub, style_class: 'cc-row-sub'});
        s.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(s);
    }
    row.add_child(text);
    for (const name of trailing)
        row.add_child(new St.Icon({icon_name: name, icon_size: 14, y_align: CENTER, style_class: 'cc-row-trail'}));
    btn.set_child(row);
    btn.connect('clicked', () => onClick?.());
    tapFeedback(btn, 0.98);
    return btn;
}

function sectionLabel(text) {
    return new St.Label({text, style_class: 'cc-section'});
}

function makeBubble(iconName, size = 18, clickable = false) {
    const icon = new St.Icon({
        icon_name: iconName, icon_size: size,
        x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true,
    });
    const bin = clickable
        ? new St.Button({
            style_class: 'cc-bubble', child: icon,
            can_focus: true, track_hover: true, y_align: CENTER,
        })
        : new St.Bin({style_class: 'cc-bubble', child: icon, y_align: CENTER});
    return {actor: bin, icon};
}

class Tile {
    constructor({icon, title, subtitle = '', onClick, onIcon = null, extraClass = ''}) {
        this.actor = new St.Button({
            style_class: `cc-tile ${extraClass}`,
            can_focus: true, track_hover: true, x_expand: true,
        });
        this.actor.set_height(TILE_H);
        LOOK?.addBlur(this.actor, 30);
        const row = box({style_class: 'cc-tile-row', y_align: CENTER, x_expand: true});
        this.bubble = makeBubble(icon, 18, !!onIcon);
        if (onIcon) {
            this.bubble.actor.connect('clicked', () => onIcon());
            tapFeedback(this.bubble.actor, 0.88);
        }
        const text = box({y_align: CENTER, x_expand: true}, true);
        this.title = new St.Label({text: title, style_class: 'cc-title'});
        this.sub = new St.Label({text: subtitle ?? '', style_class: 'cc-sub'});
        this.title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this.title);
        if (subtitle !== null)
            text.add_child(this.sub);
        row.add_child(this.bubble.actor);
        row.add_child(text);
        this.actor.set_child(row);
        this.actor.connect('clicked', () => onClick?.());
        tapFeedback(this.actor, 0.96);
    }

    setActive(on) {
        this._on = on;
        const key = `${on}:${LOOK.rev}`;
        if (this._key === key) return;
        this._key = key;
        if (on) this.actor.add_style_class_name('active');
        else this.actor.remove_style_class_name('active');
        this.bubble.actor.set_style(on ? activeCss() : null);
    }

    setSub(text) { this.sub.text = text; }
    setIcon(name) { this.bubble.icon.icon_name = name; }
}

function roundButton(iconSpec, onClick, fallback = 'image-missing') {
    const icon = new St.Icon({
        icon_size: 20, fallback_icon_name: fallback,
        x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true,
    });
    if (typeof iconSpec === 'string') icon.icon_name = iconSpec;
    else icon.gicon = iconSpec;
    const b = new St.Button({
        style_class: 'cc-round', child: icon,
        can_focus: true, track_hover: true,
        x_expand: true, x_align: CENTER, y_align: CENTER,
    });
    b.set_size(TILE_H, TILE_H);
    LOOK?.addBlur(b, 30);
    b.connect('clicked', () => onClick());
    tapFeedback(b, 0.92);
    return b;
}

function ctrlButton(iconName, onClick) {
    const icon = new St.Icon({icon_name: iconName, icon_size: 16});
    const b = new St.Button({style_class: 'cc-ctrl', child: icon, can_focus: true, track_hover: true});
    b.connect('clicked', () => onClick());
    tapFeedback(b, 0.85);
    b.iconActor = icon;
    return b;
}

// ───────────────────────── the Control Center ─────────────────────────
const ControlCenter = GObject.registerClass(
class ControlCenter extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'macOS Control Center', false);
        this._ext = ext;
        this._settings = ext.getSettings();
        this._width = this._settings.get_int('panel-width') || DEFAULT_W;
        this._actors = {};         // tile id → actor (all of them; only enabled ones are in the grid)
        this._parked = new Set();  // tiles that are switched off, see _layoutTiles()/_cleanup()
        this._lookId = 0;
        this._destroyed = false;
        this._timers = new Set();
        this._poll = 0;
        this._syncing = false;
        this._drag = {br: false, vol: false};
        this._btPowered = false;
        this._btAdapterPath = null; // cached BlueZ adapter path (hci0 is not guaranteed)
        this._agentId = 0;          // registered org.bluez.Agent1 object id
        this._pairingPath = null;   // device path we are currently pairing with
        this._airplane = false;
        this._playerName = null;
        this._brTimer = 0;
        this._brMode = null;       // 'shell' | 'gsd' | 'sysfs'
        this._backlight = null;
        this._view = 'main';        // 'main' | 'detail'
        this._detailKind = null;    // 'wifi' | 'bt'
        this._pwSsid = null;
        this._wifiSig = null;       // last rendered Wi-Fi list snapshot
        this._btSig = null;         // last rendered Bluetooth list snapshot
        this._tick = 0;
        this._busy = false;
        this._artUrl = null;
        this._session = null;
        this._btDiscovering = false;
        // now-playing / seek state
        this._trackLen = 0;        // microseconds
        this._trackId = null;
        this._posBase = 0;
        this._posAt = 0;
        this._rate = 1;
        this._playing = false;
        this._seekDrag = false;
        this._seekPoll = 0;
        this._seekTimer = 0;

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/control-center-symbolic.svg`),
            style_class: 'system-status-icon',
        }));

        this.menu.actor.add_style_class_name('cc-menu');
        LOOK?.addBlur(this.menu.actor, 38, 'backdrop');
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'cc-item',
        });
        item.add_child(this._buildUI());
        this.menu.addMenuItem(item);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) this._onOpen();
            else this._onClose();
        });
        this.connect('destroy', () => this._cleanup());

        this._settingsId = this._settings.connect('changed', (_s, key) => this._onSetting(key));
        this._applyPrefs();
        this._lookId = LOOK.subscribe(() => this._onLook());
        this._onLook();

        this._initBackends();
    }

    // ── layout (mirrors the macOS 26 control centre) ──
    // Every tile is built once; the enabled ones are flowed into a 4-column
    // grid in the order chosen in the prefs (see _layoutTiles).
    _buildUI() {
        const layout = new Clutter.GridLayout({
            column_spacing: GAP, row_spacing: GAP, column_homogeneous: true,
        });
        const grid = new St.Widget({style_class: 'cc-root', layout_manager: layout, x_expand: true});
        grid.set_width(this._width);
        this._main = grid;
        this._grid = grid;
        const A = this._actors;

        this._wifi = new Tile({
            icon: 'network-wireless-symbolic', title: 'Wi-Fi', subtitle: '…',
            onIcon: () => this._toggleWifi(),
            onClick: () => this._showDetail('wifi'),
        });
        this._bt = new Tile({
            icon: 'bluetooth-active-symbolic', title: 'Bluetooth', subtitle: '…',
            onIcon: () => this._toggleBluetooth(),
            onClick: () => this._showDetail('bt'),
        });
        this._air = new Tile({
            icon: 'airplane-mode-symbolic', title: 'Airplane Mode', subtitle: 'Off',
            onClick: () => this._toggleAirplane(),
        });
        this._focus = new Tile({
            icon: 'weather-clear-night-symbolic', title: 'Focus', subtitle: null,
            onClick: () => this._toggleDnd(), extraClass: 'cc-focus',
        });
        A['wifi'] = this._wifi.actor;
        A['bluetooth'] = this._bt.actor;
        A['airplane'] = this._air.actor;
        A['focus'] = this._focus.actor;
        A['nowplaying'] = this._buildNowPlaying();

        this._night = roundButton('night-light-symbolic', () => this._toggleNightLight());
        this._lock = roundButton('system-lock-screen-symbolic', () => {
            this.menu.close();
            Main.screenShield.lock(true);
        });
        this._dark = roundButton(
            Gio.icon_new_for_string(`${this._ext.path}/icons/dark-mode-symbolic.svg`),
            () => this._toggleDarkMode());
        this._power = roundButton('system-shutdown-symbolic', () => this._showDetail('power'));
        this._shot = roundButton('applets-screenshooter-symbolic',
            () => this._openScreenshotUI(false), 'camera-photo-symbolic');
        this._rec = roundButton('media-record-symbolic',
            () => this._openScreenshotUI(true), 'camera-video-symbolic');
        A['night-light'] = this._night;
        A['lock'] = this._lock;
        A['dark-mode'] = this._dark;
        A['power'] = this._power;
        A['screenshot'] = this._shot;
        A['screen-record'] = this._rec;

        // Sliders
        const display = this._buildSlider('Display', 'display-brightness-symbolic', 'display-brightness-symbolic');
        this._brSlider = display.slider;
        this._brBox = display.box;
        this._brSlider.connect('drag-begin', () => { this._drag.br = true; });
        this._brSlider.connect('drag-end', () => { this._drag.br = false; });
        this._brSlider.connect('notify::value', () => {
            if (!this._syncing) this._pushBrightness(this._brSlider.value);
        });
        A['display'] = display.box;

        const sound = this._buildSlider('Sound', 'audio-volume-low-symbolic', 'audio-volume-high-symbolic');
        this._volSlider = sound.slider;
        this._volBox = sound.box;
        this._volSlider.connect('drag-begin', () => { this._drag.vol = true; });
        this._volSlider.connect('drag-end', () => { this._drag.vol = false; });
        this._volSlider.connect('notify::value', () => {
            if (!this._syncing) this._pushVolume(this._volSlider.value);
        });
        A['sound'] = sound.box;

        // Settings pill
        const settings = new St.Button({
            style_class: 'cc-settings', label: 'Settings',
            x_align: CENTER, can_focus: true, track_hover: true,
        });
        LOOK?.addBlur(settings, 18);
        settings.connect('clicked', () => {
            this.menu.close();
            const app = Gio.DesktopAppInfo.new('org.gnome.Settings.desktop');
            if (app) app.launch([], null);
            else spawn(['gnome-control-center']);
        });
        tapFeedback(settings, 0.95);
        A['settings'] = settings;

        this._layoutTiles();

        // Stack: main view + (hidden) detail view that slides in over it
        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._detail = this._buildDetail();
        this._detail.hide();
        this._stack.add_child(grid);
        this._stack.add_child(this._detail);
        return this._stack;
    }

    // First-fit flow of the enabled tiles into the 4-column grid, in the
    // order from the prefs. Hidden tiles stay built but are taken out of the grid.
    _layoutTiles() {
        const layout = this._grid.layout_manager;
        for (const child of this._grid.get_children())
            this._grid.remove_child(child);

        const {enabled} = resolveTiles(
            this._settings.get_strv('tile-order'), this._settings.get_strv('tile-hidden'));
        const occ = [];
        const fits = (c, r, w, h) => {
            for (let y = r; y < r + h; y++)
                for (let x = c; x < c + w; x++)
                    if (occ[y]?.[x]) return false;
            return true;
        };
        for (const id of enabled) {
            const actor = this._actors[id];
            if (!actor) continue;
            const {w, h} = TILE_DEFS[id];
            let placed = false;
            for (let r = 0; !placed; r++) {
                for (let c = 0; c + w <= 4 && !placed; c++) {
                    if (!fits(c, r, w, h)) continue;
                    for (let y = r; y < r + h; y++) {
                        occ[y] ??= [];
                        for (let x = c; x < c + w; x++) occ[y][x] = true;
                    }
                    layout.attach(actor, c, r, w, h);
                    placed = true;
                }
            }
        }
        // everything the grid did not take is switched off and now parentless:
        // remember it, so _cleanup() does not have to poke actors the widget
        // tree may already have disposed
        this._parked = new Set();
        for (const actor of Object.values(this._actors)) {
            if (!actor.get_parent())
                this._parked.add(actor);
        }
        this._grid.queue_relayout();
    }

    _buildSlider(label, loIcon, hiIcon) {
        const b = box({style_class: 'cc-slider-box', x_expand: true}, true);
        LOOK?.addBlur(b, 28);
        b.add_child(new St.Label({text: label, style_class: 'cc-slider-label'}));
        const row = box({style_class: 'cc-slider-row', x_expand: true});
        row.add_child(new St.Icon({icon_name: loIcon, icon_size: 12, y_align: CENTER, style_class: 'cc-slider-icon'}));
        const slider = new GlassSlider(0);
        slider.add_style_class_name('cc-slider');
        slider.x_expand = true;
        slider.y_align = CENTER;
        row.add_child(slider);
        row.add_child(new St.Icon({icon_name: hiIcon, icon_size: 17, y_align: CENTER, style_class: 'cc-slider-icon'}));
        b.add_child(row);
        return {box: b, slider};
    }

    _buildNowPlaying() {
        const b = box({style_class: 'cc-tile cc-np', x_expand: true, y_expand: true}, true);
        LOOK?.addBlur(b, 30);

        // reference layout: art top-left, title/artist under it, controls at the bottom
        this._artIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic', icon_size: 20,
            x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true,
        });
        this._art = new St.Widget({
            style_class: 'cc-art',
            layout_manager: new Clutter.BinLayout(),
            x_expand: false, y_expand: false,
            x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START,
        });
        this._art.set_size(ART, ART);
        this._art.add_child(this._artIcon);
        b.add_child(this._art);

        const text = box({style_class: 'cc-np-text', x_expand: true, x_align: Clutter.ActorAlign.FILL}, true);
        this._npTitle = new St.Label({text: 'Not Playing', style_class: 'cc-title'});
        this._npArtist = new St.Label({text: '', style_class: 'cc-sub'});
        this._npTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._npArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._npTitle);
        text.add_child(this._npArtist);
        b.add_child(text);

        const controls = box({
            style_class: 'cc-np-controls', x_align: CENTER, x_expand: true,
            y_expand: true, y_align: Clutter.ActorAlign.END,
        });
        this._prev = ctrlButton('media-skip-backward-symbolic', () => this._mpris('Previous'));
        this._play = ctrlButton('media-playback-start-symbolic', () => this._mpris('PlayPause'));
        this._next = ctrlButton('media-skip-forward-symbolic', () => this._mpris('Next'));
        controls.add_child(this._prev);
        controls.add_child(this._play);
        controls.add_child(this._next);
        b.add_child(controls);

        // seek bar under the controls
        this._seek = new SeekBar(0);
        this._seek.add_style_class_name('cc-seek');
        this._seek.x_expand = true;
        this._seek.y_align = CENTER;
        this._seek.reactive = false;
        this._seek.opacity = 90;
        this._seek.connect('drag-begin', () => { this._seekDrag = true; });
        this._seek.connect('drag-end', () => {
            this._seekDrag = false;
            this._seekTo(this._seek.value);
        });
        // keyboard / scroll changes (not drags)
        this._seek.connect('notify::value', () => {
            if (this._syncing || this._seekDrag) return;
            if (this._seekTimer) GLib.source_remove(this._seekTimer);
            this._seekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._seekTimer = 0;
                this._seekTo(this._seek.value);
                return GLib.SOURCE_REMOVE;
            });
        });
        // seek bar is built but intentionally not shown for now (add back with b.add_child(this._seek))
        this._seek.hide();
        return b;
    }

    // ── album art ──
    _updateArt(url) {
        if (url === this._artUrl) return;
        this._artUrl = url;
        if (!url) {
            this._setArt(null);
            return;
        }
        if (url.startsWith('file://')) {
            this._setArt(Gio.File.new_for_uri(url).get_path());
            return;
        }
        if (!/^https?:\/\//.test(url)) {
            this._setArt(null);
            return;
        }
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'macos-control-center']);
        GLib.mkdir_with_parents(dir, 0o755);
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
        const path = GLib.build_filenamev([dir, `${hash}.jpg`]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this._setArt(path);
            return;
        }
        this._downloadArt(url, path);
    }

    async _downloadArt(url, path) {
        try {
            this._session ??= new Soup.Session({timeout: 10});
            const msg = Soup.Message.new('GET', url);
            if (!msg) return;
            const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
            if (msg.get_status() !== Soup.Status.OK) return;
            GLib.file_set_contents(path, bytes.get_data());
            if (this._destroyed || this._artUrl !== url) return;
            this._setArt(path);
        } catch (e) {
            console.error(`[macOS-CC] album art: ${e.message}`);
        }
    }

    _setArt(path) {
        if (!path) {
            this._art.set_style(null);
            this._artIcon.show();
            return;
        }
        this._art.set_style(`background-image: url("${path}"); background-size: cover;`);
        this._artIcon.hide();
    }

    // ── detail view (Wi-Fi / Bluetooth) ──
    _buildDetail() {
        const d = box({style_class: 'cc-detail', x_expand: true, y_expand: true}, true);
        d.set_width(this._width);

        const head = box({style_class: 'cc-detail-head', y_align: CENTER, x_expand: true});
        const back = new St.Button({
            style_class: 'cc-back', can_focus: true, track_hover: true, y_align: CENTER,
            child: new St.Icon({icon_name: 'go-previous-symbolic', icon_size: 16}),
        });
        back.connect('clicked', () => this._hideDetail());
        tapFeedback(back, 0.9);
        this._detailTitle = new St.Label({text: '', style_class: 'cc-detail-title', y_align: CENTER, x_expand: true});
        this._detailSwitch = makeSwitch(() => {
            if (this._detailKind === 'wifi') this._toggleWifi();
            else this._toggleBluetooth();
            this._later(900, () => this._renderDetail());
        });
        head.add_child(back);
        head.add_child(this._detailTitle);
        head.add_child(this._detailSwitch);
        d.add_child(head);

        const scroll = new St.ScrollView({
            style_class: 'cc-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._list = box({style_class: 'cc-list', x_expand: true}, true);
        scroll.add_child(this._list);
        d.add_child(scroll);

        this._status = new St.Label({text: '', style_class: 'cc-status', x_align: CENTER});
        this._status.hide();
        d.add_child(this._status);

        this._detailSettings = new St.Button({
            style_class: 'cc-settings', label: 'Settings', x_align: CENTER,
            can_focus: true, track_hover: true,
        });
        this._detailSettings.connect('clicked', () => {
            this.menu.close();
            spawn(['gnome-control-center', this._detailKind === 'wifi' ? 'wifi' : 'bluetooth']);
        });
        tapFeedback(this._detailSettings, 0.95);
        d.add_child(this._detailSettings);
        return d;
    }

    _setStatus(text) {
        this._status.text = text ?? '';
        if (text) this._status.show();
        else this._status.hide();
    }

    _showDetail(kind) {
        if (this._busy || this._view === 'detail') return;
        this._busy = true;
        this._view = 'detail';
        this._detailKind = kind;
        this._pwSsid = null;
        this._wifiSig = this._btSig = null;   // force a fresh rebuild
        this._setStatus('');
        this._detailTitle.text = {wifi: 'Wi-Fi', bt: 'Bluetooth', power: 'Power'}[kind];
        this._detailSettings.label = kind === 'wifi' ? 'Wi-Fi Settings…' : 'Bluetooth Settings…';
        this._detailSwitch.visible = kind !== 'power';
        this._detailSettings.visible = kind !== 'power';
        this._powerDrawn = false;

        this._detail.set_height(this._main.height);
        this._renderDetail();
        if (kind === 'wifi') this._scanWifi();
        else if (kind === 'bt') this._startDiscovery();

        this._detail.opacity = 0;
        this._detail.translation_x = 36;
        this._detail.show();
        this._detail.ease({
            opacity: 255, translation_x: 0, duration: 260,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => { this._busy = false; },
        });
        this._main.ease({
            opacity: 0, translation_x: -36, duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { if (this._view === 'detail') this._main.hide(); },
        });
    }

    _hideDetail() {
        if (this._busy || this._view !== 'detail') return;
        this._busy = true;
        this._view = 'main';
        this._pwSsid = null;
        this._stopDiscovery();
        this._syncWifi();
        this._syncBt();

        this._main.show();
        this._main.opacity = 0;
        this._main.translation_x = -36;
        this._main.ease({
            opacity: 255, translation_x: 0, duration: 260,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => { this._busy = false; },
        });
        this._detail.ease({
            opacity: 0, translation_x: 36, duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { if (this._view === 'main') this._detail.hide(); },
        });
    }

    _resetView() {
        this._stopDiscovery();
        this._view = 'main';
        this._busy = false;
        this._pwSsid = null;
        this._main.remove_all_transitions();
        this._detail.remove_all_transitions();
        this._main.show();
        this._main.opacity = 255;
        this._main.translation_x = 0;
        this._detail.hide();
    }

    _renderDetail() {
        if (this._destroyed || this._view !== 'detail') return;
        if (this._detailKind === 'wifi') this._renderWifi();
        else if (this._detailKind === 'bt') this._renderBt();
        else this._renderPower();
    }

    // ── Power page: sleep / log out / restart / power off ──
    _renderPower() {
        if (this._powerDrawn) return;
        this._powerDrawn = true;
        this._list.destroy_all_children();
        this._list.add_child(sectionLabel('Session'));
        const rows = [
            ['system-suspend-symbolic', 'weather-clear-night-symbolic', 'Sleep',
                () => this._suspend()],
            ['system-log-out-symbolic', 'system-log-out-symbolic', 'Log Out',
                () => spawn(['gnome-session-quit', '--logout'])],
            ['system-reboot-symbolic', 'view-refresh-symbolic', 'Restart',
                () => spawn(['gnome-session-quit', '--reboot'])],
            ['system-shutdown-symbolic', 'system-shutdown-symbolic', 'Power Off',
                () => spawn(['gnome-session-quit', '--power-off'])],
        ];
        for (const [icon, fallback, title, action] of rows) {
            this._list.add_child(listRow({
                icon, fallback, title,
                onClick: () => {
                    this.menu.close();
                    action();
                },
            }));
        }
    }

    _suspend() {
        Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', 'Suspend', new GLib.Variant('(b)', [true]),
            null, NONE, 2000, null).catch(e => console.error(`[macOS-CC] suspend: ${e.message}`));
    }

    _emptyNote(text) {
        this._list.add_child(new St.Label({text, style_class: 'cc-empty', x_align: CENTER}));
    }

    // ── Wi-Fi detail ──
    _wifiDevice() {
        return this._nm?.get_devices().find(d => d instanceof NM.DeviceWifi) ?? null;
    }

    _wifiIcon(strength) {
        if (strength >= 80) return 'network-wireless-signal-excellent-symbolic';
        if (strength >= 55) return 'network-wireless-signal-good-symbolic';
        if (strength >= 30) return 'network-wireless-signal-ok-symbolic';
        return 'network-wireless-signal-weak-symbolic';
    }

    _scanWifi() {
        const dev = this._wifiDevice();
        if (!dev || !this._nm.wireless_enabled) return;
        dev.request_scan_async(null, (d, res) => {
            try { d.request_scan_finish(res); } catch (e) { /* scan throttled */ }
        });
    }

    _listAps(dev) {
        const best = new Map();
        for (const ap of dev.get_access_points()) {
            const raw = ap.get_ssid();
            if (!raw) continue;
            const ssid = NM.utils_ssid_to_utf8(raw.get_data());
            if (!ssid) continue;
            const cur = best.get(ssid);
            if (!cur || ap.get_strength() > cur.get_strength()) best.set(ssid, ap);
        }
        const act = dev.get_active_access_point();
        const actRaw = act?.get_ssid();
        const activeSsid = actRaw ? NM.utils_ssid_to_utf8(actRaw.get_data()) : null;
        return [...best.entries()].map(([ssid, ap]) => ({
            ssid, ap,
            strength: ap.get_strength(),
            // NM_802_11_AP_FLAGS_PRIVACY = 0x1
            secured: (ap.get_flags() & 1) !== 0 || ap.get_wpa_flags() !== 0 || ap.get_rsn_flags() !== 0,
            active: ssid === activeSsid,
        })).sort((a, b) => (Number(b.active) - Number(a.active)) || (b.strength - a.strength)).slice(0, 12);
    }

    _renderWifi() {
        if (this._pwSsid) return;   // don't rebuild while the user is typing a password
        const nm = this._nm;
        const dev = this._wifiDevice();
        this._detailSwitch.setState(!!nm?.wireless_enabled, false);

        // The panel refreshes periodically; only rebuild the list when the
        // visible data actually changed, otherwise rows are destroyed under
        // the user's cursor (breaking hover and mid-click).
        let sig = null;
        let build = null;
        if (!nm || !dev) {
            sig = 'no-adapter';
            build = () => this._emptyNote('No Wi-Fi adapter found');
        } else if (!nm.wireless_enabled) {
            sig = 'off';
            build = () => this._emptyNote('Wi-Fi is off');
        } else {
            const aps = this._listAps(dev);
            if (!aps.length) {
                sig = 'searching';
                build = () => this._emptyNote('Searching for networks…');
            } else {
                sig = JSON.stringify(aps.map(a => [a.ssid, this._wifiIcon(a.strength), a.secured, a.active]));
                build = () => {
                    this._list.add_child(sectionLabel('Networks'));
                    for (const entry of aps) {
                        const trailing = [];
                        if (entry.secured) trailing.push('network-wireless-encrypted-symbolic');
                        if (entry.active) trailing.push('object-select-symbolic');
                        this._list.add_child(listRow({
                            icon: this._wifiIcon(entry.strength),
                            fallback: 'network-wireless-symbolic',
                            title: entry.ssid,
                            sub: entry.active ? 'Connected' : null,
                            trailing,
                            onClick: () => this._onWifiClicked(entry),
                        }));
                    }
                };
            }
        }
        if (sig === this._wifiSig) return;
        this._wifiSig = sig;
        this._list.destroy_all_children();
        build();
    }

    _hasSavedConnection(ssid) {
        return this._savedConnection(ssid) !== null;
    }

    _savedConnection(ssid) {
        const conns = this._nm?.get_connections() ?? [];
        return conns.find(c => {
            const w = c.get_setting_wireless?.();
            const s = w?.get_ssid();
            return s && NM.utils_ssid_to_utf8(s.get_data()) === ssid;
        }) ?? null;
    }

    _onWifiClicked(entry) {
        if (entry.active) return;
        // NM_802_11_AP_SEC_KEY_MGMT_802_1X = 0x200 → enterprise network, hand over to Settings
        if ((entry.ap.get_rsn_flags() | entry.ap.get_wpa_flags()) & 0x200) {
            this.menu.close();
            spawn(['gnome-control-center', 'wifi']);
            return;
        }
        if (entry.secured && !this._hasSavedConnection(entry.ssid)) {
            this._pwSsid = entry.ssid;
            this._renderWifiPassword(entry);
            return;
        }
        this._connectWifi(entry, null);
    }

    _renderWifiPassword(entry) {
        this._wifiSig = null;   // cancel must rebuild the network list
        this._list.destroy_all_children();
        this._list.add_child(sectionLabel('Join network'));
        const card = box({style_class: 'cc-row cc-pw-card'}, true);
        LOOK?.addBlur(card, 20);
        const top = box({style_class: 'cc-row-inner', y_align: CENTER});
        top.add_child(new St.Icon({icon_name: this._wifiIcon(entry.strength), icon_size: 16, y_align: CENTER}));
        top.add_child(new St.Label({text: entry.ssid, style_class: 'cc-row-title', y_align: CENTER, x_expand: true}));
        card.add_child(top);

        const pw = new St.PasswordEntry({style_class: 'cc-pw-entry', hint_text: 'Password', x_expand: true, can_focus: true});
        card.add_child(pw);

        const line = box({style_class: 'cc-gap', x_align: Clutter.ActorAlign.END});
        const cancel = new St.Button({style_class: 'cc-join cc-cancel', label: 'Cancel', can_focus: true, track_hover: true});
        const join = new St.Button({style_class: 'cc-join', label: 'Join', can_focus: true, track_hover: true});
        const doJoin = () => {
            const text = pw.get_text();
            const l = text.length;
            // WPA/WPA2/WPA3 passphrase (8–63), raw 64-char hex PSK, or WEP keys.
            const okLen = l === 5 || l === 10 || l === 13 || l === 26 || l === 64 ||
                (l >= 8 && l <= 63);
            if (!okLen) {
                this._setStatus('Passwords are 8–63 characters (5/13 for WEP, or 64 hex)');
                return;
            }
            this._pwSsid = null;
            this._connectWifi(entry, text);
        };
        cancel.connect('clicked', () => { this._pwSsid = null; this._setStatus(''); this._renderDetail(); });
        join.connect('clicked', doJoin);
        pw.clutter_text.connect('activate', doJoin);
        line.add_child(cancel);
        line.add_child(join);
        card.add_child(line);
        this._list.add_child(card);
        this._later(80, () => pw.grab_key_focus());
    }

    _connectWifi(entry, password) {
        const nm = this._nm;
        const dev = this._wifiDevice();
        if (!nm || !dev) return;
        this._setStatus(`Connecting to ${entry.ssid}…`);
        const finish = err => {
            if (this._destroyed) return;
            this._setStatus(err ? `Couldn’t connect to ${entry.ssid}` : '');
            if (err) console.error(`[macOS-CC] wifi: ${err.message}`);
            this._later(1200, () => { this._syncWifi(); this._renderDetail(); });
            this._renderDetail();
        };
        const saved = this._savedConnection(entry.ssid);
        if (saved) {
            nm.activate_connection_async(saved, dev, entry.ap.get_path(), null, (c, res) => {
                try { c.activate_connection_finish(res); finish(null); } catch (e) { finish(e); }
            });
            return;
        }
        try {
            const conn = NM.SimpleConnection.new();
            conn.add_setting(new NM.SettingConnection({
                uuid: NM.utils_uuid_generate(), id: entry.ssid, type: '802-11-wireless',
            }));
            conn.add_setting(new NM.SettingWireless({
                ssid: new GLib.Bytes(new TextEncoder().encode(entry.ssid)),
                mode: 'infrastructure',
            }));
            if (entry.secured) {
                // NM_802_11_AP_SEC_KEY_MGMT_PSK = 0x100, _SAE = 0x400;
                // neither flag → legacy WEP network.
                const flags = entry.ap.get_rsn_flags() | entry.ap.get_wpa_flags();
                if (flags & 0x100) {
                    conn.add_setting(new NM.SettingWirelessSecurity({key_mgmt: 'wpa-psk', psk: password}));
                } else if (flags & 0x400) {
                    conn.add_setting(new NM.SettingWirelessSecurity({key_mgmt: 'sae', psk: password}));
                } else {
                    conn.add_setting(new NM.SettingWirelessSecurity({
                        key_mgmt: 'none', wep_key0: password,
                        wep_key_type: NM.WepKeyType?.PASSPHRASE ?? 2,
                    }));
                }
            }
            nm.add_and_activate_connection_async(conn, dev, entry.ap.get_path(), null, (c, res) => {
                try { c.add_and_activate_connection_finish(res); finish(null); } catch (e) { finish(e); }
            });
        } catch (e) {
            finish(e);
        }
    }

    // ── Bluetooth detail ──
    async _fetchBtDevices() {
        try {
            const r = await Gio.DBus.system.call('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager',
                'GetManagedObjects', null, new GLib.VariantType('(a{oa{sa{sv}}})'), NONE, 2000, null);
            const objs = r.recursiveUnpack()[0];
            const out = [];
            for (const [path, ifaces] of Object.entries(objs)) {
                const d = ifaces['org.bluez.Device1'];
                if (!d) continue;
                out.push({
                    path,
                    name: d.Alias || d.Name || d.Address || 'Unknown',
                    paired: !!d.Paired,
                    connected: !!d.Connected,
                    icon: d.Icon || '',
                });
            }
            return out;
        } catch (e) {
            return [];
        }
    }

    _btIcon(icon) {
        const map = {
            'audio-headset': 'audio-headset-symbolic',
            'audio-headphones': 'audio-headphones-symbolic',
            'audio-card': 'audio-speakers-symbolic',
            'input-keyboard': 'input-keyboard-symbolic',
            'input-mouse': 'input-mouse-symbolic',
            'input-gaming': 'input-gaming-symbolic',
            'phone': 'phone-symbolic',
            'computer': 'computer-symbolic',
        };
        return map[icon] ?? 'bluetooth-active-symbolic';
    }

    async _renderBt() {
        const devices = await this._fetchBtDevices();
        if (this._destroyed || this._view !== 'detail' || this._detailKind !== 'bt') return;
        this._detailSwitch.setState(this._btPowered, false);
        if (!this._btPowered) {
            if (this._btSig === 'off') return;
            this._btSig = 'off';
            this._list.destroy_all_children();
            this._emptyNote('Bluetooth is off');
            return;
        }
        // self-heal: _showDetail may have run before _btPowered was synced
        if (!this._btDiscovering) this._startDiscovery();
        const looksLikeAddress = n => /^([0-9A-F]{2}[-:]){5}[0-9A-F]{2}$/i.test(n);
        const mine = devices.filter(d => d.paired)
            .sort((a, b) => (Number(b.connected) - Number(a.connected)) || a.name.localeCompare(b.name));
        const nearby = devices.filter(d => !d.paired && !looksLikeAddress(d.name))
            .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8);

        // Same snapshot trick as Wi-Fi: skip the rebuild when nothing changed.
        const sig = JSON.stringify([
            mine.map(d => [d.name, d.connected, d.icon]),
            nearby.map(d => [d.name, d.connected, d.icon]),
        ]);
        if (sig === this._btSig) return;
        this._btSig = sig;
        this._list.destroy_all_children();

        if (mine.length) {
            this._list.add_child(sectionLabel('My Devices'));
            for (const d of mine) this._list.add_child(this._btRow(d));
        }
        if (nearby.length) {
            this._list.add_child(sectionLabel('Nearby Devices'));
            for (const d of nearby) this._list.add_child(this._btRow(d));
        }
        if (!mine.length && !nearby.length)
            this._emptyNote('Searching for devices…');
    }

    _btRow(d) {
        return listRow({
            icon: this._btIcon(d.icon),
            fallback: 'bluetooth-active-symbolic',
            title: d.name,
            sub: d.connected ? 'Connected' : (d.paired ? null : 'Not paired'),
            trailing: d.connected ? ['object-select-symbolic'] : [],
            onClick: () => this._btAction(d),
        });
    }

    async _btAction(d) {
        const call = (method, timeout = 30000) => Gio.DBus.system.call('org.bluez', d.path,
            'org.bluez.Device1', method, null, null, NONE, timeout, null);
        try {
            if (d.connected) {
                this._setStatus(`Disconnecting ${d.name}…`);
                await call('Disconnect');
            } else {
                this._setStatus(`Connecting to ${d.name}…`);
                if (!d.paired) {
                    this._registerAgent();
                    this._pairingPath = d.path;
                    try {
                        await call('Pair', 60000);
                        // trusted devices skip service authorization later
                        await setProp(Gio.DBus.system, 'org.bluez', d.path,
                            'org.bluez.Device1', 'Trusted', 'b', true);
                    } finally {
                        this._pairingPath = null;
                    }
                }
                await call('Connect');
            }
            this._setStatus('');
        } catch (e) {
            console.error(`[macOS-CC] bluetooth: ${e.message}`);
            this._setStatus(`Couldn’t connect to ${d.name}`);
        }
        this._renderDetail();
    }

    // BlueZ adapter path: hci0 is not guaranteed (USB/dock adapters often
    // enumerate higher), so enumerate adapters instead of hard-coding.
    // Only successful lookups are cached; failures re-enumerate so a newly
    // plugged-in adapter is picked up.
    async _btAdapter() {
        if (this._btAdapterPath) return this._btAdapterPath;
        try {
            const r = await Gio.DBus.system.call('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager',
                'GetManagedObjects', null, new GLib.VariantType('(a{oa{sa{sv}}})'), NONE, 2000, null);
            const objs = r.recursiveUnpack()[0];
            const paths = Object.keys(objs).filter(p => objs[p]['org.bluez.Adapter1']);
            paths.sort((a, b) => a.localeCompare(b, undefined, {numeric: true})); // hci0 before hci10
            this._btAdapterPath = paths[0] ?? null;
        } catch (e) {
            this._btAdapterPath = null;
        }
        return this._btAdapterPath;
    }

    _registerAgent() {
        if (this._agentId) return;
        try {
            const info = Gio.DBusInterfaceInfo.new_for_xml(AGENT_XML);
            this._agentId = Gio.DBus.system.register_object(AGENT_PATH, info, {
                Release: () => {},
                Cancel: () => {},
                // We have no PIN entry UI; rejecting is the honest answer.
                RequestPinCode: () => btReject('PIN entry'),
                RequestPasskey: () => btReject('passkey entry'),
                DisplayPinCode: (_inv, _device, pin) =>
                    Main.notify('Bluetooth pairing', `PIN: ${pin}`),
                DisplayPasskey: (_inv, _device, passkey, _entered) =>
                    Main.notify('Bluetooth pairing', `Passkey: ${String(passkey).padStart(6, '0')}`),
                // Auto-confirm only the device the user started pairing on
                // from this panel; reject anything unsolicited.
                RequestConfirmation: (_inv, device) => {
                    if (device !== this._pairingPath) btReject('unrequested pairing');
                },
                RequestAuthorization: (_inv, device) => {
                    if (device !== this._pairingPath) btReject('unrequested pairing');
                },
                // While registered as default agent we must not break normal
                // connections of already-paired devices.
                AuthorizeService: () => {},
            });
        } catch (e) {
            console.error(`[macOS-CC] bt agent: ${e.message}`);
            this._agentId = 0;
        }
    }

    _unregisterAgent() {
        this._pairingPath = null;
        if (!this._agentId) return;
        try {
            Gio.DBus.system.unregister_object(this._agentId);
        } catch (e) { /* already gone */ }
        this._agentId = 0;
    }

    async _startDiscovery() {
        if (this._btDiscovering || !this._btPowered) return;
        this._btDiscovering = true;   // synchronous re-entry guard
        const path = await this._btAdapter();
        if (this._destroyed || !this._btPowered || !path ||
            this._view !== 'detail' || this._detailKind !== 'bt') {
            this._btDiscovering = false;
            return;
        }
        this._registerAgent();
        Gio.DBus.system.call('org.bluez', path, 'org.bluez.Adapter1',
            'StartDiscovery', null, null, NONE, 2000, null).catch(() => {});
    }

    _stopDiscovery() {
        this._unregisterAgent();
        if (!this._btDiscovering) return;
        this._btDiscovering = false;
        const path = this._btAdapterPath;
        if (!path) return;
        Gio.DBus.system.call('org.bluez', path, 'org.bluez.Adapter1',
            'StopDiscovery', null, null, NONE, 2000, null).catch(() => {});
    }

    // ── backends ──
    _initBackends() {
        // NetworkManager
        this._nm = null;
        NM.Client.new_async(null, (_o, res) => {
            try {
                const client = NM.Client.new_finish(res);
                if (this._destroyed) return;
                this._nm = client;
                this._nmId = client.connect('notify::wireless-enabled', () => this._syncWifi());
                this._syncWifi();
            } catch (e) {
                console.error(`[macOS-CC] NM: ${e.message}`);
            }
        });

        // Night Light + Do Not Disturb
        this._color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        this._notif = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._colorId = this._color.connect('changed::night-light-enabled', () => this._syncToggles());
        this._notifId = this._notif.connect('changed::show-banners', () => this._syncToggles());
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._ifaceId = this._iface.connect('changed::color-scheme', () => this._syncToggles());
        this._syncToggles();

        // Brightness: GNOME 49+ moved this into the shell itself
        this._brScale = Main.brightnessManager?.globalScale ?? null;
        this._brScaleId = 0;
        if (this._brScale) {
            this._brMode = 'shell';
            this._brScaleId = this._brScale.connect('notify::value', () => this._syncBrightness());
        }

        // Volume
        this._mixer = Volume.getMixerControl();
        this._sink = null;
        this._sinkVolId = 0;
        this._mixerId = this._mixer.connect('default-sink-changed', () => this._bindSink());
        this._bindSink();
    }

    _stopPoll() {
        if (this._poll) {
            GLib.source_remove(this._poll);
            this._poll = 0;
        }
        if (this._seekPoll) {
            GLib.source_remove(this._seekPoll);
            this._seekPoll = 0;
        }
    }

    _cleanup() {
        this._destroyed = true;
        this._stopDiscovery();
        this._session?.abort();
        this._session = null;
        this._seek?.destroy();
        this._seek = null;
        this._stopPoll();
        if (this._seekTimer) GLib.source_remove(this._seekTimer);
        this._seekTimer = 0;
        if (this._settings && this._settingsId) this._settings.disconnect(this._settingsId);
        if (this._lookId) LOOK?.unsubscribe(this._lookId);
        this._lookId = 0;
        // tiles that are switched off have no parent, so nothing else would free them
        for (const a of this._parked) {
            if (!a.get_parent()) a.destroy();
        }
        this._parked = new Set();
        this._actors = {};
        this._settings = null;
        for (const id of this._timers) GLib.source_remove(id);
        this._timers.clear();
        if (this._brTimer) GLib.source_remove(this._brTimer);
        if (this._nm && this._nmId) this._nm.disconnect(this._nmId);
        if (this._color) this._color.disconnect(this._colorId);
        if (this._notif) this._notif.disconnect(this._notifId);
        if (this._iface) this._iface.disconnect(this._ifaceId);
        this._iface = null;
        if (this._brScale && this._brScaleId) this._brScale.disconnect(this._brScaleId);
        if (this._mixer && this._mixerId) this._mixer.disconnect(this._mixerId);
        if (this._sink && this._sinkVolId) this._sink.disconnect(this._sinkVolId);
        this._nm = this._sink = this._mixer = this._color = this._notif = this._brScale = null;
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            if (!this._destroyed) fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    _setSlider(slider, v) {
        this._syncing = true;
        slider.value = Math.max(0, Math.min(1, v));
        this._syncing = false;
    }

    // ── preferences: width, backdrop, tiles, look ──
    _applyPrefs() {
        if (this._destroyed || !this._settings) return;
        const w = this._settings.get_int('panel-width') || DEFAULT_W;
        this._width = w;
        this._main?.set_width(w);
        this._detail?.set_width(w);

        if (this._settings.get_boolean('show-backdrop'))
            this.menu.actor.add_style_class_name('cc-backdrop');
        else
            this.menu.actor.remove_style_class_name('cc-backdrop');
    }

    _onSetting(key) {
        if (this._destroyed || !this._settings) return;
        if (key === 'tile-order' || key === 'tile-hidden') this._layoutTiles();
        else if (key === 'panel-width' || key === 'show-backdrop') this._applyPrefs();
    }

    // Glass variant (light/dark) and accent colour changed.
    _onLook() {
        if (this._destroyed) return;
        if (LOOK.light) this.menu.actor.add_style_class_name('cc-light');
        else this.menu.actor.remove_style_class_name('cc-light');
        for (const t of [this._wifi, this._bt, this._air, this._focus])
            t.setActive(!!t._on);
        this._syncToggles();
        for (const w of [this._brSlider, this._volSlider, this._seek])
            w?.queue_repaint();
        this._detailSwitch?.repaint();
    }

    // Close the panel first so it is not in the shot, then hand over to the
    // shell's own screenshot UI (screen recording is its other mode).
    _openScreenshotUI(cast) {
        this.menu.close();
        this._later(300, async () => {
            try {
                const modes = Screenshot.UIMode ?? {};
                const mode = cast ? (modes.SCREENCAST ?? 1) : (modes.SCREENSHOT ?? 0);
                await Main.screenshotUI.open(mode);
            } catch (e) {
                console.error(`[macOS-CC] screenshot UI: ${e.message}`);
            }
        });
    }

    // ── open / close / polling ──
    _onOpen() {
        defendMenuFromOtherBlurExtensions(this.menu);
        this._resetView();
        this._refresh();
        this._stopPoll();
        this._poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._seekPoll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._tickSeek();
            return GLib.SOURCE_CONTINUE;
        });
        this._animateOpen();
    }

    _onClose() {
        this._stopPoll();
        this._resetView();
        this._setStatus('');
        this._animateClose();
    }

    // Panel content grows out of the top-right corner while fading in.
    // NOTE: animate the inner content box, never menu.actor (the BoxPointer):
    // the BoxPointer keeps input muted until ITS OWN open animation completes,
    // so cancelling its transitions would leave every button dead.
    _animateOpen() {
        const a = this.menu.box;
        a.remove_all_transitions();
        a.set_pivot_point(1.0, 0.0);
        a.set_scale(0.9, 0.9);
        a.opacity = 0;
        a.ease({
            scale_x: 1, scale_y: 1, opacity: 255, duration: 240,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _animateClose() {
        const a = this.menu.box;
        a.set_pivot_point(1.0, 0.0);
        a.ease({
            scale_x: 0.94, scale_y: 0.94, duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    _refresh() {
        this._syncWifi();
        this._syncBt();
        this._syncAirplane();
        this._syncToggles();
        this._syncBrightness();
        this._syncSound();
        this._syncPlayer();
        this._tick++;
        if (this._view === 'detail' && this._tick % 2 === 0) this._renderDetail();
    }

    // ── Wi-Fi ──
    _toggleWifi() {
        if (!this._nm) return;
        this._nm.wireless_enabled = !this._nm.wireless_enabled;
        this._later(700, () => this._syncWifi());
    }

    _syncWifi() {
        const nm = this._nm;
        if (!nm) return;
        const on = nm.wireless_enabled;
        this._wifi.setActive(on);
        this._wifi.setIcon(on ? 'network-wireless-symbolic' : 'network-wireless-disabled-symbolic');
        if (!on) {
            this._wifi.setSub('Off');
            return;
        }
        let ssid = null;
        const dev = nm.get_devices().find(d => d instanceof NM.DeviceWifi);
        const ap = dev?.get_active_access_point?.();
        const raw = ap?.get_ssid();
        if (raw) ssid = NM.utils_ssid_to_utf8(raw.get_data());
        this._wifi.setSub(ssid ?? 'Not Connected');
    }

    // ── Bluetooth ──
    async _toggleBluetooth() {
        const path = await this._btAdapter();
        if (this._destroyed) return;
        if (path) {
            await setProp(Gio.DBus.system, 'org.bluez', path,
                'org.bluez.Adapter1', 'Powered', 'b', !this._btPowered);
        }
        this._later(400, () => this._syncBt());
    }

    async _syncBt() {
        const path = await this._btAdapter();
        if (this._destroyed) return;
        const v = path
            ? await getProp(Gio.DBus.system, 'org.bluez', path, 'org.bluez.Adapter1', 'Powered')
            : null;
        if (this._destroyed) return;
        if (v === null) {
            this._btAdapterPath = null;   // adapter gone / bluez stopped → re-enumerate
            this._btPowered = false;
            this._bt.setActive(false);
            this._bt.setSub('Unavailable');
            return;
        }
        this._btPowered = !!v;
        this._bt.setActive(this._btPowered);
        this._bt.setSub(this._btPowered ? 'On' : 'Off');
    }

    // ── Airplane mode ──
    async _toggleAirplane() {
        await setProp(Gio.DBus.session, 'org.gnome.SettingsDaemon.Rfkill',
            '/org/gnome/SettingsDaemon/Rfkill', 'org.gnome.SettingsDaemon.Rfkill',
            'AirplaneMode', 'b', !this._airplane);
        this._later(600, () => this._refresh());
    }

    async _syncAirplane() {
        const v = await getProp(Gio.DBus.session, 'org.gnome.SettingsDaemon.Rfkill',
            '/org/gnome/SettingsDaemon/Rfkill', 'org.gnome.SettingsDaemon.Rfkill', 'AirplaneMode');
        if (this._destroyed) return;
        this._airplane = !!v;
        this._air.setActive(this._airplane);
        this._air.setSub(v === null ? 'Unavailable' : (this._airplane ? 'On' : 'Off'));
    }

    // ── Night Light / Focus ──
    _toggleNightLight() {
        this._color.set_boolean('night-light-enabled', !this._color.get_boolean('night-light-enabled'));
    }

    _toggleDnd() {
        this._notif.set_boolean('show-banners', !this._notif.get_boolean('show-banners'));
    }

    _syncToggles() {
        if (!this._color || !this._notif) return;
        setRoundActive(this._night, this._color.get_boolean('night-light-enabled'));
        this._focus.setActive(!this._notif.get_boolean('show-banners'));
        if (this._iface && this._dark)
            setRoundActive(this._dark, this._iface.get_string('color-scheme') === 'prefer-dark');
    }

    _toggleDarkMode() {
        const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
        this._iface.set_string('color-scheme', dark ? 'default' : 'prefer-dark');
    }

    // ── Display brightness ──
    // 1) GNOME 49+: Main.brightnessManager.globalScale
    // 2) GNOME <=48: gnome-settings-daemon over D-Bus
    // 3) fallback: /sys/class/backlight written through logind (no root needed)
    _readBacklight() {
        try {
            const base = '/sys/class/backlight';
            const en = Gio.File.new_for_path(base)
                .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                const rd = f => parseInt(new TextDecoder()
                    .decode(GLib.file_get_contents(`${base}/${name}/${f}`)[1]).trim(), 10);
                const max = rd('max_brightness');
                if (max > 0) return {name, max, value: rd('brightness')};
            }
        } catch (e) { /* no backlight */ }
        return null;
    }

    async _syncBrightness() {
        if (this._drag.br) return;
        let v = null;

        const gs = this._brScale;
        if (gs && typeof gs.value === 'number') {
            this._brMode = 'shell';
            v = gs.value > 1 ? gs.value / 100 : gs.value;
        } else {
            const p = await getProp(Gio.DBus.session, 'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power', 'org.gnome.SettingsDaemon.Power.Screen', 'Brightness');
            if (typeof p === 'number' && p >= 0) {
                this._brMode = 'gsd';
                v = p / 100;
            } else {
                const bl = this._readBacklight();
                if (bl) {
                    this._brMode = 'sysfs';
                    this._backlight = bl;
                    v = bl.value / bl.max;
                }
            }
        }
        if (this._destroyed) return;

        if (v === null) {
            this._brBox.opacity = 110;
            this._brSlider.reactive = false;
            return;
        }
        this._brBox.opacity = 255;
        this._brSlider.reactive = true;
        this._setSlider(this._brSlider, v);
    }

    _pushBrightness(v) {
        this._pendingBr = v;
        if (this._brTimer) return;
        this._brTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._brTimer = 0;
            this._applyBrightness(this._pendingBr);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyBrightness(v) {
        switch (this._brMode) {
        case 'shell':
            if (this._brScale) this._brScale.value = v;
            break;
        case 'gsd':
            setProp(Gio.DBus.session, 'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power', 'org.gnome.SettingsDaemon.Power.Screen',
                'Brightness', 'i', Math.round(v * 100));
            break;
        case 'sysfs': {
            const bl = this._backlight;
            if (!bl) break;
            Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1/session/auto',
                'org.freedesktop.login1.Session', 'SetBrightness',
                new GLib.Variant('(ssu)', ['backlight', bl.name, Math.max(1, Math.round(v * bl.max))]),
                null, NONE, 1000, null).catch(e => console.error(`[macOS-CC] logind: ${e.message}`));
            break;
        }
        }
    }

    // ── Sound ──
    _bindSink() {
        if (!this._mixer) return;
        if (this._sink && this._sinkVolId) this._sink.disconnect(this._sinkVolId);
        this._sinkVolId = 0;
        this._sink = this._mixer.get_default_sink();
        if (!this._sink) {
            this._volSlider.reactive = false;
            return;
        }
        this._volSlider.reactive = true;
        this._sinkVolId = this._sink.connect('notify::volume', () => this._syncSound());
        this._syncSound();
    }

    _syncSound() {
        if (!this._sink || this._drag.vol) return;
        const max = this._mixer.get_vol_max_norm();
        this._setSlider(this._volSlider, this._sink.volume / max);
    }

    _pushVolume(v) {
        if (!this._sink) return;
        const max = this._mixer.get_vol_max_norm();
        this._sink.volume = v * max;
        this._sink.push_volume();
    }

    // ── Now Playing (MPRIS) ──
    _tickSeek() {
        if (this._destroyed || this._seekDrag || !this._trackLen) return;
        let pos = this._posBase;
        if (this._playing)
            pos += (GLib.get_monotonic_time() - this._posAt) * this._rate;
        pos = Math.max(0, Math.min(this._trackLen, pos));
        this._setSlider(this._seek, pos / this._trackLen);
    }

    async _seekTo(frac) {
        if (!this._playerName || !this._trackLen || !this._seek?.reactive) return;
        const target = Math.round(Math.max(0, Math.min(1, frac)) * this._trackLen);
        const cur = this._playing
            ? this._posBase + (GLib.get_monotonic_time() - this._posAt) * this._rate
            : this._posBase;
        const validId = typeof this._trackId === 'string' &&
            /^\/[A-Za-z0-9_\/]*$/.test(this._trackId) &&
            this._trackId !== '/org/mpris/MediaPlayer2/TrackList/NoTrack';
        const call = (method, variant) => Gio.DBus.session.call(this._playerName,
            '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', method,
            variant, null, NONE, 1000, null);
        try {
            if (validId)
                await call('SetPosition', new GLib.Variant('(ox)', [this._trackId, target]));
            else
                await call('Seek', new GLib.Variant('(x)', [Math.round(target - cur)]));
        } catch (e) {
            try {
                await call('Seek', new GLib.Variant('(x)', [Math.round(target - cur)]));
            } catch (e2) {
                console.error(`[macOS-CC] seek: ${e2.message}`);
            }
        }
        this._posBase = target;
        this._posAt = GLib.get_monotonic_time();
        this._later(300, () => this._syncPlayer());
    }

    async _mpris(method) {
        if (!this._playerName) return;
        try {
            await Gio.DBus.session.call(this._playerName, '/org/mpris/MediaPlayer2',
                'org.mpris.MediaPlayer2.Player', method, null, null, NONE, 1000, null);
        } catch (e) {
            console.error(`[macOS-CC] MPRIS ${method}: ${e.message}`);
        }
        this._later(250, () => this._syncPlayer());
    }

    async _syncPlayer() {
        let info = null;
        try {
            const r = await Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'), NONE, 1000, null);
            const names = r.recursiveUnpack()[0].filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
            for (const name of names) {
                const props = await Gio.DBus.session.call(name, '/org/mpris/MediaPlayer2', PROPS, 'GetAll',
                    new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']),
                    new GLib.VariantType('(a{sv})'), NONE, 1000, null)
                    .then(x => x.recursiveUnpack()[0]).catch(() => null);
                if (!props) continue;
                if (props.PlaybackStatus === 'Playing') {
                    info = {name, props};
                    break;
                }
                if (!info) info = {name, props};
            }
        } catch (e) { /* ignore */ }
        if (this._destroyed) return;

        if (!info) {
            this._playerName = null;
            this._npTitle.text = 'Not Playing';
            this._npArtist.text = '';
            this._play.iconActor.icon_name = 'media-playback-start-symbolic';
            this._updateArt(null);
            this._trackLen = 0;
            this._playing = false;
            this._seek.reactive = false;
            this._seek.opacity = 90;
            this._setSlider(this._seek, 0);
            return;
        }
        this._playerName = info.name;
        const md = info.props.Metadata ?? {};
        const artist = md['xesam:artist'];
        this._updateArt(md['mpris:artUrl'] ?? null);
        this._npTitle.text = md['xesam:title'] || 'Unknown';
        this._npArtist.text = Array.isArray(artist) ? artist.join(', ') : (artist ?? '');
        this._play.iconActor.icon_name = info.props.PlaybackStatus === 'Playing'
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        // seek bar state
        this._playing = info.props.PlaybackStatus === 'Playing';
        this._rate = Number(info.props.Rate) || 1;
        this._trackLen = Number(md['mpris:length']) || 0;
        this._trackId = md['mpris:trackid'] ?? null;
        const canSeek = info.props.CanSeek !== false && this._trackLen > 0;
        this._seek.reactive = canSeek;
        this._seek.opacity = canSeek ? 255 : 90;
        const pos = await getProp(Gio.DBus.session, info.name, '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player', 'Position');
        if (this._destroyed) return;
        if (typeof pos === 'number') {
            this._posBase = pos;
            this._posAt = GLib.get_monotonic_time();
        }
        this._tickSeek();
    }
});

// ───────────────────────── battery in the top bar ─────────────────────────
// The stock Quick Settings (which held the battery) is hidden, so show our own:
// a glossy battery glyph; clicking it opens time remaining + power mode.
const BATT_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const BATT_IFACE = 'org.freedesktop.UPower.Device';
const BATT_W = 36;
const BATT_H = 16;
const BATT_MENU_W = 300;

// power-profiles-daemon moved from net.hadess.* to org.freedesktop.UPower.* in 0.20
const PPD = [
    {name: 'org.freedesktop.UPower.PowerProfiles', path: '/org/freedesktop/UPower/PowerProfiles',
        iface: 'org.freedesktop.UPower.PowerProfiles'},
    {name: 'net.hadess.PowerProfiles', path: '/net/hadess/PowerProfiles',
        iface: 'net.hadess.PowerProfiles'},
];
const MODES = [
    ['power-saver', 'Power Saver', 'power-profile-power-saver-symbolic'],
    ['balanced', 'Balanced', 'power-profile-balanced-symbolic'],
    ['performance', 'Performance', 'power-profile-performance-symbolic'],
];

function fmtDuration(sec) {
    const total = Math.max(1, Math.round(sec / 60));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'macOS CC Battery', false);
        this._destroyed = false;
        this._pct = 0;
        this._state = 0;     // UPower: 1 charging, 2 discharging, 4 full, 5/6 pending
        this._tte = 0;
        this._ttf = 0;
        this._ppd = null;
        this._ppdSub = 0;
        this._profiles = [];
        this._profile = null;

        this._icon = new St.DrawingArea({style_class: 'cc-batt-icon', y_align: CENTER});
        this._icon.set_size(BATT_W, BATT_H);
        this._icon.connect('repaint', () => this._draw(this._icon));
        this.add_child(this._icon);
        this.hide();

        this.menu.actor.add_style_class_name('cc-menu');
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'cc-item',
        });
        item.add_child(this._buildMenu());
        this.menu.addMenuItem(item);
        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open) return;
            defendMenuFromOtherBlurExtensions(this.menu);
            this._sync();
            this._syncProfile();
        });

        this._sub = Gio.DBus.system.signal_subscribe('org.freedesktop.UPower', PROPS,
            'PropertiesChanged', BATT_PATH, null, Gio.DBusSignalFlags.NONE, () => this._sync());
        this._poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._sync();
            return GLib.SOURCE_CONTINUE;
        });
        this._lookId = LOOK.subscribe(() => this._onLook());
        this._onLook();
        this.connect('destroy', () => {
            this._destroyed = true;
            if (this._sub) Gio.DBus.system.signal_unsubscribe(this._sub);
            if (this._ppdSub) Gio.DBus.system.signal_unsubscribe(this._ppdSub);
            if (this._poll) GLib.source_remove(this._poll);
            if (this._lookId) LOOK?.unsubscribe(this._lookId);
            this._sub = this._ppdSub = this._poll = this._lookId = 0;
        });
        this._sync();
    }

    _charging() { return this._state === 1; }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        paintBattery(cr, w, h, this._pct, this._charging());
        cr.$dispose();
    }

    _buildMenu() {
        const col = box({style_class: 'cc-batt-menu', x_expand: true}, true);
        col.set_width(BATT_MENU_W);

        // header: big battery + percentage + state / time remaining
        const head = box({style_class: 'cc-batt-card cc-batt-head', x_expand: true, y_align: CENTER});
        LOOK?.addBlur(head, 28, 'always');
        this._bigIcon = new St.DrawingArea({y_align: CENTER});
        this._bigIcon.set_size(68, 34);
        this._bigIcon.connect('repaint', () => this._draw(this._bigIcon));
        const text = box({y_align: CENTER, x_expand: true}, true);
        this._pctLabel = new St.Label({text: '', style_class: 'cc-batt-pct'});
        this._stateLabel = new St.Label({text: '', style_class: 'cc-title'});
        this._timeLabel = new St.Label({text: '', style_class: 'cc-sub'});
        text.add_child(this._pctLabel);
        text.add_child(this._stateLabel);
        text.add_child(this._timeLabel);
        head.add_child(this._bigIcon);
        head.add_child(text);
        col.add_child(head);

        // power mode: Power Saver / Balanced / Performance
        this._modeCard = box({style_class: 'cc-batt-card', x_expand: true}, true);
        LOOK?.addBlur(this._modeCard, 28, 'always');
        this._modeCard.add_child(new St.Label({text: 'Power Mode', style_class: 'cc-slider-label'}));
        const row = box({style_class: 'cc-mode-row', x_expand: true});
        this._modeBtns = {};
        for (const [id, label, icon] of MODES) {
            const inner = box({style_class: 'cc-mode-inner', x_align: CENTER, y_align: CENTER, x_expand: true}, true);
            inner.add_child(new St.Icon({
                icon_name: icon, fallback_icon_name: 'preferences-system-symbolic',
                icon_size: 18, x_align: CENTER,
            }));
            inner.add_child(new St.Label({text: label, style_class: 'cc-mode-label', x_align: CENTER}));
            const b = new St.Button({
                style_class: 'cc-mode', child: inner,
                can_focus: true, track_hover: true, x_expand: true,
            });
            LOOK?.addBlur(b, 20, 'always');
            b.connect('clicked', () => this._setProfile(id));
            tapFeedback(b, 0.95);
            this._modeBtns[id] = b;
            row.add_child(b);
        }
        this._modeCard.add_child(row);
        this._modeCard.hide();      // shown once power-profiles-daemon answers
        col.add_child(this._modeCard);
        return col;
    }

    _updateLabels() {
        this._pctLabel.text = `${Math.round(this._pct)}%`;
        let state = '';
        let time = '';
        switch (this._state) {
        case 1:
            state = 'Charging';
            time = this._ttf > 0 ? `${fmtDuration(this._ttf)} until full` : 'Estimating time…';
            break;
        case 2:
            state = 'On battery';
            time = this._tte > 0 ? `${fmtDuration(this._tte)} remaining` : 'Estimating time…';
            break;
        case 3:
            state = 'Empty';
            break;
        case 4:
            state = 'Fully charged';
            break;
        case 5:
            state = 'Plugged in';
            time = 'Not charging';
            break;
        case 6:
            state = 'On battery';
            break;
        }
        this._stateLabel.text = state;
        this._stateLabel.visible = !!state;
        this._timeLabel.text = time;
        this._timeLabel.visible = !!time;
    }

    async _sync() {
        const r = await getAll(Gio.DBus.system, 'org.freedesktop.UPower', BATT_PATH, BATT_IFACE);
        if (this._destroyed) return;
        if (!r || !r.IsPresent || typeof r.Percentage !== 'number') {
            this.menu.close();
            this.hide();
            return;
        }
        this._pct = r.Percentage;
        this._state = Number(r.State) || 0;
        this._tte = Number(r.TimeToEmpty) || 0;
        this._ttf = Number(r.TimeToFull) || 0;
        this._updateLabels();
        this._icon.queue_repaint();
        this._bigIcon.queue_repaint();
        this.show();
    }

    // ── power modes (power-profiles-daemon) ──
    async _ppdFind() {
        if (this._ppd) return this._ppd;
        for (const c of PPD) {
            const v = await getProp(Gio.DBus.system, c.name, c.path, c.iface, 'ActiveProfile');
            if (this._destroyed) return null;
            if (typeof v === 'string') {
                this._ppd = c;
                this._ppdSub = Gio.DBus.system.signal_subscribe(c.name, PROPS, 'PropertiesChanged',
                    c.path, null, Gio.DBusSignalFlags.NONE, () => this._syncProfile());
                return c;
            }
        }
        return null;
    }

    async _syncProfile() {
        const c = await this._ppdFind();
        if (this._destroyed) return;
        if (!c) {
            this._profiles = [];
            this._renderModes();
            return;
        }
        const [active, profs] = await Promise.all([
            getProp(Gio.DBus.system, c.name, c.path, c.iface, 'ActiveProfile'),
            getProp(Gio.DBus.system, c.name, c.path, c.iface, 'Profiles'),
        ]);
        if (this._destroyed) return;
        this._profile = typeof active === 'string' ? active : null;
        this._profiles = Array.isArray(profs)
            ? profs.map(p => p.Profile).filter(Boolean)
            : ['power-saver', 'balanced'];
        this._renderModes();
    }

    async _setProfile(id) {
        const c = await this._ppdFind();
        if (!c || this._destroyed) return;
        await setProp(Gio.DBus.system, c.name, c.path, c.iface, 'ActiveProfile', 's', id);
        await this._syncProfile();   // show what the daemon really ended up with
    }

    _renderModes() {
        this._modeCard.visible = this._profiles.length > 0;
        for (const [id] of MODES) {
            const b = this._modeBtns[id];
            b.visible = this._profiles.includes(id);
            const on = id === this._profile;
            if (on) b.add_style_class_name('active');
            else b.remove_style_class_name('active');
            b.set_style(on ? `background-gradient-direction: none; ${activeCss()}` : null);
        }
    }

    _onLook() {
        if (this._destroyed) return;
        if (LOOK.light) this.menu.actor.add_style_class_name('cc-light');
        else this.menu.actor.remove_style_class_name('cc-light');
        this._renderModes();
    }
});

// ───────────────────────── Extension entry ─────────────────────────
export default class MacControlCenterExtension extends Extension {
    enable() {
        this._lookSettings = this.getSettings();
        LOOK = new Look(this._lookSettings);

        // Hide GNOME's stock Quick Settings and keep it hidden.
        const qs = Main.panel.statusArea.quickSettings;
        this._qsContainer = qs?.container ?? null;
        if (this._qsContainer) {
            this._qsContainer.hide();
            this._qsVisId = this._qsContainer.connect('notify::visible', () => {
                if (this._qsContainer.visible) this._qsContainer.hide();
            });
        }

        this._battery = new BatteryIndicator();
        Main.panel.addToStatusArea('macos-cc-battery', this._battery, -1, 'right');
        this._button = new ControlCenter(this);
        Main.panel.addToStatusArea('macos-control-center', this._button, -1, 'right');
    }

    disable() {
        this._button?.destroy();
        this._button = null;
        this._battery?.destroy();
        this._battery = null;
        LOOK?.destroy();
        LOOK = null;
        this._lookSettings = null;

        if (this._qsContainer) {
            if (this._qsVisId) this._qsContainer.disconnect(this._qsVisId);
            this._qsContainer.show();
        }
        this._qsContainer = null;
        this._qsVisId = 0;
    }
}
