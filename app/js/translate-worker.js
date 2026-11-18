// On-device subtitle translation with OPUS-MT (Marian) models via Transformers.js (ONNX Runtime Web).
// The library comes from jsDelivr and each language pair from the Hugging Face Hub the first time only;
// both are cached by the browser afterwards. Caption text never leaves this worker.
// Protocol: in  { type: 'translate', job, model, prefix?, texts, preferGPU? }
//           out { type: 'download', loaded, total } | { type: 'ready', device, model }
//               | { type: 'progress', job, done, total } | { type: 'done', job, texts } | { type: 'error', job, message }
import { AutoTokenizer, AutoModelForSeq2SeqLM, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
import { batchTexts } from '../../packages/editor-core/src/translate-utils.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

const loaded = new Map(); // model id → { tokenizer, model, device } (two at most: a pivot needs xx→en and en→yy)
const MAX_INPUT_TOKENS = 512;

async function gpu() {
  try {
    const adapter = self.navigator.gpu && (await self.navigator.gpu.requestAdapter());
    return !!(adapter && adapter.features.has('shader-f16'));
  } catch { return false; }
}

async function load(id, preferGPU) {
  if (loaded.has(id)) return loaded.get(id);
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let l = 0, t = 0;
      for (const f of files.values()) { l += f.loaded; t += f.total; }
      self.postMessage({ type: 'download', loaded: l, total: t });
    }
  };
  // Short caption batches run well on the CPU with 8-bit weights (~120 MB per pair). WebGPU is opt-in:
  // it needs the fp16 weights, about twice the download.
  const attempts = preferGPU && (await gpu()) ? [{ device: 'webgpu', dtype: 'fp16' }, { device: 'wasm', dtype: 'q8' }] : [{ device: 'wasm', dtype: 'q8' }];
  const tokenizer = await AutoTokenizer.from_pretrained(id, { progress_callback });
  let lastErr = null;
  for (const a of attempts) {
    try {
      const model = await AutoModelForSeq2SeqLM.from_pretrained(id, { ...a, progress_callback });
      if (loaded.size >= 2) {
        const [oldId, old] = loaded.entries().next().value;
        await old.model.dispose?.();
        loaded.delete(oldId);
      }
      const entry = { tokenizer, model, device: a.device };
      loaded.set(id, entry);
      return entry;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/**
 * Translate one batch. Inputs are built by hand because Transformers.js does not turn a ">>xx<<" target
 * language prefix into its single token for Marian; and each output is cut at its first end-of-sequence
 * token, because finished rows in a batch keep generating ("segundos.." artifacts).
 */
async function translateBatch({ tokenizer, model }, texts, prefix) {
  const cfg = model.config;
  const eos = Number(cfg.eos_token_id), pad = Number(cfg.pad_token_id ?? eos);
  const langId = prefix ? tokenizer.convert_tokens_to_ids(prefix) : null;
  const rows = texts.map((t) => {
    let ids = tokenizer.encode(String(t || ' ')).map(Number);
    if (ids.length > MAX_INPUT_TOKENS - 1) ids = [...ids.slice(0, MAX_INPUT_TOKENS - 2), eos];
    return langId != null && langId !== tokenizer.unk_token_id ? [Number(langId), ...ids] : ids;
  });
  const L = Math.max(...rows.map((r) => r.length));
  const ids = new BigInt64Array(rows.length * L).fill(BigInt(pad));
  const mask = new BigInt64Array(rows.length * L);
  rows.forEach((r, i) => r.forEach((v, j) => { ids[i * L + j] = BigInt(v); mask[i * L + j] = 1n; }));
  const out = await model.generate({
    input_ids: new Tensor('int64', ids, [rows.length, L]),
    attention_mask: new Tensor('int64', mask, [rows.length, L]),
    max_new_tokens: Math.min(MAX_INPUT_TOKENS, Math.ceil(L * 2.2) + 8),
    do_sample: false,
    num_beams: 1,
  });
  return out.tolist().map((seq) => {
    const keep = [];
    for (const v of seq.slice(1).map(Number)) { if (v === eos) break; keep.push(v); }
    return tokenizer.decode(keep, { skip_special_tokens: true });
  });
}

let queue = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'translate') return;
  queue = queue.then(async () => {
    try {
      const entry = await load(msg.model, msg.preferGPU);
      self.postMessage({ type: 'ready', device: entry.device, model: msg.model });
      const texts = msg.texts || [];
      const result = new Array(texts.length).fill('');
      const batches = batchTexts(texts, { maxItems: 8, maxChars: 1200 });
      let done = 0;
      for (const b of batches) {
        const out = await translateBatch(entry, b.map((i) => texts[i]), msg.prefix);
        b.forEach((i, k) => { result[i] = out[k]; });
        done += b.length;
        self.postMessage({ type: 'progress', job: msg.job, done, total: texts.length });
      }
      self.postMessage({ type: 'done', job: msg.job, texts: result });
    } catch (err) {
      self.postMessage({ type: 'error', job: msg.job, message: String((err && err.message) || err) });
    }
  });
};
