// Rule-based natural language → edit ops: the always-available offline tier of the copilot (A-01)
// and the MCP server. It understands the common requests (fillers, pauses, retakes, aspect, captions,
// camera layout, zooms, "cut everything about X", "make a 30-second reel about X", "tighten to under
// 3 minutes", render / NLE export), joined with "and" or commas. Anything else returns
// understood:false so the host can fall back to a model or show help. Pure; never applies the ops.

import { defaultEdit, segmentWords, normalizeWord, wordIdOf, outputSize, computeCuts, keptRanges } from './edl.js';
import { findHighlights } from './highlights.js';
import { clarityCuts, STOP_WORDS } from './clarity.js';
import { applyOps, validateOp, inferDuration, outputDuration, fmtTime } from './ops.js';

// ---- time expressions -----------------------------------------------------------------------------

const UNIT = { h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, ms: 0.001 };
const TIME_RE = /(\d+):(\d{2})(?::(\d{2}))?(?:\.(\d+))?|(\d+(?:\.\d+)?)\s*-?\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|ms)(?![a-z])/gi;
const ASPECT_LIKE = new Set(['9:16']);

/**
 * All time expressions in `text`, in order: [{ value (seconds), index, end, before (the word before) }].
 * Understands 0:42, 1:02:03, 42s, 42 seconds, 1m 20s, 2.5 minutes, 30-second, and a bare number after "at".
 */
export function findTimes(text) {
  const s = String(text);
  const raw = [];
  for (const m of s.matchAll(TIME_RE)) {
    let value;
    if (m[1] !== undefined) {
      const a = Number(m[1]), b = Number(m[2]), c = m[3] !== undefined ? Number(m[3]) : null;
      const frac = m[4] ? Number(`0.${m[4]}`) : 0;
      value = c === null ? a * 60 + b + frac : a * 3600 + b * 60 + c + frac;
    } else value = Number(m[5]) * UNIT[m[6].toLowerCase()];
    const before = (/([a-z]+)\W*$/i.exec(s.slice(0, m.index)) || [])[1]?.toLowerCase() || '';
    if (m[1] !== undefined && ASPECT_LIKE.has(m[0]) && !['at', 'from', 'to', 'until', 'till', 'under', 'below', 'around'].includes(before)) continue;
    raw.push({ value, index: m.index, end: m.index + m[0].length, before, unit: m[6] ? UNIT[m[6].toLowerCase()] : 0 });
  }
  for (const m of s.matchAll(/\bat\s+(\d+(?:\.\d+)?)(?![\d:.]|\s*(?:%|x\b|×|-?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|ms)\b))/gi)) {
    const index = m.index + m[0].length - m[1].length;
    if (!raw.some((r) => index >= r.index && index < r.end)) raw.push({ value: Number(m[1]), index, end: index + m[1].length, before: 'at', unit: 1 });
  }
  raw.sort((a, b) => a.index - b.index);
  // "1 minute 20 seconds", "1m20s" → one value.
  const out = [];
  for (const r of raw) {
    const prev = out[out.length - 1];
    if (prev && prev.unit > r.unit && r.unit > 0 && /^[\s,]*(?:and\s*)?$/i.test(s.slice(prev.end, r.index))) {
      prev.value += r.value; prev.end = r.end; prev.unit = r.unit;
    } else out.push({ ...r });
  }
  return out.map(({ unit, ...r }) => r);
}

// ---- topics ---------------------------------------------------------------------------------------

const GENERIC = new Set(['everything', 'anything', 'something', 'stuff', 'part', 'parts', 'bit', 'bits', 'section', 'sections', 'segment', 'segments', 'tangent', 'tangents', 'mention', 'mentions', 'talk', 'whole', 'every', 'entire']);

function topicTokens(topic) {
  return String(topic).split(/\s+/).map(normalizeWord).filter((t) => t && !STOP_WORDS.has(t) && !GENERIC.has(t));
}

function sameWord(a, b) {
  if (a === b) return true;
  const strip = (x) => (x.length > 3 ? x.replace(/'s$|s$/, '') : x);
  const x = strip(a), y = strip(b);
  if (x === y) return true;
  const n = Math.min(x.length, y.length);
  if (n < 4) return false;
  let p = 0;
  while (p < n && x[p] === y[p]) p++;
  return p >= Math.max(4, n - 2);
}

/** Live sentences (segmentWords) that mention the topic: phrase match first, then all topic words present. */
export function sentencesAbout(words, topic) {
  const T = topicTokens(topic);
  if (!T.length) return [];
  const segs = segmentWords(words || []);
  const toks = segs.map((s) => s.indices.map((i) => normalizeWord(words[i].text)).filter((t) => t && !STOP_WORDS.has(t)));
  const phrase = (ns) => ns.some((_, i) => T.every((t, q) => i + q < ns.length && sameWord(ns[i + q], t)));
  let hits = segs.filter((_, k) => phrase(toks[k]));
  if (!hits.length && T.length > 1) hits = segs.filter((_, k) => T.every((t) => toks[k].some((n) => sameWord(n, t))));
  return hits;
}

const CONTINUES = new Set(['it', "it's", 'its', 'that', "that's", 'this', 'they', "they're", 'them', 'which', 'and', 'but', 'also', 'plus', 'because', 'there', 'he', 'she', 'we', 'you']);
const CLOSER = /^(?:anyway|anyways|so anyway|back to|moving on|okay so|ok so|alright|all right)\b/;

function cutTopic(ctx, topic, { tangent = false } = {}) {
  const words = ctx.edit.words || [];
  if (!words.some((w) => !w.deleted)) return { notes: ['I need a transcript to find that. Transcribe first.'] };
  const hits = sentencesAbout(words, topic);
  if (!hits.length) return { notes: [`I couldn't find “${topic}” in the transcript`] };
  const segs = segmentWords(words);
  const pick = new Set(hits.map((h) => segs.findIndex((s) => s.from === h.from)));
  if (tangent) {
    // A tangent runs on through sentences that continue it ("It was…", "That…") until a closer.
    for (const k of [...pick].sort((a, b) => a - b)) {
      for (let j = k + 1, n = 0; j < segs.length && n < 3 && !pick.has(j); j++, n++) {
        const first = normalizeWord(words[segs[j].from].text);
        const text = segs[j].indices.map((i) => words[i].text).join(' ').toLowerCase();
        if (CLOSER.test(text) || !CONTINUES.has(first)) break;
        pick.add(j);
      }
    }
  }
  const ks = [...pick].sort((a, b) => a - b);
  const ops = [];
  for (let i = 0; i < ks.length;) {
    let j = i;
    while (j + 1 < ks.length && ks[j + 1] === ks[j] + 1) j++;
    ops.push({ op: 'cut_words', args: { from_word_id: wordIdOf(words, segs[ks[i]].from), to_word_id: wordIdOf(words, segs[ks[j]].to) } });
    i = j + 1;
  }
  return { ops };
}

// ---- planners -------------------------------------------------------------------------------------

function planClip(ctx, { seconds = 30, topic = null, aspect = '9:16' }) {
  const { edit, duration } = ctx;
  const words = edit.words || [];
  const live = words.filter((w) => !w.deleted);
  if (!live.length) return { notes: ['I need a transcript to pick a clip. Transcribe first.'] };
  const minDur = Math.max(3, seconds * 0.6), maxDur = Math.max(minDur + 1, seconds * 1.2);
  let topicSegs = null;
  if (topic) {
    topicSegs = sentencesAbout(words, topic);
    if (!topicSegs.length) return { notes: [`I couldn't find “${topic}” in the transcript`] };
  }
  const hits = (c) => (topicSegs ? topicSegs.filter((s) => s.start < c.end && s.end > c.start).length : 1);
  const best = (cands) => cands.filter((c) => hits(c) > 0).sort((a, b) => (b.score + 15 * hits(b)) - (a.score + 15 * hits(a)))[0];
  let pick = best(findHighlights(words, { minDur, maxDur, count: 30 }));
  if (!pick && topicSegs) {
    const s0 = topicSegs[0];
    pick = best(findHighlights(words.filter((w) => w.end >= s0.start - maxDur && w.start <= s0.end + maxDur), { minDur, maxDur, count: 30 }));
  }
  if (!pick) {
    // Build a window of whole sentences from the first mention (or the start).
    const segs = segmentWords(words);
    let i = topicSegs ? segs.findIndex((s) => s.from === topicSegs[0].from) : 0;
    let j = i;
    while (j + 1 < segs.length && segs[j + 1].end - segs[i].start <= maxDur) j++;
    while (i > 0 && segs[j].end - segs[i].start < minDur && segs[j].end - segs[i - 1].start <= maxDur) i--;
    pick = { start: Math.max(0, segs[i].start - 0.15), end: segs[j].end + 0.25 };
  }
  const start = Math.round(Math.max(0, pick.start) * 1000) / 1000;
  const end = Math.round(Math.min(duration, pick.end) * 1000) / 1000;
  const ops = [{ op: 'set_clip_range', args: { start, end } }, { op: 'set_aspect', args: { aspect } }];
  if (!(edit.captions && edit.captions.enabled)) ops.push({ op: 'set_captions', args: { enabled: true } });
  return { ops };
}

function planTighten(ctx, target) {
  const { edit, duration } = ctx;
  const cur = outputDuration(edit, duration);
  if (cur <= target) return { notes: [`It's already ${fmtDur(cur)}, under ${fmtDur(target)}`] };
  const ops = [];
  const cheap = [{ op: 'remove_retakes', args: {} }, { op: 'remove_fillers', args: {} }, { op: 'shorten_pauses', args: {} }];
  const trial = applyOps(edit, cheap, { duration });
  for (const d of trial.diffs) if ((d.seconds || 0) < -0.05) ops.push(cheap[d.index]);
  const e2 = ops.length ? applyOps(edit, ops, { duration }).edit : edit;
  let est = outputDuration(e2, duration);
  if (est > target) {
    const kept = keptRanges(computeCuts(e2, duration), duration);
    for (const p of clarityCuts(e2.words || [], { duration, targetDuration: target, kept })) {
      ops.push({ op: 'cut_words', args: { from_word_id: p.from_word_id, to_word_id: p.to_word_id } });
    }
    est = outputDuration(applyOps(edit, ops, { duration }).edit, duration);
  }
  const notes = est > target + 0.05 ? [`That gets it to about ${fmtDur(est)}; I couldn't find more safe cuts to reach ${fmtDur(target)}`] : [];
  return { ops, notes };
}

function fmtDur(s) {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60), r = Math.round(s - m * 60);
  return r === 60 ? `${m + 1}:00` : `${m}:${String(r).padStart(2, '0')}`;
}

// ---- clause matchers ------------------------------------------------------------------------------

const CAPTION_WORD = /\b(captions?|subtitles?|subs|closed captions)\b/;
const LAYOUT_WORD = /\b(camera|cam|webcam|bubble|pip|picture[- ]in[- ]picture|face|facecam|layout|split|side[- ]by[- ]side|talking head|screen only|only (?:the )?screen|just (?:the )?screen)\b/;
const CORNERS = [[/\b(?:top|upper)[- ]?left\b/, 'tl'], [/\b(?:top|upper)[- ]?right\b/, 'tr'], [/\b(?:bottom|lower)[- ]?left\b/, 'bl'], [/\b(?:bottom|lower)[- ]?right\b/, 'br']];
const COLORS = { yellow: '#ffd34d', white: '#ffffff', red: '#ff5a4f', coral: '#ff6b5b', orange: '#ff9f43', green: '#5be38a', mint: '#5be3b0', blue: '#5aa9ff', purple: '#b78cff', pink: '#ff7ad9', cyan: '#4dd9ff' };
const PLATFORM = /\s*(?:for|on|in)\s+(?:youtube(?: shorts)?|tiktok|instagram(?: reels)?|reels|shorts|linkedin|twitter|x)\b.*$/i;

function corner(s) { for (const [re, c] of CORNERS) if (re.test(s)) return c; return null; }

function aspectOf(s, { allowSquare = true, allowWide = true } = {}) {
  if (/\b(9\s*[:x/]\s*16|vertical|portrait(?! post)|tiktok|reels?|shorts|(?:instagram|ig|snapchat) stor(?:y|ies)|instagram(?! (?:feed|post)))\b/.test(s)) return '9:16';
  if (/\b(4\s*[:x/]\s*5|instagram (?:feed|post)|feed post|portrait post)\b/.test(s)) return '4:5';
  if (/\b1\s*[:x/]\s*1\b/.test(s) || (allowSquare && /\bsquare\b/.test(s))) return '1:1';
  if (/\b(16\s*[:x/]\s*9|landscape|horizontal|widescreen|youtube)\b/.test(s) || (allowWide && /\bwide\b/.test(s))) return '16:9';
  return null;
}

function matchCaptions(s, ctx, { force = false } = {}) {
  if (!force && !CAPTION_WORD.test(s)) return null;
  const C = { ...defaultEdit().captions, ...(ctx.edit.captions || {}) };
  const a = {};
  if (/\b(off|disable|disabled|hide|remove|no|without|kill|drop|get rid of|delete|turn off)\b/.test(s)) a.enabled = false;
  else {
    if (/\b(studio|boxed|karaoke|clean|default)\b/.test(s)) a.preset = 'studio';
    else if (/\b(cinema|cinematic|film|movie|subtle|minimal)\b/.test(s)) a.preset = 'cinema';
    else if (/\b(editorial|serif|italic|elegant|magazine)\b/.test(s)) a.preset = 'editorial';
    else if (/\b(bold|pop|neon|big|punchy|loud|caps|uppercase|hormozi|tiktok style|word by word)\b/.test(s)) a.preset = 'bold';
    if (/\b(top|upper)\b/.test(s)) a.position = 'top';
    else if (/\b(middle|center|centre|centered|centred)\b/.test(s)) a.position = 'middle';
    else if (/\b(bottom|lower)\b/.test(s)) a.position = 'bottom';
    const size = C.size ?? 1;
    if (/\b(huge|biggest|largest|max(?:imum)? size)\b/.test(s)) a.size = 1.5;
    else if (/\b(tiny|smallest|min(?:imum)? size)\b/.test(s)) a.size = 0.7;
    else if (/\b(bigger|larger|increase|grow|enlarge)\b/.test(s)) a.size = Math.min(1.5, Math.round((size + 0.15) * 100) / 100);
    else if (/\b(smaller|decrease|shrink|reduce)\b/.test(s)) a.size = Math.max(0.7, Math.round((size - 0.15) * 100) / 100);
    const hex = /#([0-9a-f]{6})\b/i.exec(s);
    if (hex) a.color = `#${hex[1].toLowerCase()}`;
    else for (const [name, c] of Object.entries(COLORS)) if (new RegExp(`\\b${name}\\b`).test(s)) { a.color = c; break; }
    if (!C.enabled || /\b(on|add|enable|show|turn on|burn|with)\b/.test(s) || !Object.keys(a).length) a.enabled = true;
  }
  return { ops: [{ op: 'set_captions', args: a }], domain: 'captions' };
}

function matchLayout(s, ctx, { force = false } = {}) {
  const c = corner(s);
  if (!force && !LAYOUT_WORD.test(s) && !(c && /\b(move|put|place|corner)\b/.test(s))) return null;
  const L = { ...defaultEdit().layout, ...(ctx.edit.layout || {}) };
  const a = {};
  if (/\b(screen only|only (?:the )?screen|just (?:the )?screen|hide (?:the )?(?:camera|cam|webcam|face|bubble)|no (?:camera|cam|webcam|bubble|face)|without (?:the )?(?:camera|cam|webcam|face)|camera off|remove (?:the )?(?:camera|bubble|webcam))\b/.test(s)) a.mode = 'screen';
  else if (/\b(camera only|only (?:the )?camera|just (?:the )?(?:camera|face)|full[- ]?screen camera|camera full[- ]?screen|talking head)\b/.test(s)) a.mode = 'camera';
  else if (/\b(split|side[- ]by[- ]side)\b/.test(s)) a.mode = 'split';
  else if (/\b(bubble|pip|picture[- ]in[- ]picture|corner|overlay)\b/.test(s) || c || /\b(show|add|bring back|turn on|use)\b.*\b(camera|cam|webcam|face|facecam)\b/.test(s)) a.mode = 'pip';
  if (c) a.corner = c;
  if (/\b(circle|circular|round)\b/.test(s)) a.shape = 'circle';
  else if (/\brounded\b/.test(s)) a.shape = 'rounded';
  else if (/\bsquare\b/.test(s)) a.shape = 'square';
  else if (/\b(wide|rectangle|rectangular)\b/.test(s)) a.shape = 'wide';
  const mode = a.mode || L.mode;
  const bigger = /\b(bigger|larger|increase|grow|enlarge)\b/.test(s), smaller = /\b(smaller|decrease|shrink|reduce|tiny)\b/.test(s);
  if (mode === 'split' && (bigger || smaller)) a.split = Math.max(0.25, Math.min(0.7, Math.round(((L.split ?? 0.4) + (bigger ? 0.1 : -0.1)) * 100) / 100));
  else if (bigger || smaller) a.size = Math.max(0.08, Math.min(0.5, Math.round(((L.size ?? 0.22) + (bigger ? 0.06 : -0.06)) * 100) / 100));
  if (!Object.keys(a).length) return null;
  a.mode = mode === 'screen' && !a.mode && (a.corner || a.shape || a.size) ? 'pip' : mode;
  return { ops: [{ op: 'set_layout', args: a }], domain: 'layout' };
}

function matchZoom(s, ctx, { force = false } = {}) {
  if (!force && !/\bzoom/.test(s)) return null;
  const { edit, duration } = ctx;
  const times = findTimes(s);
  if (/\b(remove|delete|clear|drop|kill|get rid of|undo|no|without)\b/.test(s) || /\bzooms? off\b/.test(s)) {
    if (!(edit.zooms || []).length) return { notes: ['There are no zooms to remove'], domain: 'zoom' };
    const t = times.find((x) => x.before !== 'for');
    if (t && !/\ball\b/.test(s)) {
      const z = (edit.zooms || []).find((x) => x.start <= t.value + 0.5 && x.end >= t.value - 0.5);
      if (!z) return { notes: [`There's no zoom at ${fmtTime(t.value)}`], domain: 'zoom' };
      return { ops: [{ op: 'remove_zoom', args: { id: z.id } }], domain: 'zoom' };
    }
    return { ops: [{ op: 'remove_zoom', args: { start: 0, end: duration } }], domain: 'zoom' };
  }
  let start = null, end = null, len = null;
  for (const t of times) {
    if (t.before === 'for') len = t.value;
    else if (['to', 'until', 'till', 'through'].includes(t.before) && start !== null) end = t.value;
    else if (start === null) start = t.value;
  }
  if (start === null) {
    const say = /\b(?:when i say|on the word|at the word|where i say|when i mention)\s+["']?([\p{L}\p{N}']+)/u.exec(s);
    if (say) {
      const target = normalizeWord(say[1]);
      const w = (edit.words || []).find((x) => !x.deleted && normalizeWord(x.text) === target);
      if (!w) return { notes: [`I couldn't find the word “${say[1]}”`], domain: 'zoom' };
      start = Math.max(0, w.start - 0.3);
    }
  }
  if (start === null) return { notes: ['Tell me where to zoom, e.g. “zoom in at 0:42 for 3 seconds”'], domain: 'zoom' };
  if (start >= duration) return { notes: [`${fmtTime(start)} is past the end of the video (${fmtTime(duration)})`], domain: 'zoom' };
  end = Math.min(duration, end ?? start + (len ?? 2.6));
  if (end - start < 0.3) end = Math.min(duration, start + 2.6);
  let scale = 1.8;
  const mx = /(\d+(?:\.\d+)?)\s*(?:x|×)(?![\w:])/.exec(s), pct = /(\d{2,3})\s*%/.exec(s);
  if (mx) scale = Number(mx[1]);
  else if (pct) scale = Number(pct[1]) / 100;
  else if (/\b(a lot|tight|close|way in|big)\b/.test(s)) scale = 2.4;
  else if (/\b(slight|slightly|a little|subtle|gently|gentle)\b/.test(s)) scale = 1.3;
  scale = Math.max(1.1, Math.min(4, scale));
  let x = 0.5, y = 0.5;
  const c = corner(s);
  if (c) { x = c[1] === 'l' ? 0.25 : 0.75; y = c[0] === 't' ? 0.25 : 0.75; }
  else {
    if (/\bleft\b/.test(s)) x = 0.3; else if (/\bright\b/.test(s)) x = 0.7;
    if (/\btop\b/.test(s)) y = 0.3; else if (/\bbottom\b/.test(s)) y = 0.7;
  }
  return { ops: [{ op: 'add_zoom', args: { start: r3(start), end: r3(end), scale, x, y } }], domain: 'zoom' };
}

const r3 = (v) => Math.round(v * 1000) / 1000;

function matchFillers(s) {
  const soft = /\b(likes|you knows|i means|basicallys|actuallys|literallys|soft fillers?|all (?:the )?fillers|every filler|filler phrases)\b|["']like["']|the word like/.test(s);
  if (!soft && !/\b(fillers?|filler words|umm*s?|uhh*s?|um's|uh's|ers|ahs|erms|hmms)\b/.test(s)) return null;
  if (/\b(keep|leave|don't|do not)\b/.test(s)) return null;
  return { ops: [{ op: 'remove_fillers', args: soft ? { include_soft: true } : {} }], domain: 'fillers' };
}

function matchPauses(s) {
  if (!/\b(pauses?|silences?|silent|dead air|gaps?|breaths?)\b/.test(s) && !/^(?:tighten|tighten (?:it|this|everything) up|tighten up|make it (?:tighter|snappier)|speed up the pacing)$/.test(s.trim())) return null;
  const a = {};
  for (const t of findTimes(s)) {
    if (['than', 'over', 'above', 'exceeding'].includes(t.before)) a.min_gap = r3(Math.max(0.1, Math.min(10, t.value)));
    else a.keep = r3(Math.max(0, Math.min(5, t.value)));
  }
  if (a.keep !== undefined && a.keep >= (a.min_gap ?? 0.75)) a.min_gap = r3(Math.min(10, a.keep + 0.25));
  return { ops: [{ op: 'shorten_pauses', args: a }], domain: 'pauses' };
}

function matchRetakes(s) {
  if (!/\b(retakes?|repeats?|repeated|repetitions?|repeating|restarts?|false starts?|flubs?|bad takes?|duplicates?|stumbles?|do-?overs?)\b/.test(s)) return null;
  return { ops: [{ op: 'remove_retakes', args: {} }], domain: 'retakes' };
}

function matchAspect(s) {
  const layoutish = LAYOUT_WORD.test(s);
  const a = aspectOf(s, { allowSquare: !layoutish, allowWide: !layoutish });
  return a ? { ops: [{ op: 'set_aspect', args: { aspect: a } }], domain: 'aspect' } : null;
}

function matchExport(s) {
  let fmt = null;
  if (/\b(final cut|fcpx?|fcpxml)\b/.test(s)) fmt = 'fcpxml';
  else if (/\b(premiere|xmeml|davinci|resolve)\b/.test(s)) fmt = /\b(davinci|resolve)\b/.test(s) && !/\bpremiere\b/.test(s) ? 'fcpxml' : 'xmeml';
  else if (/\b(edl|cmx ?3600)\b/.test(s)) fmt = 'edl';
  if (fmt) return { ops: [{ op: 'export_nle', args: { format: fmt } }], domain: 'export', claims: true };
  if (!/\b(render|export|save (?:it |the video )?(?:as|to)|download)\b/.test(s)) return null;
  const a = {};
  if (/\bwebm\b/.test(s)) a.format = 'webm'; else if (/\bmp4\b/.test(s)) a.format = 'mp4';
  if (CAPTION_WORD.test(s)) a.captions = !/\b(without|no)\b/.test(s);
  const fps = /(\d{2,3})\s*fps\b/.exec(s);
  if (fps) a.fps = Math.max(1, Math.min(120, Number(fps[1])));
  const res = /\b(4k|2160p|1440p|1080p|720p|480p)\b/.exec(s);
  const short = res ? { '4k': 2160, '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480 }[res[1]] : null;
  const ops = [];
  const aspect = aspectOf(s);
  if (aspect) ops.push({ op: 'set_aspect', args: { aspect } });
  ops.push({ op: 'render', args: a, short });
  return { ops, domain: 'export', claims: true };
}

// ---- clause parser --------------------------------------------------------------------------------

const CUT_VERB = /\b(cut|remove|delete|drop|lose|skip|trim|take out|get rid of|strip|kill|axe|edit out)\b/;
const ABOUT = /\b(?:about|mentions? of|mentioning|regarding|related to|talk(?:s|ing)? about|that mentions?|where i (?:talk about|mention|discuss|go on about)|on the topic of)\s+(.+)$/i;
const CLIP_WORD = /\b(reel|reels|clip|short|shorts|tiktok|teaser|highlight|trailer|cut-?down|snippet)\b/;

function cleanTopic(t) {
  return String(t).replace(PLATFORM, '').replace(/\b(please|thanks|thank you)\b.*$/i, '').replace(/^[\s"'“”‘’]+|[\s"'“”‘’.!?]+$/g, '').trim();
}

function parseClause(raw, ctx, last) {
  const s = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').trim();
  const r = { ops: [], notes: [], domain: null };
  const take = (m) => { if (!m) return false; r.ops.push(...(m.ops || [])); r.notes.push(...(m.notes || [])); r.domain = r.domain || m.domain; return true; };

  if (/\b(restore|bring back|undo|revert|put back)\b/.test(s) && /\b(retakes?|restarts?|repeats?)\b/.test(s)) {
    const words = ctx.edit.words || [];
    const groups = new Map();
    words.forEach((w, i) => { if (w.deleted && w.retake) { const g = groups.get(w.retake) || [i, i]; g[1] = i; groups.set(w.retake, g); } });
    if (!groups.size) take({ notes: ['No retakes have been cut'], domain: 'restore' });
    else take({ ops: [...groups.values()].map(([a, b]) => ({ op: 'restore_words', args: { from_word_id: wordIdOf(words, a), to_word_id: wordIdOf(words, b) } })), domain: 'restore' });
    return r;
  }
  if (/\b(restore|bring back|undo|revert)\b.*\b(everything|all(?: the)? cuts|all|original)\b/.test(s)) {
    take({ ops: [{ op: 'restore_range', args: { start: 0, end: ctx.duration } }], domain: 'restore' });
    return r;
  }
  if (/\b(clear|remove|reset|drop)\b.*\b(clip )?range\b|\buse the (?:whole|full|entire) (?:video|recording)\b/.test(s)) {
    take({ ops: [{ op: 'set_clip_range', args: null }], domain: 'range' });
    return r;
  }
  if (/\b(find|suggest|show|list|what are|give me)\b.*\b(clips|highlights|moments|reels)\b/.test(s) && !/\babout\b/.test(s)) {
    const n = /\b(\d+)\s+(?:clips|highlights|moments|reels)\b/.exec(s);
    const a = {};
    if (n) a.count = Math.max(1, Math.min(20, Number(n[1])));
    const t = findTimes(s).find((x) => ['under', 'than', 'max', 'to', 'most'].includes(x.before) || x.before === '');
    if (t && t.value >= 5) { a.max_dur = r3(Math.min(900, t.value)); a.min_dur = r3(Math.max(1, Math.min(12, a.max_dur * 0.5))); }
    take({ ops: [{ op: 'find_clips', args: a }], domain: 'clips' });
    return r;
  }
  const times = findTimes(s);
  if (CLIP_WORD.test(s) && (/\b(make|create|build|turn|pull|cut|give|get|export|find|want|need)\b/.test(s) || times.length)) {
    const t = times.find((x) => x.before !== 'at');
    const m = ABOUT.exec(raw);
    const topic = m ? cleanTopic(m[1]) : null;
    take(planClip(ctx, { seconds: t ? Math.max(3, t.value) : 30, topic: topic || null, aspect: aspectOf(s.replace(CLIP_WORD, ' ').replace(/\breels?\b/, '')) || '9:16' }));
    r.domain = 'clip';
    return r;
  }
  const target = times.find((x) => ['under', 'below', 'than', 'within', 'to', 'max', 'most', 'about', 'around'].includes(x.before));
  if (target && /\b(tighten|trim|shorten|cut|get|bring|make|reduce|edit|keep|condense|squeeze)\b/.test(s) && !/\b(pauses?|silences?|gaps?)\b/.test(s)) {
    take(planTighten(ctx, target.value));
    r.domain = 'tighten';
    return r;
  }
  if (CUT_VERB.test(s)) {
    const m = ABOUT.exec(raw) || /\b(?:cut|remove|delete|drop|skip|trim)\s+(?:the\s+|that\s+)?(.+?)\s+(?:tangent|section|part|bit|segment|stuff|rant)s?\b/i.exec(raw);
    if (m) {
      const topic = cleanTopic(m[1]);
      take(cutTopic(ctx, topic, { tangent: /\b(tangents?|everything|anything|section|part|rant|bit)\b/.test(s) }));
      r.domain = 'topic';
      r.tangent = /\b(tangents?|everything|anything|section|part|rant|bit)\b/.test(s);
      return r;
    }
  }

  // "…make the bubble bigger and square": a bare shape or size word continues the layout request.
  if (last && last.domain === 'layout' && /^(?:(?:make it|a|in a|as a)\s+)?(?:circle|circular|round|rounded|square|wide|bigger|smaller|larger)(?:\s+(?:one|shape|bubble))?$/.test(s)) {
    take(matchLayout(s, ctx, { force: true }));
    return r;
  }
  if (/\b(clean(?: it| this| the video| everything)? up|polish|tidy(?: it)? up)\b/.test(s)) {
    take({ ops: [{ op: 'remove_retakes', args: {} }, { op: 'remove_fillers', args: {} }, { op: 'shorten_pauses', args: {} }], domain: 'clean' });
  }
  const exp = matchExport(s);
  if (exp) take(exp);
  take(matchRetakes(s));
  take(matchFillers(s));
  take(matchPauses(s));
  if (!exp) take(matchAspect(s));
  if (!exp) take(matchCaptions(s, ctx));
  take(matchLayout(s, ctx));
  take(matchZoom(s, ctx));
  if (r.ops.length || r.notes.length) return r;

  // Continuations: "…about the old UI and the beta", "captions on and put them at the top".
  if (last && last.domain === 'topic' && s.split(/\s+/).length <= 6) {
    take(cutTopic(ctx, cleanTopic(raw.replace(/^(?:about|on|of)\s+/i, '')), { tangent: last.tangent }));
    r.domain = 'topic'; r.tangent = last.tangent;
    return r;
  }
  if (last && last.domain === 'captions' && /\b(top|middle|center|centre|bottom|bigger|smaller|larger|bold|cinema|editorial|studio|yellow|white|#[0-9a-f]{6})\b/.test(s)) take(matchCaptions(s, ctx, { force: true }));
  else if (last && last.domain === 'layout' && (corner(s) || /\b(bigger|smaller|circle|rounded|square|wide)\b/.test(s))) take(matchLayout(s, ctx, { force: true }));
  else if (last && last.domain === 'zoom' && findTimes(s).length) take(matchZoom(s, ctx, { force: true }));
  return r;
}

export function splitClauses(text) {
  return String(text || '')
    .replace(/[“”]/g, '"')
    .split(/\s*(?:[,;]|\.\s+|\.$|\s+(?:and then|then|and also|also|plus|as well as|and|&)\s+)\s*/i)
    .map((c) => c.replace(/^(?:and|then|also|plus|please|can you|could you|would you|i want you to|i'd like you to)\s+/i, '').replace(/^(?:and|then|please)\s+/i, '').trim())
    .filter(Boolean);
}

// Word cuts first, pauses after them (they depend on which words remain), settings and effects last.
const PRIORITY = { restore_range: 0, remove_retakes: 1, remove_fillers: 1, cut_words: 1, restore_words: 1, cut_range: 1, shorten_pauses: 2 };
const SINGLE = new Set(['remove_retakes', 'remove_fillers', 'shorten_pauses', 'set_aspect', 'set_captions', 'set_layout', 'set_clip_range', 'find_clips', 'render', 'remove_zoom']);

function mergeOps(ops) {
  const out = [];
  const seenCut = new Set();
  for (const o of ops) {
    if (o.op === 'cut_words') {
      const k = `${o.args.from_word_id}|${o.args.to_word_id}`;
      if (seenCut.has(k)) continue;
      seenCut.add(k);
    }
    const prev = SINGLE.has(o.op) && out.find((x) => x.op === o.op && (o.op !== 'remove_zoom' || (!x.args.id && !o.args.id)));
    if (!prev) { out.push({ ...o, args: o.args === null ? null : { ...o.args } }); continue; }
    if (o.op === 'remove_fillers') { if (o.args.include_soft) prev.args.include_soft = true; }
    else if (o.args === null || prev.args === null) prev.args = o.args;
    else Object.assign(prev.args, o.args);
    if (o.short) prev.short = o.short;
  }
  return out.map((o, i) => ({ o, i })).sort((a, b) => (PRIORITY[a.o.op] ?? 3) - (PRIORITY[b.o.op] ?? 3) || a.i - b.i).map((x) => x.o);
}

const HELP = 'Try “remove fillers and pauses”, “make it vertical with bold captions”, “put the camera in the top right”, “zoom in at 0:42”, “cut everything about pricing”, “make a 30-second reel about onboarding” or “tighten to under 2 minutes”.';

/**
 * Parse a request into ops. ctx = { edit, duration }.
 * Returns { ops: [{ op, args }], reply, understood }. Ops are validated and dry-run with applyOps;
 * the reply describes what they would do. Nothing is applied.
 */
export function parseIntent(text, { edit, duration } = {}) {
  const e = edit || defaultEdit();
  const dur = duration > 0 ? duration : inferDuration(e);
  const ctx = { edit: e, duration: dur };
  const clauses = splitClauses(text);
  let ops = [];
  const notes = [];
  const unknown = [];
  let last = null;
  for (const c of clauses) {
    const r = parseClause(c, ctx, last);
    if (!r.ops.length && !r.notes.length) { unknown.push(c); continue; }
    ops.push(...r.ops);
    notes.push(...r.notes);
    last = r;
  }
  ops = mergeOps(ops);
  // Resolution words for render become width/height in the final aspect.
  const finalAspect = [...ops].reverse().find((o) => o.op === 'set_aspect')?.args.aspect || e.aspect || '16:9';
  ops = ops.map((o) => {
    if (o.op !== 'render') return o;
    const { short, ...rest } = o;
    if (!short) return rest;
    const size = outputSize(finalAspect, short);
    return { ...rest, args: { ...rest.args, width: size.width, height: size.height } };
  });
  ops = ops.filter((o) => validateOp(o).valid);
  let res = applyOps(e, ops, { duration: dur });
  if (res.errors.length) {
    const bad = new Set(res.errors.map((x) => x.index));
    for (const x of res.errors) notes.push(x.message);
    ops = ops.filter((_, i) => !bad.has(i));
    res = applyOps(e, ops, { duration: dur });
  }
  const understood = ops.length > 0 || notes.length > 0;
  if (!understood) {
    return { ops: [], reply: `I didn't catch that. ${HELP}`, understood: false };
  }
  const parts = res.diffs.map((d) => d.summary);
  parts.push(...notes);
  if (unknown.length) parts.push(`I didn't understand “${unknown.join('”, “')}”`);
  return { ops, reply: `${parts.join('. ')}.`, understood: true };
}
