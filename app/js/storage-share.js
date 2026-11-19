// Upload-free sharing to the user's OWN storage (ticket S-05): an export goes straight from this browser to an
// S3-compatible bucket the user controls (AWS S3, Cloudflare R2, Backblaze B2, MinIO…), then a time-limited
// link is created locally. No Slipstream server is involved, nothing happens until the user sets up a bucket
// and presses Share, and the access keys stay in this browser. The bucket must allow PUT/GET from this origin
// (CORS) — the settings dialog says how.
import { h, icon, modal, toast, fill } from './ui.js';
import { getSetting, setSetting } from './store.js';
import { presign, objectUrl } from '../../packages/editor-core/src/sigv4.js';

export const loadStorage = async () => (await getSetting('storage').catch(() => null)) || null;

// ---- Bucket client (S-05, X-06) ---------------------------------------------------------------------
// Everything below works from any window or worker with fetch and Web Crypto (no DOM, no settings store), so
// Slipstream for Chrome uses it from its offscreen recorder and pages. Settings come in as a plain object:
// s = { endpoint, bucket, region, accessKeyId, secretAccessKey, sessionToken?, virtualHosted? }.

/** S3 refuses parts under 5 MiB except the last; R2 also wants every part but the last to be the same size. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
export const PART_SIZE = MIN_PART_SIZE;

/** Adds https:// to a bare host such as "<account>.r2.cloudflarestorage.com" and drops trailing slashes. */
export function normalizeEndpoint(raw) {
  const t = String(raw || '').trim().replace(/\/+$/, '');
  return /^[a-z]+:\/\//i.test(t) ? t : `https:/${'/'}${t}`;
}

/** Region from a well-known endpoint (AWS, Backblaze B2, Wasabi, DigitalOcean…); R2 and unknown hosts use 'auto'. */
export function regionFor(endpoint) {
  let host = '';
  try { host = new URL(normalizeEndpoint(endpoint)).hostname; } catch { return 'auto'; }
  const m = host.match(/(?:^|\.)s3[.-]([a-z0-9-]+)\.amazonaws\.com$/) || host.match(/^s3\.([a-z0-9-]+)\.(?:backblazeb2|wasabisys)\.com$/) || host.match(/^([a-z0-9-]+)\.digitaloceanspaces\.com$/);
  if (m && m[1] !== 'external-1') return m[1];
  if (/(?:^|\.)s3\.amazonaws\.com$/.test(host)) return 'us-east-1';
  return 'auto';
}

/** The bucket CORS rule a page or extension at `origins` needs (ETag is read back after each multipart part). */
export function corsRule(origins) {
  return [{ AllowedOrigins: [].concat(origins), AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }];
}

/** Text of the first <tag>…</tag> in an S3 XML response (no DOMParser: service workers don't have one). */
export function xmlTag(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : null;
}
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** CompleteMultipartUpload body for [{ n, etag }]. */
export function completeXml(parts) {
  return `<CompleteMultipartUpload>${[...parts].sort((a, b) => a.n - b.n).map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
}

/**
 * How to cut `buffered` bytes into parts: every part is exactly `partSize` (R2 needs equal parts), and when `final`
 * the rest goes out as the last part. Returns { parts: [bytes…], rest }.
 */
export function planParts(buffered, { partSize = PART_SIZE, final = false } = {}) {
  if (partSize < MIN_PART_SIZE) throw new Error('Parts must be at least 5 MiB');
  const parts = [];
  let rest = Math.max(0, buffered);
  while (rest >= partSize) { parts.push(partSize); rest -= partSize; }
  if (final && rest > 0) { parts.push(rest); rest = 0; }
  return { parts, rest };
}

async function storageError(res, what) {
  const body = await res.text().catch(() => '');
  const code = xmlTag(body, 'Code');
  const msg = xmlTag(body, 'Message');
  return Object.assign(new Error(`Your storage refused ${what} (${res.status}${code ? ` ${code}` : ''}${msg ? `: ${msg.slice(0, 140)}` : ''})`), { status: res.status, code });
}

/** A small S3 client signed locally with SigV4 query presigning. Keys never leave this device. */
export function bucketClient(s, { fetch: doFetch = (...a) => globalThis.fetch(...a) } = {}) {
  const endpoint = normalizeEndpoint(s.endpoint);
  const creds = { region: s.region || regionFor(endpoint), accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, sessionToken: s.sessionToken };
  const url = (key) => objectUrl({ endpoint, bucket: s.bucket, key, virtualHosted: !!s.virtualHosted });
  const sign = (method, key, query = {}, expires = 900) => presign({ ...creds, method, url: url(key), query, expires });
  const call = async (method, key, { query, body, headers, what, signal } = {}) => {
    let res;
    try { res = await doFetch(await sign(method, key, query), { method, body, headers, signal, cache: 'no-store' }); }
    catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw Object.assign(new Error('Couldn’t reach your storage. Check the endpoint, and that the bucket’s CORS rule allows this origin.'), { network: true });
    }
    if (!res.ok) throw await storageError(res, what || `${method} ${key}`);
    return res;
  };
  return {
    endpoint, region: creds.region, bucket: s.bucket,
    url,
    origin: new URL(url('x')).origin,
    /** Presigned GET, at most 7 days (S3's limit). `query` may carry response-content-disposition etc. */
    presignGet: (key, seconds, query = {}) => sign('GET', key, query, Math.min(604800, Math.max(1, seconds))),
    async put(key, body, { type, cacheControl, signal } = {}) {
      const headers = {};
      if (type) headers['Content-Type'] = type;
      if (cacheControl) headers['Cache-Control'] = cacheControl;
      const res = await call('PUT', key, { body, headers, signal, what: `the upload of ${key.split('/').pop()}` });
      return { etag: res.headers.get('ETag') };
    },
    async get(key) { return call('GET', key, { what: `reading ${key.split('/').pop()}` }); },
    async remove(key) { await call('DELETE', key, { what: `deleting ${key.split('/').pop()}` }); },
    /** All objects under `prefix`: [{ key, size }]. */
    async list(prefix) {
      const out = [];
      let token = null;
      do {
        const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
        const xml = await (await call('GET', '', { query, what: 'listing the bucket' })).text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) out.push({ key: xmlTag(m[1], 'Key'), size: Number(xmlTag(m[1], 'Size')) || 0 });
        token = xmlTag(xml, 'IsTruncated') === 'true' ? xmlTag(xml, 'NextContinuationToken') : null;
      } while (token);
      return out;
    },
    multipart: (key, opts = {}) => new MultipartUpload({ call, key, ...opts }),
    /** Upload a Blob in equal parts (any size); onProgress(sent, total). */
    async uploadLarge(key, blob, { type = blob.type, onProgress = () => {}, signal } = {}) {
      if (blob.size <= PART_SIZE) { const r = await this.put(key, blob, { type, signal }); onProgress(blob.size, blob.size); return r; }
      const up = this.multipart(key, { type, signal, onProgress: (sent) => onProgress(sent, blob.size) });
      up.push(blob);
      return up.finish();
    },
  };
}

/**
 * S3 multipart upload fed while a recording runs (X-06): push() chunks as they arrive, parts go out in order as soon
 * as PART_SIZE bytes are buffered (one request at a time, retried), finish() sends the rest and completes, so the
 * object is whole seconds after the take stops. abort() cancels it on the bucket.
 */
export class MultipartUpload {
  constructor({ call, key, type = 'application/octet-stream', partSize = PART_SIZE, retries = 3, retryDelay = 800, onProgress = () => {}, signal } = {}) {
    Object.assign(this, { call, key, type, partSize, retries, retryDelay, onProgress, signal });
    this.buffer = [];
    this.buffered = 0;
    this.sent = 0;
    this.parts = [];
    this.uploadId = null;
    this.error = null;
    this.state = 'open'; // open → finishing → done | aborted | failed
    this.chain = Promise.resolve();
  }

  async _begin() {
    if (this.uploadId) return;
    const xml = await (await this.call('POST', this.key, { query: { uploads: '' }, headers: { 'Content-Type': this.type }, what: 'starting the upload' })).text();
    this.uploadId = xmlTag(xml, 'UploadId');
    if (!this.uploadId) throw new Error('Your storage didn’t return an upload id');
  }

  async _sendPart(blob) {
    await this._begin();
    const n = this.parts.length + 1;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (this.state === 'aborted') throw new DOMException('Upload cancelled', 'AbortError');
      try {
        const res = await this.call('PUT', this.key, { query: { partNumber: String(n), uploadId: this.uploadId }, body: blob, signal: this.signal, what: `part ${n} of the upload` });
        const etag = res.headers.get('ETag');
        if (!etag) throw new Error('Your storage hid the ETag header. Add "ExposeHeaders": ["ETag"] to the bucket’s CORS rule.');
        this.parts.push({ n, etag, size: blob.size });
        this.sent += blob.size;
        this.onProgress(this.sent);
        return;
      } catch (err) {
        lastErr = err;
        if (err?.name === 'AbortError' || (err.status && err.status < 500 && err.status !== 429)) break;
        await new Promise((r) => setTimeout(r, this.retryDelay * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  _drain(final) {
    const whole = new Blob(this.buffer, { type: this.type });
    const { parts, rest } = planParts(whole.size, { partSize: this.partSize, final });
    let at = 0;
    const blobs = parts.map((len) => { const b = whole.slice(at, at + len); at += len; return b; });
    this.buffer = rest ? [whole.slice(at)] : [];
    this.buffered = rest;
    for (const b of blobs) this.chain = this.chain.then(() => (this.error ? null : this._sendPart(b))).catch((err) => { this.error ||= err; this.state = this.state === 'aborted' ? 'aborted' : 'failed'; });
  }

  /** Add bytes (a Blob, e.g. a recorder chunk). Never throws; check `.error` / `.state`. */
  push(blob) {
    if (this.state !== 'open' || !blob?.size) return;
    this.buffer.push(blob);
    this.buffered += blob.size;
    if (this.buffered >= this.partSize) this._drain(false);
  }

  /** Send what's left and complete. Resolves { etag, size, parts }; throws if any part failed. */
  async finish() {
    if (this.state !== 'open' && this.state !== 'failed') throw this.error || new Error(`Upload is ${this.state}`);
    if (this.state === 'open') { this.state = 'finishing'; this._drain(true); }
    await this.chain;
    if (this.error) { await this.abort().catch(() => {}); this.state = 'failed'; throw this.error; }
    if (!this.parts.length) {
      // Nothing was sent (empty take): an empty multipart upload can't be completed, so write an empty object.
      await this.abort().catch(() => {});
      await this.call('PUT', this.key, { body: new Blob([], { type: this.type }), headers: { 'Content-Type': this.type }, what: 'the upload' });
      this.state = 'done';
      return { etag: null, size: 0, parts: 0 };
    }
    const xml = await (await this.call('POST', this.key, { query: { uploadId: this.uploadId }, body: completeXml(this.parts), headers: { 'Content-Type': 'application/xml' }, what: 'finishing the upload' })).text();
    if (/<Error>/.test(xml)) throw new Error(`Your storage couldn’t finish the upload: ${xmlTag(xml, 'Message') || xmlTag(xml, 'Code')}`);
    this.state = 'done';
    return { etag: xmlTag(xml, 'ETag'), size: this.sent, parts: this.parts.length };
  }

  async abort() {
    const was = this.state;
    this.state = 'aborted';
    this.buffer = [];
    if (this.uploadId && was !== 'done') await this.call('DELETE', this.key, { query: { uploadId: this.uploadId }, what: 'cancelling the upload' }).catch(() => {});
  }
}

/** Upload a blob and return { url (shareable, expires), key }. onProgress(0..1). */
export async function shareToBucket(blob, name, { onProgress = () => {}, signal } = {}) {
  const s = await loadStorage();
  if (!s) throw new Error('Set up your storage first.');
  const key = `${(s.prefix || 'slipstream').replace(/^\/+|\/+$/g, '')}/${new Date().toISOString().slice(0, 10)}/${Date.now().toString(36)}-${name}`.replace(/^\//, '');
  const target = objectUrl({ endpoint: s.endpoint, bucket: s.bucket, key, virtualHosted: !!s.virtualHosted });
  const creds = { region: s.region || 'auto', accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey };
  const putUrl = await presign({ ...creds, method: 'PUT', url: target, expires: 3600 });
  await new Promise((resolve, reject) => {
    // XMLHttpRequest because fetch() has no upload progress.
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', putUrl);
    if (blob.type) xhr.setRequestHeader('Content-Type', blob.type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Your storage returned ${xhr.status}${xhr.responseText ? `: ${xhr.responseText.slice(0, 160)}` : ''}`)));
    xhr.onerror = () => reject(new Error('Couldn’t reach your storage. Check the endpoint and that the bucket’s CORS rules allow PUT from this page.'));
    signal?.addEventListener('abort', () => { xhr.abort(); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
    xhr.send(blob);
  });
  const days = Math.max(1, Math.min(7, Number(s.linkDays) || 7));
  const url = await presign({ ...creds, method: 'GET', url: target, expires: days * 86400 });
  return { url, key, days };
}

export function openStorageSettings() {
  return new Promise(async (resolve) => {
    const s = (await loadStorage()) || {};
    const f = (label, key, extra = {}) => { const el = h('input', { type: extra.secret ? 'password' : 'text', value: s[key] ?? extra.value ?? '', placeholder: extra.placeholder || '', autocomplete: 'off', spellcheck: false, 'aria-label': label }); return [h('label.field', h('span', label), el), el]; };
    const [endpointF, endpoint] = f('Endpoint', 'endpoint', { placeholder: '<account>.r2.cloudflarestorage.com or s3.<region>.amazonaws.com' });
    const [bucketF, bucket] = f('Bucket', 'bucket');
    const [regionF, region] = f('Region', 'region', { placeholder: 'auto (R2) or e.g. eu-west-1' });
    const [keyF, accessKeyId] = f('Access key ID', 'accessKeyId');
    const [secretF, secret] = f('Secret access key', 'secretAccessKey', { secret: true });
    const [prefixF, prefix] = f('Folder in the bucket', 'prefix', { value: 'slipstream' });
    const vhost = h('input', { type: 'checkbox', checked: !!s.virtualHosted });
    const days = h('select', { 'aria-label': 'Link lifetime' }, [1, 3, 7].map((d) => h('option', { value: d, selected: (s.linkDays || 7) === d }, `${d} day${d > 1 ? 's' : ''}`)));
    let done = false;
    const m = modal('Share to your storage', h('div.stack.cloud-settings',
      h('p.cloud-warning', icon('info', 14), 'Exports upload straight from this browser to a bucket you own, then Slipstream makes a link that expires. Keys stay on this device.'),
      endpointF, bucketF, regionF, keyF, secretF, prefixF,
      h('label.toggle-row', vhost, h('span', 'Use virtual-hosted URLs (bucket.endpoint)')),
      h('label.field', h('span', 'Links expire after'), days),
      h('details.small', h('summary', 'Bucket CORS rule to add'), h('pre.cors', JSON.stringify([{ AllowedOrigins: [location.origin], AllowedMethods: ['PUT', 'GET'], AllowedHeaders: ['*'], MaxAgeSeconds: 3600 }], null, 2))),
      h('div.row.end',
        s.bucket ? h('button.btn.danger', { onclick: async () => { await setSetting('storage', null); toast('Storage settings removed', 'ok'); done = true; resolve(null); m.close(); } }, 'Remove') : null,
        h('button.btn', { onclick: () => m.close() }, 'Cancel'),
        h('button.btn.primary', { onclick: async () => {
          const raw = endpoint.value.trim().replace(/\/+$/, '');
          const next = { endpoint: /^[a-z]+:\/\//i.test(raw) ? raw : `https:/${'/'}${raw}`, bucket: bucket.value.trim(), region: region.value.trim() || 'auto', accessKeyId: accessKeyId.value.trim(), secretAccessKey: secret.value.trim(), prefix: prefix.value.trim(), virtualHosted: vhost.checked, linkDays: Number(days.value) };
          try { new URL(next.endpoint); } catch { toast('That endpoint doesn’t look like a web address', 'error'); return; }
          if (!next.bucket || !next.accessKeyId || !next.secretAccessKey) { toast('Bucket and both keys are needed', 'error'); return; }
          await setSetting('storage', next);
          toast('Storage saved in this browser', 'ok');
          done = true; resolve(next); m.close();
        } }, 'Save'))), { wide: true, onClose: () => { if (!done) resolve(null); } });
  });
}

/** Button for the export dialog: share an export via the user's bucket, copying the link. */
export function shareButton(blob, name) {
  const btn = h('button.btn', { title: 'Upload to your own S3-compatible storage and copy a link that expires' }, icon('share', 15), 'Share link…');
  const status = h('span.muted.small');
  btn.onclick = async () => {
    if (!(await loadStorage()) && !(await openStorageSettings())) return;
    btn.disabled = true;
    try {
      const r = await shareToBucket(blob, name, { onProgress: (p) => { status.textContent = `Uploading to your storage… ${Math.round(p * 100)}%`; } });
      await navigator.clipboard.writeText(r.url).catch(() => {});
      fill(status, h('span', `Link copied · expires in ${r.days} day${r.days > 1 ? 's' : ''} `), h('a.link', { href: r.url, target: '_blank', rel: 'noopener' }, 'Open'));
      toast('Link copied to the clipboard', 'ok');
    } catch (err) {
      status.textContent = err.message;
    } finally { btn.disabled = false; }
  };
  return h('span.share-wrap', btn, status);
}
