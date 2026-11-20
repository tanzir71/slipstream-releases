// On-device speech-to-text with Whisper (Transformers.js, ONNX Runtime Web).
// The library comes from jsDelivr and the model from the Hugging Face Hub the first time only; both are
// cached by the browser afterwards. Audio never leaves this worker.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;
let loadedKey = '';

async function hasWebGPU() {
  try { return !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch { return false; }
}

async function load(model, preferGPU) {
  const gpu = preferGPU && (await hasWebGPU());
  const key = `${model}:${gpu}`;
  if (asr && loadedKey === key) return gpu ? 'webgpu' : 'wasm';
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      self.postMessage({ type: 'download', loaded, total });
    }
  };
  const attempts = gpu
    ? [{ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }, { device: 'wasm', dtype: 'q8' }]
    : [{ device: 'wasm', dtype: 'q8' }];
  let lastErr = null;
  for (const a of attempts) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, { ...a, progress_callback });
      loadedKey = `${model}:${a.device === 'webgpu'}`;
      return a.device;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'transcribe') return;
  try {
    const device = await load(msg.model, msg.preferGPU);
    self.postMessage({ type: 'ready', device });
    const english = msg.model.includes('.en');
    const opts = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
    if (!english && msg.language && msg.language !== 'auto') { opts.language = msg.language; opts.task = 'transcribe'; }
    const { pcm, segments } = msg;
    for (let s = 0; s < segments.length; s++) {
      const [a, b] = segments[s];
      const slice = pcm.subarray(Math.floor(a * 16000), Math.floor(b * 16000));
      const res = await asr(slice, opts);
      const words = [];
      // Whisper pads short audio to 30 s and sometimes writes text into the padding ("Thank you." at 18 s of a 4 s
      // take): drop words that start after the audio ends, and keep the rest inside it.
      const sliceEnd = a + slice.length / 16000;
      for (const c of res.chunks || []) {
        const text = String(c.text || '').trim();
        if (!text) continue;
        const [ts, te] = c.timestamp || [];
        const start = a + (Number.isFinite(ts) ? ts : 0);
        if (start >= sliceEnd) continue;
        const end = a + (Number.isFinite(te) ? te : (Number.isFinite(ts) ? ts + 0.3 : 0.3));
        words.push({ text, start, end: Math.min(sliceEnd, Math.max(end, start + 0.05)) });
      }
      self.postMessage({ type: 'segment', index: s, total: segments.length, words });
    }
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
