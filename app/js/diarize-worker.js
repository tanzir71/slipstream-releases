// On-device speaker labels (ticket W-03), a pyannote-style pipeline in two models:
//   1. pyannote segmentation 3.0 finds who speaks when inside ~1-minute windows (up to 3 local speakers),
//      stitched into one timeline by overlap agreement (packages/editor-core/src/speakers.js);
//   2. a WeSpeaker ResNet34 voice embedding for each stretch of speech, clustered across the whole
//      recording, so speakers keep the same label from start to end and similar voices stay apart.
// The library comes from jsDelivr and the models from the Hugging Face Hub the first time only; both are
// cached by the browser afterwards. Audio never leaves this worker.
// Protocol: in  { type: 'diarize', pcm (16 kHz mono Float32Array), segModel, embModel|null, numSpeakers?, preferGPU?, windowSec?, overlapSec? }
//           out { type: 'download', loaded, total } | { type: 'ready', device } | { type: 'progress', p }
//               | { type: 'done', segments: [{ start, end, speaker }] } | { type: 'error', message }
import { AutoProcessor, AutoModelForAudioFrameClassification, AutoModel, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
import {
  powersetActivity, diarizationWindows, voiceSignatures, stitchDiarization, findPauses, embeddingRegions, clusterSpeakers,
} from '../../packages/editor-core/src/speakers.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

const SR = 16000;
let seg = null; // { id, processor, model, device }
let emb = null; // { id, processor, model }

const files = new Map();
const progress_callback = (p) => {
  if (p.status === 'progress' && p.file) {
    files.set(`${p.name || ''}/${p.file}`, { loaded: p.loaded || 0, total: p.total || 0 });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    self.postMessage({ type: 'download', loaded, total });
  }
};

async function hasWebGPU() {
  try { return !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch { return false; }
}

async function loadSegmentation(id, preferGPU) {
  const gpu = preferGPU && (await hasWebGPU());
  const want = gpu ? 'webgpu' : 'wasm';
  if (seg && seg.id === id && seg.device === want) return seg;
  const processor = seg && seg.id === id ? seg.processor : await AutoProcessor.from_pretrained(id, { progress_callback });
  // The model is ~6 MB in fp32; quantized variants cost accuracy for no real gain.
  const attempts = gpu ? [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'fp32' }] : [{ device: 'wasm', dtype: 'fp32' }];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const model = await AutoModelForAudioFrameClassification.from_pretrained(id, { ...a, progress_callback });
      seg = { id, processor, model, device: a.device };
      return seg;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function loadEmbedding(id) {
  if (emb && emb.id === id) return emb;
  // 8-bit weights (~6.7 MB) score the same as fp32 (26 MB) on our tests; int8 convolutions run on the
  // CPU (WASM) backend, which is fast enough for one short clip at a time.
  const processor = await AutoProcessor.from_pretrained(id, { progress_callback });
  const model = await AutoModel.from_pretrained(id, { device: 'wasm', dtype: 'q8', progress_callback });
  emb = { id, processor, model };
  return emb;
}

async function frameLogits(x, msg) {
  try {
    return (await seg.model(await seg.processor(x))).logits;
  } catch (e) {
    if (seg.device !== 'webgpu') throw e;
    await loadSegmentation(msg.segModel, false); // some GPU drivers can't run the LSTM: retry on WASM
    return (await seg.model(await seg.processor(x))).logits;
  }
}

async function run(msg) {
  const { pcm } = msg;
  await loadSegmentation(msg.segModel, msg.preferGPU !== false);
  if (msg.embModel) await loadEmbedding(msg.embModel);
  self.postMessage({ type: 'ready', device: seg.device });

  const duration = pcm.length / SR;
  const { offset = 990, step = 270 } = seg.processor.feature_extractor.config;
  const spans = diarizationWindows(duration, { windowSec: msg.windowSec || 60, overlapSec: msg.overlapSec || 15 });
  const segShare = msg.embModel ? 0.3 : 1;
  const windows = [];
  for (let k = 0; k < spans.length; k++) {
    const [a, b] = spans[k];
    const x = pcm.subarray(Math.floor(a * SR), Math.min(pcm.length, Math.floor(b * SR)));
    if (x.length < offset + 4 * step) continue; // too short for a single model frame
    const logits = await frameLogits(x, msg);
    const [, frames] = logits.dims;
    const { act } = powersetActivity(logits.data, frames);
    const w = { start: a, end: a + x.length / SR, frameDur: x.length / ((x.length - offset) / step) / SR, act };
    w.sig = voiceSignatures(pcm, SR, w);
    windows.push(w);
    self.postMessage({ type: 'progress', p: segShare * ((k + 1) / spans.length) });
  }
  if (!windows.length) return [];
  const numSpeakers = Math.max(0, Math.floor(Number(msg.numSpeakers) || 0));
  if (!msg.embModel) return stitchDiarization(windows, { maxSpeakers: numSpeakers });

  // Second stage: voice embeddings for each stretch of speech, then clustering.
  const raw = stitchDiarization(windows, { fillGapSec: 0, minSpeakerSec: 0, minSegSec: 0.1 });
  const regions = embeddingRegions(raw, { pauses: findPauses(pcm, SR) });
  const todo = regions.filter((r) => r.embed).length || 1;
  const vectors = [];
  let done = 0;
  for (const r of regions) {
    if (!r.embed) { vectors.push(null); continue; }
    const x = pcm.slice(Math.floor(r.start * SR), Math.min(pcm.length, Math.ceil(r.end * SR)));
    const out = await emb.model(await emb.processor(x));
    const t = out.last_hidden_state || out.embeddings || Object.values(out)[0];
    vectors.push(Float32Array.from(t.data));
    done++;
    if (done % 8 === 0 || done === todo) self.postMessage({ type: 'progress', p: segShare + (1 - segShare) * (done / todo) });
  }
  return clusterSpeakers(regions, vectors, { numSpeakers });
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'diarize') return;
  try {
    const segments = await run(msg);
    self.postMessage({ type: 'done', segments });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
