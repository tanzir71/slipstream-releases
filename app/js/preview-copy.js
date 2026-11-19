// Desktop app: preview copies of recordings the webview can't decode (HEVC without the Windows extension, ProRes,
// 10-bit, AVI…). The engine makes the copy on this computer; the original is kept beside it in the project and is
// what engine exports and .slipstream bundles use. In a browser none of this runs (`desktop.available` is false).
import { h, modal } from './ui.js';
import { probe } from './media.js';
import { putMedia, saveProject } from './store.js';
import desktop from './desktop-bridge.js';

/**
 * Desktop app: a video the webview can't decode (HEVC without the Windows extension, ProRes, 10-bit, AVI…) is
 * edited from a preview copy the engine makes (≤ 1280 px, every audio track mixed). The original is kept beside it
 * (keepOriginal) and is what the engine exports and bundles carry. `what` names it in the dialog ('recording',
 * 'camera recording', …). Resolves { preview, original? } (original: { file, path, info }), or null when cancelled.
 */
export async function desktopPreview(file, path, what = 'recording') {
  if (!desktop.available || !file) return { preview: file };
  const info = await probe(file).catch(() => null);
  if (!info || !info.hasVideo || info.canDecodeVideo || info.canPlayElement) return { preview: file };
  const ctrl = new AbortController();
  const bar = h('div.bar', h('i'));
  const label = h('p.muted.small', 'Starting…');
  const m = modal('Making a preview copy', h('div.stack',
    h('p.muted', `This computer can’t play the ${what} (${info.videoCodec || 'its video format'}) in the editor, so Slipstream makes a smaller copy to edit with. Your export still uses the original, at full quality.`),
    bar, label,
    h('div.row.end', h('button.btn', { onclick: () => ctrl.abort() }, 'Cancel'))), { onClose: () => ctrl.abort() });
  try {
    const res = await desktop.proxy(path || file, { key: `import-${file.name || what}`, signal: ctrl.signal }, (e) => {
      if (e?.done == null) return;
      bar.firstChild.style.width = `${Math.round(e.done * 100)}%`;
      label.textContent = `${e.stage === 'copy' ? 'Reading the file' : e.stage || 'Making the preview'} · ${Math.round(e.done * 100)}%`;
    });
    const base = String(file.name || what).replace(/\.[^.]+$/, '');
    const preview = await desktop.readFile({ path: res.path, name: `${base}.mp4`, size: res.size }, { type: 'video/mp4', signal: ctrl.signal });
    return { preview, original: { file, path, info } };
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  } finally {
    m.close();
  }
}

/** Where each recording's original is kept when it has a preview copy (angles: `angle-<id>-original`, media.angles[i].original). */
export const ORIGINAL_SLOTS = { screen: { key: 'original', field: 'original' }, camera: { key: 'camera-original', field: 'cameraOriginal' } };

/** What the project records about a kept original (planFor uses its size for the edit plan). */
export const originalRecord = ({ file, path, info }) => ({
  name: file.name || '', type: file.type || '', size: file.size,
  ...(info?.width && info?.height ? { width: info.width, height: info.height } : {}), ...(path ? { path } : {}),
});

/** Store the original of a recording edited from a preview copy: what the engine exports, never the preview. */
export async function keepOriginal(p, original, role = 'screen') {
  const slot = ORIGINAL_SLOTS[role];
  await putMedia(`${p.id}:${slot.key}`, original.file);
  p.media[slot.field] = originalRecord(original);
  await saveProject(p);
}
