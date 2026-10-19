// Live backdrop blur backends.
//
// Preferred: GNOME's "Blur" library (libblur-effect) — a real backdrop blur
// that also rounds the blurred rectangle to the surface's border radius, so
// nothing bleeds out of the rounded corners.
// Fallback: Shell.BlurEffect — the same real blur on shells that do not ship
// that library (the blurred rectangle keeps square corners, but the surface's
// own rounded background hides all but a sliver of it).
//
// Both namespaces are loaded dynamically: neither exists everywhere, and a
// missing namespace must never take the whole extension down.

let Blur = null;
try {
    Blur = (await import('gi://Blur')).default;
} catch (_e) {
    Blur = null;
}

let Shell = null;
if (!Blur?.BlurEffect) {
    try {
        Shell = (await import('gi://Shell')).default;
    } catch (_e) {
        Shell = null;
    }
}

export const BLUR_SUPPORTED = !!(Blur?.BlurEffect || Shell?.BlurEffect);
export const BLUR_ROUNDED = !!Blur?.BlurEffect;

// RADIUS is in layout pixels; the effects work in device pixels, so it gets
// scaled by the display scale factor. CORNER is the surface's CSS border
// radius, used to trim the blurred rectangle (rounded backend only).
export function makeBlurEffect(radius, corner = 0, scale = 1) {
    const r = Math.max(0, Math.round(radius * scale));
    if (Blur?.BlurEffect) {
        const effect = new Blur.BlurEffect({mode: Blur.BlurMode.BACKGROUND, radius: r});
        if (corner > 0)
            effect.corner_radius = corner * scale;
        return effect;
    }
    if (Shell?.BlurEffect)
        return new Shell.BlurEffect({mode: Shell.BlurEffectMode.BACKGROUND, radius: r});
    return null;
}
