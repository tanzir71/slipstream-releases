// Crash recovery for recordings (W-02). A recording interrupted by a crash, a closed tab or a power cut
// leaves a journal entry plus the chunks written so far. The partial WebM has no duration or cues, so we
// remux it through Mediabunny (no re-encode) to make duration and seeking work, then open it as a project.
import { MB } from './media.js';
import { readFile, positionalWriter, renameFile, opfsSupported } from './opfs.js';
import { getChunks, deleteChunks, putMedia } from './store.js';

/** Raw media left behind by an interrupted recording. */
export async function recoveredMedia(j) {
  if (j.backend === 'opfs' && (await opfsSupported())) {
    const screen = await readFile(['projects', j.id], 'screen', j.screenType);
    const camera = j.hasCamera ? await readFile(['projects', j.id], 'camera', j.cameraType) : null;
    return { screen: screen?.size ? screen : null, camera: camera?.size ? camera : null };
  }
  const s = await getChunks(j.id, 'screen');
  const c = j.hasCamera ? await getChunks(j.id, 'camera') : [];
  return { screen: s.length ? new Blob(s, { type: j.screenType || 'video/webm' }) : null, camera: c.length ? new Blob(c, { type: j.cameraType || 'video/webm' }) : null };
}

/**
 * Remux a partial recording into a well-formed file (same codecs, no re-encode).
 * OPFS: streamed to projects/<id>/<name>.fixed, then renamed over the original. Otherwise in memory.
 * Returns the repaired Blob/File, or the original if it couldn't be repaired.
 */
export async function remux(blob, { id, name, onProgress = () => {} }) {
  const type = (blob.type || 'video/webm').split(';')[0];
  const webm = !type.includes('mp4');
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const opfs = await opfsSupported() && blob instanceof File;
  const tmp = `${name}.fixed`;
  const target = opfs ? new MB.StreamTarget(await positionalWriter(['projects', id], tmp), { chunked: true }) : new MB.BufferTarget();
  const output = new MB.Output({ format: webm ? new MB.WebMOutputFormat() : new MB.Mp4OutputFormat(), target });
  try {
    const conv = await MB.Conversion.init({ input, output });
    if (!conv.isValid) throw new Error('This recording can’t be repaired in this browser');
    conv.onProgress = onProgress;
    await conv.execute();
    if (opfs) {
      await renameFile(['projects', id], tmp, name);
      return readFile(['projects', id], name, type);
    }
    const fixed = new Blob([target.buffer], { type });
    return fixed;
  } catch (err) {
    console.warn('Remux failed; using the raw recording', err);
    return blob;
  } finally {
    input.dispose?.();
  }
}

/** Remux whatever an interrupted recording left and return media ready for createProject(). */
export async function repairRecording(j, onProgress = () => {}) {
  const raw = await recoveredMedia(j);
  if (!raw.screen) throw new Error('Nothing was saved from that recording.');
  const screen = await remux(raw.screen, { id: j.id, name: 'screen', onProgress: (p) => onProgress(raw.camera ? p * 0.7 : p) });
  const camera = raw.camera ? await remux(raw.camera, { id: j.id, name: 'camera', onProgress: (p) => onProgress(0.7 + p * 0.3) }) : null;
  let stored = j.backend === 'opfs' && screen instanceof File;
  if (!stored) {
    // IndexedDB chunks: move the repaired media into normal storage and drop the chunks.
    await putMedia(`${j.id}:screen`, screen);
    if (camera) await putMedia(`${j.id}:camera`, camera);
    await deleteChunks(j.id).catch(() => {});
    stored = true;
  }
  return { screen, camera, cameraOffset: j.cameraOffset || 0, stored };
}
