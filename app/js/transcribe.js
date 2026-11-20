// Main-thread side of transcription: picks split points at quiet moments, runs the worker, streams words back.
import { ASR_RATE } from './media.js';
import { uid, isWhisperSilence } from './edl.js';

export const MODELS = [
  { id: 'onnx-community/whisper-base_timestamped', label: 'Balanced', note: 'Whisper Base · ~80 MB · 99 languages', default: true },
  { id: 'onnx-community/whisper-tiny_timestamped', label: 'Fast', note: 'Whisper Tiny · ~40 MB · quick drafts' },
  { id: 'onnx-community/whisper-small_timestamped', label: 'Accurate', note: 'Whisper Small · ~250 MB · best quality' },
  { id: 'onnx-community/whisper-base.en_timestamped', label: 'English', note: 'Whisper Base (English-only) · ~80 MB' },
];

/** Split audio into ~45 s pieces at the quietest 300 ms near each target, so no word is cut in half. */
export function splitPoints(pcm, target = 45) {
  const dur = pcm.length / ASR_RATE;
  const pts = [0];
  const win = Math.round(0.3 * ASR_RATE);
  let t = target;
  while (t < dur - 8) {
    const lo = Math.max(pts[pts.length - 1] + 20, t - 10), hi = Math.min(dur - 4, t + 10);
    let best = t, bestE = Infinity;
    for (let s = lo; s < hi; s += 0.1) {
      const i0 = Math.round(s * ASR_RATE);
      let e = 0;
      for (let i = i0; i < i0 + win && i < pcm.length; i += 4) e += pcm[i] * pcm[i];
      if (e < bestE) { bestE = e; best = s + 0.15; }
    }
    pts.push(best);
    t = best + target;
  }
  pts.push(dur);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  return segs;
}

/**
 * Run Whisper on-device. Callbacks: onDownload(loaded,total), onReady(device), onWords(words, done, total).
 * Returns a promise of all words and a cancel() function.
 */
export function transcribe(pcm, { model, language = 'auto', preferGPU = true, onDownload, onReady, onWords }) {
  const worker = new Worker(new URL('./transcribe-worker.js', import.meta.url), { type: 'module' });
  const segments = splitPoints(pcm);
  const all = [];
  let cancel;
  const promise = new Promise((resolve, reject) => {
    cancel = () => { worker.terminate(); reject(new DOMException('Transcription cancelled', 'AbortError')); };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'download') onDownload?.(m.loaded, m.total);
      else if (m.type === 'ready') onReady?.(m.device);
      else if (m.type === 'segment') {
        const words = m.words.map((w) => ({ id: uid('w'), ...w }));
        all.push(...words);
        onWords?.(words, m.index + 1, m.total);
      } else if (m.type === 'done') { worker.terminate(); resolve(isWhisperSilence(all) ? [] : all); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Transcription worker failed to start')); };
    worker.postMessage({ type: 'transcribe', pcm, segments, model, language, preferGPU });
  });
  return { promise, cancel: () => cancel?.() };
}
