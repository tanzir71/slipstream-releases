// Copilot language model, on this device only (tickets A-02 web column, W-08).
// Tiers, best first:
//   builtin — Chrome's Prompt API (`LanguageModel`, Gemini Nano). Runs on-device; Chrome manages the model.
//   browser — a small instruct model run by Transformers.js in llm-worker.js. Opt-in download, cached by the browser.
//   none    — the caller falls back to its rule-based parser.
// Prompts, transcripts and replies never leave the device. No cloud tier lives here: a bring-your-own-key
// provider must be a separate, clearly badged module.

export const LLM_MODELS = [
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    label: 'Qwen2.5 0.5B Instruct',
    license: 'Apache-2.0',
    default: true,
    // Measured downloads (model + tokenizer). WebGPU with shader-f16 uses q4f16, everything else q8 on WASM.
    sizes: { q4f16: 490, q8: 519 },
    sizeMB: 519,
    note: 'Qwen2.5 0.5B · ~500 MB once · runs in this browser',
  },
];

/** Character budgets for buildCopilotMessages: a 0.5B model on WASM vs. Gemini Nano's larger context. */
export const PROMPT_BUDGET = { builtin: 12000, browser: 6000 };

const BUILTIN_OPTS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

async function builtinAvailability() {
  const LM = globalThis.LanguageModel;
  if (!LM || typeof LM.availability !== 'function') return 'unavailable';
  try { return await LM.availability(BUILTIN_OPTS); } catch {
    try { return await LM.availability(); } catch { return 'unavailable'; }
  }
}

async function gpuInfo() {
  try {
    const adapter = globalThis.navigator?.gpu && (await navigator.gpu.requestAdapter());
    return adapter ? { gpu: true, f16: adapter.features.has('shader-f16') } : { gpu: false, f16: false };
  } catch { return { gpu: false, f16: false }; }
}

/**
 * Which tier this browser can use right now.
 * builtin: needsDownload is true while Chrome still has to fetch Gemini Nano (Chrome shows and manages it).
 * browser: needsDownload is true unless the model was already fetched (we can't cheaply tell, so the UI
 * should present sizeMB and ask before the first run).
 * Returns { tier, label, sizeMB?, needsDownload, device?, maxChars, model? }.
 */
export async function detectLLM({ allowBrowserModel = true } = {}) {
  const a = await builtinAvailability();
  if (a === 'available' || a === 'downloadable' || a === 'downloading' || a === 'readily' || a === 'after-download') {
    return {
      tier: 'builtin',
      label: 'Chrome on-device model (Gemini Nano)',
      needsDownload: a !== 'available' && a !== 'readily',
      maxChars: PROMPT_BUDGET.builtin,
    };
  }
  const canWorker = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
  if (allowBrowserModel && canWorker) {
    const m = LLM_MODELS.find((x) => x.default) || LLM_MODELS[0];
    const { gpu, f16 } = await gpuInfo();
    const device = gpu && f16 ? 'webgpu' : 'wasm';
    return {
      tier: 'browser',
      label: `${m.label} (in this browser${device === 'webgpu' ? ', WebGPU' : ''})`,
      model: m.id,
      device,
      sizeMB: device === 'webgpu' ? m.sizes.q4f16 : m.sizes.q8,
      needsDownload: true,
      maxChars: PROMPT_BUDGET.browser,
    };
  }
  return { tier: 'none', label: 'No on-device model', needsDownload: false, maxChars: 0 };
}

// ---------------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------------

const SYSTEM = [
  'You are the edit copilot inside Slipstream, a video editor.',
  'Turn the user\'s instruction into edit operations for their project.',
  'Rules:',
  '- Reply with ONE JSON object and nothing else: {"ops": [ ... ]}. No prose, no markdown, no code fences.',
  '- Use only the operations and fields described in the schema. Do not invent fields.',
  '- Refer to words by their ids exactly as written in the transcript. Times are in seconds.',
  '- Prefer few, precise operations. If nothing should change, reply {"ops": []}.',
].join('\n');

const STOP = new Set('the a an and or but to of in on at for with from by is are was were be been it this that these those my your our their me you we they i he she them his her its as so do does did not no yes can could would should will just about into over than then there here what which who when where how all any some more most very'.split(' '));

function keywords(text) {
  return [...new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) || [])].filter((w) => !STOP.has(w));
}

/** Keep transcript lines within `budget` characters: the opening lines, then lines that share words with the instruction (with one line of context), in order. */
export function fitTranscript(transcript, instruction, budget) {
  const text = String(transcript || '');
  if (text.length <= budget) return text;
  if (budget <= 0) return '';
  const lines = text.split('\n');
  const keys = keywords(instruction);
  const keep = new Set();
  let used = 0;
  const take = (i) => {
    if (i < 0 || i >= lines.length || keep.has(i)) return true;
    const cost = lines[i].length + 1;
    if (used + cost > budget - 40) return false;
    keep.add(i); used += cost; return true;
  };
  for (let i = 0; i < Math.min(3, lines.length); i++) take(i);
  if (keys.length) {
    const scored = lines.map((l, i) => {
      const low = l.toLowerCase();
      return { i, s: keys.reduce((a, k) => a + (low.includes(k) ? 1 : 0), 0) };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
    for (const { i } of scored) { if (!take(i)) break; take(i - 1); take(i + 1); }
  }
  for (let i = 3; i < lines.length; i++) if (!take(i)) break; // fill what's left from the top
  const out = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`… (${i - last - 1} lines omitted)`);
    out.push(lines[i]);
    last = i;
  }
  if (last < lines.length - 1) out.push(`… (${lines.length - 1 - last} lines omitted)`);
  return out.join('\n');
}

/**
 * A worked example shown to the model as an earlier exchange. Small models copy the shape of a demo far
 * more reliably than they follow a description, so keep it in the same op format as `opsSchema`
 * (pass `examples` to buildCopilotMessages to replace it, or [] to drop it).
 */
export const COPILOT_EXAMPLES = [
  {
    transcript: '[w1-w6] 0.0-2.1 Um, so, welcome back everyone.\n[w7-w15] 2.4-6.0 Before we start, ignore the noise outside.\n[w16-w24] 6.3-9.8 Today we look at the export settings.',
    instruction: 'Cut the bit about the noise, remove the fillers and make it square.',
    reply: '{"ops": [{"op": "cut_words", "from_word_id": "w7", "to_word_id": "w15"}, {"op": "remove_fillers"}, {"op": "set_aspect", "aspect": "1:1"}]}',
  },
];

const userTurn = ({ summary, transcript, instruction }) => {
  const parts = [];
  if (summary) parts.push(`Project:\n${summary}`);
  if (transcript) parts.push(`Transcript:\n${transcript}`);
  parts.push(`Instruction: ${instruction}`);
  return parts.join('\n\n');
};

/**
 * Assemble a compact chat prompt for the copilot. transcript, summary and opsSchema are prepared by the
 * caller (strings). The instruction and schema are always kept whole; the summary is capped at a sixth of
 * the budget, worked examples are dropped if they would not fit, and the transcript gets the rest
 * (trimmed by fitTranscript).
 * Returns [{ role: 'system', content }, ({ role: 'user' }, { role: 'assistant' })*, { role: 'user', content }].
 */
export function buildCopilotMessages({ instruction, transcript = '', summary = '', opsSchema = '', maxChars = PROMPT_BUDGET.browser, examples = COPILOT_EXAMPLES } = {}) {
  const ins = String(instruction || '').trim();
  const schema = String(opsSchema || '').trim();
  const system = schema ? `${SYSTEM}\n\nOperation schema:\n${schema}` : SYSTEM;
  let room = Math.max(0, maxChars - system.length - ins.length - 60);
  let sum = String(summary || '').trim();
  const sumCap = Math.max(200, Math.floor(maxChars / 6));
  if (sum.length > sumCap) sum = `${sum.slice(0, sumCap - 1)}…`;
  room -= sum.length;
  const demo = [];
  for (const ex of examples || []) {
    const u = userTurn({ transcript: ex.transcript, instruction: ex.instruction });
    if (u.length + ex.reply.length > room / 3) continue; // keep most of the budget for the real transcript
    demo.push({ role: 'user', content: u }, { role: 'assistant', content: ex.reply });
    room -= u.length + ex.reply.length;
  }
  const tr = fitTranscript(String(transcript || '').trim(), ins, Math.max(0, room));
  return [{ role: 'system', content: system }, ...demo, { role: 'user', content: userTurn({ summary: sum, transcript: tr, instruction: ins }) }];
}

// ---------------------------------------------------------------------------------------------
// JSON from model text
// ---------------------------------------------------------------------------------------------

/** The first balanced {...} in text (string- and escape-aware), or null. */
export function firstJSONObject(text) {
  const s = String(text || '');
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) return s.slice(start, i + 1); if (depth < 0) break; }
    }
    // Unbalanced: close what is open (a reply cut off by max tokens) and let the parser decide.
    if (depth > 0) return closeOpen(s.slice(start));
  }
  return null;
}

function closeOpen(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (const c of s) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let t = s;
  if (inStr) t += '"';
  t = t.replace(/[,:\s]+$/, '');
  return t + stack.reverse().join('');
}

/** Repairs small models commonly need: code fences, // comments, trailing commas, smart quotes, bare keys. */
export function repairJSON(text) {
  return String(text)
    .replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (m, str) => str || '')
    .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => str || close)
    .replace(/("(?:[^"\\]|\\.)*")|([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, (m, str, pre, key, colon) => str || `${pre}"${key}"${colon}`);
}

/** Parse the first JSON object in a model reply, repairing if needed. Throws SyntaxError if there is none. */
export function extractJSON(text) {
  const raw = firstJSONObject(text);
  if (!raw) throw new SyntaxError('No JSON object in model reply');
  try { return JSON.parse(raw); } catch {}
  const fixed = repairJSON(raw);
  try { return JSON.parse(fixed); } catch (err) {
    // Last resort: single-quoted strings ({'ops': []}).
    if (!fixed.includes("'")) throw err;
    return JSON.parse(repairJSON(fixed.replace(/("(?:[^"\\]|\\.)*")|'((?:[^'\\]|\\.)*)'/g, (m, dq, sq) => dq || JSON.stringify(sq))));
  }
}

/** Top-level shape check against a JSON schema: object, required keys present, array-typed keys are arrays. */
export function matchesSchema(obj, schema) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!schema || typeof schema !== 'object') return true;
  for (const k of schema.required || []) if (!(k in obj)) return false;
  for (const [k, p] of Object.entries(schema.properties || {})) {
    if (!(k in obj) || !p || !p.type) continue;
    if (p.type === 'array' && !Array.isArray(obj[k])) return false;
    if (p.type === 'object' && (typeof obj[k] !== 'object' || Array.isArray(obj[k]))) return false;
  }
  return true;
}

const RETRY = 'That reply was not a valid JSON object. Reply again with only the JSON object, starting with { and ending with }.';

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------

/**
 * Create a model adapter for a tier from detectLLM().
 * generateJSON(messages, schema, { signal, onToken }) → Promise<object> (one retry on unparseable output).
 * onDownload(loaded, total) reports model download: bytes for the browser tier, a 0..1 fraction (total 1)
 * while Chrome fetches its built-in model. onReady(device) fires once the model is loaded.
 */
export function createLLM({ tier, model, onDownload, onReady } = {}) {
  if (tier === 'builtin') return builtinLLM({ onDownload, onReady });
  if (tier === 'browser') return browserLLM({ model, onDownload, onReady });
  throw new Error('No on-device language model available');
}

function builtinLLM({ onDownload, onReady }) {
  const LM = globalThis.LanguageModel;
  const sessions = new Set();
  let announced = false;
  const open = async (initialPrompts, signal) => {
    const s = await LM.create({
      ...BUILTIN_OPTS,
      initialPrompts,
      signal,
      monitor(m) { m.addEventListener('downloadprogress', (e) => onDownload?.(e.loaded, 1)); },
    });
    sessions.add(s);
    if (!announced) { announced = true; onReady?.('builtin'); }
    return s;
  };
  const ask = async (session, text, schema, signal, onToken) => {
    const opts = { signal };
    if (schema) opts.responseConstraint = schema;
    if (onToken && typeof session.promptStreaming === 'function') {
      let out = '';
      const stream = session.promptStreaming(text, opts);
      for await (const chunk of stream) {
        // Older Chrome builds stream the whole reply so far; newer ones stream deltas.
        const delta = chunk.startsWith(out) ? chunk.slice(out.length) : chunk;
        out += delta;
        if (delta) onToken(delta);
      }
      return out;
    }
    return session.prompt(text, opts);
  };
  return {
    tier: 'builtin',
    async generateJSON(messages, schema, { signal, onToken } = {}) {
      const msgs = messages.slice();
      const last = msgs.pop();
      const session = await open(msgs, signal);
      try {
        let text;
        try { text = await ask(session, last.content, schema, signal, onToken); } catch (e) {
          if (e?.name !== 'NotSupportedError' || !schema) throw e;
          text = await ask(session, last.content, null, signal, onToken); // schema feature not supported
        }
        try { const obj = extractJSON(text); if (matchesSchema(obj, schema)) return obj; } catch {}
        const again = await ask(session, RETRY, schema, signal, onToken).catch(() => ask(session, RETRY, null, signal, onToken));
        const obj = extractJSON(again);
        if (!matchesSchema(obj, schema)) throw new SyntaxError('Model reply does not match the schema');
        return obj;
      } finally { session.destroy?.(); sessions.delete(session); }
    },
    destroy() { for (const s of sessions) s.destroy?.(); sessions.clear(); },
  };
}

function browserLLM({ model, onDownload, onReady }) {
  const m = LLM_MODELS.find((x) => x.id === model) || LLM_MODELS.find((x) => x.default) || LLM_MODELS[0];
  let worker = null;
  let seq = 0;
  const pending = new Map(); // id → { resolve, reject, onToken }
  const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  const start = () => {
    if (worker) return worker;
    worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'download') onDownload?.(msg.loaded, msg.total);
      else if (msg.type === 'ready') onReady?.(msg.device);
      else if (msg.type === 'token') pending.get(msg.id)?.onToken?.(msg.text);
      else if (msg.type === 'done') { pending.get(msg.id)?.resolve(msg.text); pending.delete(msg.id); }
      else if (msg.type === 'error') {
        const err = new Error(msg.message);
        if (msg.id != null) { pending.get(msg.id)?.reject(err); pending.delete(msg.id); } else failAll(err);
      }
    };
    worker.onerror = (e) => { failAll(new Error(e.message || 'Language model worker failed to start')); worker?.terminate(); worker = null; };
    return worker;
  };
  const generate = (messages, { signal, onToken, prefill = '{', maxNewTokens = 768 } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Generation cancelled', 'AbortError')); return; }
    const id = ++seq;
    const w = start();
    const onAbort = () => {
      w.postMessage({ type: 'interrupt', id });
      pending.delete(id);
      reject(new DOMException('Generation cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      onToken,
      resolve: (t) => { signal?.removeEventListener('abort', onAbort); resolve(t); },
      reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
    });
    w.postMessage({ type: 'generate', id, model: m.id, messages, prefill, maxNewTokens });
  });
  return {
    tier: 'browser',
    model: m.id,
    async generateJSON(messages, schema, { signal, onToken } = {}) {
      // Prefilling "{" makes a small model start its reply inside the JSON object.
      const text = await generate(messages, { signal, onToken });
      try { const obj = extractJSON(text); if (matchesSchema(obj, schema)) return obj; } catch {}
      const retry = [...messages, { role: 'assistant', content: text }, { role: 'user', content: RETRY }];
      const again = await generate(retry, { signal, onToken });
      const obj = extractJSON(again);
      if (!matchesSchema(obj, schema)) throw new SyntaxError('Model reply does not match the schema');
      return obj;
    },
    destroy() { failAll(new DOMException('Language model closed', 'AbortError')); worker?.terminate(); worker = null; },
  };
}
