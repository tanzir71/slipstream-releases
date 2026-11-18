// Copilot "browser" tier: a small instruct model run by Transformers.js (ONNX Runtime Web) in this worker.
// The library comes from jsDelivr and the weights from the Hugging Face Hub the first time only; both are
// cached by the browser afterwards. Prompts and replies never leave this worker.
// Protocol: in  { type: 'generate', id, model, messages, prefill?, maxNewTokens? } | { type: 'interrupt', id }
//           out { type: 'download', loaded, total } | { type: 'ready', device } | { type: 'token', id, text }
//               | { type: 'done', id, text } | { type: 'error', id?, message }
import { AutoTokenizer, AutoModelForCausalLM, TextStreamer, InterruptableStoppingCriteria, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

env.allowLocalModels = false;
env.useBrowserCache = true;

let tokenizer = null;
let model = null;
let loadedKey = '';
let device = 'wasm';
const stops = new Map(); // generation id → InterruptableStoppingCriteria
const cancelled = new Set(); // ids interrupted before they started
let queue = Promise.resolve();

async function gpu() {
  try {
    const adapter = self.navigator.gpu && (await self.navigator.gpu.requestAdapter());
    return adapter ? { ok: true, f16: adapter.features.has('shader-f16') } : { ok: false, f16: false };
  } catch { return { ok: false, f16: false }; }
}

async function load(id) {
  const g = await gpu();
  // q4f16 needs shader-f16 on the GPU; otherwise q8 on WASM (similar download, no GPU needed).
  const attempts = g.ok && g.f16 ? [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'wasm', dtype: 'q8' }] : [{ device: 'wasm', dtype: 'q8' }];
  const key = `${id}:${attempts[0].device}`;
  if (model && loadedKey === key) return device;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      self.postMessage({ type: 'download', loaded, total });
    }
  };
  tokenizer = tokenizer && loadedKey.startsWith(`${id}:`) ? tokenizer : await AutoTokenizer.from_pretrained(id, { progress_callback });
  let lastErr = null;
  for (const a of attempts) {
    try {
      await model?.dispose?.();
      model = await AutoModelForCausalLM.from_pretrained(id, { ...a, progress_callback });
      loadedKey = `${id}:${a.device}`;
      device = a.device;
      return device;
    } catch (e) { lastErr = e; model = null; }
  }
  throw lastErr;
}

async function generate({ id, model: modelId, messages, prefill = '', maxNewTokens = 768 }) {
  const dev = await load(modelId);
  self.postMessage({ type: 'ready', device: dev });
  let prompt = tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
  if (prefill) prompt += prefill;
  const inputs = tokenizer(prompt, { add_special_tokens: false });
  const stop = new InterruptableStoppingCriteria();
  stops.set(id, stop);
  let text = prefill;
  if (prefill) self.postMessage({ type: 'token', id, text: prefill });
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (t) => { text += t; self.postMessage({ type: 'token', id, text: t }); },
  });
  try {
    const out = await model.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      do_sample: false, // greedy: the lowest-temperature, most repeatable choice for JSON
      repetition_penalty: 1.05,
      streamer,
      stopping_criteria: stop,
    });
    // Prefer a clean decode of the new tokens over the streamed pieces (the streamer may hold back a tail).
    const n = inputs.input_ids.dims[1];
    const ids = out.tolist()[0].slice(n);
    const decoded = tokenizer.decode(ids, { skip_special_tokens: true });
    return prefill + decoded;
  } catch (e) {
    if (stop.interrupted) return text;
    throw e;
  } finally { stops.delete(id); }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'interrupt') {
    if (stops.has(msg.id)) stops.get(msg.id).interrupt(); else cancelled.add(msg.id);
    return;
  }
  if (msg.type !== 'generate') return;
  // One generation at a time; later requests wait their turn.
  queue = queue.then(async () => {
    if (cancelled.delete(msg.id)) return;
    try {
      const text = await generate(msg);
      self.postMessage({ type: 'done', id: msg.id, text });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
  });
};
