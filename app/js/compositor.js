// Frame compositor. The SAME function renders the live preview and the exported file, so the preview
// is exactly what you export. Inputs can be <video> elements (preview) or canvases (export decode).

import { zoomAt } from './edl.js';
import { cueAt, drawCaption } from './captions.js';
import { WALLPAPERS, resolveBackground, wallpaperBitmap } from './wallpapers.js';
import { layoutBlendAt, layoutAt, lerpRect } from '../../packages/editor-core/src/scenes.js';
import { activeAt, maskRectAt, fadeAlpha, ANNOTATION_COLOR } from '../../packages/editor-core/src/overlays.js';

export { WALLPAPERS as BACKGROUNDS } from './wallpapers.js';
const gradCache = new Map();

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  else ctx.rect(x, y, w, h);
}

export function dimsOf(src) {
  if (!src) return null;
  const w = src.videoWidth ?? src.width, h = src.videoHeight ?? src.height;
  return w && h ? { w, h } : null;
}

function fitContain(sw, sh, area) {
  const s = Math.min(area.w / sw, area.h / sh);
  const w = sw * s, h = sh * s;
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}

/** Crop rect in source pixels that covers a destination aspect, centered near (fx, fy). */
function coverCrop(sw, sh, dw, dh, fx = 0.5, fy = 0.5) {
  const dstA = dw / dh, srcA = sw / sh;
  let w = sw, h = sh;
  if (srcA > dstA) w = sh * dstA; else h = sw / dstA;
  const x = Math.max(0, Math.min(sw - w, fx * sw - w / 2));
  const y = Math.max(0, Math.min(sh - h, fy * sh - h / 2));
  return { x, y, w, h };
}

/** Where each layer goes for the current edit settings. Pure geometry. */
export function computeLayout(edit, W, H, sDims, cDims) {
  const L = edit.layout, S = edit.style;
  const m = Math.min(W, H);
  const pad = S.padding * m;
  const radius = S.radius * m;
  const vertical = H >= W; // square and portrait frames stack the camera under the screen
  const hasCam = !!cDims && L.mode !== 'screen';
  const out = { pad, radius, screen: null, camera: null, cameraShape: L.shape, fit: L.fit };
  if (L.mode === 'camera' && hasCam) {
    out.camera = { x: 0, y: 0, w: W, h: H, shape: 'square', full: true, r: 0, ring: 0 };
    return out;
  }
  if (L.mode === 'split' && hasCam) {
    const r = Math.max(0.25, Math.min(0.7, L.split));
    if (vertical) {
      const camH = H * r;
      out.screen = { x: pad, y: pad, w: W - pad * 2, h: H - camH - pad * 1.5 };
      out.camera = { x: pad, y: H - camH + pad * 0.5, w: W - pad * 2, h: camH - pad * 1.5, shape: 'rounded', ring: 0 };
    } else {
      const camW = W * r;
      out.screen = { x: pad, y: pad, w: W - camW - pad * 1.5, h: H - pad * 2 };
      out.camera = { x: W - camW + pad * 0.5, y: pad, w: camW - pad * 1.5, h: H - pad * 2, shape: 'rounded', ring: 0 };
    }
    out.screenFill = vertical || L.fit === 'cover';
    return out;
  }
  out.screen = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
  out.screenFill = L.fit === 'cover';
  if (hasCam && L.mode === 'pip') {
    const size = Math.max(0.08, Math.min(0.5, L.size)) * m;
    const margin = Math.max(pad * 0.55, m * 0.03);
    const cw = L.shape === 'circle' ? size : size * (L.shape === 'wide' ? 16 / 9 : 1);
    const ch = size;
    const right = L.corner.includes('r'), bottom = L.corner.includes('b');
    out.camera = { x: right ? W - margin - cw : margin, y: bottom ? H - margin - ch : margin, w: cw, h: ch, shape: L.shape, ring: 1 };
  }
  return out;
}

/** Corner radius for a camera rectangle (a circle is a square with radius = half its side). */
function cameraRadius(R, m) {
  if (!R) return 0;
  if (R.full) return 0;
  if (R.shape === 'circle') return Math.min(R.w, R.h) / 2;
  if (R.shape === 'square') return m * 0.006;
  return Math.min(R.w, R.h) * 0.14;
}

/**
 * Layout for source time t, including scene overrides (S-01). During a scene transition the two layouts
 * are blended: rectangles, corner radii and the bubble ring interpolate, a layer that only exists on one
 * side fades. Pure geometry, shared by preview and export.
 */
export function layoutForTime(edit, W, H, sDims, cDims, t) {
  const m = Math.min(W, H);
  const blend = layoutBlendAt(edit, t);
  const B = computeLayout({ ...edit, layout: blend.to }, W, H, sDims, cDims);
  if (B.camera) B.camera.r = cameraRadius(B.camera, m);
  B.screenAlpha = 1; B.cameraAlpha = 1; B.mode = blend.to.mode;
  if (blend.k >= 1) return B;
  const A = computeLayout({ ...edit, layout: blend.from }, W, H, sDims, cDims);
  if (A.camera) A.camera.r = cameraRadius(A.camera, m);
  const k = blend.k;
  const out = { ...B, mode: blend.to.mode };
  out.screen = lerpRect(A.screen, B.screen, k);
  out.screenAlpha = A.screen && B.screen ? 1 : A.screen ? 1 - k : k;
  out.screenFill = k < 0.5 ? A.screenFill : B.screenFill;
  if (A.camera || B.camera) {
    const r = lerpRect(A.camera, B.camera, k);
    out.camera = { ...r, shape: (k < 0.5 ? A.camera : B.camera)?.shape || 'rounded', full: false, r: (A.camera?.r ?? B.camera.r) + ((B.camera?.r ?? A.camera.r) - (A.camera?.r ?? B.camera.r)) * k, ring: (A.camera?.ring || 0) * (1 - k) + (B.camera?.ring || 0) * k };
    out.cameraAlpha = A.camera && B.camera ? 1 : A.camera ? 1 - k : k;
  }
  return out;
}

/** True if any part of the edit (global layout or a scene) shows the camera. */
export function usesCamera(edit) {
  return edit.layout.mode !== 'screen' || (edit.scenes || []).some((s) => (s.layout?.mode ?? edit.layout.mode) !== 'screen');
}

function drawBackground(ctx, W, H, edit, screenSrc, sDims) {
  const S = edit.style;
  if (S.bg === 'solid') { ctx.fillStyle = S.solid || '#0b0d12'; ctx.fillRect(0, 0, W, H); return; }
  if (S.bg === 'blur' && screenSrc && sDims) {
    const small = blurCanvas(Math.max(8, Math.round(W / 28)), Math.max(8, Math.round(H / 28)));
    const sctx = small.getContext('2d');
    const c = coverCrop(sDims.w, sDims.h, small.width, small.height);
    sctx.drawImage(screenSrc, c.x, c.y, c.w, c.h, 0, 0, small.width, small.height);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, W, H);
    ctx.fillStyle = 'rgba(6,7,10,0.38)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    return;
  }
  const id = resolveBackground(S.bg);
  const wp = WALLPAPERS[id];
  const bmp = wallpaperBitmap(id);
  if (bmp) {
    const c = coverCrop(bmp.width, bmp.height, W, H);
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, W, H);
    ctx.restore();
    return;
  }
  // Instant fallback while the wallpaper decodes: a soft three-tone wash in the same colours.
  const key = `${id}:${W}x${H}`;
  let g = gradCache.get(key);
  if (!g) {
    g = ctx.createLinearGradient(0, 0, W, H);
    wp.tone.forEach((c, i) => g.addColorStop(i / (wp.tone.length - 1), c));
    gradCache.set(key, g);
    if (gradCache.size > 64) gradCache.delete(gradCache.keys().next().value);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

let _blur = null;
function blurCanvas(w, h) {
  if (!_blur) _blur = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  if (_blur.width !== w || _blur.height !== h) { _blur.width = w; _blur.height = h; }
  return _blur;
}


function drawScreen(ctx, W, H, layout, edit, src, sDims, z, t) {
  const area = layout.screen;
  if (!area || !src || !sDims || area.w < 1 || area.h < 1 || layout.screenAlpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = layout.screenAlpha ?? 1;
  drawScreenInner(ctx, W, H, layout, edit, src, sDims, z, area, t);
  ctx.restore();
}

/**
 * Where the screen recording lands at zoom z: `dest` is its rect on the canvas and `view` the part of the source
 * (in source pixels) drawn into it. Masks, annotations and pointer mapping all use this, so they follow zooms.
 */
function screenView(layout, sDims, z) {
  const area = layout.screen;
  const fill = layout.screenFill;
  const dest = fill ? area : fitContain(sDims.w, sDims.h, area);
  const base = fill ? coverCrop(sDims.w, sDims.h, dest.w, dest.h, z.k > 0 ? z.x : 0.5, z.k > 0 ? z.y : 0.5) : { x: 0, y: 0, w: sDims.w, h: sDims.h };
  const vw = base.w / z.scale, vh = base.h / z.scale;
  const cx = Math.max(base.x + vw / 2, Math.min(base.x + base.w - vw / 2, z.x * sDims.w));
  const cy = Math.max(base.y + vh / 2, Math.min(base.y + base.h - vh / 2, z.y * sDims.h));
  return { dest, view: { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh } };
}

function drawScreenInner(ctx, W, H, layout, edit, src, sDims, z, area, t) {
  const { dest, view } = screenView(layout, sDims, z);
  const r = layout.radius;
  const shadow = edit.style.shadow || 0;
  if (shadow > 0 && layout.pad > 0) {
    ctx.save();
    const m = Math.min(W, H);
    ctx.fillStyle = '#000';
    // two layers, like a macOS window: a wide ambient shadow and a tight contact shadow
    ctx.shadowColor = `rgba(10,12,20,${0.42 * shadow})`;
    ctx.shadowBlur = m * 0.06 * shadow;
    ctx.shadowOffsetY = m * 0.022 * shadow;
    roundRectPath(ctx, dest.x, dest.y, dest.w, dest.h, r);
    ctx.fill();
    ctx.shadowColor = `rgba(10,12,20,${0.28 * shadow})`;
    ctx.shadowBlur = m * 0.012 * shadow;
    ctx.shadowOffsetY = m * 0.004 * shadow;
    roundRectPath(ctx, dest.x, dest.y, dest.w, dest.h, r);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRectPath(ctx, dest.x, dest.y, dest.w, dest.h, layout.pad > 0 ? r : 0);
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, view.x, view.y, view.w, view.h, dest.x, dest.y, dest.w, dest.h);
  if (edit.masks?.length && t != null) drawMasks(ctx, edit, src, sDims, { dest, view }, t);
  ctx.restore();
  if (layout.pad > 0) {
    ctx.save();
    roundRectPath(ctx, dest.x + 0.5, dest.y + 0.5, dest.w - 1, dest.h - 1, r);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

// ---- Privacy masks (T-03/M-03) and annotations (T-05/M-05) -----------------------------------------------
let _maskCanvas = null;
function maskCanvas() {
  if (!_maskCanvas) _maskCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
  return _maskCanvas;
}

/**
 * Masks are drawn inside the screen's clip in source space, so they follow zooms. Blur and pixelate rebuild the
 * region from a few samples of the SOURCE, so no original pixel survives under the mask (a CSS blur would let
 * sharp pixels bleed back in at the edges).
 */
function drawMasks(ctx, edit, src, sDims, v, t) {
  const kx = v.dest.w / v.view.w, ky = v.dest.h / v.view.h;
  for (const mk of activeAt(edit.masks, t)) {
    const r = maskRectAt(mk, t);
    if (!r || r.length !== 4) continue;
    const x0 = Math.max(0, Math.min(r[0], r[0] + r[2])) * sDims.w, y0 = Math.max(0, Math.min(r[1], r[1] + r[3])) * sDims.h;
    const x1 = Math.min(1, Math.max(r[0], r[0] + r[2])) * sDims.w, y1 = Math.min(1, Math.max(r[1], r[1] + r[3])) * sDims.h;
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 2 || rh < 2) continue;
    const X = v.dest.x + (x0 - v.view.x) * kx, Y = v.dest.y + (y0 - v.view.y) * ky, Wc = rw * kx, Hc = rh * ky;
    ctx.save();
    roundRectPath(ctx, X, Y, Wc, Hc, Math.min(Wc, Hc) * 0.12);
    ctx.clip();
    if (mk.mode === 'solid') {
      ctx.fillStyle = '#17171a';
      ctx.fillRect(X, Y, Wc, Hc);
    } else {
      const pixelate = mk.mode === 'pixelate';
      const cell = pixelate ? Math.max(8, Math.min(rw, rh) / 6) : Math.max(6, Math.min(rw, rh) / 9);
      const sw = Math.max(2, Math.round(rw / cell)), sh = Math.max(2, Math.round(rh / cell));
      const c = maskCanvas();
      c.width = sw; c.height = sh;
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(src, x0, y0, rw, rh, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = !pixelate;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(c, 0, 0, sw, sh, X, Y, Wc, Hc);
      if (!pixelate) { ctx.fillStyle = 'rgba(23,23,26,0.18)'; ctx.fillRect(X, Y, Wc, Hc); }
    }
    ctx.restore();
  }
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x8b93ff;
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Arrows, boxes, highlights and text callouts, placed in source space and sized in output pixels (like macOS). */
function drawAnnotations(ctx, W, H, layout, edit, sDims, z, t) {
  const list = activeAt(edit.annotations, t);
  if (!list.length || !layout.screen || !sDims || layout.screenAlpha <= 0) return;
  const { dest, view } = screenView(layout, sDims, z);
  const map = (fx, fy) => ({ x: dest.x + (fx * sDims.w - view.x) * (dest.w / view.w), y: dest.y + (fy * sDims.h - view.y) * (dest.h / view.h) });
  const m = Math.min(W, H);
  const lw = Math.max(3, m * 0.006);
  for (const a of list) {
    const alpha = fadeAlpha(a, t) * (layout.screenAlpha ?? 1);
    if (alpha <= 0) continue;
    const r = Array.isArray(a.rect) && a.rect.length === 4 ? a.rect : [0.4, 0.4, 0.2, 0.1];
    const p0 = map(r[0], r[1]), p1 = map(r[0] + r[2], r[1] + r[3]);
    const color = a.color || ANNOTATION_COLOR;
    ctx.save();
    ctx.globalAlpha = alpha;
    const shadow = (blur, y, o = 0.35) => { ctx.shadowColor = `rgba(0,0,0,${o})`; ctx.shadowBlur = blur; ctx.shadowOffsetY = y; };
    const bx = Math.min(p0.x, p1.x), by = Math.min(p0.y, p1.y), bw = Math.abs(p1.x - p0.x), bh = Math.abs(p1.y - p0.y);
    if (a.kind === 'box') {
      shadow(m * 0.012, m * 0.004);
      ctx.strokeStyle = color; ctx.lineWidth = lw;
      roundRectPath(ctx, bx, by, bw, bh, Math.min(m * 0.01, bw / 2, bh / 2));
      ctx.stroke();
    } else if (a.kind === 'highlight') {
      ctx.fillStyle = hexA(color, 0.26);
      roundRectPath(ctx, bx, by, bw, bh, Math.min(m * 0.006, bw / 2, bh / 2));
      ctx.fill();
    } else if (a.kind === 'arrow') {
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const head = Math.max(lw * 4, m * 0.03);
      shadow(m * 0.012, m * 0.004);
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw * 1.3; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x - Math.cos(ang) * head * 0.8, p1.y - Math.sin(ang) * head * 0.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p1.x - Math.cos(ang - 0.45) * head, p1.y - Math.sin(ang - 0.45) * head);
      ctx.lineTo(p1.x - Math.cos(ang + 0.45) * head, p1.y - Math.sin(ang + 0.45) * head);
      ctx.closePath();
      ctx.fill();
    } else if (a.kind === 'text') {
      const size = Math.max(14, m * 0.032);
      ctx.font = `600 ${size}px Geist, ui-sans-serif, system-ui, sans-serif`;
      const text = String(a.text ?? 'Note');
      const padX = size * 0.6, padY = size * 0.38;
      const w = ctx.measureText(text).width + padX * 2, h = size * 1.25 + padY * 2;
      shadow(m * 0.02, m * 0.006, 0.4);
      ctx.fillStyle = 'rgba(14,15,18,0.86)';
      roundRectPath(ctx, p0.x, p0.y, w, h, size * 0.36);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = color;
      ctx.fillRect(p0.x + padX * 0.45, p0.y + padY, size * 0.12, h - padY * 2);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, p0.x + padX, p0.y + h / 2);
    }
    ctx.restore();
  }
}

/**
 * Map between the canvas and the screen recording at source time t, following the layout, scenes and zoom
 * (the preview's reduced-motion setting included). For drawing and dragging masks and annotations.
 * Returns null when the screen isn't on screen at t.
 */
export function screenMapping(edit, W, H, sDims, cDims, t, { reducedMotion = false } = {}) {
  if (!sDims) return null;
  const layout = layoutForTime(edit, W, H, sDims, cDims, t);
  if (!layout.screen || layout.screen.w < 1) return null;
  const z0 = zoomAt(edit.zooms, t);
  const { dest, view } = screenView(layout, sDims, reducedMotion ? snapZoom(z0) : z0);
  return {
    dest,
    toCanvas: (fx, fy) => ({ x: dest.x + (fx * sDims.w - view.x) * (dest.w / view.w), y: dest.y + (fy * sDims.h - view.y) * (dest.h / view.h) }),
    toSource: (px, py) => ({ x: (view.x + (px - dest.x) * (view.w / dest.w)) / sDims.w, y: (view.y + (py - dest.y) * (view.h / dest.h)) / sDims.h }),
  };
}

function drawCamera(ctx, W, H, layout, edit, src, cDims) {
  const R = layout.camera;
  if (!R || !src || !cDims || R.w < 1 || R.h < 1 || layout.cameraAlpha <= 0) return;
  const crop = coverCrop(cDims.w, cDims.h, R.w, R.h, 0.5, 0.42);
  const m = Math.min(W, H);
  const radius = R.r ?? cameraRadius(R, m);
  ctx.save();
  ctx.globalAlpha = layout.cameraAlpha ?? 1;
  if (!R.full) {
    ctx.shadowColor = 'rgba(10,12,20,0.38)';
    ctx.shadowBlur = m * 0.04;
    ctx.shadowOffsetY = m * 0.012;
  }
  const path = () => {
    if (R.full || radius <= 0) { ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); }
    else roundRectPath(ctx, R.x, R.y, R.w, R.h, radius);
  };
  path();
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  path();
  ctx.clip();
  if (edit.layout.mirror) {
    ctx.translate(R.x + R.w, R.y);
    ctx.scale(-1, 1);
    ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, R.w, R.h);
  } else {
    ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, R.x, R.y, R.w, R.h);
  }
  ctx.restore();
  const ring = (R.ring ?? (edit.layout.mode === 'pip' ? 1 : 0)) * (layout.cameraAlpha ?? 1);
  if (!R.full && ring > 0.01) {
    ctx.save();
    path();
    ctx.lineWidth = Math.max(2, m * 0.0045);
    ctx.strokeStyle = `rgba(255,255,255,${0.92 * ring})`;
    ctx.stroke();
    ctx.restore();
  }
}

// ---- B-roll (S-04): images and clips over the screen (or the whole frame) with a short crossfade ----------
export const BROLL_FADE = 0.3;
/** B-roll items visible at source time t, with their opacity (crossfaded at both ends). */
export function brollAt(edit, t) {
  const out = [];
  for (const b of edit.broll || []) {
    if (t < b.start || t >= b.end) continue;
    const k = Math.max(0, Math.min(1, (t - b.start) / BROLL_FADE, (b.end - t) / BROLL_FADE));
    out.push({ item: b, alpha: k * (b.opacity ?? 1) });
  }
  return out;
}
function drawBroll(ctx, W, H, layout, edit, t, sources) {
  if (!sources) return;
  for (const { item, alpha } of brollAt(edit, t)) {
    const src = sources[item.id];
    const d = dimsOf(src);
    if (!src || !d || alpha <= 0) continue;
    const area = item.area === 'full' || !layout.screen ? { x: 0, y: 0, w: W, h: H } : layout.screen;
    const rounded = item.area !== 'full' && layout.screen && layout.pad > 0;
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRectPath(ctx, area.x, area.y, area.w, area.h, rounded ? layout.radius : 0);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(area.x, area.y, area.w, area.h);
    ctx.imageSmoothingQuality = 'high';
    if (item.fit === 'contain') {
      const r = fitContain(d.w, d.h, area);
      ctx.drawImage(src, r.x, r.y, r.w, r.h);
    } else {
      const c = coverCrop(d.w, d.h, area.w, area.h);
      ctx.drawImage(src, c.x, c.y, c.w, c.h, area.x, area.y, area.w, area.h);
    }
    ctx.restore();
  }
}

// ---- brand overlays (S-02): logo bug and lower third ---------------------------------------------
function drawLogo(ctx, W, H, opts, bmp) {
  if (!opts?.enabled || !bmp) return;
  const m = Math.min(W, H);
  const w = Math.max(16, (opts.size ?? 0.12) * m);
  const h = (w * bmp.height) / Math.max(1, bmp.width);
  const margin = m * 0.035;
  const c = opts.corner || 'tr';
  const x = c.includes('r') ? W - margin - w : margin, y = c.includes('b') ? H - margin - h : margin;
  ctx.save();
  ctx.globalAlpha = opts.opacity ?? 0.9;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, x, y, w, h);
  ctx.restore();
}

function drawLowerThird(ctx, W, H, lt, t) {
  if (!lt?.enabled || !lt.title) return;
  const start = lt.start ?? 0.5, dur = lt.duration ?? 5;
  if (t < start || t > start + dur) return;
  const ease = Math.min(1, (t - start) / 0.4, (start + dur - t) / 0.4);
  const k = ease * ease * (3 - 2 * ease);
  const m = Math.min(W, H), vertical = H > W;
  const size = m * (vertical ? 0.05 : 0.038);
  const x0 = vertical ? W * 0.08 : W * 0.06;
  const y0 = vertical ? H * 0.68 : H * 0.72;
  ctx.save();
  ctx.globalAlpha = k;
  ctx.translate((1 - k) * -m * 0.03, 0);
  ctx.font = `600 ${size}px "Geist", system-ui, sans-serif`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(-0.01 * size).toFixed(2)}px`;
  const tw = ctx.measureText(lt.title).width;
  ctx.font = `450 ${size * 0.62}px "Geist", system-ui, sans-serif`;
  const sw = lt.subtitle ? ctx.measureText(lt.subtitle).width : 0;
  const padX = size * 0.6, padY = size * 0.42;
  const bw = Math.max(tw, sw) + padX * 2, bh = size * (lt.subtitle ? 1.95 : 1.2) + padY * 2;
  ctx.fillStyle = 'rgba(14,15,18,0.78)';
  roundRectPath(ctx, x0, y0, bw, bh, size * 0.3);
  ctx.fill();
  ctx.fillStyle = lt.color || '#8b93ff';
  roundRectPath(ctx, x0, y0 + padY * 0.8, size * 0.12, bh - padY * 1.6, size * 0.06);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${size}px "Geist", system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(lt.title, x0 + padX, y0 + padY);
  if (lt.subtitle) {
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = `450 ${size * 0.62}px "Geist", system-ui, sans-serif`;
    ctx.fillText(lt.subtitle, x0 + padX, y0 + padY + size * 1.22);
  }
  ctx.restore();
}

/**
 * Render one frame.
 * f = { screen, camera, edit, t, cues }  (t = SOURCE time of the screen recording)
 */
export function renderFrame(ctx, W, H, f) {
  const sDims = dimsOf(f.screen);
  const cDims = f.camera ? dimsOf(f.camera) : null;
  const layout = layoutForTime(f.edit, W, H, sDims, cDims, f.t);
  drawBackground(ctx, W, H, f.edit, f.screen, sDims);
  const z = f.reducedMotion ? snapZoom(zoomAt(f.edit.zooms, f.t)) : zoomAt(f.edit.zooms, f.t);
  drawScreen(ctx, W, H, layout, f.edit, f.screen, sDims, z, f.t);
  drawBroll(ctx, W, H, layout, f.edit, f.t, f.overlays?.broll);
  drawCamera(ctx, W, H, layout, f.edit, f.camera, cDims);
  // Annotations sit above B-roll and the camera, under the logo and captions (same order as macOS and the engine).
  drawAnnotations(ctx, W, H, layout, f.edit, sDims, z, f.t);
  drawLogo(ctx, W, H, f.edit.brand?.logo, f.overlays?.logo);
  drawLowerThird(ctx, W, H, f.edit.brand?.lowerThird, f.t);
  if (f.edit.captions.enabled && f.cues && f.cues.length) {
    drawCaption(ctx, W, H, cueAt(f.cues, f.t), f.t, f.edit.captions);
  }
  return { layout, zoom: z };
}

/**
 * Preview-only accessibility setting (W-10, D-03): with prefers-reduced-motion the preview shows each zoom
 * at its final framing instead of animating the ramps. Exports always keep the eased motion.
 */
function snapZoom(z) {
  return z.k > 0 ? { ...z, scale: 1 + (z.scale - 1) / z.k, x: 0.5 + (z.x - 0.5) / z.k, y: 0.5 + (z.y - 0.5) / z.k, k: 1 } : z;
}

/** Inverse-map a point on the preview canvas to normalized screen-source coordinates (for zoom focus). */
export function canvasPointToSource(edit, W, H, sDims, cDims, px, py, t = 0) {
  const layout = computeLayout({ ...edit, layout: layoutAt(edit, t) }, W, H, sDims, cDims);
  const area = layout.screen;
  if (!area || !sDims) return null;
  const dest = layout.screenFill ? area : fitContain(sDims.w, sDims.h, area);
  const u = (px - dest.x) / dest.w, v = (py - dest.y) / dest.h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  if (!layout.screenFill) return { x: u, y: v };
  const c = coverCrop(sDims.w, sDims.h, dest.w, dest.h);
  return { x: (c.x + u * c.w) / sDims.w, y: (c.y + v * c.h) / sDims.h };
}
