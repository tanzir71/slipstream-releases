// Local "Find clips": scores transcript windows for short-form potential. No network, no model.
// Heuristics mirror what creator tools look for: a hook in the first sentence, information density,
// few fillers, few dead pauses, and a clean sentence ending. Unit-tested in tests/web-highlights.test.mjs.

import { normalizeWord, HARD_FILLERS } from './edl.js';

const HOOK_STARTS = ['how', 'why', 'what', 'here', 'heres', "here's", 'this', 'stop', 'never', 'dont', "don't", 'the', 'most', 'you', 'if', 'imagine', 'secret', 'nobody', 'every'];
const HOOK_WORDS = ['secret', 'mistake', 'mistakes', 'trick', 'tip', 'tips', 'fastest', 'easiest', 'best', 'worst', 'never', 'always', 'stop', 'free', 'instantly', 'actually', 'nobody', 'everyone', 'hack', 'why', 'how'];
const VALUE_WORDS = ['because', 'step', 'first', 'second', 'then', 'finally', 'example', 'means', 'result', 'so', 'instead', 'faster', 'save', 'saves', 'without'];

/** Split words into sentences using punctuation and long pauses. */
export function sentences(words, { pause = 0.9 } = {}) {
  const out = [];
  let cur = [];
  const live = words.filter((w) => !w.deleted);
  for (let i = 0; i < live.length; i++) {
    const w = live[i];
    cur.push(w);
    const next = live[i + 1];
    const end = /[.!?…]["')\]]?$/.test(w.text) || !next || next.start - w.end > pause;
    if (end) { out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur }); cur = []; }
  }
  return out;
}

function hookScore(sentence) {
  const first = sentence.words.slice(0, 8).map((w) => normalizeWord(w.text));
  let s = 0;
  const reasons = [];
  if (HOOK_STARTS.includes(first[0])) { s += 1; reasons.push('strong opener'); }
  if (sentence.words.some((w) => /\?$/.test(w.text))) { s += 1.2; reasons.push('opens with a question'); }
  if (first.some((w) => HOOK_WORDS.includes(w))) { s += 1; reasons.push('hook words'); }
  if (sentence.words.some((w) => /\d/.test(w.text))) { s += 0.8; reasons.push('specific numbers'); }
  return { s, reasons };
}

/**
 * Find up to `count` non-overlapping clip candidates of minDur..maxDur seconds.
 * Returns [{ start, end, score (0..100), title, reasons }] sorted by score.
 */
export function findHighlights(words, { minDur = 12, maxDur = 60, count = 5 } = {}) {
  const sents = sentences(words);
  const cands = [];
  for (let i = 0; i < sents.length; i++) {
    let j = i;
    while (j < sents.length && sents[j].end - sents[i].start < minDur) j++;
    for (; j < sents.length && sents[j].end - sents[i].start <= maxDur; j++) {
      const span = sents.slice(i, j + 1);
      const ws = span.flatMap((s) => s.words);
      const dur = sents[j].end - sents[i].start;
      const norm = ws.map((w) => normalizeWord(w.text));
      const fillers = norm.filter((n) => HARD_FILLERS.has(n)).length;
      let pauses = 0;
      for (let k = 1; k < ws.length; k++) if (ws[k].start - ws[k - 1].end > 0.8) pauses++;
      const wps = ws.length / dur;
      const hook = hookScore(sents[i]);
      const value = norm.filter((n) => VALUE_WORDS.includes(n)).length / Math.max(1, ws.length) * 20;
      const endsClean = /[.!?]$/.test(ws[ws.length - 1].text) ? 0.6 : 0;
      const sweet = 1 - Math.min(1, Math.abs(dur - 32) / 40);
      const raw = hook.s * 1.4 + Math.min(wps, 3.4) * 0.8 + value + endsClean + sweet - fillers * 0.35 - pauses * 0.3;
      const reasons = [...hook.reasons];
      if (wps > 2.4) reasons.push('fast-paced');
      if (fillers === 0) reasons.push('no fillers');
      if (endsClean) reasons.push('ends on a full sentence');
      cands.push({ start: sents[i].start, end: sents[j].end, raw, reasons, title: titleFrom(sents[i].words) });
    }
  }
  cands.sort((a, b) => b.raw - a.raw);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue;
    picked.push(c);
  }
  const max = Math.max(1e-6, ...picked.map((p) => p.raw));
  const min = Math.min(0, ...picked.map((p) => p.raw));
  return picked.map((p) => ({
    start: Math.max(0, p.start - 0.15),
    end: p.end + 0.25,
    score: Math.round(55 + 44 * ((p.raw - min) / (max - min || 1))),
    title: p.title,
    reasons: p.reasons.slice(0, 3),
  }));
}

export function titleFrom(words, max = 9) {
  const t = words.slice(0, max).map((w) => w.text).join(' ').replace(/[,;:]$/, '');
  return words.length > max ? t + '…' : t;
}

/** Chapters from long pauses / topic gaps. Returns [{ start, title }] in SOURCE time. */
export function suggestChapters(words, duration, { minLen = 45, maxChapters = 12 } = {}) {
  const sents = sentences(words, { pause: 1.4 });
  if (!sents.length) return [];
  const gaps = [];
  for (let i = 1; i < sents.length; i++) gaps.push({ i, gap: sents[i].start - sents[i - 1].end });
  gaps.sort((a, b) => b.gap - a.gap);
  const starts = [0];
  for (const g of gaps) {
    if (starts.length >= maxChapters) break;
    const t = sents[g.i].start;
    if (starts.every((s) => Math.abs(sents[s].start - t) >= minLen) && duration - t >= minLen / 2) starts.push(g.i);
  }
  starts.sort((a, b) => a - b);
  return starts.map((si, k) => ({ start: k === 0 ? 0 : sents[si].start, title: titleFrom(sents[si].words, 6) }));
}
