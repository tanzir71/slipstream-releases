// Optional cloud models with the user's own keys (tickets A-02 "BYO key" and S-04 "generated B-roll").
// Everything is off until the user adds a key in Settings. Keys stay in this browser (IndexedDB settings)
// and are never written into projects, bundles or exports. What may leave the device, after opt-in:
//   - copilot: the request, the transcript text and a short edit summary (never video or audio);
//   - B-roll: the prompt the user typed for an image or video clip.
// Providers:
//   copilot  — Anthropic (official SDK), OpenRouter, any OpenAI-compatible endpoint (OpenAI, LM Studio, Ollama…)
//   B-roll   — OpenRouter (Image + Video APIs), Higgsfield (images and video), OpenAI-compatible images
// This module is the ONLY place in the web app allowed to contact these hosts (tests/web-app-shell.test.mjs).
// Higgsfield asks that its API not be called from browser code, and none of the providers document CORS, so
// inside the desktop app requests go through the native layer (globalThis.slipstreamDesktop.cloudFetch).
import { getSetting, setSetting } from './store.js';

// Pinned Anthropic TypeScript SDK, loaded only when Anthropic is the copilot provider.
const ANTHROPIC_SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.5.0/+esm';
const OPENROUTER = 'https://openrouter.ai/api/v1';
const OPENROUTER_ORIGIN = 'https://openrouter.ai';
const HIGGSFIELD = 'https://api.higgsfield.ai';
const OPENAI = 'https://api.openai.com/v1';

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', roles: ['copilot'], fields: ['apiKey', 'model'], defaults: { model: 'claude-opus-5-5' }, keyHint: 'sk-ant-…' },
  openrouter: { label: 'OpenRouter', roles: ['copilot', 'media'], fields: ['apiKey', 'model', 'imageModel', 'videoModel'], defaults: { imageModel: 'bytedance-seed/seedream-4.5', videoModel: 'google/veo-3.1-lite' }, keyHint: 'sk-or-…', video: true },
  higgsfield: { label: 'Higgsfield', roles: ['media'], fields: ['keyId', 'keySecret', 'imageModel', 'videoModel'], defaults: { imageModel: 'higgsfield-ai/soul/v2/standard', videoModel: 'higgsfield/cinema-studio/4.0' }, video: true, desktopOnly: true },
  openai: { label: 'OpenAI-compatible', roles: ['copilot', 'media'], fields: ['apiKey', 'baseURL', 'model', 'imageModel'], defaults: { baseURL: OPENAI, imageModel: 'gpt-image-1' }, keyHint: 'sk-… (or blank for LM Studio / Ollama)' },
  elevenlabs: { label: 'ElevenLabs', roles: ['music'], fields: ['apiKey'], keyHint: 'sk_…' },
};
const ELEVENLABS = 'https://api.elevenlabs.io';

/** Saved settings: { consent, copilot: id|null, media: id|null, music: id|null, anthropic: {...}, openrouter: {...}, … } */
export async function loadCloud() { return (await getSetting('cloud').catch(() => null)) || {}; }
export const saveCloud = (s) => setSetting('cloud', s);
export const clearCloud = () => setSetting('cloud', null);

const hasKey = (id, c) => (id === 'higgsfield' ? !!(c?.keyId && c?.keySecret) : id === 'openai' ? !!c?.baseURL || !!c?.apiKey : !!c?.apiKey);
const conf = (s, id) => ({ ...PROVIDERS[id].defaults, ...(s?.[id] || {}) });

/** The provider used for copilot requests, or null. */
export async function copilotProvider() {
  const s = await loadCloud();
  if (!s.consent || !s.copilot || !hasKey(s.copilot, s[s.copilot])) return null;
  return { id: s.copilot, label: providerLabel(s.copilot, s), config: conf(s, s.copilot) };
}
/** The provider used for B-roll generation, or null. */
export async function mediaProvider() {
  const s = await loadCloud();
  if (!s.consent || !s.media || !hasKey(s.media, s[s.media])) return null;
  return { id: s.media, label: providerLabel(s.media, s), config: conf(s, s.media), video: !!PROVIDERS[s.media].video, desktopOnly: !!PROVIDERS[s.media].desktopOnly };
}

/** The provider used for music generation (S-04), or null. */
export async function musicProvider() {
  const s = await loadCloud();
  if (!s.consent || !s.music || !hasKey(s.music, s[s.music])) return null;
  return { id: s.music, label: providerLabel(s.music, s), config: conf(s, s.music) };
}

export function providerLabel(id, s = {}) {
  if (id === 'openai') { const b = s.openai?.baseURL; if (b && b !== OPENAI) { try { return new URL(b).host; } catch { return 'custom endpoint'; } } }
  return PROVIDERS[id]?.label || id;
}

/** fetch() that goes through the desktop app's native HTTP when available (no CORS, key never in a webview request log). */
function cloudFetch(url, init) {
  const native = globalThis.slipstreamDesktop?.cloudFetch;
  return native ? native(url, init) : fetch(url, init);
}
async function okJson(res, label) {
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = j?.error?.message || j?.detail || JSON.stringify(j).slice(0, 200); } catch { msg = (await res.text().catch(() => '')).slice(0, 200); }
    throw new Error(`${label} returned ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  return res.json();
}
function networkHint(err, id) {
  if (err?.name === 'TypeError' && !globalThis.slipstreamDesktop) {
    return new Error(`${PROVIDERS[id].label} couldn’t be reached from the browser${PROVIDERS[id].desktopOnly ? ' (it only allows calls from apps, not web pages)' : ' (it may block browser requests)'}. Use the Slipstream desktop app for this provider.`);
  }
  return err;
}

// ---- copilot ---------------------------------------------------------------------------------------

/** Structured-output schema for copilot replies: op args travel as JSON strings and are validated locally. */
export function cloudOpsSchema(opNames) {
  return {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'One short sentence for the user describing the plan, or why nothing applies.' },
      ops: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: opNames },
            args_json: { type: 'string', description: 'The op arguments as a JSON object, e.g. {"from_word_id":"w12","to_word_id":"w30"}. Use "{}" when the op takes none.' },
          },
          required: ['op', 'args_json'],
          additionalProperties: false,
        },
      },
    },
    required: ['reply', 'ops'],
    additionalProperties: false,
  };
}

let sdkPromise = null;
async function anthropicClient(apiKey) {
  sdkPromise ??= import(ANTHROPIC_SDK);
  const mod = await sdkPromise;
  const Anthropic = mod.default || mod.Anthropic;
  // The user's own key in the user's own browser; requests go straight to Anthropic.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, ...(globalThis.slipstreamDesktop?.cloudFetch ? { fetch: globalThis.slipstreamDesktop.cloudFetch } : {}) });
}

/** Ask the copilot provider for ops. Returns { reply, ops: [{ op, args }] }. */
export async function cloudOps(provider, { system, user, opNames, signal }) {
  const schema = cloudOpsSchema(opNames);
  const c = provider.config;
  let text;
  try {
    if (provider.id === 'anthropic') {
      const client = await anthropicClient(c.apiKey);
      const msg = await client.beta.messages.create({
        model: c.model || PROVIDERS.anthropic.defaults.model,
        max_tokens: 16000,
        // Server-side fallback: if the request is declined, the API re-runs it on a suitable model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content: user }],
      }, { signal });
      if (msg.stop_reason === 'refusal') throw new Error(`The model declined this request${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ''}.`);
      if (msg.stop_reason === 'max_tokens') throw new Error('The model’s answer was cut off. Try a shorter request.');
      text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    } else {
      const base = provider.id === 'openrouter' ? OPENROUTER : (c.baseURL || OPENAI).replace(/\/+$/, '');
      if (!c.model) throw new Error(`Choose a model for ${provider.label} in Cloud settings.`);
      const res = await cloudFetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
        body: JSON.stringify({
          model: c.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          response_format: { type: 'json_schema', json_schema: { name: 'slipstream_ops', strict: true, schema } },
          ...(provider.id === 'openrouter' ? { provider: { require_parameters: true } } : {}),
        }),
      });
      const data = await okJson(res, provider.label);
      text = data.choices?.[0]?.message?.content || '';
    }
  } catch (err) { throw networkHint(err, provider.id); }
  const out = JSON.parse(text);
  const ops = (out.ops || []).map((o) => {
    let args = {};
    try { args = o.args_json ? JSON.parse(o.args_json) : {}; } catch { args = { __invalid: o.args_json }; }
    return { op: o.op, args };
  });
  return { reply: String(out.reply || ''), ops };
}

/** Text models on OpenRouter that support structured outputs (public list, no key needed). */
export async function openRouterTextModels() {
  const res = await cloudFetch(`${OPENROUTER}/models?supported_parameters=structured_outputs`, {});
  const data = await okJson(res, 'OpenRouter');
  return (data.data || []).map((m) => m.id).sort();
}

// ---- B-roll generation (S-04) --------------------------------------------------------------------------

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
});
function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Generate a B-roll image or video from a prompt. opts = { kind: 'image'|'video', prompt, aspect ('16:9'|'9:16'|'1:1'),
 * duration (s, video), signal, onStatus(text) }. Resolves with a Blob. Only the prompt is sent.
 */
export async function generateMedia(provider, { kind, prompt, aspect = '16:9', duration = 4, signal, onStatus = () => {} }) {
  const c = provider.config;
  try {
    if (provider.id === 'openrouter') return kind === 'video' ? await openRouterVideo(c, { prompt, aspect, duration, signal, onStatus }) : await openRouterImage(c, { prompt, aspect, signal, onStatus });
    if (provider.id === 'higgsfield') return await higgsfield(c, { kind, prompt, aspect, duration, signal, onStatus });
    if (provider.id === 'openai') {
      if (kind === 'video') throw new Error('Video generation needs OpenRouter or Higgsfield.');
      return await openAIImage(c, { prompt, aspect, signal, onStatus });
    }
    throw new Error('This provider can’t generate media.');
  } catch (err) { throw networkHint(err, provider.id); }
}

// ---- music (S-04) ------------------------------------------------------------------------------------

/**
 * Generate a music bed from a text prompt with the user's own key. Only the prompt and the length are sent.
 * Resolves an audio Blob (MP3).
 */
export async function generateMusic(provider, { prompt, seconds = 60, signal, onStatus = () => {} }) {
  if (provider.id !== 'elevenlabs') throw new Error(`${provider.label} can't make music`);
  onStatus('Composing…');
  const ms = Math.round(Math.max(3, Math.min(600, seconds)) * 1000);
  let res;
  try {
    res = await cloudFetch(`${ELEVENLABS}/v1/music?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': provider.config.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ prompt: String(prompt).slice(0, 2000), music_length_ms: ms }),
      signal,
    });
  } catch (err) { throw networkHint(err, provider.id); }
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = j?.detail?.message || (typeof j?.detail === 'string' ? j.detail : '') || JSON.stringify(j).slice(0, 200); } catch { /* not JSON */ }
    throw new Error(`ElevenLabs returned ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  const blob = await res.blob();
  return blob.type.startsWith('audio/') ? blob : new Blob([blob], { type: 'audio/mpeg' });
}

async function openRouterImage(c, { prompt, aspect, signal, onStatus }) {
  onStatus('Generating image…');
  const res = await cloudFetch(`${OPENROUTER}/images`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify({ model: c.imageModel, prompt, aspect_ratio: aspect, n: 1 }),
  });
  const data = await okJson(res, 'OpenRouter');
  const item = data.data?.[0];
  if (!item?.b64_json) throw new Error('OpenRouter returned no image.');
  return b64ToBlob(item.b64_json, item.media_type || 'image/png');
}

async function openRouterVideo(c, { prompt, aspect, duration, signal, onStatus }) {
  onStatus('Submitting video…');
  const auth = { authorization: `Bearer ${c.apiKey}` };
  const res = await cloudFetch(`${OPENROUTER}/videos`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: c.videoModel, prompt, duration, resolution: '720p', aspect_ratio: aspect, generate_audio: false }),
  });
  const job = await okJson(res, 'OpenRouter');
  const poll = job.polling_url?.startsWith('http') ? job.polling_url : `${OPENROUTER_ORIGIN}${job.polling_url || `/api/v1/videos/${job.id}`}`;
  for (let wait = 2000, t0 = performance.now(); ; wait = Math.min(10000, wait * 1.5)) {
    await sleep(wait + Math.random() * 400, signal);
    const st = await okJson(await cloudFetch(poll, { headers: auth, signal }), 'OpenRouter');
    onStatus(`Video ${st.status.replace('_', ' ')} · ${Math.round((performance.now() - t0) / 1000)} s`);
    if (st.status === 'completed') {
      if (st.urls?.[0]) return (await cloudFetch(st.urls[0], { signal })).blob();
      return (await cloudFetch(`${OPENROUTER}/videos/${job.id}/content?index=0`, { headers: auth, signal })).blob();
    }
    if (['failed', 'cancelled', 'expired'].includes(st.status)) throw new Error(`Video generation ${st.status}${st.error ? `: ${st.error.message || st.error}` : ''}.`);
    if (performance.now() - t0 > 15 * 60 * 1000) throw new Error('Video generation timed out after 15 minutes.');
  }
}

async function higgsfield(c, { kind, prompt, aspect, duration, signal, onStatus }) {
  const auth = { authorization: `Key ${c.keyId}:${c.keySecret}` };
  const model = kind === 'video' ? c.videoModel : c.imageModel;
  const body = kind === 'video' ? { prompt, duration: Math.max(4, Math.min(30, Math.round(duration))), aspect_ratio: aspect, resolution: '720p', generate_audio: false } : { prompt };
  onStatus(`Submitting ${kind}…`);
  const res = await cloudFetch(`${HIGGSFIELD}/${model}`, { method: 'POST', signal, headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) });
  const job = await okJson(res, 'Higgsfield');
  for (let wait = 2000, t0 = performance.now(); ; wait = Math.min(10000, wait * 1.5)) {
    await sleep(wait + Math.random() * 400, signal);
    const st = await okJson(await cloudFetch(job.status_url, { headers: auth, signal }), 'Higgsfield');
    onStatus(`${kind === 'video' ? 'Video' : 'Image'} ${String(st.status).replace('_', ' ')} · ${Math.round((performance.now() - t0) / 1000)} s`);
    if (st.status === 'completed') {
      const url = kind === 'video' ? st.video?.url : st.images?.[0]?.url;
      if (!url) throw new Error('Higgsfield returned no file.');
      return (await cloudFetch(url, { signal })).blob(); // output links expire, so download now
    }
    if (['failed', 'nsfw', 'canceled'].includes(st.status)) throw new Error(`Higgsfield: ${st.status}${st.error ? ` (${st.error})` : ''}.`);
    if (performance.now() - t0 > 15 * 60 * 1000) throw new Error('Generation timed out after 15 minutes.');
  }
}

async function openAIImage(c, { prompt, aspect, signal, onStatus }) {
  onStatus('Generating image…');
  const base = (c.baseURL || OPENAI).replace(/\/+$/, '');
  const size = aspect === '9:16' ? '1024x1536' : aspect === '1:1' ? '1024x1024' : '1536x1024';
  const res = await cloudFetch(`${base}/images/generations`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
    body: JSON.stringify({ model: c.imageModel, prompt, size, n: 1 }),
  });
  const data = await okJson(res, providerLabel('openai', { openai: c }));
  const item = data.data?.[0];
  if (item?.b64_json) return b64ToBlob(item.b64_json, 'image/png');
  if (item?.url) return (await cloudFetch(item.url, { signal })).blob();
  throw new Error('The provider returned no image.');
}
