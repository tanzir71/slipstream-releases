// Edit for clarity (ticket A-07), heuristic tier: proposes sentence-level cuts that remove restarts,
// repetition, tangents, filler-heavy and low-information sentences until the output fits a target
// duration. Never applies anything: the host shows proposals as a diff (cut_words ops) for review.
// An LLM tier can replace or re-rank these; this one always works offline.

import {
  normalizeWord, HARD_FILLERS, SOFT_FILLERS, segmentWords, detectRetakes, computeCuts, keptRanges,
  totalDuration, wordCutRanges, wordIdOf, markFillers, MIN_RANGE,
} from './edl.js';

export const STOP_WORDS = new Set(`a an the and or but if then so to of in on at by for with from up down out over into onto about as is am are was were be been being it its it's this that these those there here
i me my mine we us our you your yours he him his she her they them their what which who whom whose when where why how all any both each few more most other some such no nor not only own same than too very
can will just don't do does did doing have has had having i'm you're we're they're i've we've you've i'll we'll you'll let's let get got go going gonna wanna kind sort thing things really also well yeah yes oh
okay ok right like actually basically literally just would could should might must shall may one that's what's here's there's
who's how's i'd you'd we'd today now want need`.split(/\s+/));

const TANGENT_OPEN = ['by the way', 'side note', 'on a side note', 'fun fact', 'random', 'off topic', 'tangent', 'unrelated', 'speaking of', 'funny story', 'quick story', 'long story short', 'back in the day', 'as an aside', 'i digress', 'little detour', 'before i forget', 'remember when'];
const TANGENT_CLOSE = ['anyway', 'anyways', 'back to', 'where was i', 'moving on', 'but yeah', 'ok so', 'okay so', 'all right so', 'alright so', 'so anyway'];
const LOW_INFO = ['let me see', 'let me think', "let's see", 'where was i', 'hold on', 'one sec', 'one second', 'just a sec', 'give me a second', 'bear with me', 'what was i saying', 'how do i put this', 'does that make sense', 'you know what i mean', 'so yeah', 'yeah so', 'as i said', 'like i said', 'i guess', 'whatever'];

function stem(w) {
  let s = w.replace(/'s$/, '');
  if (s.length > 4) s = s.replace(/ies$/, 'y').replace(/(?:ing|ed|es|s)$/, '');
  return s;
}

const startsWithPhrase = (norm, list) => { const head = ` ${norm.slice(0, 5).join(' ')} `; return list.some((p) => head.startsWith(` ${p} `)); };
const hasPhrase = (norm, list) => { const all = ` ${norm.join(' ')} `; return list.some((p) => all.includes(` ${p} `)); };

/**
 * Heuristic clarity cuts. words: transcript words (deleted ones are already cut).
 * opts = { duration, targetDuration?, kept? } — kept = current kept ranges (computeCuts + keptRanges
 * of the whole edit) so pauses, manual cuts and the clip range are taken into account.
 * Returns ranked proposals [{ from_word_id, to_word_id, reason, seconds, text, start, end, score }],
 * accumulated until the output would be at or under targetDuration (all of them when no target).
 * reason: 'restart' | 'repeat' | 'tangent' | 'filler-heavy' | 'low-information'.
 */
export function clarityCuts(words, { duration, targetDuration, kept } = {}) {
  const ws = words || [];
  if (!ws.some((w) => !w.deleted)) return [];
  const dur = duration > 0 ? duration : Math.max(...ws.map((w) => w.end || 0));
  const baseKept = kept || keptRanges(computeCuts({ words: ws, cuts: [], range: null }, dur), dur);
  // Everything outside the current kept ranges stays cut while we try word deletions.
  const baseCuts = [];
  let t = 0;
  for (const k of baseKept) { if (k.start > t) baseCuts.push({ start: t, end: k.start }); t = k.end; }
  if (t < dur) baseCuts.push({ start: t, end: dur });
  const outOf = (st) => totalDuration(keptRanges([...baseCuts, ...wordCutRanges(st, dur)], dur));
  let current = totalDuration(baseKept);
  const target = Number.isFinite(targetDuration) ? targetDuration : null;
  if (target !== null && current <= target) return [];

  const marked = markFillers(ws);
  const segs = segmentWords(ws, { pause: 0.9 }).map((s) => {
    const norm = s.indices.map((i) => normalizeWord(ws[i].text)).filter(Boolean);
    const content = norm.filter((n) => !STOP_WORDS.has(n) && !HARD_FILLERS.has(n) && !SOFT_FILLERS.has(n)).map(stem);
    const fillers = s.indices.filter((i) => marked[i].filler).length;
    const hard = s.indices.filter((i) => marked[i].filler === 'hard').length;
    const text = s.indices.map((i) => ws[i].text).join(' ');
    return { ...s, norm, content, fillers, hard, text, hasNumber: /\d/.test(text), secs: Math.max(0.2, s.end - s.start) };
  });
  const cands = [];
  const add = (from, to, reason, score, ref = null) => { if (to >= from) cands.push({ from, to, reason, score, ref }); };

  // Restarts and immediate repeats (W-04).
  for (const p of detectRetakes(ws)) {
    const last = String(ws[p.to].text || '').trim();
    add(p.from, p.to, /[.!?]["')\]]?$/.test(last) ? 'repeat' : 'restart', /[.!?]["')\]]?$/.test(last) ? 0.95 : 1);
  }

  // Df of content stems across sentences, for repeats and off-topic detection.
  const df = new Map();
  for (const s of segs) for (const c of new Set(s.content)) df.set(c, (df.get(c) || 0) + 1);

  segs.forEach((s, k) => {
    const n = s.norm.length;
    // A later sentence that says the same thing again (not the closing line: recaps are deliberate).
    if (s.content.length >= 4 && k < segs.length - 1) {
      const mine = new Set(s.content);
      for (let j = 0; j < k; j++) {
        const theirs = new Set(segs[j].content);
        let common = 0;
        for (const c of mine) if (theirs.has(c)) common++;
        // ref: the earlier sentence must survive, or cutting this one would lose the point entirely.
        if (common / mine.size >= 0.75) { add(s.from, s.to, 'repeat', 0.8, segs[j].indices); break; }
      }
    }
    // Tangent: an opener ("by the way", "fun fact") through to just before a closer ("anyway").
    if (startsWithPhrase(s.norm, TANGENT_OPEN)) {
      let end = k;
      for (let j = k + 1; j < Math.min(segs.length, k + 5); j++) {
        if (startsWithPhrase(segs[j].norm, TANGENT_CLOSE)) { end = j - 1; break; }
      }
      add(s.from, segs[end].to, 'tangent', 0.75);
    }
    if (n >= 3 && (s.fillers / n >= 0.34 || s.hard >= 3)) add(s.from, s.to, 'filler-heavy', 0.6 + Math.min(0.3, (s.fillers / n) * 0.3));
    if (!s.hasNumber && ((s.content.length <= 1 && n <= 6) || (hasPhrase(s.norm, LOW_INFO) && s.content.length <= 3))) add(s.from, s.to, 'low-information', 0.62);
    // Off-topic: a sentence whose content words appear nowhere else in a longer talk.
    if (segs.length >= 20 && k > 0 && k < segs.length - 1 && s.content.length >= 4 && !startsWithPhrase(s.norm, TANGENT_CLOSE)) {
      const shared = s.content.filter((c) => df.get(c) > 1).length / s.content.length;
      if (shared <= 0.15) add(s.from, s.to, 'tangent', 0.4);
    }
  });

  // Last resort: the least dense sentences (content words per second), never the opener or the close.
  if (segs.length >= 6) {
    const dens = segs.map((s, k) => ({ k, d: s.content.length / s.secs })).filter((x) => x.k > 0 && x.k < segs.length - 1).sort((a, b) => a.d - b.d);
    dens.slice(0, Math.ceil(dens.length / 4)).forEach((x, rank) => add(segs[x.k].from, segs[x.k].to, 'low-information', 0.3 - rank * 0.01));
  }

  cands.sort((a, b) => b.score - a.score || a.from - b.from);
  const out = [];
  const taken = [];
  let state = ws;
  for (const c of cands) {
    if (taken.some(([a, b]) => c.from <= b && c.to >= a)) continue;
    if (c.ref && c.ref.every((i) => state[i].deleted)) continue;
    const live = [];
    for (let i = c.from; i <= c.to; i++) if (!state[i].deleted) live.push(i);
    if (!live.length) continue;
    const next = state.slice();
    for (const i of live) next[i] = { ...next[i], deleted: true };
    const after = outOf(next);
    const seconds = current - after;
    if (seconds < MIN_RANGE) continue;
    taken.push([c.from, c.to]);
    state = next;
    current = after;
    const text = live.map((i) => ws[i].text).join(' ');
    out.push({
      from_word_id: wordIdOf(ws, live[0]),
      to_word_id: wordIdOf(ws, live[live.length - 1]),
      reason: c.reason,
      seconds: Math.round(seconds * 10) / 10,
      text: text.length > 120 ? `${text.slice(0, 119)}…` : text,
      start: ws[live[0]].start,
      end: ws[live[live.length - 1]].end,
      score: Math.round(c.score * 100) / 100,
    });
    if (target !== null && current <= target) break;
  }
  return out;
}
