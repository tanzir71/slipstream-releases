// Background wallpapers for the composition: soft macOS-style gradients (generated for Slipstream)
// and a few photographs (Unsplash License). Images are bundled with the site, never hot-linked.
// Each entry carries `tone` colours used as an instant fallback while the image decodes.

const BASE = new URL('../../assets/img/', import.meta.url);

export const WALLPAPERS = {
  tide:     { label: 'Tide',     kind: 'gradient', file: 'grad-tide.webp',     tone: ['#8da5c9', '#afc3db', '#cdbfe0'] },
  morning:  { label: 'Morning',  kind: 'gradient', file: 'grad-morning.webp',  tone: ['#c7d3ee', '#e8edf5', '#f5e4d7'] },
  sage:     { label: 'Sage',     kind: 'gradient', file: 'grad-sage.webp',     tone: ['#c9dfd3', '#e3ece7', '#d8e3ee'] },
  sand:     { label: 'Sand',     kind: 'gradient', file: 'grad-sand.webp',     tone: ['#e6d2c1', '#ede7df', '#dce2e8'] },
  dusk:     { label: 'Dusk',     kind: 'gradient', file: 'grad-dusk.webp',     tone: ['#343a66', '#191c2a', '#4e3756'] },
  graphite: { label: 'Graphite', kind: 'gradient', file: 'grad-graphite.webp', tone: ['#2a2d33', '#161719', '#25282e'] },
  valley:   { label: 'Valley',   kind: 'photo',    file: 'wall-valley.webp',   tone: ['#9db3c4', '#c7c9d2', '#6f8790'] },
  shore:    { label: 'Shore',    kind: 'photo',    file: 'wall-shore.webp',    tone: ['#f2c9a5', '#9fd3d3', '#e9e2d6'] },
  peaks:    { label: 'Peaks',    kind: 'photo',    file: 'wall-peaks.webp',    tone: ['#c9ccd1', '#e8e9ea', '#8d9196'] },
  dunes:    { label: 'Dusk sea', kind: 'photo',    file: 'wall-dusk.webp',     tone: ['#6f6a9c', '#c3a6c8', '#3f4a74'] },
};

/** Older projects used saturated procedural gradients; map them to the closest new wallpaper. */
export const LEGACY_BACKGROUNDS = { aurora: 'dusk', mint: 'sage', ember: 'sand', ocean: 'tide', paper: 'sand', blush: 'morning' };

export function resolveBackground(id) {
  if (id === 'solid' || id === 'blur') return id;
  if (WALLPAPERS[id]) return id;
  return LEGACY_BACKGROUNDS[id] || 'tide';
}

export function wallpaperURL(id) {
  const w = WALLPAPERS[resolveBackground(id)];
  return w ? new URL(w.file, BASE).href : null;
}

const cache = new Map(); // id -> { bitmap, promise }
const listeners = new Set();
export function onWallpaperReady(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Load (once) and return the decoded wallpaper. Resolves to null if it can't be loaded. */
export function loadWallpaper(id) {
  id = resolveBackground(id);
  if (!WALLPAPERS[id]) return Promise.resolve(null);
  let entry = cache.get(id);
  if (entry) return entry.promise;
  entry = { bitmap: null, promise: null };
  entry.promise = fetch(wallpaperURL(id))
    .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.blob(); })
    .then((b) => createImageBitmap(b))
    .then((bmp) => { entry.bitmap = bmp; listeners.forEach((fn) => fn(id)); return bmp; })
    .catch(() => null);
  cache.set(id, entry);
  return entry.promise;
}

/** Synchronous accessor for the renderer: returns the bitmap if ready, else starts loading. */
export function wallpaperBitmap(id) {
  id = resolveBackground(id);
  const e = cache.get(id);
  if (e) return e.bitmap;
  loadWallpaper(id);
  return null;
}
