// Main-thread side of the Origin Private File System store. Media lives on disk as real files, so a
// one-hour recording reopens as a disk-backed File instead of a multi-gigabyte blob in memory.
// All writes go through opfs-worker.js (synchronous access handles); reads use getFile() here.

let worker = null;
let seq = 0;
const pending = new Map();
let supported = null;

/** True when this browser can store media in OPFS (needs workers with sync access handles). */
export function opfsSupported() {
  if (!supported) {
    supported = (async () => {
      try {
        if (!navigator.storage?.getDirectory || typeof Worker === 'undefined') return false;
        // createSyncAccessHandle is only exposed in workers, so ask the worker to try it (private windows
        // in some browsers have OPFS without it).
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
        await Promise.race([call('probe', {}), timeout]);
        return true;
      } catch { return false; }
    })();
  }
  return supported;
}

function call(op, args, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('./opfs-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.rid);
      if (!p) return;
      pending.delete(e.data.rid);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(Object.assign(new Error(e.data.error.message), { name: e.data.error.name }));
    };
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Storage worker failed')); pending.clear(); };
  }
  const rid = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject });
    worker.postMessage({ rid, op, ...args }, transfer);
  });
}

async function dirAt(path, create = false) {
  let dir = await navigator.storage.getDirectory();
  for (const part of path) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

/** Copy a Blob/File into OPFS at path/name and return the stored, disk-backed File. */
export async function writeFile(path, name, blob, type = blob.type) {
  await call('writeBlob', { path, name, blob });
  return readFile(path, name, type);
}

/** Returns the stored File (with `type` restored, since OPFS doesn't keep MIME types) or null. */
export async function readFile(path, name, type = '') {
  try {
    const dir = await dirAt(path);
    const file = await (await dir.getFileHandle(name)).getFile();
    return type && !file.type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
  } catch (err) {
    if (err.name === 'NotFoundError' || err.name === 'TypeMismatchError') return null;
    throw err;
  }
}

export function removePath(path) { return call('remove', { path }); }

/** Total bytes under a directory (recursive). */
export async function dirSize(path) {
  let total = 0;
  const walk = async (dir) => {
    for await (const [, handle] of dir.entries()) {
      if (handle.kind === 'file') total += (await handle.getFile()).size;
      else await walk(handle);
    }
  };
  try { await walk(await dirAt(path)); } catch { /* missing dir = 0 */ }
  return total;
}

/** Names of the sub-directories of path (e.g. project ids under ['projects']). */
export async function listDirs(path) {
  const out = [];
  try {
    for await (const [name, handle] of (await dirAt(path)).entries()) if (handle.kind === 'directory') out.push(name);
  } catch { /* none */ }
  return out;
}

export function renameFile(path, from, to) { return call('rename', { path, from, to }); }

/**
 * A WritableStream that accepts Mediabunny StreamTarget chunks ({ type: 'write', data, position }) and
 * writes them at their positions in an OPFS file, so a remux never holds the whole file in memory.
 */
export async function positionalWriter(path, name) {
  const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  await call('open', { id, path, name, truncate: true });
  const stream = new WritableStream({
    async write(chunk) {
      const data = chunk.data.byteOffset === 0 && chunk.data.byteLength === chunk.data.buffer.byteLength ? chunk.data.buffer.slice(0) : chunk.data.slice().buffer;
      await call('writeAt', { id, data, position: chunk.position }, [data]);
    },
    async close() { await call('close', { id }); },
    async abort() { await call('close', { id }).catch(() => {}); },
  });
  return stream;
}

/**
 * Append-only file for MediaRecorder chunks. Each write is flushed to disk before the next one starts,
 * in order, so a crash loses at most the chunk being written.
 */
export class OpfsAppender {
  static async open(path, name, type = '') {
    const a = new OpfsAppender(path, name, type);
    await call('open', { id: a.id, path, name, truncate: true });
    return a;
  }

  constructor(path, name, type) {
    this.id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    this.path = path; this.name = name; this.type = type;
    this.size = 0;
    this.chain = Promise.resolve();
    this.error = null;
  }

  write(blob) {
    this.chain = this.chain.then(async () => {
      if (this.error) return;
      const buf = await blob.arrayBuffer();
      const r = await call('append', { id: this.id, data: buf }, [buf]);
      this.size = r.size;
    }).catch((err) => { this.error = err; });
    return this.chain;
  }

  async close(type = this.type) {
    await this.chain;
    await call('close', { id: this.id });
    if (this.error) throw this.error;
    return readFile(this.path, this.name, type);
  }

  async abort() {
    await this.chain.catch(() => {});
    await call('close', { id: this.id }).catch(() => {});
  }
}
