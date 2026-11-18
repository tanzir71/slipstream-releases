// AWS Signature Version 4 query-string presigning (ticket S-05: share to the user's own S3-compatible storage —
// AWS S3, Cloudflare R2, Backblaze B2, MinIO…). Pure: uses Web Crypto (crypto.subtle), works in browsers and
// Node 20+. Keys never leave the device; only the signed request goes to the user's own bucket.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(text));
}

/** RFC 3986 encoding as SigV4 requires (unreserved characters kept; '/' kept in paths). */
export function uriEncode(str, keepSlash = false) {
  return [...enc.encode(String(str))].map((b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

export const amzDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * Presign a request. Returns the URL string with X-Amz-* query parameters.
 * opts = { method, url, region, service = 's3', accessKeyId, secretAccessKey, sessionToken?, expires (s, ≤ 604800), date?, query? }
 */
export async function presign({ method = 'GET', url, region, service = 's3', accessKeyId, secretAccessKey, sessionToken, expires = 3600, date = new Date(), query = {} }) {
  const u = new URL(url);
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const params = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(Math.max(1, Math.min(604800, Math.round(expires)))),
    'X-Amz-SignedHeaders': 'host',
    ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}),
  };
  const canonicalQuery = Object.keys(params).sort().map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`).join('&');
  const canonicalPath = uriEncode(decodeURIComponent(u.pathname || '/'), true);
  const canonicalRequest = [method.toUpperCase(), canonicalPath, canonicalQuery, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n');
  let key = await hmac(`AWS4${secretAccessKey}`, day);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  const signature = hex(await hmac(key, stringToSign));
  return `${u.origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Object URL for a bucket + key on an S3-compatible endpoint (path style unless virtualHosted). */
export function objectUrl({ endpoint, bucket, key, virtualHosted = false }) {
  const e = new URL(endpoint);
  const path = String(key).split('/').map((s) => uriEncode(s)).join('/');
  return virtualHosted ? `${e.protocol}//${bucket}.${e.host}/${path}` : `${e.origin}/${uriEncode(bucket)}/${path}`;
}
