// Captions: grouping words into cues, SRT/VTT import & export, and canvas rendering.
// Grouping/format functions are pure and unit-tested (tests/web-captions.test.mjs).

import { srcToOut, findRange } from './edl.js';

// Caption looks, set like film and broadcast subtitles: one family per look, sentence case by default,
// measured line lengths, balanced two-line breaks, soft shadows instead of hard strokes.
// size = cap height relative to the frame's short side (landscape) or width (vertical).
export const CAPTION_PRESETS = {
  studio:    { label: 'Studio',    family: 'sans',  weight: 560, italic: false, uppercase: false, tracking: -0.006, box: true,  highlight: 'progress', shadow: 0,   size: 0.043, vSize: 0.054, maxWords: 9,  maxChars: 46, lines: 2 },
  cinema:    { label: 'Cinema',    family: 'sans',  weight: 520, italic: false, uppercase: false, tracking: 0,      box: false, highlight: 'none',     shadow: 1, scrim: 0.42, size: 0.041, vSize: 0.05,  maxWords: 12, maxChars: 64, lines: 2 },
  editorial: { label: 'Editorial', family: 'serif', weight: 440, italic: true,  uppercase: false, tracking: -0.004, box: false, highlight: 'none',     shadow: 1, scrim: 0.42, size: 0.05,  vSize: 0.062, maxWords: 10, maxChars: 52, lines: 2 },
  bold:      { label: 'Bold',      family: 'sans',  weight: 780, italic: false, uppercase: true,  tracking: -0.024, box: false, highlight: 'color',    shadow: 1, scrim: 0.36, size: 0.06,  vSize: 0.086, maxWords: 3,  maxChars: 18, lines: 2 },
};

/** Older projects stored these preset ids. */
export const LEGACY_PRESETS = { pop: 'bold', neon: 'bold', boxed: 'studio', karaoke: 'studio', minimal: 'cinema' };
export function resolvePreset(id) { return CAPTION_PRESETS[id] ? id : (LEGACY_PRESETS[id] || 'studio'); }

const FAMILIES = {
  sans: '"Geist", "SF Pro Display", "Segoe UI", system-ui, sans-serif',
  serif: '"Newsreader", "Iowan Old Style", Georgia, serif',
};

/** Make sure caption faces are decoded before drawing (preview and export). */
export async function ensureCaptionFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  await Promise.all([
    document.fonts.load('560 48px "Geist"'), document.fonts.load('780 48px "Geist"'), document.fonts.load('520 48px "Geist"'),
    document.fonts.load('italic 440 48px "Newsreader"'),
  ].map((p) => p.catch(() => null)));
}

const SENTENCE_END = /[.!?…]["')\]]?$/;
const CLAUSE_END = /[,;:]$/;

/**
 * Group transcript words into caption cues. Deleted words are skipped.
 * Returns [{ start, end, text, words: [{ text, start, end }] }] in source time.
 */
export function buildCues(words, { maxWords = 6, maxChars = 32, maxGap = 0.6, maxDur = 3.2 } = {}) {
  const cues = [];
  let cur = null;
  const push = () => { if (cur && cur.words.length) { cur.text = cur.words.map((w) => w.text).join(' '); cues.push(cur); } cur = null; };
  for (const w of words) {
    if (w.deleted) continue;
    const text = String(w.text).trim();
    if (!text) continue;
    if (cur) {
      const last = cur.words[cur.words.length - 1];
      const chars = cur.words.reduce((n, x) => n + x.text.length + 1, 0) + text.length;
      const tooLong = cur.words.length >= maxWords || chars > maxChars || w.end - cur.start > maxDur;
      const gap = w.start - last.end > maxGap;
      // short-form looks (2–3 words) break at commas sooner so chunks read as phrases, not fragments
      const brk = SENTENCE_END.test(last.text) || (CLAUSE_END.test(last.text) && cur.words.length >= Math.min(3, Math.max(2, maxWords - 1)));
      if (tooLong || gap || brk) push();
    }
    if (!cur) cur = { start: w.start, end: w.end, words: [] };
    cur.words.push({ text, start: w.start, end: w.end });
    cur.end = w.end;
  }
  push();
  return cues;
}

/** Cue visible at source time t (cues are sorted). */
export function cueAt(cues, t, hold = 0.25) {
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    const next = cues[mid + 1];
    const end = next ? Math.min(c.end + hold, next.start) : c.end + hold;
    if (t < c.start) hi = mid - 1;
    else if (t >= end) lo = mid + 1;
    else return c;
  }
  return null;
}

/** Re-time cues onto the output timeline (after cuts). Cues fully inside cuts are dropped. */
export function remapCues(cues, kept) {
  const out = [];
  for (const c of cues) {
    const live = c.words.filter((w) => findRange(kept, (w.start + w.end) / 2) >= 0);
    if (!live.length) continue;
    const start = srcToOut(kept, live[0].start);
    const end = Math.max(start + 0.2, srcToOut(kept, live[live.length - 1].end));
    out.push({ start, end, text: live.map((w) => w.text).join(' ') });
  }
  for (let i = 0; i < out.length - 1; i++) out[i].end = Math.min(out[i].end, out[i + 1].start);
  return out;
}

export function formatTimestamp(sec, sep = ',') {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

export function toSRT(cues) {
  return cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}\n`).join('\n');
}

export function toVTT(cues) {
  return 'WEBVTT\n\n' + cues.map((c) => `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.text}\n`).join('\n');
}

function parseTs(s) {
  const m = String(s).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (!m) return NaN;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/** Parse SRT or WebVTT text into cues [{start, end, text}]. */
export function parseSubtitles(text) {
  const blocks = String(text).replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, z] = lines[idx].split('-->');
    const start = parseTs(a), end = parseTs(z);
    const body = lines.slice(idx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) cues.push({ start, end, text: body });
  }
  return cues;
}

/** Turn cue-level subtitles into approximate word timings (distributed by character length). */
export function cuesToWords(cues, idFor = (i) => `w${i}`) {
  const words = [];
  for (const c of cues) {
    const parts = c.text.split(/\s+/).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    let t = c.start;
    for (const p of parts) {
      const d = ((p.length + 1) / total) * (c.end - c.start);
      words.push({ id: idFor(words.length), text: p, start: t, end: t + d * 0.92 });
      t += d;
    }
  }
  return words;
}

// ---------------------------------------------------------------------------------------------
// Rendering

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

/** Greedy wrap, then rebalance two-line cues so the top line is no longer than the bottom (subtitle convention). */
function layoutLines(words, maxWidth, space, maxLines) {
  const lines = [];
  let line = { words: [], width: 0 };
  for (const w of words) {
    const add = (line.words.length ? space : 0) + w.w;
    if (line.words.length && line.width + add > maxWidth) { lines.push(line); line = { words: [], width: 0 }; }
    line.words.push(w);
    line.width += line.words.length > 1 ? space + w.w : w.w;
  }
  if (line.words.length) lines.push(line);
  if (lines.length === 2 || (lines.length === 1 && maxLines >= 2 && lines[0].width > maxWidth * 0.82 && words.length > 3)) {
    // choose the split that minimises the longer line while keeping top <= bottom
    const all = lines.flatMap((l) => l.words);
    const width = (arr) => arr.reduce((n, w, i) => n + w.w + (i ? space : 0), 0);
    let best = null;
    for (let k = 1; k < all.length; k++) {
      const a = all.slice(0, k), b = all.slice(k);
      const wa = width(a), wb = width(b);
      if (wa > maxWidth || wb > maxWidth) continue;
      const score = Math.max(wa, wb) + (wa > wb ? (wa - wb) * 0.6 : 0);
      if (!best || score < best.score) best = { score, lines: [{ words: a, width: wa }, { words: b, width: wb }] };
    }
    if (best) return best.lines;
  }
  return lines;
}

/**
 * Draw the caption cue for source time t into a canvas of size W x H.
 * opts = { preset, position, size, color, uppercase }
 */
export function drawCaption(ctx, W, H, cue, t, opts) {
  if (!cue) return;
  const P = CAPTION_PRESETS[resolvePreset(opts.preset)];
  const vertical = W < H;
  const upper = opts.uppercase ?? P.uppercase;
  const base = (vertical ? W * P.vSize : Math.min(W, H) * P.size) * (opts.size || 1);
  ctx.save();
  ctx.font = `${P.italic ? 'italic ' : ''}${P.weight} ${base}px ${FAMILIES[P.family]}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(P.tracking * base).toFixed(2)}px`;
  if ('textRendering' in ctx) ctx.textRendering = 'optimizeLegibility';
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
  ctx.textBaseline = 'alphabetic';
  const space = ctx.measureText(' ').width;
  const words = cue.words.map((w) => {
    const text = upper ? w.text.toLocaleUpperCase() : w.text;
    return { ...w, text, w: ctx.measureText(text).width };
  });
  const maxWidth = W * (vertical ? 0.84 : (P.box ? 0.66 : 0.72));
  const lines = layoutLines(words, maxWidth, space, P.lines);
  const lineH = base * (P.family === 'serif' ? 1.24 : 1.3);
  const blockH = lines.length * lineH;
  const pos = opts.position || 'bottom';
  const safeBottom = vertical ? H * 0.2 : H * 0.075;
  const safeTop = vertical ? H * 0.13 : H * 0.08;
  const cy = pos === 'top' ? safeTop + blockH / 2 : pos === 'middle' ? H * 0.5 : H - safeBottom - blockH / 2;
  const accent = opts.color || '#ffd34d';
  const activeIdx = words.findIndex((w) => t >= w.start && t < w.end + 0.06);

  if (P.scrim) {
    // a soft, wide shadow pool behind the words keeps white type legible on bright UI without a hard plate
    const bw = Math.max(...lines.map((l) => l.width));
    const g = ctx.createRadialGradient(W / 2, cy, 0, W / 2, cy, bw * 0.75);
    g.addColorStop(0, `rgba(0,0,0,${P.scrim})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(W / 2, cy); ctx.scale(1, Math.max(0.35, (blockH * 1.6) / (bw * 1.5))); ctx.translate(-W / 2, -cy);
    ctx.fillStyle = g;
    ctx.fillRect(W / 2 - bw, cy - bw, bw * 2, bw * 2);
    ctx.restore();
  }

  if (P.box) {
    const padX = base * 0.62, padY = base * 0.34;
    const bw = Math.max(...lines.map((l) => l.width)) + padX * 2;
    const bh = blockH + padY * 2 - (lineH - base * 1.08);
    ctx.fillStyle = 'rgba(14,15,18,0.66)';
    roundRect(ctx, W / 2 - bw / 2, cy - bh / 2, bw, bh, base * 0.36);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = Math.max(1, base * 0.02);
    ctx.stroke();
  }

  let k = 0;
  lines.forEach((line, li) => {
    let x = W / 2 - line.width / 2;
    const y = cy - blockH / 2 + lineH * li + lineH * 0.5 + base * 0.36;
    for (const w of line.words) {
      const idx = k++;
      const active = idx === activeIdx;
      const spoken = t >= w.start;
      let fill = '#ffffff';
      let alpha = 1;
      if (P.highlight === 'progress') alpha = spoken ? 1 : 0.58;
      if (P.highlight === 'color' && active) fill = accent;
      if (P.shadow > 0) {
        // broadcast-style drop shadow: wide and soft, so white type holds up over bright UI
        ctx.shadowColor = `rgba(0,0,0,${0.72 * P.shadow})`;
        ctx.shadowBlur = base * 0.3;
        ctx.shadowOffsetY = base * 0.045;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fillText(w.text, x, y);
      if (P.shadow > 0) {
        // a tighter second pass keeps edges crisp on bright footage without a hard outline
        ctx.shadowColor = `rgba(0,0,0,${0.6 * P.shadow})`;
        ctx.shadowBlur = base * 0.07;
        ctx.shadowOffsetY = 0;
        ctx.fillText(w.text, x, y);
      }
      x += w.w + space;
    }
  });
  ctx.restore();
}
