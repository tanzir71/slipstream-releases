// Serverless signalling and transfer framing for direct device-to-device links (S-05, S-06).
//
// There is no signalling server: one browser turns its WebRTC offer (with every ICE candidate
// already gathered) into a short "code" that the person sends over any chat app; the other browser
// pastes it and answers with a code of its own. A code is JSON → deflate-raw → base64url, so it is
// safe in a URL fragment (#/guest/<code>), which browsers never send to a server.
//
// Also here: SDP trimming to keep codes short, the binary frame format used on the file data
// channel, the file manifest, a progress/ETA tracker and NTP-style clock-offset maths.
// Pure: no DOM, no Node built-ins. Runs in browsers and Node 20+.

export const SIGNAL_VERSION = 1;
const PREFIX_DEFLATE = 'S1';
const PREFIX_PLAIN = 'S0'; // fallback for engines without CompressionStream('deflate-raw')
const MAX_DECODED_BYTES = 256 * 1024;

/** Errors a person can act on. `reason` is one of: empty, format, chars, corrupt, version, kind. */
export class SignalCodeError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'SignalCodeError';
    this.reason = reason;
  }
}

// ---- base64url (RFC 4648 §5, no padding) ----------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

export function toBase64Url(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >>> 18] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[n >>> 18] + B64[(n >>> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[n >>> 18] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63];
  }
  return out;
}

export function fromBase64Url(str) {
  if (str.length % 4 === 1) throw new SignalCodeError('The code is incomplete. Copy all of it and paste it again.', 'corrupt');
  const out = new Uint8Array(Math.floor((str.length * 3) / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) throw new SignalCodeError('The code contains characters that don’t belong in it. Copy it again, all of it.', 'chars');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >>> bits) & 255; }
  }
  return out.subarray(0, o);
}

// ---- compression ---------------------------------------------------------------------------------
const hasDeflateRaw = () => {
  try { return typeof CompressionStream !== 'undefined' && !!new CompressionStream('deflate-raw'); } catch { return false; }
};

async function transform(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > limit) { reader.cancel().catch(() => {}); throw new SignalCodeError('That code is far too large to be a Slipstream code.', 'corrupt'); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/**
 * Pull the code out of whatever was pasted: the bare code, a full link ending in #/guest/<code>
 * or #/receive/<code>, or a code wrapped over several lines or in quotes by a chat app.
 */
export function extractCode(input) {
  let s = String(input ?? '').trim();
  const at = s.lastIndexOf('#/');
  if (at >= 0) s = s.slice(at + 2).split('/').pop();
  try { if (s.includes('%')) s = decodeURIComponent(s); } catch { /* keep as is */ }
  return s.replace(/\s+/g, '').replace(/^[<"'`(]+|[>"'`).,]+$/g, '');
}

/** JSON-serialisable value → URL-safe code (async: compression is stream based). */
export async function encodeSignal(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  if (!hasDeflateRaw()) return PREFIX_PLAIN + toBase64Url(json);
  return PREFIX_DEFLATE + toBase64Url(await transform(json, new CompressionStream('deflate-raw')));
}

/** Code (or a link containing one) → the original value. Throws SignalCodeError with a clear message. */
export async function decodeSignal(code) {
  const s = extractCode(code);
  if (!s) throw new SignalCodeError('Paste the code first.', 'empty');
  const prefix = s.slice(0, 2);
  if (prefix !== PREFIX_DEFLATE && prefix !== PREFIX_PLAIN) {
    if (/^S\d/.test(s)) throw new SignalCodeError('This code was made by a newer version of Slipstream. Reload both apps and try again.', 'version');
    throw new SignalCodeError('That doesn’t look like a Slipstream code. Codes start with “S1”.', 'format');
  }
  const raw = fromBase64Url(s.slice(2));
  let bytes = raw;
  if (prefix === PREFIX_DEFLATE) {
    if (typeof DecompressionStream === 'undefined') throw new SignalCodeError('This browser can’t read compressed codes. Use a recent Chrome, Edge, Firefox or Safari.', 'format');
    try {
      bytes = await transform(raw, new DecompressionStream('deflate-raw'), MAX_DECODED_BYTES);
    } catch (err) {
      if (err instanceof SignalCodeError) throw err;
      throw new SignalCodeError('The code is incomplete or damaged. Copy all of it again, or ask for a new one.', 'corrupt');
    }
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new SignalCodeError('The code is incomplete or damaged. Copy all of it again, or ask for a new one.', 'corrupt');
  }
  return value;
}

/**
 * Validate a decoded offer/answer: { v, k: 'offer'|'answer', sdp, p?, n?, ice?, f? }.
 * `kind` is what this screen expects; `purpose` ('call' | 'send') is checked for offers.
 */
export function checkSignal(obj, kind, purpose) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.sdp !== 'string' || !obj.sdp.startsWith('v=0')) {
    throw new SignalCodeError('The code is incomplete or damaged. Copy all of it again, or ask for a new one.', 'corrupt');
  }
  if (obj.v !== SIGNAL_VERSION) throw new SignalCodeError('This code was made by a different version of Slipstream. Reload both apps and try again.', 'version');
  if (kind && obj.k !== kind) {
    throw new SignalCodeError(obj.k === 'answer'
      ? 'This is an answer code. Paste it into the screen that made the invite.'
      : 'This is an invite. Open it on the other device, then paste the answer it gives you here.', 'kind');
  }
  if (purpose && obj.k === 'offer' && (obj.p || 'call') !== purpose) {
    throw new SignalCodeError(obj.p === 'send'
      ? 'This invite is for receiving a file, not for a recording session.'
      : 'This invite is for a recording session, not for receiving a file.', 'kind');
  }
  return obj;
}

// ---- SDP trimming -------------------------------------------------------------------------------
// Header extensions worth keeping: demuxing (mid, rid), congestion control and camera rotation.
export const DEFAULT_EXTMAPS = ['sdes:mid', 'rtp-stream-id', 'transport-wide-cc', 'abs-send-time', 'video-orientation'];
const CANDIDATE_EXT_KEEP = new Set(['raddr', 'rport', 'tcptype']);

function trimCandidate(line, { dropTcp, rtcpMux }) {
  // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> [name value]...
  const parts = line.slice('a=candidate:'.length).split(' ');
  if (parts.length < 8 || parts[6] !== 'typ') return line;
  if (dropTcp && parts[2].toLowerCase() === 'tcp') return null;
  if (rtcpMux && parts[1] !== '1') return null;
  const head = parts.slice(0, 8);
  for (let i = 8; i + 1 < parts.length; i += 2) if (CANDIDATE_EXT_KEEP.has(parts[i])) head.push(parts[i], parts[i + 1]);
  return 'a=candidate:' + head.join(' ');
}

function trimMedia(sec, { keepCodecs, keepExtmaps, dropTcp }) {
  const [mline, ...attrs] = sec;
  const m = mline.split(' ');
  const rtcpMux = attrs.includes('a=rtcp-mux');
  let keep = null; // Set of payload types to keep, or null to keep all
  if ((m[0] === 'm=audio' || m[0] === 'm=video') && /RTP/.test(m[2] || '') && keepCodecs?.length) {
    const want = new Set(keepCodecs.map((c) => c.toLowerCase()));
    const name = new Map(), apt = new Map();
    for (const a of attrs) {
      let r = a.match(/^a=rtpmap:(\d+) ([^/]+)/);
      if (r) name.set(r[1], r[2].toLowerCase());
      r = a.match(/^a=fmtp:(\d+) .*\bapt=(\d+)/);
      if (r) apt.set(r[1], r[2]);
    }
    const pts = m.slice(3);
    const base = new Set(pts.filter((pt) => want.has(name.get(pt))));
    if (base.size) keep = new Set(pts.filter((pt) => base.has(pt) || (name.get(pt) === 'rtx' && base.has(apt.get(pt)))));
  }
  const out = [keep ? [...m.slice(0, 3), ...m.slice(3).filter((pt) => keep.has(pt))].join(' ') : mline];
  for (const a of attrs) {
    if (keep) {
      const pt = a.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)[ ]/);
      if (pt && !keep.has(pt[1])) continue;
    }
    if (a.startsWith('a=extmap:') && keepExtmaps) {
      const uri = a.split(' ')[1] || '';
      if (!keepExtmaps.some((k) => uri.includes(k))) continue;
    }
    if (/^a=ssrc:\d+ (msid|mslabel|label):/.test(a)) continue; // duplicated by the media-level a=msid
    if (rtcpMux && a.startsWith('a=rtcp:')) continue;
    if (a.startsWith('a=candidate:')) {
      const c = trimCandidate(a, { dropTcp, rtcpMux });
      if (c) out.push(c);
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Drop SDP lines a direct connection doesn't need so the code stays short:
 * codecs other than `keepCodecs` (and their RTX), unused header extensions, TCP and RTCP-component
 * candidates, candidate bookkeeping (generation, network-id…) and per-SSRC msid duplicates.
 * The result is still valid SDP; an answer to it simply negotiates the smaller set.
 */
export function stripSdp(sdp, { keepCodecs = ['opus', 'VP8'], keepExtmaps = DEFAULT_EXTMAPS, dropTcp = true } = {}) {
  const lines = String(sdp).split(/\r?\n/).filter((l) => l.length);
  const sections = [[]];
  for (const l of lines) {
    if (l.startsWith('m=')) sections.push([l]);
    else sections[sections.length - 1].push(l);
  }
  const [session, ...media] = sections;
  const out = [...session, ...media.flatMap((sec) => trimMedia(sec, { keepCodecs, keepExtmaps, dropTcp }))];
  return out.join('\r\n') + '\r\n';
}

/** Count ICE candidates by type in an SDP, e.g. { host: 2, srflx: 1 } (mDNS hosts count as host). */
export function candidateTypes(sdp) {
  const out = {};
  for (const m of String(sdp).matchAll(/^a=candidate:\S+ \d+ \S+ \d+ \S+ \d+ typ (\S+)/gm)) out[m[1]] = (out[m[1]] || 0) + 1;
  return out;
}

// ---- user-supplied ICE servers ------------------------------------------------------------------
const ICE_URL = /^(stuns?|turns?):[^\s]+$/i;

/**
 * Parse what someone pasted into the "ICE server" field into RTCIceServer objects.
 * Accepts one server per line (or comma separated): `stun:stun.example.org:3478`, or
 * `turn:turn.example.org:3478?transport=udp username credential`; or a JSON RTCIceServer / array of them.
 * Nothing is built in: an empty field means host and mDNS candidates only.
 */
export function parseIceServers(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  let list;
  if (s[0] === '[' || s[0] === '{') {
    let v;
    try { v = JSON.parse(s); } catch { throw new Error('The ICE server JSON is not valid.'); }
    list = (Array.isArray(v) ? v : [v]).map((x) => ({ urls: x?.urls, username: x?.username, credential: x?.credential }));
  } else {
    list = s.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [urls, username, credential] = l.split(/\s+/);
      return { urls, username, credential };
    });
  }
  return list.map((x) => {
    const urls = Array.isArray(x.urls) ? x.urls : [x.urls];
    if (!urls.length || !urls.every((u) => typeof u === 'string' && ICE_URL.test(u))) {
      throw new Error('ICE servers start with stun:, stuns:, turn: or turns:, for example stun:stun.example.org:3478.');
    }
    const turn = urls.some((u) => /^turns?:/i.test(u));
    if (turn && (!x.username || !x.credential)) throw new Error('A TURN server needs a username and password after the address.');
    const out = { urls: urls.length === 1 ? urls[0] : urls };
    if (x.username) out.username = String(x.username);
    if (x.credential) out.credential = String(x.credential);
    return out;
  });
}

// ---- file manifest and data frames -------------------------------------------------------------
// A transfer is: manifest (JSON on the control channel) → receiver replies "accept" with the byte
// offset it already holds (0, or more when resuming) → binary frames from that offset on the file
// channel → receiver hashes as it goes and replies "ok" or "bad". Every frame carries its transfer
// id and absolute byte offset, so gaps, duplicates and resumes are detectable.

export const FILE_KINDS = ['screen', 'camera', 'mic', 'export', 'project'];
export const FRAME_SIZE = 64 * 1024; // largest message every browser accepts on a data channel
export const FRAME_HEADER_BYTES = 16;
export const FRAME_PAYLOAD = FRAME_SIZE - FRAME_HEADER_BYTES;
const MAGIC_0 = 0x53, MAGIC_1 = 0x46; // "SF"
const FRAME_VERSION = 1;
const FLAG_LAST = 1;

/** Safe file name: no path separators or control characters, at most 180 characters. */
export function safeFileName(name, fallback = 'file') {
  // eslint-disable-next-line no-control-regex
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.{2,}/g, '.')
    .replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 180);
  return s || fallback;
}

/** Validate and normalise a manifest. Throws on anything malformed. */
export function parseHeader(input) {
  let m = input;
  if (typeof input === 'string') {
    try { m = JSON.parse(input); } catch { throw new Error('File header is not valid JSON.'); }
  }
  if (!m || typeof m !== 'object') throw new Error('File header is missing.');
  const id = m.id;
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new Error('File header has a bad transfer id.');
  if (!Number.isSafeInteger(m.size) || m.size < 0) throw new Error('File header has a bad size.');
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error('File header has a bad SHA-256.');
  if (!FILE_KINDS.includes(m.kind)) throw new Error(`File header has an unknown kind “${m.kind}”.`);
  const offset = m.offset == null ? 0 : m.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > m.size) throw new Error('File header has a bad offset.');
  const type = typeof m.type === 'string' && /^[\w.+-]+\/[\w.+-]+(;[\w\s.,=+"/-]*)?$/.test(m.type) && m.type.length <= 120 ? m.type : 'application/octet-stream';
  const extra = m.extra && typeof m.extra === 'object' && !Array.isArray(m.extra) ? m.extra : {};
  return { id, name: safeFileName(m.name), type, size: m.size, sha256: m.sha256, kind: m.kind, offset, extra };
}

/** Manifest → JSON string (validated, so a bad one fails on the sender, not the receiver). */
export function makeHeader(meta) {
  const h = parseHeader(meta);
  return JSON.stringify({ sys: 'file', ...h });
}

/** Binary data frame: "SF" | version | flags | id u32 | offset u64 | payload (all big-endian). */
export function makeFrame(id, offset, payload, { last = false } = {}) {
  if (payload.byteLength > FRAME_PAYLOAD) throw new Error(`Frame payload is larger than ${FRAME_PAYLOAD} bytes.`);
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const dv = new DataView(out.buffer);
  out[0] = MAGIC_0; out[1] = MAGIC_1; out[2] = FRAME_VERSION; out[3] = last ? FLAG_LAST : 0;
  dv.setUint32(4, id >>> 0);
  dv.setUint32(8, Math.floor(offset / 0x100000000));
  dv.setUint32(12, offset >>> 0);
  out.set(payload instanceof Uint8Array ? payload : new Uint8Array(payload.buffer ?? payload, payload.byteOffset ?? 0, payload.byteLength), FRAME_HEADER_BYTES);
  return out;
}

/** ArrayBuffer | Uint8Array → { id, offset, last, payload }. Throws on anything that isn't a frame. */
export function parseFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < FRAME_HEADER_BYTES || bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) throw new Error('Not a Slipstream data frame.');
  if (bytes[2] !== FRAME_VERSION) throw new Error(`Unsupported frame version ${bytes[2]}.`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    id: dv.getUint32(4),
    offset: dv.getUint32(8) * 0x100000000 + dv.getUint32(12),
    last: !!(bytes[3] & FLAG_LAST),
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

// ---- progress and ETA ---------------------------------------------------------------------------
/**
 * Transfer progress with a smoothed rate. `now` is injectable for tests (milliseconds).
 * update(done) → { done, total, fraction, rate (bytes/s, or 0 while unknown), eta (s, or null) }.
 */
export function createProgress(total, { now = () => Date.now(), start = 0, tau = 2500 } = {}) {
  let lastT = now(), lastDone = start, rate = 0, samples = 0;
  const stats = (done) => {
    const left = Math.max(0, total - done);
    return { done, total, fraction: total > 0 ? Math.min(1, done / total) : 1, rate, eta: left === 0 ? 0 : rate > 0 ? left / rate : null };
  };
  return {
    update(done) {
      const t = now();
      const dt = t - lastT;
      if (dt >= 50 || done >= total) {
        if (dt > 0) {
          const inst = Math.max(0, ((done - lastDone) * 1000) / dt);
          const a = samples ? 1 - Math.exp(-dt / tau) : 1;
          rate = rate + a * (inst - rate);
          samples++;
        }
        lastT = t; lastDone = done;
      }
      return stats(done);
    },
  };
}

/** Human ETA in sentence case. */
export function formatEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec <= 0) return 'done';
  if (sec < 10) return 'a few seconds left';
  if (sec < 60) return `about ${Math.round(sec / 5) * 5} s left`;
  if (sec < 3600) { const m = Math.round(sec / 60); return `about ${m} min left`; }
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return `about ${h} h ${m} min left`;
}

// ---- shared clock (NTP-style) -------------------------------------------------------------------
// Both sides use performance.timeOrigin + performance.now() (ms since the epoch). A ping sent at
// local time a, answered with the remote time b, and received back at local time c gives
// rtt = c − a and offset = b − (a + c) / 2 (remote minus local). The sample with the lowest RTT
// is the least distorted by queueing, so the estimate uses the best few.

export function clockSample(sentAt, remoteAt, receivedAt) {
  return { rtt: Math.max(0, receivedAt - sentAt), offset: remoteAt - (sentAt + receivedAt) / 2 };
}

/** samples → { offset, rtt, samples } using the lowest-RTT quarter (at least one). */
export function estimateClock(samples) {
  const ok = samples.filter((s) => Number.isFinite(s?.rtt) && Number.isFinite(s?.offset));
  if (!ok.length) return null;
  const best = [...ok].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.floor(ok.length / 4)));
  const offs = best.map((s) => s.offset).sort((a, b) => a - b);
  const mid = offs.length >> 1;
  const offset = offs.length % 2 ? offs[mid] : (offs[mid - 1] + offs[mid]) / 2;
  return { offset, rtt: best[0].rtt, samples: ok.length };
}

/**
 * Seconds from the host's recording start to the guest's, both measured on their own clocks.
 * `offset` is guest clock minus host clock (from estimateClock on the host). Positive = guest later.
 */
export function startOffsetSeconds({ hostStart, guestStart, offset = 0 }) {
  return (guestStart - offset - hostStart) / 1000;
}
