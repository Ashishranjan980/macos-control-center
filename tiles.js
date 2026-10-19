// Shared tile catalogue (used by extension.js and prefs.js; plain data only).
// w/h are cells in the panel's 4-column grid: a round button is 1x1, a standard
// tile is 2x1, Now Playing is 2x2, sliders and the Settings pill span all 4.

export const TILE_DEFS = {
    'wifi':        {title: 'Wi-Fi',                  icon: 'network-wireless-symbolic',            w: 2, h: 1},
    'nowplaying':  {title: 'Now Playing',            icon: 'multimedia-player-symbolic',           w: 2, h: 2, sub: 'Takes two rows'},
    'bluetooth':   {title: 'Bluetooth',              icon: 'bluetooth-active-symbolic',            w: 2, h: 1},
    'airplane':    {title: 'Airplane Mode',          icon: 'airplane-mode-symbolic',               w: 2, h: 1},
    'night-light': {title: 'Night Light',            icon: 'night-light-symbolic',                 w: 1, h: 1, sub: 'Round button'},
    'lock':        {title: 'Lock Screen',            icon: 'system-lock-screen-symbolic',          w: 1, h: 1, sub: 'Round button'},
    'dark-mode':   {title: 'Dark / Light Mode',      icon: 'preferences-desktop-appearance-symbolic', w: 1, h: 1, sub: 'Round button'},
    'power':       {title: 'Power Menu',             icon: 'system-shutdown-symbolic',             w: 1, h: 1, sub: 'Round button'},
    'screenshot':  {title: 'Screenshot',             icon: 'applets-screenshooter-symbolic',       w: 1, h: 1, sub: 'Round button, opens the screenshot tool'},
    'screen-record': {title: 'Screen Recording',     icon: 'media-record-symbolic',                w: 1, h: 1, sub: 'Round button, opens the screen recorder'},
    'focus':       {title: 'Focus',                  icon: 'weather-clear-night-symbolic',         w: 2, h: 1},
    'display':     {title: 'Display slider',         icon: 'display-brightness-symbolic',          w: 4, h: 1},
    'sound':       {title: 'Sound slider',           icon: 'audio-volume-high-symbolic',           w: 4, h: 1},
    'settings':    {title: 'Settings button',        icon: 'preferences-system-symbolic',          w: 4, h: 1},
};

// Tiles fill the grid first-fit from the top-left in this order. With the
// default order and nothing hidden this reproduces the original layout.
export const DEFAULT_ORDER = [
    'wifi', 'nowplaying', 'bluetooth', 'airplane',
    'night-light', 'lock', 'dark-mode', 'power',
    'screenshot', 'screen-record', 'focus',
    'display', 'sound', 'settings',
];

export const DEFAULT_HIDDEN = ['screenshot', 'screen-record'];

// Normalises the two stored lists: unknown ids are dropped, tiles added in a
// newer version are appended, hidden ids are filtered out of `enabled`.
export function resolveTiles(order, hidden) {
    const all = [];
    for (const id of [...order, ...DEFAULT_ORDER]) {
        if (TILE_DEFS[id] && !all.includes(id))
            all.push(id);
    }
    const off = new Set(hidden);
    return {all, enabled: all.filter(id => !off.has(id))};
}
