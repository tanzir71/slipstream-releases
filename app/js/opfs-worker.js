// Origin Private File System writer (W-01, W-02). Runs in a dedicated worker because synchronous access
// handles — the only OPFS API that writes straight to disk without a swap file — exist only in workers,
// and they work the same in Chrome, Edge, Safari and Firefox. Each recorder chunk is appended and flushed,
// so if the tab is killed mid-recording everything up to the last second is already on disk.

const open = new Map(); // id -> { handle, size }

async function dirAt(path, create = true) {
  let dir = await navigator.storage.getDirectory();
  for (const part of path) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function openFile(path, name, { truncate = true } = {}) {
  const dir = await dirAt(path);
  const fh = await dir.getFileHandle(name, { create: true });
  const handle = await fh.createSyncAccessHandle();
  if (truncate) handle.truncate(0);
  return { handle, size: handle.getSize() };
}

const ops = {
  async probe() {
    const root = await navigator.storage.getDirectory();
    const name = `.probe-${Math.random().toString(36).slice(2)}`;
    const fh = await root.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    h.close();
    await root.removeEntry(name).catch(() => {});
    return { ok: true };
  },
  async open({ id, path, name, truncate }) {
    open.set(id, await openFile(path, name, { truncate }));
    return { size: open.get(id).size };
  },
  async append({ id, data }) {
    const f = open.get(id);
    if (!f) throw new Error('File is not open');
    const bytes = new Uint8Array(data);
    let off = 0;
    while (off < bytes.length) off += f.handle.write(bytes.subarray(off), { at: f.size + off });
    f.size += bytes.length;
    f.handle.flush();
    return { size: f.size };
  },
  async writeAt({ id, data, position }) {
    const f = open.get(id);
    if (!f) throw new Error('File is not open');
    const bytes = new Uint8Array(data);
    let off = 0;
    while (off < bytes.length) off += f.handle.write(bytes.subarray(off), { at: position + off });
    f.size = Math.max(f.size, position + bytes.length);
    return { size: f.size };
  },
  async rename({ path, from, to }) {
    const dir = await dirAt(path);
    const src = await dir.getFileHandle(from);
    if (typeof src.move === 'function') {
      await dir.removeEntry(to).catch(() => {});
      await src.move(to);
      return {};
    }
    // No move(): copy through sync handles, then delete the source.
    const a = await src.createSyncAccessHandle();
    const b = await (await dir.getFileHandle(to, { create: true })).createSyncAccessHandle();
    try {
      b.truncate(0);
      const size = a.getSize(), buf = new Uint8Array(4 * 1024 * 1024);
      for (let at = 0; at < size;) {
        const n = a.read(buf, { at });
        if (!n) break;
        b.write(buf.subarray(0, n), { at });
        at += n;
      }
      b.flush();
    } finally { a.close(); b.close(); }
    await dir.removeEntry(from);
    return {};
  },
  async close({ id }) {
    const f = open.get(id);
    if (!f) return { size: 0 };
    f.handle.flush();
    f.handle.close();
    open.delete(id);
    return { size: f.size };
  },
  async writeBlob({ path, name, blob }) {
    const f = await openFile(path, name);
    try {
      const reader = blob.stream().getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let off = 0;
        while (off < value.length) off += f.handle.write(value.subarray(off), { at: f.size + off });
        f.size += value.length;
      }
      f.handle.flush();
      return { size: f.size };
    } finally {
      f.handle.close();
    }
  },
  async remove({ path }) {
    if (!path.length) return {};
    const parent = await dirAt(path.slice(0, -1), false).catch(() => null);
    if (parent) await parent.removeEntry(path[path.length - 1], { recursive: true }).catch((e) => { if (e.name !== 'NotFoundError') throw e; });
    return {};
  },
};

self.onmessage = async (e) => {
  const { rid, op, ...args } = e.data;
  try {
    const result = await ops[op](args);
    self.postMessage({ rid, ok: true, result });
  } catch (err) {
    self.postMessage({ rid, ok: false, error: { name: err?.name || 'Error', message: String(err?.message || err) } });
  }
};
