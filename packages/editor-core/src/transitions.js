// Auto edit transitions (ticket AE-09), on the output timeline, from edit.autoEdit.transitions and the song's beat
// grid (autoedit-tweaks.outputBeats). compositor.renderFrame() applies them, so the preview and both web exporters
// show the same frames. Pure: no DOM. Tested in test/autoedit-tweaks.test.mjs; parity/transitions.json for the ports.
//   - Zoom punch on downbeats: the picture scales 1.00 → 1.06 over one beat from each downbeat (smootherstep), then
//     eases back over half a beat.
//   - Flash on the drop: a white flash (0.85 → 0 over 0.3 s, quadratic) where the chorus (else the loudest section)
//     starts.
//   - Crossfade between sections: at a cut that falls on a section boundary, the picture dips through black over half
//     a beat (a quarter beat out, a quarter beat in). It is a dip rather than a mix of two clips, so a frame needs
//     only one source.

import { smootherstep, smoothstep, sequenceSegments } from './edl.js';
import { outputBeats } from './autoedit-tweaks.js';

export const PUNCH = 0.06;
export const FLASH = 0.85;
export const FLASH_DUR = 0.3;

/** Picture scale at t for the zoom punch: 1 outside, up to 1 + PUNCH a beat after a downbeat. */
export function punchScale(downbeats, beat, t) {
  if (!(beat > 0)) return 1;
  for (let i = downbeats.length - 1; i >= 0; i--) {
    const d = downbeats[i];
    if (d > t) continue;
    const k = (t - d) / beat;
    if (k < 1) return 1 + PUNCH * smootherstep(k);
    if (k < 1.5) return 1 + PUNCH * (1 - smootherstep((k - 1) / 0.5));
    return 1;
  }
  return 1;
}

/** White flash opacity at t after the drop times. */
export function flashAlpha(drops, t, dur = FLASH_DUR) {
  for (const d of drops) {
    const k = (t - d) / dur;
    if (k >= 0 && k < 1) return FLASH * (1 - k) * (1 - k);
  }
  return 0;
}

/** Picture opacity at t for dips at the given cut times, each `half` seconds either side (0 at the cut). */
export function dipAlpha(cuts, t, half) {
  if (!(half > 0)) return 1;
  let a = 1;
  for (const c of cuts) {
    const k = Math.abs(t - c) / half;
    if (k < 1) a = Math.min(a, smoothstep(k));
  }
  return a;
}

/** Where the drop is: the first chorus, else the loudest section after the first, on the output timeline. */
export function dropTimes(grid) {
  const secs = (grid?.sections || []).filter((s) => s.start > 0.05);
  const chorus = secs.find((s) => /chorus|drop/i.test(String(s.label || '')));
  if (chorus) return [chorus.start];
  const loud = [...secs].sort((a, b) => (b.energy ?? 0) - (a.energy ?? 0))[0];
  return loud ? [loud.start] : [];
}

/** Cuts that fall on a section boundary (within a tenth of a beat). */
export function sectionCuts(edit, grid) {
  if (!grid) return [];
  const cuts = sequenceSegments(edit.segments).slice(0, -1).map((s) => s.end);
  const bounds = grid.sections.map((s) => s.start).filter((t) => t > 0.05);
  return cuts.filter((c) => bounds.some((b) => Math.abs(b - c) <= grid.beat / 10));
}

/**
 * The transitions in effect at output time t: { scale, flash, alpha } (picture scale, white flash opacity, picture
 * opacity). Neutral ({ 1, 0, 1 }) unless the edit is an Auto edit to music with that transition on. `cache` is an
 * optional object the caller keeps per edit, so the grid isn't rebuilt every frame.
 */
export function transitionsAt(edit, t, cache = null) {
  const tr = edit?.autoEdit?.transitions;
  const neutral = { scale: 1, flash: 0, alpha: 1 };
  if (!tr || !(tr.punch || tr.flash || tr.sectionFade)) return neutral;
  let c = cache && cache.edit === edit ? cache : null;
  if (!c) {
    const grid = outputBeats(edit);
    c = { edit, grid, drops: grid ? dropTimes(grid) : [], cuts: grid ? sectionCuts(edit, grid) : [] };
    if (cache) Object.assign(cache, c);
  }
  if (!c.grid) return neutral;
  return {
    scale: tr.punch ? punchScale(c.grid.downbeats, c.grid.beat, t) : 1,
    flash: tr.flash ? flashAlpha(c.drops, t) : 0,
    alpha: tr.sectionFade ? dipAlpha(c.cuts, t, c.grid.beat / 4) : 1,
  };
}
