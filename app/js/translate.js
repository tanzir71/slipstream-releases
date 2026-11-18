// Translated subtitles (ticket A-06), on this device: OPUS-MT (Marian) models run by translate-worker.js.
// Cues are translated a sentence at a time and spread back over the original cues (translate-utils.js),
// so timings, cue count and order are kept. Each language pair is an opt-in download (~110–140 MB, 8-bit),
// cached by the browser after the first use.
import { planTranslation, assembleTranslation, fillRetries, normalizeCueText, cleanTranslation } from '../../packages/editor-core/src/translate-utils.js';

const X = (pair) => `Xenova/opus-mt-${pair}`;

/**
 * Languages with a verified OPUS-MT model on the Hugging Face Hub (ONNX, 8-bit weights present).
 * to:   English → language. from: language → English. sizeMB = download for that model (8-bit + tokenizer).
 * prefix: the target-language token multi-target models need.
 * English → Japanese, Korean, Polish, Turkish and Thai are missing on purpose: the only en→ja model
 * (opus-mt-en-jap) is trained on Bible text and produces unusable subtitles, and the others have no
 * browser-sized model.
 */
export const TRANSLATION_LANGS = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'es', label: 'Spanish', native: 'Español', to: { id: X('en-es'), sizeMB: 119 }, from: { id: X('es-en'), sizeMB: 119 } },
  { code: 'fr', label: 'French', native: 'Français', to: { id: X('en-fr'), sizeMB: 113 }, from: { id: X('fr-en'), sizeMB: 113 } },
  { code: 'de', label: 'German', native: 'Deutsch', to: { id: X('en-de'), sizeMB: 112 }, from: { id: X('de-en'), sizeMB: 112 } },
  { code: 'it', label: 'Italian', native: 'Italiano', to: { id: X('en-it'), sizeMB: 136 }, from: { id: X('it-en'), sizeMB: 137 } },
  { code: 'pt', label: 'Portuguese (Brazil)', native: 'Português', to: { id: X('en-ROMANCE'), prefix: '>>pt_br<<', sizeMB: 119 }, from: { id: X('ROMANCE-en'), sizeMB: 119 } },
  { code: 'nl', label: 'Dutch', native: 'Nederlands', to: { id: X('en-nl'), sizeMB: 122 }, from: { id: X('nl-en'), sizeMB: 122 } },
  { code: 'ro', label: 'Romanian', native: 'Română', to: { id: X('en-ro'), sizeMB: 113 }, from: { id: X('ROMANCE-en'), sizeMB: 119 } },
  { code: 'sv', label: 'Swedish', native: 'Svenska', to: { id: X('en-sv'), sizeMB: 110 }, from: { id: X('sv-en'), sizeMB: 110 } },
  { code: 'da', label: 'Danish', native: 'Dansk', to: { id: X('en-da'), sizeMB: 113 }, from: { id: X('da-en'), sizeMB: 113 } },
  { code: 'fi', label: 'Finnish', native: 'Suomi', to: { id: X('en-fi'), sizeMB: 119 }, from: { id: X('fi-en'), sizeMB: 113 } },
  { code: 'cs', label: 'Czech', native: 'Čeština', to: { id: X('en-cs'), sizeMB: 117 }, from: { id: X('cs-en'), sizeMB: 117 } },
  { code: 'hu', label: 'Hungarian', native: 'Magyar', to: { id: X('en-hu'), sizeMB: 117 }, from: { id: X('hu-en'), sizeMB: 117 } },
  { code: 'pl', label: 'Polish', native: 'Polski', from: { id: X('pl-en'), sizeMB: 118 } },
  { code: 'ru', label: 'Russian', native: 'Русский', to: { id: X('en-ru'), sizeMB: 118 }, from: { id: X('ru-en'), sizeMB: 118 } },
  { code: 'uk', label: 'Ukrainian', native: 'Українська', to: { id: X('en-uk'), sizeMB: 117 }, from: { id: X('uk-en'), sizeMB: 117 } },
  { code: 'tr', label: 'Turkish', native: 'Türkçe', from: { id: X('tr-en'), sizeMB: 117 } },
  { code: 'ar', label: 'Arabic', native: 'العربية', to: { id: X('en-ar'), prefix: '>>ara<<', sizeMB: 118 }, from: { id: X('ar-en'), sizeMB: 118 } },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', to: { id: X('en-hi'), sizeMB: 117 }, from: { id: X('hi-en'), sizeMB: 116 } },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia', to: { id: X('en-id'), sizeMB: 108 }, from: { id: X('id-en'), sizeMB: 108 } },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt', to: { id: X('en-vi'), prefix: '>>vie<<', sizeMB: 107 }, from: { id: X('vi-en'), sizeMB: 107 } },
  { code: 'th', label: 'Thai', native: 'ไทย', from: { id: X('th-en'), sizeMB: 117 } },
  { code: 'zh', label: 'Chinese (Simplified)', native: '简体中文', to: { id: X('en-zh'), prefix: '>>cmn_Hans<<', sizeMB: 119 }, from: { id: X('zh-en'), sizeMB: 119 } },
  { code: 'ja', label: 'Japanese', native: '日本語', from: { id: X('ja-en'), sizeMB: 115 } },
  { code: 'ko', label: 'Korean', native: '한국어', from: { id: X('ko-en'), sizeMB: 120 } },
];

/** Direct pairs that skip English (better than pivoting, and one download instead of two). */
export const DIRECT_PAIRS = {
  'de-es': 115, 'de-fr': 115, 'es-de': 115, 'es-fr': 131, 'es-it': 113, 'es-ru': 119, 'fr-de': 115, 'fr-es': 131,
  'fr-ru': 120, 'it-es': 113, 'it-fr': 113, 'nl-fr': 111, 'ru-es': 119, 'ru-fr': 120, 'ru-uk': 113, 'uk-ru': 113,
};

const base = (code) => String(code || '').toLowerCase().split(/[-_]/)[0];
const lang = (code) => TRANSLATION_LANGS.find((l) => l.code === base(code));

/**
 * Model steps to translate source → target: [] when they match, one step for English pairs and direct
 * pairs, two (via English) otherwise. Returns { steps: [{ id, prefix?, sizeMB }], sizeMB } or null when
 * a step has no model.
 */
export function translationModel(sourceLang, targetLang) {
  const s = base(sourceLang), t = base(targetLang);
  if (!s || !t) return null;
  if (s === t) return { steps: [], sizeMB: 0 };
  let steps;
  if (DIRECT_PAIRS[`${s}-${t}`]) steps = [{ id: X(`${s}-${t}`), sizeMB: DIRECT_PAIRS[`${s}-${t}`] }];
  else if (s === 'en') steps = lang(t)?.to ? [lang(t).to] : null;
  else if (t === 'en') steps = lang(s)?.from ? [lang(s).from] : null;
  else steps = lang(s)?.from && lang(t)?.to ? [lang(s).from, lang(t).to] : null;
  if (!steps) return null;
  steps = steps.map((x) => ({ ...x }));
  return { steps, sizeMB: steps.reduce((a, x) => a + x.sizeMB, 0) };
}

/** Target languages reachable from a source language, for the picker. */
export function translationTargets(sourceLang) {
  return TRANSLATION_LANGS.filter((l) => l.code !== base(sourceLang) && translationModel(sourceLang, l.code));
}

/**
 * Translate caption cues on-device. cues: [{ start, end, text }]. Callbacks: onDownload(loaded,total),
 * onReady(device), onProgress(p) with p in 0..1. Returns { promise: Promise<[{ start, end, text }]>, cancel() }.
 * The returned cues have the same count, order and timings as the input.
 */
export function translateCues(cues, { source = 'en', target, preferGPU = false, onDownload, onReady, onProgress } = {}) {
  const route = translationModel(source, target);
  if (!route) {
    return { promise: Promise.reject(new Error(`No on-device model for ${source} → ${target}`)), cancel() {} };
  }
  const input = (cues || []).map((c) => ({ start: c.start, end: c.end, text: normalizeCueText(c.text) }));
  if (!route.steps.length || !input.length) return { promise: Promise.resolve(input), cancel() {} };

  const worker = new Worker(new URL('./translate-worker.js', import.meta.url), { type: 'module' });
  let job = 0;
  let cancel;
  const waiting = new Map();
  let fail = () => {};
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'download') onDownload?.(m.loaded, m.total);
    else if (m.type === 'ready') onReady?.(m.device);
    else if (m.type === 'progress') waiting.get(m.job)?.progress(m.done, m.total);
    else if (m.type === 'done') { waiting.get(m.job)?.resolve(m.texts); waiting.delete(m.job); }
    else if (m.type === 'error') { waiting.get(m.job)?.reject(new Error(m.message)); waiting.delete(m.job); }
  };
  worker.onerror = (e) => fail(new Error(e.message || 'Translation worker failed to start'));

  // Work units for progress: every step translates the groups; retries are counted when they happen.
  const plan = planTranslation(input, { source });
  let unitsDone = 0;
  let unitsTotal = plan.texts.length * route.steps.length;
  const run = (step, texts) => new Promise((resolve, reject) => {
    const id = ++job;
    const startDone = unitsDone;
    waiting.set(id, {
      resolve: (r) => { unitsDone = startDone + texts.length; onProgress?.(Math.min(1, unitsDone / unitsTotal)); resolve(r); },
      reject,
      progress: (d) => onProgress?.(Math.min(1, (startDone + d) / unitsTotal)),
    });
    worker.postMessage({ type: 'translate', job: id, model: step.id, prefix: step.prefix || '', texts, preferGPU });
  });
  const through = async (texts) => {
    let cur = texts;
    for (let k = 0; k < route.steps.length; k++) {
      const prev = cur;
      cur = await run(route.steps[k], cur);
      // Tidy the English in the middle of a pivot before it is translated again.
      if (k < route.steps.length - 1) cur = cur.map((t, i) => cleanTranslation(t, { source: prev[i], lang: 'en' }));
    }
    return cur;
  };

  const promise = new Promise((resolve, reject) => {
    fail = (err) => { worker.terminate(); reject(err); };
    cancel = () => fail(new DOMException('Translation cancelled', 'AbortError'));
    (async () => {
      const translated = await through(plan.texts);
      const { cues: out, retry } = assembleTranslation(input, plan.groups, translated, { target });
      if (!retry.length) return out;
      unitsTotal += retry.length * route.steps.length;
      const single = await through(retry.map((i) => input[i].text));
      return fillRetries(out, input, retry, single, { target });
    })().then((out) => { worker.terminate(); onProgress?.(1); resolve(out); }, fail);
  });
  return { promise, cancel: () => cancel?.() };
}
