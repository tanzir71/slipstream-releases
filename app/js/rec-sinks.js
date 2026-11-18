// Where recorder chunks go while recording (W-01, W-02). Every chunk is persisted as it arrives:
// - OPFS (preferred): appended and flushed to projects/<id>/screen|camera, so the recording already
//   *is* the project's media when you press stop — no multi-GB copy.
// - IndexedDB (fallback): one record per 1 s chunk, assembled on stop.
import { OpfsAppender, opfsSupported } from './opfs.js';
import { putChunk, getChunks, deleteChunks } from './store.js';

class OpfsSink {
  constructor(appender) { this.a = appender; }
  write(blob) { this.a.write(blob); }
  close(type) { return this.a.close(type); }
  abort() { return this.a.abort(); }
}

class IdbSink {
  constructor(id, track) { this.id = id; this.track = track; this.n = 0; this.chain = Promise.resolve(); this.error = null; }
  write(blob) {
    const n = this.n++;
    this.chain = this.chain.then(() => putChunk(this.id, this.track, n, blob)).catch((e) => { this.error = e; });
  }
  async close(type) {
    await this.chain;
    if (this.error) throw this.error;
    return new Blob(await getChunks(this.id, this.track), { type });
  }
  abort() { return deleteChunks(this.id).catch(() => {}); }
}

/** Create sinks for a new recording whose project id is `id`. Returns { sinks, backend }. */
export async function createSinks(id, { camera = false } = {}) {
  if (await opfsSupported()) {
    try {
      const screen = new OpfsSink(await OpfsAppender.open(['projects', id], 'screen'));
      const cam = camera ? new OpfsSink(await OpfsAppender.open(['projects', id], 'camera')) : null;
      const sinks = { screen, camera: cam, stored: true };
      return { sinks, backend: 'opfs' };
    } catch (err) { console.warn('OPFS recording unavailable, using IndexedDB chunks', err); }
  }
  return { sinks: { screen: new IdbSink(id, 'screen'), camera: camera ? new IdbSink(id, 'camera') : null, stored: false }, backend: 'idb' };
}
