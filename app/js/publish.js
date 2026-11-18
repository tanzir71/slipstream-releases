// Publish kit: title, description and chapters, generated on-device.
// Uses Chrome's built-in Summarizer API (Gemini Nano, runs locally) when available; otherwise falls
// back to transcript heuristics. Nothing is sent to a server either way.

import { suggestChapters, titleFrom, sentences } from './highlights.js';
import { srcToOut } from './edl.js';

export function chapterTimestamp(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** YouTube-style chapter list in OUTPUT time (needs ≥3 chapters, first at 00:00). */
export function chaptersText(words, duration, kept) {
  const ch = suggestChapters(words, duration).map((c) => ({ ...c, out: srcToOut(kept, c.start) }));
  const dedup = ch.filter((c, i) => i === 0 || c.out - ch[i - 1].out >= 10);
  if (dedup.length < 3) return '';
  dedup[0].out = 0;
  return dedup.map((c) => `${chapterTimestamp(c.out)} ${c.title}`).join('\n');
}

export async function summarizerAvailable() {
  try {
    if (!('Summarizer' in self)) return false;
    const a = await self.Summarizer.availability();
    return a === 'available' || a === 'downloadable' || a === 'downloading';
  } catch { return false; }
}

async function summarize(text, type, length) {
  const s = await self.Summarizer.create({ type, format: 'plain-text', length, sharedContext: 'A transcript of a screen recording / creator video.' });
  try { return (await s.summarize(text.slice(0, 12000))).trim(); } finally { s.destroy?.(); }
}

/** Returns { title, description, source: 'on-device AI' | 'transcript' }. */
export async function publishKit(words) {
  const live = words.filter((w) => !w.deleted);
  const text = live.map((w) => w.text).join(' ');
  if (!text.trim()) return { title: '', description: '', source: 'transcript' };
  if (await summarizerAvailable()) {
    try {
      const [title, description] = await Promise.all([summarize(text, 'headline', 'short'), summarize(text, 'tldr', 'medium')]);
      return { title: title.replace(/^["']|["']$/g, ''), description, source: 'on-device AI' };
    } catch { /* fall through to heuristics */ }
  }
  const clean = live.filter((w) => w.filler !== 'hard');
  const sents = sentences(clean);
  const title = capitalize(titleFrom(sents[0]?.words || clean, 10).replace(/[.!?,;:]$/, ''));
  const description = capitalize(sents.slice(0, 3).map((s) => s.words.map((w) => w.text).join(' ')).join(' '));
  return { title, description, source: 'transcript' };
}

function capitalize(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
