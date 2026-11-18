// Upload-free sharing to the user's OWN storage (ticket S-05): an export goes straight from this browser to an
// S3-compatible bucket the user controls (AWS S3, Cloudflare R2, Backblaze B2, MinIO…), then a time-limited
// link is created locally. No Slipstream server is involved, nothing happens until the user sets up a bucket
// and presses Share, and the access keys stay in this browser. The bucket must allow PUT/GET from this origin
// (CORS) — the settings dialog says how.
import { h, icon, modal, toast, fill } from './ui.js';
import { getSetting, setSetting } from './store.js';
import { presign, objectUrl } from '../../packages/editor-core/src/sigv4.js';

export const loadStorage = async () => (await getSetting('storage').catch(() => null)) || null;

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
