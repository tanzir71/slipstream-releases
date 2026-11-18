// Translated subtitles (ticket A-06): pure helpers around the on-device translation model.
// Caption cues are often sentence fragments ("Now every click gets a smooth zoom," / "and your viewers…"),
// which translate badly one by one. So cues are grouped into sentences, each sentence is translated whole,
// and the translation is spread back over the original cues in proportion to their source length,
// cutting at word boundaries (or CJK/Thai word segments) and preferring punctuation.
// Timings, cue count and order never change. No DOM, no model. Tests: packages/editor-core/test/translate-utils.test.mjs.

const SENTENCE_END = /[.!?…。！？]["'”’)\]」』]*$/;
const UNSPACED = new Set(['zh', 'ja', 'th', 'lo', 'km', 'my', 'bo']);
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/** Languages written without spaces between words. Accepts 'zh', 'zh-Hans', 'ja-JP', … */
export function isUnspaced(lang) {
  return UNSPACED.has(String(lang || '').toLowerCase().split(/[-_]/)[0]);
}

/** One line of plain text: newlines and runs of spaces collapse, edges trimmed. */
export function normalizeCueText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Group consecutive cues into sentence-sized pieces to translate together.
 * A group ends at sentence punctuation, after `maxCues` cues, before exceeding `maxChars`, or at a
 * silence longer than `maxGap` seconds. Returns [{ from, to, text }] (inclusive cue indexes).
 */
export function groupCues(cues, { maxChars = 300, maxCues = 5, maxGap = 1.0, lang = 'en' } = {}) {
  const sep = isUnspaced(lang) ? '' : ' ';
  const groups = [];
  let cur = null;
  const close = () => { if (cur) { cur.text = cur.parts.join(sep); delete cur.parts; groups.push(cur); } cur = null; };
  for (let i = 0; i < cues.length; i++) {
    const text = normalizeCueText(cues[i].text);
    if (cur) {
      const gap = (Number(cues[i].start) || 0) - (Number(cues[i - 1].end) || 0);
      const len = cur.parts.reduce((a, p) => a + p.length + 1, 0) + text.length;
      if (gap > maxGap || len > maxChars || cur.to - cur.from + 1 >= maxCues) close();
    }
    if (!cur) cur = { from: i, to: i, parts: [] };
    cur.to = i;
    cur.parts.push(text);
    if (SENTENCE_END.test(text)) close();
  }
  close();
  return groups;
}

/**
 * Split text into units that can be rejoined with '' (each unit keeps its trailing space/punctuation).
 * Spaced languages split at spaces; Chinese, Japanese, Thai… use Intl.Segmenter words when available,
 * else characters. Punctuation never starts a unit.
 */
export function splitUnits(text, lang = 'en') {
  const s = String(text ?? '');
  if (!s) return [];
  let units;
  if (isUnspaced(lang) || (CJK.test(s) && !/\s/.test(s.trim()))) {
    let segs;
    try {
      const Seg = globalThis.Intl && Intl.Segmenter;
      segs = Seg ? [...new Seg(lang, { granularity: 'word' }).segment(s)].map((x) => x.segment) : Array.from(s);
    } catch { segs = Array.from(s); }
    units = [];
    for (const g of segs) {
      if (units.length && (/^[\s\p{P}\p{S}]+$/u.test(g))) units[units.length - 1] += g;
      else units.push(g);
    }
  } else {
    units = s.match(/\S+\s*/g) || [];
    const lead = s.match(/^\s+/);
    if (lead && units.length) units[0] = lead[0] + units[0];
    // Glue lone punctuation ("—", "…", French " ?") to the unit before it.
    const out = [];
    for (const u of units) {
      if (out.length && /^[\p{P}\p{S}]+\s*$/u.test(u)) out[out.length - 1] += u;
      else out.push(u);
    }
    units = out;
  }
  return units;
}

const BREAK_AFTER = /[,;:，、；：.!?。！？…)\]»”」』—–-]\s*$/;

/**
 * Spread `text` over parts with relative `weights` (e.g. source cue lengths). Cuts fall on unit
 * boundaries nearest each proportional position, preferring a boundary right after punctuation when
 * one is close. Returns an array of weights.length non-empty strings, or null when the text has fewer
 * units than parts (caller should translate those cues one by one instead).
 */
export function distributeText(text, weights, { lang = 'en', snap = 0.12 } = {}) {
  const n = weights.length;
  if (!n) return [];
  const clean = normalizeCueText(text);
  if (n === 1) return clean ? [clean] : null;
  const units = splitUnits(clean, lang);
  if (units.length < n) return null;
  const total = units.reduce((a, u) => a + u.length, 0);
  const pos = []; // character offset after unit k
  let acc = 0;
  for (const u of units) { acc += u.length; pos.push(acc); }
  const wsum = weights.reduce((a, w) => a + Math.max(0, Number(w) || 0), 0) || n;
  const cuts = [];
  let cum = 0;
  let prev = -1;
  for (let k = 0; k < n - 1; k++) {
    cum += Math.max(0, Number(weights[k]) || 0) || (wsum === n ? 1 : 0);
    const target = (cum / wsum) * total;
    const lo = prev + 1, hi = units.length - (n - 1 - k) - 1; // leave ≥ 1 unit for every later part
    let best = lo, bestCost = Infinity;
    for (let b = lo; b <= hi; b++) {
      let cost = Math.abs(pos[b] - target) / total;
      if (BREAK_AFTER.test(units[b])) cost -= snap;
      if (cost < bestCost) { bestCost = cost; best = b; }
    }
    cuts.push(best);
    prev = best;
  }
  const parts = [];
  let start = 0;
  for (const c of [...cuts, units.length - 1]) {
    parts.push(units.slice(start, c + 1).join('').trim());
    start = c + 1;
  }
  return parts.every(Boolean) ? parts : null;
}

/**
 * Batches of item indexes for the model: similar lengths together (less padding, fewer artifacts),
 * at most `maxItems` items and about `maxChars` characters per batch. Returns [[i, …], …].
 */
export function batchTexts(texts, { maxItems = 8, maxChars = 1200 } = {}) {
  const order = texts.map((t, i) => i).sort((a, b) => String(texts[a]).length - String(texts[b]).length || a - b);
  const batches = [];
  let cur = [], chars = 0;
  for (const i of order) {
    const len = String(texts[i]).length;
    if (cur.length && (cur.length >= maxItems || chars + len > maxChars)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(i);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Tidy a raw model translation: special tokens and SentencePiece marks, runaway repetition, stray spacing
 * (CJK text gets no spaces; French keeps its space before ? ! : ;), punctuation the source didn't have.
 */
export function cleanTranslation(text, { source = '', lang = 'en' } = {}) {
  let t = String(text ?? '')
    .replace(/<unk>|<pad>|<\/?s>/g, ' ')
    .replace(/>>[\w-]+<<\s*/g, '')
    .replace(/▁/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Runaway loops: the same 1–6 words three or more times in a row → once.
  t = t.replace(/(^|\s)((?:[\p{L}\p{N}'’-]+[,.]?\s+){0,5}[\p{L}\p{N}'’-]+[,.]?)(?:\s+\2){2,}(?=\s|$)/giu, '$1$2');
  const base = String(lang || '').toLowerCase().split(/[-_]/)[0];
  if (isUnspaced(lang) || CJK.test(t)) {
    t = t.replace(/(.{1,8}?)\1{3,}/gu, '$1');
    t = t.replace(/([　-鿿＀-￯])\s+(?=[　-鿿＀-￯])/g, '$1');
    t = t.replace(/\s+([，。！？、；：」』）])/g, '$1');
    if (base === 'zh' || base === 'ja') t = t.replace(/([㐀-鿿぀-ヿ])\s*,\s*(?=[㐀-鿿぀-ヿ])/g, base === 'zh' ? '$1，' : '$1、');
  } else if (base === 'fr') {
    t = t.replace(/\s+([,.)])/g, '$1');
  } else {
    t = t.replace(/\s+([,.;:!?)])/g, '$1');
  }
  t = t.replace(/\(\s+/g, '(');
  // "segundos.." → "segundos." unless the source itself trails off.
  const src = normalizeCueText(source);
  if (!/(\.\.|…)$/.test(src)) t = t.replace(/([.!?。！？])\1+$/u, '$1');
  // A fragment without final punctuation shouldn't gain a full stop.
  if (src && !/[.!?…。！？]["'”’)\]」』]*$/.test(src)) t = t.replace(/(?<![.!?…])[.。]$/u, '');
  return t.trim();
}

/** Plan: groups of cues and the texts to send to the model (one per group). */
export function planTranslation(cues, { source = 'en', maxChars, maxCues, maxGap } = {}) {
  const groups = groupCues(cues, { lang: source, maxChars, maxCues, maxGap });
  return { groups, texts: groups.map((g) => g.text) };
}

/**
 * Put translated group texts back onto the cues. Returns { cues, retry } where cues keep start/end/order
 * (text '' for cues listed in `retry`) and retry lists cue indexes whose group could not be spread
 * (translate those one by one, then call fillRetries).
 */
export function assembleTranslation(cues, groups, translated, { target = 'en' } = {}) {
  const out = cues.map((c) => ({ start: c.start, end: c.end, text: '' }));
  const retry = [];
  groups.forEach((g, gi) => {
    const srcTexts = [];
    for (let i = g.from; i <= g.to; i++) srcTexts.push(normalizeCueText(cues[i].text));
    const tr = cleanTranslation(translated[gi], { source: g.text, lang: target });
    const weights = srcTexts.map((t) => Math.max(1, t.length));
    const parts = distributeText(tr, weights, { lang: target });
    if (!parts) { for (let i = g.from; i <= g.to; i++) retry.push(i); return; }
    parts.forEach((p, k) => { out[g.from + k].text = p; });
  });
  return { cues: out, retry };
}

/** Fill cues listed in `retry` with their one-by-one translations (cleaned); falls back to the source text. */
export function fillRetries(out, cues, retry, translated, { target = 'en' } = {}) {
  const res = out.map((c) => ({ ...c }));
  retry.forEach((i, k) => {
    const src = normalizeCueText(cues[i].text);
    res[i].text = cleanTranslation(translated[k], { source: src, lang: target }) || src;
  });
  return res;
}
