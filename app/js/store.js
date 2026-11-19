// Local project library. Media and edit state never leave the browser.
//
// - Project JSON (edit state, plan v2 mirror, thumbnails) lives in IndexedDB.
// - Media lives in the Origin Private File System as real files (W-01), so multi-GB recordings and
//   Safari quotas behave. Browsers without OPFS sync access handles fall back to IndexedDB blobs.
// - In-progress recordings keep a journal entry here plus their chunks on disk (W-02), so a crashed
//   tab can offer "Recover recording" on the next launch.
import { opfsSupported, writeFile, readFile, removePath, dirSize, listDirs } from './opfs.js';

const DB_NAME = 'slipstream-web';
const VERSION = 2;
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('media')) d.createObjectStore('media');
        if (!d.objectStoreNames.contains('recordings')) d.createObjectStore('recordings', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks');
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result && typeof result === 'object' && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}

// ---- projects ---------------------------------------------------------------------------------
export async function listProjects() {
  const all = await tx('projects', 'readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}
export const getProject = (id) => tx('projects', 'readonly', (s) => s.get(id));
export const saveProject = (p) => tx('projects', 'readwrite', (s) => s.put({ ...p, updated: Date.now() }));

// ---- media --------------------------------------------------------------------------------------
const splitKey = (key) => { const i = key.lastIndexOf(':'); return [key.slice(0, i), key.slice(i + 1)]; };

/** True when media is stored as files in OPFS (vs. IndexedDB blobs). */
export const usesOPFS = () => opfsSupported();

/** Store a media blob under `${projectId}:${name}`. Returns the stored File/Blob to use from now on. */
export async function putMedia(key, blob) {
  const [id, name] = splitKey(key);
  if (await opfsSupported()) {
    try { return await writeFile(['projects', id], name, blob); } catch (err) { console.warn('OPFS write failed, using IndexedDB', err); }
  }
  await tx('media', 'readwrite', (s) => s.put(blob, key));
  return blob;
}

/** Load media by key; `type` restores the MIME type that OPFS doesn't keep. */
export async function getMedia(key, type = '') {
  const [id, name] = splitKey(key);
  if (await opfsSupported()) {
    const f = await readFile(['projects', id], name, type).catch(() => null);
    if (f && f.size) return f;
  }
  return tx('media', 'readonly', (s) => s.get(key));
}

/**
 * Media a project can hold under `${id}:<name>`: the recordings, the originals kept beside preview copies in the
 * desktop app (`original` for the screen, `camera-original`, `angle-<id>-original`), camera angles
 * (`angle-<id>`), B-roll (`broll-<id>`), the logo, music and intro/outro. The IndexedDB fallback matches every key
 * that starts with `${id}:` (keyRange), so names added later are deleted and counted too.
 */
export const MEDIA_NAMES = ['screen', 'camera', 'original', 'camera-original', 'logo', 'music', 'intro', 'outro'];
const projectKeys = (id) => IDBKeyRange.bound(`${id}:`, `${id}:\uffff`);

export async function deleteProject(id) {
  await tx('projects', 'readwrite', (s) => s.delete(id));
  await tx('media', 'readwrite', (s) => s.delete(projectKeys(id)));
  if (await opfsSupported()) await removePath(['projects', id]).catch(() => {});
}

/** Bytes used by one project's media (OPFS files + any legacy IndexedDB blobs). */
export async function projectSize(id) {
  let total = 0;
  if (await opfsSupported()) total += await dirSize(['projects', id]);
  const blobs = await tx('media', 'readonly', (s) => s.getAll(projectKeys(id))).catch(() => []);
  for (const b of blobs || []) total += b?.size || 0;
  return total;
}

/** Media folders in OPFS that no project or recording journal points to (left by crashes or old builds). */
export async function orphanMedia() {
  if (!(await opfsSupported())) return [];
  const [dirs, projects, journals] = await Promise.all([listDirs(['projects']), listProjects(), listJournals()]);
  const known = new Set([...projects.map((p) => p.id), ...journals.map((j) => j.id)]);
  return dirs.filter((d) => !known.has(d));
}
export const removeMediaDir = (id) => removePath(['projects', id]);

export async function storageInfo() {
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    return { persisted, usage: est?.usage || 0, quota: est?.quota || 0, opfs: await opfsSupported() };
  } catch { return { persisted: false, usage: 0, quota: 0, opfs: false }; }
}

export async function requestPersistence() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

// ---- recording journal (W-02) ---------------------------------------------------------------------
// { id (= future project id), started, updated, elapsed, screenType, cameraType, hasCamera, cameraOffset, backend: 'opfs'|'idb' }
export const saveJournal = (j) => tx('recordings', 'readwrite', (s) => s.put({ ...j, updated: Date.now() }));
export const deleteJournal = (id) => tx('recordings', 'readwrite', (s) => s.delete(id));
export async function listJournals() {
  try { return (await tx('recordings', 'readonly', (s) => s.getAll())) || []; } catch { return []; }
}

// ---- chunk fallback for browsers without OPFS: one IndexedDB record per recorder chunk ----------------
const chunkKey = (sid, track, n) => `${sid}:${track}:${String(n).padStart(9, '0')}`;
export const putChunk = (sid, track, n, blob) => tx('chunks', 'readwrite', (s) => s.put(blob, chunkKey(sid, track, n)));
export async function getChunks(sid, track) {
  const range = IDBKeyRange.bound(`${sid}:${track}:`, `${sid}:${track}:￿`);
  return (await tx('chunks', 'readonly', (s) => s.getAll(range))) || [];
}
export const deleteChunks = (sid) => tx('chunks', 'readwrite', (s) => s.delete(IDBKeyRange.bound(`${sid}:`, `${sid}:￿`)));

// ---- settings (brand kit, templates, copilot preferences) ------------------------------------------
export const getSetting = (key) => tx('settings', 'readonly', (s) => s.get(key));
export const setSetting = (key, value) => tx('settings', 'readwrite', (s) => s.put(value, key));
