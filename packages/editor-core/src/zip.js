// Minimal ZIP writer/reader for Slipstream project bundles. No dependencies.
//
// Writer: the archive is a Blob assembled from small header buffers plus references to the
// original Blobs, so a multi-GB recording is never copied into memory. Media is stored (method 0);
// small text may be deflated (method 8) with CompressionStream('deflate-raw') when available.
// ZIP64 is used automatically for entries/offsets >= 4 GiB or more than 65535 entries.
// Names are UTF-8 (general purpose flag bit 11).
//
// Reader: parses the end-of-central-directory record (and the ZIP64 locator/record) from the
// tail, then the central directory. Stored entries are returned as zero-copy Blob slices.
// Supports methods 0 (stored) and 8 (deflate, via DecompressionStream('deflate-raw')).
//
// Pure: no DOM, no Node built-ins. Runs in browsers and Node 20+.

import { forEachBlobChunk } from './sha256.js';

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

// ---------------------------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, reflected 0xEDB88320), slicing-by-8.

const CRC = new Int32Array(256 * 8);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
for (let n = 0; n < 256; n++) {
  let c = CRC[n];
  for (let k = 1; k < 8; k++) {
    c = CRC[c & 0xff] ^ (c >>> 8);
    CRC[k * 256 + n] = c;
  }
}

/** Continue a CRC-32 over `bytes`. Start with 0. Returns an unsigned 32-bit number. */
export function crc32Update(crc, bytes) {
  let c = ~crc;
  const n = bytes.length;
  let i = 0;
  for (const end = n - 7; i < end; i += 8) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c = CRC[1792 + (c & 0xff)] ^ CRC[1536 + ((c >>> 8) & 0xff)] ^ CRC[1280 + ((c >>> 16) & 0xff)] ^ CRC[1024 + (c >>> 24)]
      ^ CRC[768 + bytes[i + 4]] ^ CRC[512 + bytes[i + 5]] ^ CRC[256 + bytes[i + 6]] ^ CRC[bytes[i + 7]];
  }
  for (; i < n; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** CRC-32 of a Uint8Array. */
export const crc32 = (bytes) => crc32Update(0, bytes);

/** CRC-32 of a Blob, streamed in chunks. */
export async function crc32Blob(blob, onProgress) {
  let c = 0;
  await forEachBlobChunk(blob, (chunk) => { c = crc32Update(c, chunk); }, { onProgress });
  return c;
}

// ---------------------------------------------------------------------------------------------
// Little-endian helpers

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;

const setU64 = (dv, off, v) => {
  dv.setUint32(off, v % 0x100000000, true);
  dv.setUint32(off + 4, Math.floor(v / 0x100000000), true);
};
const getU64 = (dv, off) => {
  const v = dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000;
  if (!Number.isSafeInteger(v)) throw new ZipError('Zip archive has a size or offset larger than 2^53 bytes.');
  return v;
};

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

const isBlob = (x) => typeof Blob !== 'undefined' && x instanceof Blob;

function toBytes(data) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function dosDateTime(date) {
  let d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  if (d.getFullYear() < 1980) d = new Date(1980, 0, 1);
  if (d.getFullYear() > 2107) d = new Date(2107, 11, 31, 23, 59, 58);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: day };
}

function fromDosDateTime(time, date) {
  if (!date) return null;
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}

let deflateRawSupported;
function canDeflateRaw() {
  if (deflateRawSupported === undefined) {
    try {
      deflateRawSupported = typeof CompressionStream === 'function' && !!new CompressionStream('deflate-raw');
    } catch {
      deflateRawSupported = false;
    }
  }
  return deflateRawSupported;
}

async function collect(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  return { chunks, size };
}

function concat(chunks, size) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writer

/**
 * Build a ZIP archive.
 * @param {Array<{ name: string, data: Blob | Uint8Array | ArrayBuffer | string, mtime?: Date,
 *   compress?: boolean, crc32?: number }>} entries
 *   `compress` defaults to true for strings and false for binary data. Deflate is skipped when
 *   CompressionStream('deflate-raw') is unavailable or doesn't make the entry smaller.
 *   `crc32` may be supplied when the caller already computed it (saves a pass over a large Blob).
 * @param {{ onProgress?: (p: { done: number, total: number, name: string }) => void,
 *   zip64?: boolean, comment?: string }} [opts]
 *   `zip64: true` forces ZIP64 records even for small archives (used by tests).
 * @returns {Promise<Blob>} type application/zip
 */
export async function createZip(entries, { onProgress, zip64: forceZip64 = false, comment = '' } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('createZip: entries must be an array');
  const now = new Date();
  const seen = new Set();
  const items = entries.map((e, i) => {
    if (!e || typeof e.name !== 'string' || !e.name) throw new TypeError(`createZip: entry ${i} needs a name`);
    if (seen.has(e.name)) throw new ZipError(`Duplicate zip entry name: ${e.name}`);
    seen.add(e.name);
    const nameBytes = encoder.encode(e.name);
    if (nameBytes.length > MAX16) throw new ZipError(`Zip entry name is too long: ${e.name.slice(0, 40)}…`);
    const bytes = isBlob(e.data) ? null : toBytes(e.data ?? '');
    if (!bytes && !isBlob(e.data)) throw new TypeError(`createZip: entry "${e.name}" data must be a Blob, Uint8Array, ArrayBuffer or string`);
    const size = bytes ? bytes.length : e.data.size;
    return {
      name: e.name,
      nameBytes,
      bytes,
      blob: bytes ? null : e.data,
      size,
      compress: (e.compress ?? typeof e.data === 'string') && size > 0,
      crc: Number.isInteger(e.crc32) ? e.crc32 >>> 0 : null,
      mtime: e.mtime instanceof Date ? e.mtime : now,
    };
  });

  // Pass 1: CRC (+ optional deflate) for every entry.
  const total = items.reduce((s, it) => s + (it.crc === null || it.compress ? it.size : 0), 0);
  let done = 0;
  const report = (name) => onProgress && onProgress({ done, total, name });
  for (const it of items) {
    const counted = it.crc === null || it.compress;
    const base = done;
    if (it.crc === null) {
      it.crc = it.bytes ? crc32(it.bytes) : await crc32Blob(it.blob, (d) => { done = base + d; report(it.name); });
    }
    it.method = 0;
    it.payload = it.bytes || it.blob;
    it.compressedSize = it.size;
    if (it.compress && canDeflateRaw()) {
      const source = it.bytes ? new Blob([it.bytes]) : it.blob;
      const { chunks, size } = await collect(source.stream().pipeThrough(new CompressionStream('deflate-raw')));
      if (size < it.size) {
        it.method = 8;
        it.payload = it.bytes ? concat(chunks, size) : new Blob(chunks);
        it.compressedSize = size;
      }
    }
    if (counted) { done = base + it.size; report(it.name); }
  }

  // Pass 2: lay out local headers + data, then the central directory.
  const parts = [];
  const central = [];
  let offset = 0;
  for (const it of items) {
    const big = forceZip64 || it.size >= MAX32 || it.compressedSize >= MAX32;
    const { time, date } = dosDateTime(it.mtime);
    const needed = big ? 45 : 20;
    const localExtra = big ? 20 : 0;
    const local = new Uint8Array(30 + it.nameBytes.length + localExtra);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, SIG_LOCAL, true);
    dv.setUint16(4, needed, true);
    dv.setUint16(6, FLAG_UTF8, true);
    dv.setUint16(8, it.method, true);
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, it.crc, true);
    dv.setUint32(18, big ? MAX32 : it.compressedSize, true);
    dv.setUint32(22, big ? MAX32 : it.size, true);
    dv.setUint16(26, it.nameBytes.length, true);
    dv.setUint16(28, localExtra, true);
    local.set(it.nameBytes, 30);
    if (big) {
      const x = 30 + it.nameBytes.length;
      dv.setUint16(x, 0x0001, true);
      dv.setUint16(x + 2, 16, true);
      setU64(dv, x + 4, it.size);
      setU64(dv, x + 12, it.compressedSize);
    }
    parts.push(local, it.payload);
    central.push({ it, offset, time, date });
    offset += local.length + it.compressedSize;
  }

  const cdStart = offset;
  for (const { it, offset: localOffset, time, date } of central) {
    const z = [];
    if (forceZip64 || it.size >= MAX32) z.push(it.size);
    if (forceZip64 || it.compressedSize >= MAX32) z.push(it.compressedSize);
    if (forceZip64 || localOffset >= MAX32) z.push(localOffset);
    const extra = z.length ? 4 + z.length * 8 : 0;
    const rec = new Uint8Array(46 + it.nameBytes.length + extra);
    const dv = new DataView(rec.buffer);
    const needed = z.length ? 45 : 20;
    dv.setUint32(0, SIG_CENTRAL, true);
    dv.setUint16(4, (3 << 8) | 45, true); // made by: Unix, spec 4.5
    dv.setUint16(6, needed, true);
    dv.setUint16(8, FLAG_UTF8, true);
    dv.setUint16(10, it.method, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, it.crc, true);
    dv.setUint32(20, forceZip64 || it.compressedSize >= MAX32 ? MAX32 : it.compressedSize, true);
    dv.setUint32(24, forceZip64 || it.size >= MAX32 ? MAX32 : it.size, true);
    dv.setUint16(28, it.nameBytes.length, true);
    dv.setUint16(30, extra, true);
    dv.setUint16(32, 0, true); // comment length
    dv.setUint16(34, 0, true); // disk number start
    dv.setUint16(36, 0, true); // internal attributes
    const dir = it.name.endsWith('/');
    dv.setUint32(38, ((dir ? 0o40755 : 0o100644) << 16 | (dir ? 0x10 : 0)) >>> 0, true);
    dv.setUint32(42, forceZip64 || localOffset >= MAX32 ? MAX32 : localOffset, true);
    rec.set(it.nameBytes, 46);
    if (extra) {
      let x = 46 + it.nameBytes.length;
      dv.setUint16(x, 0x0001, true);
      dv.setUint16(x + 2, z.length * 8, true);
      x += 4;
      for (const v of z) { setU64(dv, x, v); x += 8; }
    }
    parts.push(rec);
    offset += rec.length;
  }
  const cdSize = offset - cdStart;
  const count = items.length;
  const need64 = forceZip64 || count > MAX16 || cdSize >= MAX32 || cdStart >= MAX32;
  if (need64) {
    const rec = new Uint8Array(56 + 20);
    const dv = new DataView(rec.buffer);
    dv.setUint32(0, SIG_EOCD64, true);
    setU64(dv, 4, 44);
    dv.setUint16(12, (3 << 8) | 45, true);
    dv.setUint16(14, 45, true);
    dv.setUint32(16, 0, true);
    dv.setUint32(20, 0, true);
    setU64(dv, 24, count);
    setU64(dv, 32, count);
    setU64(dv, 40, cdSize);
    setU64(dv, 48, cdStart);
    dv.setUint32(56, SIG_LOCATOR64, true);
    dv.setUint32(60, 0, true);
    setU64(dv, 64, offset);
    dv.setUint32(72, 1, true);
    parts.push(rec);
  }
  const commentBytes = encoder.encode(comment).subarray(0, MAX16);
  const eocd = new Uint8Array(22 + commentBytes.length);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, SIG_EOCD, true);
  dv.setUint16(8, need64 ? MAX16 : count, true);
  dv.setUint16(10, need64 ? MAX16 : count, true);
  dv.setUint32(12, need64 ? MAX32 : cdSize, true);
  dv.setUint32(16, need64 ? MAX32 : cdStart, true);
  dv.setUint16(20, commentBytes.length, true);
  eocd.set(commentBytes, 22);
  parts.push(eocd);
  return new Blob(parts, { type: 'application/zip' });
}

// ---------------------------------------------------------------------------------------------
// Reader

const METHOD_NAMES = { 1: 'shrink', 6: 'implode', 9: 'deflate64', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 95: 'xz', 98: 'ppmd', 99: 'AES encryption' };

// IBM code page 437, bytes 0x80-0xFF (used for names without the UTF-8 flag that aren't valid UTF-8).
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeName(raw, flags, extras) {
  if (flags & FLAG_UTF8) return utf8.decode(raw);
  const up = extras.get(0x7075); // Info-ZIP Unicode Path extra field
  if (up && up.length > 5 && up[0] === 1) {
    const dv = new DataView(up.buffer, up.byteOffset, up.byteLength);
    if (dv.getUint32(1, true) === crc32(raw)) return utf8.decode(up.subarray(5));
  }
  try {
    return utf8Strict.decode(raw);
  } catch {
    let s = '';
    for (const b of raw) s += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80];
    return s;
  }
}

function parseExtras(bytes) {
  const map = new Map();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.length;) {
    const id = dv.getUint16(i, true);
    const len = dv.getUint16(i + 2, true);
    if (i + 4 + len > bytes.length) break;
    map.set(id, bytes.subarray(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return map;
}

async function readRange(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

class ZipEntry {
  #zip;
  #dataStart = null;

  constructor(zip, fields) {
    this.#zip = zip;
    Object.assign(this, fields);
  }

  get encrypted() {
    return !!(this.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) || this.method === 99;
  }

  get isDirectory() {
    return this.name.endsWith('/');
  }

  #check() {
    if (this.encrypted) throw new ZipError(`"${this.name}" is encrypted. Encrypted zip entries are not supported; re-create the archive without a password.`);
    if (this.method !== 0 && this.method !== 8) {
      const label = METHOD_NAMES[this.method] ? ` (${METHOD_NAMES[this.method]})` : '';
      throw new ZipError(`"${this.name}" uses compression method ${this.method}${label}, which is not supported. Only stored (0) and deflate (8) entries can be read.`);
    }
  }

  async #start() {
    if (this.#dataStart === null) {
      const head = await readRange(this.#zip, this.offset, this.offset + 30);
      const dv = new DataView(head.buffer);
      if (head.length < 30 || dv.getUint32(0, true) !== SIG_LOCAL) throw new ZipError(`Zip archive is damaged: local header for "${this.name}" not found.`);
      this.#dataStart = this.offset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
      if (this.#dataStart + this.compressedSize > this.#zip.size) throw new ZipError(`Zip archive is truncated: "${this.name}" is incomplete.`);
    }
    return this.#dataStart;
  }

  /** Byte offset of the entry's (possibly compressed) data within the archive. */
  async dataOffset() {
    return this.#start();
  }

  /**
   * The entry's contents. Stored entries are a zero-copy slice of the archive (CRC not checked;
   * use bytes() or your own hash for that). Deflated entries are inflated and CRC-checked.
   * @param {string} [type] MIME type for the returned Blob
   */
  async blob(type = '') {
    this.#check();
    const start = await this.#start();
    const raw = this.#zip.slice(start, start + this.compressedSize, type);
    if (this.method === 0) return raw;
    if (typeof DecompressionStream !== 'function') throw new ZipError(`Cannot read "${this.name}": this browser has no DecompressionStream for deflate.`);
    let crc = 0;
    let size = 0;
    const chunks = [];
    try {
      const reader = raw.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crc = crc32Update(crc, value);
        size += value.byteLength;
        chunks.push(value);
      }
    } catch (err) {
      throw new ZipError(`"${this.name}" is damaged and could not be decompressed (${err?.message || err}).`);
    }
    if (size !== this.size || crc !== this.crc32) throw new ZipError(`"${this.name}" is damaged: CRC-32 or size does not match.`);
    return new Blob(chunks, { type });
  }

  /** The entry's contents as bytes, CRC-checked. */
  async bytes() {
    const bytes = new Uint8Array(await (await this.blob()).arrayBuffer());
    if (this.method === 0 && (bytes.length !== this.size || crc32(bytes) !== this.crc32)) {
      throw new ZipError(`"${this.name}" is damaged: CRC-32 or size does not match.`);
    }
    return bytes;
  }

  /** The entry's contents decoded as UTF-8, CRC-checked. */
  async text() {
    return utf8.decode(await this.bytes());
  }
}

/**
 * Read a ZIP archive's directory.
 * @param {Blob | Uint8Array | ArrayBuffer} blob
 * @returns {Promise<Map<string, ZipEntry>>} by entry name; each entry has
 *   { name, size, compressedSize, method, crc32, flags, mtime, offset, encrypted, isDirectory,
 *     blob(type?), bytes(), text(), dataOffset() }
 */
export async function readZip(blob) {
  if (!isBlob(blob)) {
    const bytes = toBytes(blob);
    if (!bytes || typeof blob === 'string') throw new TypeError('readZip expects a Blob, Uint8Array or ArrayBuffer');
    blob = new Blob([bytes]);
  }
  const size = blob.size;
  if (size < 22) throw new ZipError('Not a zip archive (file is too small).');
  const tailStart = Math.max(0, size - (22 + MAX16 + 20));
  const tail = await readRange(blob, tailStart, size);
  const tdv = new DataView(tail.buffer);

  // Find the end-of-central-directory record, preferring one whose comment ends exactly at EOF.
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === SIG_EOCD && i + 22 + tdv.getUint16(i + 20, true) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) {
    for (let i = tail.length - 22; i >= 0; i--) if (tdv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('Not a zip archive (end of central directory not found).');

  let disk = tdv.getUint16(eocd + 4, true);
  let cdDisk = tdv.getUint16(eocd + 6, true);
  let count = tdv.getUint16(eocd + 10, true);
  let cdSize = tdv.getUint32(eocd + 12, true);
  let cdOffset = tdv.getUint32(eocd + 16, true);
  let cdEnd = tailStart + eocd; // where the central directory should end

  if (eocd >= 20 && tdv.getUint32(eocd - 20, true) === SIG_LOCATOR64) {
    const recOffset = getU64(tdv, eocd - 20 + 8);
    if (tdv.getUint32(eocd - 20 + 16, true) > 1) throw new ZipError('Split or spanned zip archives are not supported.');
    const rec = await readRange(blob, recOffset, recOffset + 56);
    const rdv = new DataView(rec.buffer);
    if (rec.length < 56 || rdv.getUint32(0, true) !== SIG_EOCD64) throw new ZipError('Zip archive is damaged: ZIP64 end of central directory not found.');
    disk = rdv.getUint32(16, true);
    cdDisk = rdv.getUint32(20, true);
    count = getU64(rdv, 32);
    cdSize = getU64(rdv, 40);
    cdOffset = getU64(rdv, 48);
    cdEnd = recOffset;
  }
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('Split or spanned zip archives are not supported.');
  if (cdSize > cdEnd) throw new ZipError('Zip archive is damaged: central directory is larger than the file.');

  let cd = await readRange(blob, cdOffset, cdOffset + cdSize);
  let delta = 0; // bytes prepended to the archive (e.g. self-extracting stubs)
  if (cdSize && (cd.length < 4 || new DataView(cd.buffer).getUint32(0, true) !== SIG_CENTRAL)) {
    delta = cdEnd - cdSize - cdOffset;
    cd = delta > 0 ? await readRange(blob, cdOffset + delta, cdOffset + delta + cdSize) : cd;
    if (delta <= 0 || cd.length < 4 || new DataView(cd.buffer).getUint32(0, true) !== SIG_CENTRAL) {
      throw new ZipError('Zip archive is damaged: central directory not found.');
    }
  }

  const dv = new DataView(cd.buffer);
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('Zip archive is damaged: central directory is truncated.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const time = dv.getUint16(p + 12, true);
    const date = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const raw = cd.subarray(p + 46, p + 46 + nameLen);
    const extras = parseExtras(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
    const z64 = extras.get(0x0001);
    if (z64) {
      const zdv = new DataView(z64.buffer, z64.byteOffset, z64.byteLength);
      let x = 0;
      const next = () => {
        if (x + 8 > z64.length) throw new ZipError('Zip archive is damaged: ZIP64 extra field is too short.');
        const v = getU64(zdv, x);
        x += 8;
        return v;
      };
      if (size === MAX32) size = next();
      if (compressedSize === MAX32) compressedSize = next();
      if (offset === MAX32) offset = next();
    }
    const name = decodeName(raw, flags, extras);
    entries.set(name, new ZipEntry(blob, {
      name, size, compressedSize, method, crc32: crc, flags, mtime: fromDosDateTime(time, date), offset: offset + delta,
    }));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
