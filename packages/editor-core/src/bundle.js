// `.slipstream` project bundles and `.slipstream-brand` brand kits (ticket C-02).
//
// A bundle is a zip: manifest.json (stored, first) + plan.json + media/screen.<ext>
// [+ media/camera.<ext>] [+ thumb.jpg]. manifest.hashes lists the SHA-256 of every other file,
// and unpackBundle() refuses a bundle whose files don't match. Spec: docs/bundle-format.md.
//
// Pure: no DOM, no Node built-ins. Runs in browsers and Node 20+. Media Blobs are hashed in
// chunks and referenced (not copied) into the output, so multi-GB recordings are fine.

import { createSha256, forEachBlobChunk, sha256Hex } from './sha256.js';
import { createZip, crc32Update, readZip, ZipError } from './zip.js';

export const BUNDLE_EXT = '.slipstream';
export const BRAND_EXT = '.slipstream-brand';
export const BUNDLE_MIME = 'application/zip';
export const BUNDLE_FORMAT = 'slipstream-bundle';
export const BRAND_FORMAT = 'slipstream-brand';
export const BUNDLE_VERSION = 1;
export const BRAND_VERSION = 1;

const SURFACES = ['web', 'macos', 'tauri', 'engine'];
const MEDIA_ROLES = ['screen', 'camera'];

export class BundleError extends Error {
  /**
   * @param {string} message
   * @param {Array<{ kind: string, path?: string, expected?: string, actual?: string, message?: string }>} [problems]
   */
  constructor(message, problems = []) {
    super(message);
    this.name = 'BundleError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------------------------
// Extensions and MIME types

const MEDIA_EXT_BY_MIME = {
  'video/webm': 'webm', 'audio/webm': 'webm',
  'video/mp4': 'mp4', 'video/x-m4v': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/matroska': 'mkv', 'audio/x-matroska': 'mkv',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/ogg': 'ogg', 'video/ogg': 'ogg', 'application/ogg': 'ogg',
};
const MIME_BY_MEDIA_EXT = { webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };
const IMAGE_EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const MIME_BY_IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml' };

const baseType = (type) => String(type || '').split(';')[0].trim().toLowerCase();
const nameExt = (name) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};
const basename = (path) => String(path).split(/[\\/]/).pop();

/** File extension (no dot) for a media file: from its MIME type, else its name, else 'bin'. */
export function mediaExtension(type, name) {
  const fromType = MEDIA_EXT_BY_MIME[baseType(type)];
  if (fromType) return fromType;
  const ext = nameExt(name);
  if (ext === 'm4v') return 'mp4';
  return ext || 'bin';
}

function imageExtension(type, name, fallback) {
  const fromType = IMAGE_EXT_BY_MIME[baseType(type)];
  if (fromType) return fromType;
  const ext = nameExt(name);
  if (ext === 'jpeg') return 'jpg';
  return MIME_BY_IMAGE_EXT[ext] ? ext : fallback;
}

// ---------------------------------------------------------------------------------------------
// Helpers

const encoder = new TextEncoder();
const isBlob = (x) => typeof Blob !== 'undefined' && x instanceof Blob;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function toBlob(data, type = '') {
  if (isBlob(data)) return data;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data], { type });
  return null;
}

function makeFile(blob, name, type, lastModified) {
  if (typeof File === 'function') {
    return new File([blob], name, { type, ...(Number.isFinite(lastModified) ? { lastModified } : {}) });
  }
  const b = blob.type === type ? blob : blob.slice(0, blob.size, type);
  return Object.assign(b, { name, lastModified: lastModified ?? Date.now() });
}

/** SHA-256 and (optionally) CRC-32 of a Blob in one streamed pass. */
async function digest(blob, { crc = false, onProgress } = {}) {
  const h = createSha256();
  let c = 0;
  await forEachBlobChunk(blob, (chunk) => {
    h.update(chunk);
    if (crc) c = crc32Update(c, chunk);
  }, { onProgress });
  return { sha256: h.digestHex(), crc32: crc ? c : undefined };
}

// Accepts a Blob/File, or a descriptor { blob | file, path?, name?, type?, size?, sha256? }.
function normalizeMedia(input, role) {
  if (input == null) return null;
  if (isBlob(input)) return { blob: input, name: input.name || '', type: input.type || '', path: '', size: input.size, sha256: '' };
  if (!isObject(input)) throw new TypeError(`packBundle: media.${role} must be a Blob, File or { path, size, sha256 } descriptor`);
  const blob = toBlob(input.blob ?? input.file ?? null);
  return {
    blob,
    name: input.name || blob?.name || '',
    type: input.type || blob?.type || '',
    path: input.path || '',
    size: Number.isFinite(input.size) ? input.size : blob ? blob.size : undefined,
    sha256: typeof input.sha256 === 'string' ? input.sha256.toLowerCase() : '',
  };
}

function normalizeApp(app = {}) {
  const surface = app.surface ?? 'web';
  if (!SURFACES.includes(surface)) throw new TypeError(`packBundle: app.surface must be one of ${SURFACES.join(', ')}`);
  return { name: String(app.name || 'Slipstream'), surface, version: String(app.version || '0.0.0') };
}

function isoDate(created) {
  const d = created instanceof Date ? created : created ? new Date(created) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// ---------------------------------------------------------------------------------------------
// Pack

/**
 * Build a `.slipstream` bundle.
 * @param {object} args
 * @param {object} args.plan Edit plan v2 (opaque JSON). A copy is written; when it has a
 *   `sources` object, sources.screen/camera get `path` (bundle-relative) and `sha256`.
 * @param {{ screen: Blob | File | object, camera?: Blob | File | object | null }} args.media
 *   Blobs/Files, or descriptors { blob|file, path?, name?, type?, size?, sha256? }. With planOnly,
 *   a descriptor may omit the blob: { path: '../my-recording.webm', size, sha256, type }.
 * @param {Blob | Uint8Array} [args.thumb] JPEG preferred (written as thumb.jpg).
 * @param {{ name?: string, surface?: 'web'|'macos'|'tauri'|'engine', version?: string }} [args.app]
 * @param {boolean} [args.planOnly=false] Write plan + manifest only; media stay external refs.
 * @param {Date | string} [args.created]
 * @param {(p: { phase: 'hash' | 'zip', done: number, total: number }) => void} [args.onProgress]
 * @returns {Promise<Blob>} application/zip
 */
export async function packBundle({ plan, media = {}, thumb = null, assets = [], app, planOnly = false, created, onProgress } = {}) {
  if (!isObject(plan)) throw new TypeError('packBundle: plan must be an object');
  const items = {};
  for (const role of MEDIA_ROLES) items[role] = normalizeMedia(media?.[role], role);
  if (!items.screen) throw new TypeError('packBundle: media.screen is required');
  for (const role of MEDIA_ROLES) {
    const m = items[role];
    if (!m) continue;
    if (!planOnly && !m.blob) throw new TypeError(`packBundle: media.${role} must include the recording (a Blob or File)`);
    if (planOnly && !m.blob && !m.path && !m.name) throw new TypeError(`packBundle: media.${role} needs a path for a plan-only bundle`);
  }
  const thumbBlob = thumb == null ? null : toBlob(thumb, 'image/jpeg');
  if (thumb != null && !thumbBlob) throw new TypeError('packBundle: thumb must be a Blob or Uint8Array');

  // Hash media (and CRC it for the zip in the same pass when it will be embedded).
  const toHash = MEDIA_ROLES.filter((r) => items[r]?.blob && (!planOnly || !items[r].sha256));
  const total = toHash.reduce((s, r) => s + items[r].blob.size, 0);
  let done = 0;
  for (const role of toHash) {
    const m = items[role];
    const base = done;
    const r = await digest(m.blob, {
      crc: !planOnly,
      onProgress: onProgress && ((d) => onProgress({ phase: 'hash', done: base + d, total })),
    });
    if (m.sha256 && m.sha256 !== r.sha256) {
      throw new BundleError(`media.${role} does not match the sha256 it was given.`, [{ kind: 'hash-mismatch', path: m.path || m.name || role, expected: m.sha256, actual: r.sha256 }]);
    }
    m.sha256 = r.sha256;
    m.crc32 = r.crc32;
    done = base + m.blob.size;
  }

  const entries = [];
  const hashes = {};
  const mediaManifest = {};
  for (const role of MEDIA_ROLES) {
    const m = items[role];
    if (!m) continue;
    const ext = mediaExtension(m.type, m.name || m.path);
    const type = baseType(m.type) ? m.type : MIME_BY_MEDIA_EXT[ext] || 'application/octet-stream';
    const desc = { path: '', type };
    if (Number.isFinite(m.size)) desc.size = m.size;
    if (m.sha256) desc.sha256 = m.sha256;
    if (m.name) desc.name = basename(m.name);
    if (planOnly) {
      desc.path = m.path || basename(m.name) || `${role}.${ext}`;
      desc.external = true;
    } else {
      desc.path = `media/${role}.${ext}`;
      hashes[desc.path] = m.sha256;
      const lastModified = m.blob.lastModified;
      entries.push({ name: desc.path, data: m.blob, compress: false, crc32: m.crc32, mtime: Number.isFinite(lastModified) ? new Date(lastModified) : undefined });
    }
    mediaManifest[role] = desc;
  }

  // Extra project assets (camera angles, B-roll, logo): media/assets/<key>.<ext>, hashed like the rest.
  // Plan-only bundles leave them out (they only reference the main recordings).
  const assetManifest = {};
  if (!planOnly) {
    for (const a of assets || []) {
      if (!a || !isBlob(a.blob) || !/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(String(a.key || ''))) continue;
      const ext = a.blob.type?.startsWith('image/') ? imageExtension(a.blob.type, a.name, 'png') : mediaExtension(a.blob.type, a.name);
      const path = `media/assets/${a.key}.${ext}`;
      const r = await digest(a.blob, { crc: true });
      assetManifest[a.key] = { path, type: a.blob.type || 'application/octet-stream', size: a.blob.size, sha256: r.sha256, ...(a.name ? { name: basename(a.name) } : {}) };
      hashes[path] = r.sha256;
      entries.push({ name: path, data: a.blob, compress: false, crc32: r.crc32 });
    }
  }

  if (thumbBlob) {
    const ext = imageExtension(thumbBlob.type, thumbBlob.name, 'jpg');
    const path = `thumb.${ext}`;
    const { sha256 } = await digest(thumbBlob);
    mediaManifest.thumb = { path, type: baseType(thumbBlob.type) ? thumbBlob.type : MIME_BY_IMAGE_EXT[ext], size: thumbBlob.size, sha256 };
    hashes[path] = sha256;
    entries.unshift({ name: path, data: thumbBlob, compress: false }); // small things first, media last
  }

  const planOut = JSON.parse(JSON.stringify(plan));
  if (isObject(planOut.sources)) {
    for (const role of MEDIA_ROLES) {
      const d = mediaManifest[role];
      if (!d) continue;
      const prev = isObject(planOut.sources[role]) ? planOut.sources[role] : {};
      planOut.sources[role] = { ...prev, path: d.path, ...(d.sha256 ? { sha256: d.sha256 } : {}) };
    }
  }
  const planBytes = encoder.encode(JSON.stringify(planOut, null, 2));
  hashes['plan.json'] = sha256Hex(planBytes);

  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    app: normalizeApp(app),
    created: isoDate(created),
    plan: 'plan.json',
    media: mediaManifest,
    ...(Object.keys(assetManifest).length ? { assets: assetManifest } : {}),
    hashes,
  };
  entries.unshift(
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2), compress: false },
    { name: 'plan.json', data: planBytes, compress: true },
  );
  return createZip(entries, {
    onProgress: onProgress && ((p) => onProgress({ phase: 'zip', done: p.done, total: p.total })),
  });
}

// ---------------------------------------------------------------------------------------------
// Unpack

async function openZip(blob, label) {
  if (!isBlob(blob)) throw new TypeError(`Expected the ${label} file as a Blob or File`);
  try {
    return await readZip(blob);
  } catch (err) {
    if (err instanceof ZipError) throw new BundleError(`This is not a valid ${label} file: ${err.message}`, [{ kind: 'corrupt', message: err.message }]);
    throw err;
  }
}

async function readJson(zip, path, label) {
  const entry = zip.get(path);
  if (!entry) throw new BundleError(`This is not a valid ${label} file: ${path} is missing.`, [{ kind: 'missing', path }]);
  let text;
  try {
    text = await entry.text();
  } catch (err) {
    throw new BundleError(`${path} could not be read: ${err.message}`, [{ kind: 'corrupt', path, message: err.message }]);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch (err) {
    throw new BundleError(`${path} is not valid JSON: ${err.message}`, [{ kind: 'invalid-json', path, message: err.message }]);
  }
}

function checkEnvelope(doc, format, supported, label, path) {
  if (!isObject(doc)) throw new BundleError(`${path} is not a JSON object.`, [{ kind: 'invalid-json', path }]);
  if (doc.format !== format) {
    throw new BundleError(`This is not a ${label} file (format "${doc.format}", expected "${format}").`, [{ kind: 'format', path, expected: format, actual: String(doc.format) }]);
  }
  const major = Math.floor(Number.parseFloat(String(doc.version)));
  if (!Number.isFinite(major) || major < 1) {
    throw new BundleError(`${path} has an invalid version: ${doc.version}.`, [{ kind: 'version', path, expected: String(supported), actual: String(doc.version) }]);
  }
  if (major > supported) {
    throw new BundleError(`This ${label} uses format version ${doc.version}, which is newer than this version of Slipstream supports (${supported}). Update Slipstream to open it.`, [{ kind: 'version', path, expected: String(supported), actual: String(doc.version) }]);
  }
}

// Check presence and hashes. Returns problems (missing / hash-mismatch / corrupt).
async function verifyFiles(zip, expected, required, { verify, onProgress }) {
  const problems = [];
  const present = [];
  const paths = new Set([...required, ...expected.keys()]);
  for (const path of paths) {
    const entry = zip.get(path);
    if (!entry) problems.push({ kind: 'missing', path, ...(expected.get(path) ? { expected: expected.get(path) } : {}) });
    else if (verify && expected.get(path)) present.push([path, entry]);
  }
  const total = present.reduce((s, [, e]) => s + e.size, 0);
  let done = 0;
  for (const [path, entry] of present) {
    const base = done;
    let actual;
    try {
      ({ sha256: actual } = await digest(await entry.blob(), {
        onProgress: onProgress && ((d) => onProgress({ phase: 'verify', done: base + d, total })),
      }));
    } catch (err) {
      problems.push({ kind: 'corrupt', path, message: err.message });
      continue;
    } finally {
      done = base + entry.size;
    }
    const want = expected.get(path).toLowerCase();
    if (actual !== want) problems.push({ kind: 'hash-mismatch', path, expected: want, actual });
  }
  return problems;
}

function describeProblems(problems) {
  return problems.map((p) => {
    if (p.kind === 'missing') return `${p.path} is missing`;
    if (p.kind === 'hash-mismatch') return `${p.path} does not match its checksum`;
    if (p.kind === 'corrupt') return `${p.path} is damaged`;
    return `${p.path}: ${p.kind}`;
  }).join('; ');
}

/**
 * Open a `.slipstream` bundle.
 * @param {Blob | File} blob
 * @param {{ verify?: boolean, onProgress?: (p: { phase: 'verify', done: number, total: number }) => void }} [opts]
 *   verify (default true): hash every file listed in manifest.hashes and throw BundleError on any
 *   mismatch or missing file. verify: false skips hashing and returns missing files as problems
 *   instead of throwing ("open anyway").
 * @returns {Promise<{ manifest: object, plan: object, media: { screen: File | null, camera: File | null },
 *   thumb: Blob | null, problems: object[] }>}
 *   problems may contain { kind: 'external', role, path, size, sha256, type } for plan-only refs.
 */
export async function unpackBundle(blob, { verify = true, onProgress } = {}) {
  const zip = await openZip(blob, 'Slipstream project');
  const { value: manifest } = await readJson(zip, 'manifest.json', 'Slipstream project');
  checkEnvelope(manifest, BUNDLE_FORMAT, BUNDLE_VERSION, 'Slipstream project', 'manifest.json');

  const planPath = typeof manifest.plan === 'string' && manifest.plan ? manifest.plan : 'plan.json';
  const mediaManifest = isObject(manifest.media) ? manifest.media : {};
  const expected = new Map();
  for (const [path, hash] of Object.entries(isObject(manifest.hashes) ? manifest.hashes : {})) {
    if (typeof hash === 'string' && hash) expected.set(path, hash.toLowerCase());
  }
  const required = [planPath];
  const external = [];
  for (const role of [...MEDIA_ROLES, 'thumb']) {
    const d = mediaManifest[role];
    if (!isObject(d) || typeof d.path !== 'string' || !d.path) continue;
    if (d.external) {
      external.push({ kind: 'external', role, path: d.path, ...(d.size != null ? { size: d.size } : {}), ...(d.sha256 ? { sha256: d.sha256 } : {}), ...(d.type ? { type: d.type } : {}) });
      continue;
    }
    required.push(d.path);
    if (!expected.has(d.path) && typeof d.sha256 === 'string' && d.sha256) expected.set(d.path, d.sha256.toLowerCase());
  }

  const assetManifest = isObject(manifest.assets) ? manifest.assets : {};
  for (const d of Object.values(assetManifest)) if (isObject(d) && typeof d.path === 'string' && d.path) required.push(d.path);
  const fileProblems = await verifyFiles(zip, expected, required, { verify, onProgress });
  if (fileProblems.some((p) => p.path === planPath)) {
    throw new BundleError(`This project can't be opened: ${describeProblems(fileProblems)}.`, [...fileProblems, ...external]);
  }
  if (verify && fileProblems.length) {
    throw new BundleError(`This project failed its integrity check: ${describeProblems(fileProblems)}.`, [...fileProblems, ...external]);
  }

  const { value: plan } = await readJson(zip, planPath, 'Slipstream project');
  const out = { screen: null, camera: null };
  for (const role of MEDIA_ROLES) {
    const d = mediaManifest[role];
    if (!isObject(d) || d.external || !d.path) continue;
    const entry = zip.get(d.path);
    if (!entry) continue;
    const type = typeof d.type === 'string' ? d.type : '';
    out[role] = makeFile(await entry.blob(type), basename(d.name || d.path), type, entry.mtime?.getTime());
  }
  let thumb = null;
  const td = mediaManifest.thumb;
  if (isObject(td) && !td.external && td.path && zip.get(td.path)) thumb = await zip.get(td.path).blob(td.type || 'image/jpeg');

  const assets = {};
  for (const [key, d] of Object.entries(assetManifest)) {
    const entry = isObject(d) && d.path ? zip.get(d.path) : null;
    if (entry) assets[key] = makeFile(await entry.blob(d.type || ''), basename(d.name || d.path), d.type || '', entry.mtime?.getTime());
  }
  return { manifest, plan, media: out, thumb, assets, problems: [...fileProblems, ...external] };
}

// ---------------------------------------------------------------------------------------------
// Brand kits

const BRAND_RESERVED = ['format', 'version', 'assets', 'hashes'];

/**
 * Build a `.slipstream-brand` file: brand.json { format, version, ...brand, assets?, hashes }
 * plus an optional logo.(png|svg|webp|jpg). The keys format, version, assets and hashes are
 * reserved and are overwritten.
 * @param {object} brand
 * @param {{ logo?: Blob }} [opts]
 * @returns {Promise<Blob>} application/zip
 */
export async function packBrand(brand, { logo } = {}) {
  if (!isObject(brand)) throw new TypeError('packBrand: brand must be an object');
  const body = JSON.parse(JSON.stringify(brand));
  for (const k of BRAND_RESERVED) delete body[k];
  const doc = { format: BRAND_FORMAT, version: BRAND_VERSION, ...body };
  const entries = [];
  const hashes = {};
  const logoBlob = logo == null ? null : toBlob(logo, 'image/png');
  if (logo != null && !logoBlob) throw new TypeError('packBrand: logo must be a Blob');
  if (logoBlob) {
    const ext = imageExtension(logoBlob.type, logoBlob.name, 'png');
    const path = `logo.${ext}`;
    const { sha256 } = await digest(logoBlob);
    doc.assets = { logo: { path, type: baseType(logoBlob.type) ? logoBlob.type : MIME_BY_IMAGE_EXT[ext], size: logoBlob.size, sha256 } };
    hashes[path] = sha256;
    entries.push({ name: path, data: logoBlob, compress: ext === 'svg' });
  }
  doc.hashes = hashes;
  entries.unshift({ name: 'brand.json', data: JSON.stringify(doc, null, 2), compress: false });
  return createZip(entries);
}

/**
 * Open a `.slipstream-brand` file.
 * @param {Blob | File} blob
 * @param {{ verify?: boolean }} [opts]
 * @returns {Promise<{ brand: object, logo: File | null, manifest: object, problems: object[] }>}
 *   brand is brand.json without the reserved envelope keys (round-trips through packBrand).
 */
export async function unpackBrand(blob, { verify = true } = {}) {
  const zip = await openZip(blob, 'Slipstream brand');
  const { value: manifest } = await readJson(zip, 'brand.json', 'Slipstream brand');
  checkEnvelope(manifest, BRAND_FORMAT, BRAND_VERSION, 'Slipstream brand', 'brand.json');
  const expected = new Map();
  for (const [path, hash] of Object.entries(isObject(manifest.hashes) ? manifest.hashes : {})) {
    if (typeof hash === 'string' && hash) expected.set(path, hash.toLowerCase());
  }
  const logoDesc = isObject(manifest.assets) && isObject(manifest.assets.logo) ? manifest.assets.logo : null;
  const required = logoDesc?.path ? [logoDesc.path] : [];
  if (logoDesc?.path && !expected.has(logoDesc.path) && logoDesc.sha256) expected.set(logoDesc.path, String(logoDesc.sha256).toLowerCase());
  const problems = await verifyFiles(zip, expected, required, { verify });
  if (verify && problems.length) throw new BundleError(`This brand kit failed its integrity check: ${describeProblems(problems)}.`, problems);

  const brand = { ...manifest };
  for (const k of BRAND_RESERVED) delete brand[k];
  let logo = null;
  if (logoDesc?.path && zip.get(logoDesc.path)) {
    const entry = zip.get(logoDesc.path);
    const type = logoDesc.type || MIME_BY_IMAGE_EXT[nameExt(logoDesc.path)] || '';
    logo = makeFile(await entry.blob(type), basename(logoDesc.path), type, entry.mtime?.getTime());
  }
  return { brand, logo, manifest, problems };
}
