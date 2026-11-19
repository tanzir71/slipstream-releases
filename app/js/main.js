// Slipstream Web — app shell: library, recorder, import, routing.
import { h, $, icon, fmtTime, fmtBytes, toast, confirmDialog, toggle, modal, fill } from './ui.js';
import {
  listProjects, getProject, saveProject, deleteProject, putMedia, getMedia, storageInfo, requestPersistence,
  projectSize, orphanMedia, removeMediaDir, deleteJournal, listJournals, deleteChunks,
} from './store.js';
import { repairRecording } from './recover.js';
import { exportBundle, readBundle, matchesRef, isBundleFile, BundleError } from './projects-io.js';
import { downloadBlob } from './exporter.js';
import { fromV2 } from '../../packages/editor-core/src/plan.js';
import { showHostRoom, showGuestRoom, showReceive, sendToDeviceDialog } from './guest.js';
import { probe, thumbnail, mixAudioTracks } from './media.js';
import { positionalWriter, readFile, opfsSupported } from './opfs.js';
import { defaultEdit, uid } from './edl.js';
import { openEditor } from './editor.js';
import { recordingSupported, alignCursor } from './recorder.js';
import { mountRecorder, applySourceCrop } from './rec-ui.js';
import { setScene } from '../../packages/editor-core/src/scenes.js';
import { compactCursorSamples } from './autozoom.js';
import { webcodecsVideo, webcodecsAudio } from './media-compat.js';
import { realtimeSupported } from './exporter-realtime.js';
import desktop from './desktop-bridge.js';
import { desktopPreview, keepOriginal, originalRecord } from './preview-copy.js';

const root = $('#app');
let current = null; // active screen controller with optional cleanup()

/** Phones and small tablets can edit but not record (no screen capture there). */
export const isHandheld = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(min-width: 900px) and (hover: hover)').matches;

export function capabilities() {
  return {
    webcodecs: webcodecsVideo() && webcodecsAudio(),
    realtime: realtimeSupported(),
    record: recordingSupported() && !isHandheld(),
    idb: typeof indexedDB !== 'undefined',
    webgpu: !!navigator.gpu,
  };
}

function route() {
  current?.cleanup?.();
  current = null;
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/edit\/(.+)$/);
  if (m) return showEditor(decodeURIComponent(m[1]));
  if (hash.startsWith('#/record')) return showRecorder();
  // Remote guests (S-06) and direct device-to-device transfer (S-05): serverless WebRTC.
  if (hash.startsWith('#/host')) { current = showHostRoom(root, { onDone: (res) => createGuestSession(res) }); return; }
  const g = hash.match(/^#\/guest(?:\/(.*))?$/);
  if (g) { current = showGuestRoom(root, decodeURIComponent(g[1] || '')); return; }
  const rcv = hash.match(/^#\/receive(?:\/(.*))?$/);
  if (rcv) { current = showReceive(root, decodeURIComponent(rcv[1] || ''), { onFile: (file) => importFile(file) }); return; }
  return showHome();
}
window.addEventListener('hashchange', route);

// ---- Home / library ---------------------------------------------------------------------------
async function showHome() {
  const caps = capabilities();
  const fileInput = h('input', { type: 'file', multiple: true, accept: 'video/*,audio/*,image/*,.mkv,.mov,.m4a,.mp3,.wav,.slipstream', hidden: true, onchange: (e) => importFiles([...e.target.files]) });
  // The desktop app's own dialog gives the file's path, so a Slipstream 1 recording's cursor track comes along.
  const drop = h('button.start-card.drop', { onclick: () => (desktop.available ? pickAndImport() : fileInput.click()) },
    h('span.sc-icon.blue', icon('upload', 22)),
    h('span.sc-text', h('b', 'Import a video'), h('span', 'Drop a file here, or browse. MP4, MOV, WebM, MKV, audio files and .slipstream projects work. Pick several videos or photos to make one project from them.')),
    h('span.sc-kbd', 'Drop anywhere'));
  const rec = h('button.start-card', { disabled: !caps.record, onclick: () => { location.hash = '#/record'; } },
    h('span.sc-icon.rec-ic', h('i')),
    h('span.sc-text', h('b', 'New recording'), h('span', caps.record ? 'Your screen, a window or a tab, with camera and mic.' : 'Recording needs a desktop browser with screen capture.')),
    h('span.sc-kbd', 'R'));
  const grid = h('div.project-grid');
  const storage = h('button.storage', { title: 'Storage used by your projects', onclick: () => showStorage() });
  const recoverHost = h('div.recover-host');
  const warn = caps.webcodecs ? null : caps.realtime
    ? h('div.banner.warn', icon('info', 16), h('span', 'This browser is missing some fast video features (WebCodecs), so Slipstream uses a slower path: analysis takes longer and exports render in real time. Everything still stays on this device. Chrome, Edge and the desktop app are fastest.'), h('a.btn.small', { href: '../#download' }, 'Desktop app'))
    : h('div.banner.warn', icon('info', 16), h('span', 'This browser can’t decode or record video, so editing and export won’t work. Use a recent Chrome, Edge, Firefox or Safari, or the desktop app.'), h('a.btn.small', { href: '../#download' }, 'Get the desktop app'));

  const el = h('div.home',
    h('header.home-top',
      h('a.brand', { href: '../' }, h('img.brand-logo', { src: '../assets/brand/slipstream-logo-white.svg', alt: 'Slipstream', width: 141, height: 24 }), h('span.badge-web', 'Web')),
      h('nav.home-nav', h('a', { href: '../#features' }, 'Features'), h('a', { href: '../#download' }, 'Desktop app'), h('a', { href: 'https://github.com/tanzir71/slipstream-releases' }, 'GitHub'), storage)),
    warn,
    recoverHost,
    h('section.home-hero',
      h('h1', 'Record it once. It’s edited by the time you stop.'),
      h('p.lede', 'Slipstream zooms on your clicks, frames your camera, captions every word and trims the dead air, right here in your browser. Your footage never leaves this device.'),
      h('div.start-row', rec, drop, fileInput),
      caps.record ? h('div.start-extra', h('a.btn.small', { href: '#/host' }, icon('people', 14), 'Record with a guest'), h('a.btn.small.ghost', { href: '#/receive' }, icon('download', 14), 'Receive from another device'), h('span.muted.small', 'Direct between browsers, nothing uploaded.')) : null,
      desktop.available ? h('div.start-extra',
        h('button.btn.small', { onclick: async () => { const f = await desktop.openProjectFile().catch((err) => { toast(err.message, 'error'); return null; }); if (f) importFile(f); } }, icon('box', 14), 'Open project…'),
        h('button.btn.small.ghost', { onclick: () => openLegacyProject().catch((err) => toast(`Couldn’t open that project: ${err.message}`, 'error', 7000)) }, icon('file', 14), 'Open a Slipstream 1 project…'),
        h('button.btn.small.ghost', { onclick: () => checkForUpdates() }, icon('download', 14), 'Check for updates')) : null,
      h('ul.trust', [['lock', 'Footage stays on this device'], ['cpu', 'Speech-to-text on your GPU'], ['check', 'No account or watermark'], ['download', 'MP4, WebM, SRT and VTT']].map(([i, t]) => h('li', icon(i, 14), t)))),
    h('section.recent', h('div.recent-head', h('h2', 'Projects'), h('span.muted.small', 'Saved in this browser only')), grid));
  root.replaceChildren(el);

  const onDrop = (e) => { e.preventDefault(); document.body.classList.remove('dragging'); importFiles([...e.dataTransfer.files]); };
  const onOver = (e) => { e.preventDefault(); document.body.classList.add('dragging'); };
  const onLeave = (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); };
  const onKey = (e) => { if (e.key.toLowerCase() === 'r' && !e.target.closest('input,textarea') && caps.record) location.hash = '#/record'; };
  document.addEventListener('drop', onDrop);
  document.addEventListener('dragover', onOver);
  document.addEventListener('dragleave', onLeave);
  document.addEventListener('keydown', onKey);
  current = { cleanup() { document.removeEventListener('drop', onDrop); document.removeEventListener('dragover', onOver); document.removeEventListener('dragleave', onLeave); document.removeEventListener('keydown', onKey); } };

  const [projects, info] = await Promise.all([listProjects().catch(() => []), storageInfo()]);
  storage.replaceChildren(icon('file', 13), info.quota ? `${fmtBytes(info.usage)} used` : 'Storage');
  showRecoveries(recoverHost);
  if (!projects.length) {
    grid.replaceChildren(h('div.empty', h('img.empty-icon', { src: '../assets/brand/app-icon-128.png', alt: '', width: 56, height: 56 }), h('p', 'Your projects will appear here. Start a recording or drop in a video.')));
    return;
  }
  grid.replaceChildren(...projects.map((p) => h('article.project-card',
    h('a.pc-thumb', { href: `#/edit/${encodeURIComponent(p.id)}`, style: p.thumb ? { backgroundImage: `url(${p.thumb})` } : {} }, h('span.pc-dur', fmtTime(p.media?.duration || 0)), p.media?.camera ? h('span.pc-tag', icon('camera', 12)) : null),
    h('div.pc-meta',
      h('a.pc-name', { href: `#/edit/${encodeURIComponent(p.id)}` }, p.name),
      h('span.muted.small', new Date(p.updated || p.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))),
    h('button.icon-btn.pc-exp', { title: 'Export project (.slipstream)', 'aria-label': `Export ${p.name} as a .slipstream file`, onclick: () => exportProjectFile(p) }, icon('box', 15)),
    h('button.icon-btn.pc-send', { title: 'Send this project to another device', 'aria-label': `Send ${p.name} to another device`, onclick: async () => { const blob = await exportBundle(p).catch((err) => { toast(err.message, 'error'); return null; }); if (blob) sendToDeviceDialog(new File([blob], `${(p.name || 'project').slice(0, 60)}.slipstream`, { type: 'application/zip' }), `${(p.name || 'project').slice(0, 60)}.slipstream`, { kind: 'project' }); } }, icon('share', 15)),
    h('button.icon-btn.pc-del', { title: 'Delete project', 'aria-label': `Delete ${p.name}`, onclick: async () => { if (await confirmDialog('Delete project?', `“${p.name}” and its media will be removed from this browser.`)) { await deleteProject(p.id); showHome(); } } }, icon('trash', 15)))));
}

// ---- Guest sessions (S-06): the host's recording plus each guest as a synced camera angle ---------------
async function createGuestSession(res) {
  const busy = h('div.busy-overlay', h('div.busy-card', h('div.spinner'), h('p', 'Saving the session…')));
  document.body.append(busy);
  try {
    const guests = res.guests || [];
    const names = guests.map((g) => g.name).filter(Boolean);
    const cameraOnly = res.host.mode === 'camera' || !res.host.camera;
    // Screen + camera: the host's camera is the main camera layer. Camera only: the host's recording is the
    // main picture and the first guest becomes the camera layer, so the editor opens in an interview split.
    const camera = cameraOnly ? guests[0]?.file || null : res.host.camera;
    const cameraOffset = cameraOnly ? guests[0]?.startOffset || 0 : res.host.cameraOffset || 0;
    const name = names.length ? `Session with ${names.join(', ')}` : `Session ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    const p = await createProject({ name, screen: res.host.screen, camera, cameraOffset });
    const extra = cameraOnly ? guests.slice(1) : guests;
    const angles = camera ? [{ id: 'camera', name: cameraOnly ? (guests[0]?.name || 'Guest') : 'You', offset: cameraOffset }] : [];
    for (const g of extra) {
      const id = uid('ang');
      await putMedia(`${p.id}:angle-${id}`, g.file);
      angles.push({ id, name: g.name || 'Guest', offset: g.startOffset || 0, type: g.file.type });
    }
    p.media.angles = angles;
    if (cameraOnly && camera) p.edit.layout = { ...p.edit.layout, mode: 'split' };
    await saveProject(p);
    toast(`Saved: ${1 + guests.length} track${guests.length ? 's' : ''}, each recorded on its own device`, 'ok');
    location.hash = `#/edit/${encodeURIComponent(p.id)}`;
  } catch (err) {
    toast(`Couldn’t save the session: ${err.message}`, 'error', 8000);
  } finally {
    busy.remove();
  }
}

// ---- Project bundles (C-02, W-09) ---------------------------------------------------------------
async function exportProjectFile(p) {
  const body = h('div.stack');
  const m = modal('Export project', body);
  let planOnly = false;
  const go = h('button.btn.primary.wide', { onclick: async () => {
    go.disabled = true;
    const bar = h('div.bar', h('i'));
    const label = h('p.muted.small', 'Hashing media…');
    body.replaceChildren(label, bar);
    try {
      const blob = await exportBundle(p, { planOnly, onProgress: (pr) => { bar.firstChild.style.width = `${Math.round((pr.done / Math.max(1, pr.total)) * 100)}%`; label.textContent = pr.phase === 'zip' ? 'Packing…' : 'Hashing media…'; } });
      const name = `${(p.name || 'project').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}.slipstream`;
      const saved = await downloadBlob(blob, name);
      m.close();
      if (saved) toast(`Saved ${saved.name || name} (${fmtBytes(blob.size)})`, 'ok');
    } catch (err) {
      body.replaceChildren(h('p.warn', `Export failed: ${err.message}`));
    }
  } }, icon('download', 16), 'Export .slipstream');
  body.append(
    h('p.muted', 'A .slipstream file holds the edit plan, the recording and a thumbnail. Open it in Slipstream on another computer — web, macOS, Windows or Linux — to keep editing. It’s built on this device and never uploaded.'),
    toggle('Edit plan only (link to the original recording)', planOnly, (v) => { planOnly = v; }),
    h('p.muted.small', 'Plan-only files are tiny; whoever opens them picks the recording from their own disk, checked by size and SHA-256.'),
    go);
}

async function openBundleFile(file, { verify = true } = {}) {
  const busy = h('div.busy-overlay', h('div.busy-card', h('div.spinner'), h('p', `Opening ${file.name}…`)));
  document.body.append(busy);
  try {
    const b = await readBundle(file, { verify });
    let { screen, camera } = b.media;
    const clipFiles = { ...(b.clips || {}) };
    for (const ref of b.external) {
      const picked = await pickForRef(ref);
      if (!picked) throw new Error('The project needs its recording to open.');
      if (ref.role === 'clip') clipFiles[ref.id] = picked;
      else if (ref.role === 'camera') camera = picked; else screen = picked;
    }
    // Multi-clip projects (AE-01): every clip becomes project media; the plan's sequence opens as it was.
    if (b.clipList?.length) {
      const missing = b.clipList.filter((c) => !clipFiles[c.id]);
      if (missing.length) throw new Error(`This project is missing ${missing.length === 1 ? `the clip ${missing[0].name || missing[0].id}` : `${missing.length} clips`}.`);
      const p = await createClipsProject({ name: b.name, files: b.clipList.map((c) => clipFiles[c.id]), clipIds: b.clipList.map((c) => c.id), photoSeconds: b.clipList.map((c) => c.duration), edit: b.edit });
      for (const [key, blob] of Object.entries(b.assets || {})) {
        await putMedia(`${p.id}:${key}`, blob);
        if (key === 'logo') { p.media.logo = true; p.media.logoType = blob.type; }
        if (key === 'intro' || key === 'outro') { p.media[key] = true; p.media[`${key}Type`] = blob.type; }
        if (key === 'music' && p.edit.music) p.edit.music.type = blob.type || p.edit.music.type;
      }
      for (const it of p.edit.broll || []) if (b.assets?.[`broll-${it.id}`]) it.type = b.assets[`broll-${it.id}`].type;
      await saveProject(p);
      toast(`Opened “${b.name}”`, 'ok');
      location.hash = `#/edit/${encodeURIComponent(p.id)}`;
      return;
    }
    if (!screen) throw new Error('This project has no screen recording.');
    // Desktop app: recordings this webview can't decode (HEVC/ProRes from a Mac, …) get preview copies.
    busy.hidden = true;
    const ps = await desktopPreview(screen, null, 'recording');
    const pc = ps && camera ? await desktopPreview(camera, null, 'camera recording') : null;
    const anglePreviews = {};
    for (const [key, blob] of Object.entries(b.assets || {})) {
      if (!ps || (camera && !pc) || !key.startsWith('angle-')) continue;
      const pa = await desktopPreview(blob, null, 'camera angle');
      if (!pa) return; // cancelled
      if (pa.original) anglePreviews[key] = pa;
    }
    busy.hidden = false;
    if (!ps || (camera && !pc)) return;
    const p = await createProject({ name: b.name, screen: ps.preview, camera: pc?.preview || null, cameraOffset: b.cameraOffset, edit: b.edit, cursor: takeCursorSamples(b.edit) });
    if (ps.original) await keepOriginal(p, ps.original, 'screen');
    if (pc?.original) await keepOriginal(p, pc.original, 'camera');
    // Extra assets travel with the bundle: camera angles, B-roll and the logo.
    let changed = false;
    const angleOriginals = {};
    for (const [key, blob] of Object.entries(b.assets || {})) {
      const pa = anglePreviews[key];
      if (pa) {
        // An angle with a preview copy: the copy plays in the editor, the original is what exports and bundles use.
        await putMedia(`${p.id}:${key}-original`, blob);
        await putMedia(`${p.id}:${key}`, pa.preview);
        angleOriginals[key.slice('angle-'.length)] = originalRecord(pa.original);
        continue;
      }
      await putMedia(`${p.id}:${key}`, blob);
      if (key === 'logo') { p.media.logo = true; p.media.logoType = blob.type; changed = true; }
      if (key === 'intro' || key === 'outro') { p.media[key] = true; p.media[`${key}Type`] = blob.type; changed = true; }
      if (key === 'music' && p.edit.music) { p.edit.music.type = blob.type || p.edit.music.type; changed = true; }
    }
    if (b.angles?.length) {
      p.media.angles = b.angles.filter((a) => a.id === 'camera' || b.assets?.[`angle-${a.id}`]).map((a) => angleOriginals[a.id]
        ? { ...a, type: 'video/mp4', original: angleOriginals[a.id] }
        : { ...a, type: b.assets?.[`angle-${a.id}`]?.type || a.type });
      changed = true;
    }
    for (const it of p.edit.broll || []) if (b.assets?.[`broll-${it.id}`]) it.type = b.assets[`broll-${it.id}`].type;
    if (changed || p.edit.broll?.length) await saveProject(p);
    toast(`Opened “${b.name}”`, 'ok');
    location.hash = `#/edit/${encodeURIComponent(p.id)}`;
  } catch (err) {
    if (err instanceof BundleError && verify && err.problems?.some((x) => x.kind === 'hash-mismatch' || x.kind === 'missing')) {
      busy.remove();
      const list = err.problems.map((x) => `${x.path || x.role}: ${x.kind === 'missing' ? 'missing' : 'contents changed'}`).join(', ');
      if (await confirmDialog('This project failed its integrity check', `${list}. The file may be damaged or edited by another tool. Open it anyway?`, 'Open anyway')) return openBundleFile(file, { verify: false });
      return;
    }
    toast(`Couldn’t open ${file.name}: ${err.message}`, 'error', 7000);
  } finally {
    busy.remove();
  }
}

/** Plan-only bundles reference media by name, size and hash; ask for the file and check it. */
function pickForRef(ref) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'video/*,audio/*', hidden: true });
    const status = h('p.muted.small');
    const m = modal('Find the recording', [
      h('p.muted', `This project links to “${(ref.path || '').split('/').pop() || ref.role}”${ref.size ? ` (${fmtBytes(ref.size)})` : ''}. Choose that file on this computer.`),
      status,
      h('div.row.end', h('button.btn', { onclick: () => { m.close(); } }, 'Cancel'), h('button.btn.primary', { onclick: () => input.click() }, 'Choose file…')), input,
    ], { onClose: () => resolve(null) });
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      status.textContent = 'Checking…';
      const ok = await matchesRef(f, ref, (pr) => { status.textContent = `Checking… ${Math.round((pr.done / Math.max(1, pr.total)) * 100)}%`; }).catch(() => false);
      if (!ok && !(await confirmDialog('That file doesn’t match', 'Its size or SHA-256 differs from the one this project was edited with, so cuts may land in the wrong places. Use it anyway?', 'Use it'))) { status.textContent = 'Choose another file.'; return; }
      resolve(f);
      m.close();
    };
  });
}

/**
 * Mix a file's audio tracks into one when it has several (see mixAudioTracks), streaming the result to the
 * project's OPFS folder as `screen` when OPFS is available. Returns { screen, written } (written: already stored).
 */
async function mixedScreen(id, screen, onProgress) {
  const opfs = await opfsSupported();
  let ws = null;
  const sink = opfs ? { open: async () => (ws = await positionalWriter(['projects', id], 'screen')), read: (type) => readFile(['projects', id], 'screen', type) } : null;
  const mixed = await mixAudioTracks(screen, { sink, onProgress });
  if (!mixed) { await ws?.release(); return { screen, written: false }; }
  // Keep the name the user knows (OPFS files are just called "screen").
  const named = mixed instanceof File && mixed.name === (screen.name || mixed.name) ? mixed : new File([mixed], screen.name || 'screen.mp4', { type: mixed.type });
  return { screen: named, written: opfs };
}

async function createProject({ id = uid('p'), name, screen, camera = null, cameraOffset = 0, stored = false, edit: givenEdit = null, cursor = null, onProgress = () => {} }) {
  let screenWritten = false;
  if (!stored) ({ screen, written: screenWritten } = await mixedScreen(id, screen, onProgress));
  const info = await probe(screen);
  if (!info.duration || !Number.isFinite(info.duration)) throw new Error('Could not read the duration of this file.');
  if (info.hasVideo && !info.canDecodeVideo && !info.canPlayElement) throw new Error(`This browser can’t decode ${info.videoCodec || 'this video codec'}. Try Chrome or Edge, or convert to MP4 (H.264).`);
  const edit = givenEdit ? { ...defaultEdit(), ...givenEdit } : defaultEdit();
  if (!givenEdit) {
    if (!camera) edit.layout.mode = 'screen';
    if (!info.hasVideo) { edit.style.bg = 'dusk'; edit.captions.position = 'middle'; edit.captions.preset = 'editorial'; edit.captions.size = 1.25; }
  }
  const project = {
    id, name, created: Date.now(),
    media: {
      duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio, hasVideo: info.hasVideo, camera: !!camera, cameraOffset, audioChannels: info.audioChannels || 0,
      screenType: screen.type || '', cameraType: camera?.type || '', screenName: screen.name || '', cameraName: camera?.name || '', compat: !!info.compat,
      // Pointer samples and clicks from the desktop app's recorder (T-04): recorded data like the media, so they stay
      // out of the undoable edit; planFor() carries them into the edit plan's `cursor`.
      ...(cursor?.samples?.length ? { cursor } : {}),
    },
    thumb: info.hasVideo ? await thumbnail(screen, Math.min(1.5, info.duration / 3)) : null,
    edit,
    // Run the automatic edit (zooms, transcript, fillers, pauses, captions) the first time it opens.
    autoPolish: !givenEdit,
  };
  if (!stored) {
    if (!screenWritten) await putMedia(`${id}:screen`, screen);
    if (camera) await putMedia(`${id}:camera`, camera);
  }
  await saveProject(project);
  requestPersistence();
  return project;
}

// ---- Multi-clip projects (AE-01) ----------------------------------------------------------------------
const PHOTO_SECONDS = 3;
const isPhotoFile = (f) => /^image\//.test(f.type || '') || /\.(png|jpe?g|webp|gif|avif)$/i.test(f.name || '');

/** Several files at once make one project with a clip each; one file keeps the usual single-recording path. */
async function importFiles(files) {
  files = files.filter(Boolean);
  if (!files.length) return;
  const bundle = files.find((f) => isBundleFile(f));
  if (files.length === 1 || bundle) {
    if (bundle && files.length > 1) toast('Opening the project file only. Import videos and photos on their own.', 'info', 5000);
    return importFile(bundle || files[0]);
  }
  const busy = h('div.busy-overlay', h('div.busy-card', h('div.spinner'), h('p', `Opening ${files.length} files…`)));
  document.body.append(busy);
  try {
    const p = await createClipsProject({ name: `${files[0].name.replace(/\.[^.]+$/, '')} and ${files.length - 1} more`, files, onProgress: (i) => { busy.querySelector('p').textContent = `Opening ${files[i].name} (${i + 1} of ${files.length})…`; } });
    location.hash = `#/edit/${encodeURIComponent(p.id)}`;
  } catch (err) {
    toast(err.message, 'error', 7000);
  } finally {
    busy.remove();
  }
}

/** First frame of a photo or video as a JPEG data URL, for the project card. */
async function clipThumb(file, clip) {
  if (clip.kind === 'photo') {
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) return null;
    const c = document.createElement('canvas');
    c.width = 480; c.height = Math.round((480 * bmp.height) / Math.max(1, bmp.width));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.72);
  }
  return clip.hasVideo ? thumbnail(file, Math.min(1.5, (clip.duration || 0) / 3)) : null;
}

/**
 * A multi-clip project: each file is a clip (`<id>:clip-<clipId>` in storage, project.media.clips) and
 * edit.segments plays them end to end in the order given. Photos hold for PHOTO_SECONDS. Opened from a bundle,
 * `edit` (with its own segments) and `clipIds` come from the plan.
 */
async function createClipsProject({ id = uid('p'), name, files, clipIds = null, photoSeconds = null, edit: givenEdit = null, onProgress = () => {} }) {
  const clips = [];
  for (const [i, file] of files.entries()) {
    onProgress(i);
    const cid = clipIds?.[i] || `c${i + 1}`;
    if (isPhotoFile(file)) {
      const bmp = await createImageBitmap(file).catch(() => null);
      if (!bmp) throw new Error(`Couldn’t read the image ${file.name}.`);
      clips.push({ id: cid, kind: 'photo', name: file.name || `${cid}.jpg`, type: file.type || 'image/jpeg', width: bmp.width, height: bmp.height, hasAudio: false, hasVideo: true });
      bmp.close?.();
    } else {
      const info = await probe(file);
      if (!info.duration || !Number.isFinite(info.duration)) throw new Error(`Could not read the duration of ${file.name}.`);
      if (info.hasVideo && !info.canDecodeVideo && !info.canPlayElement) throw new Error(`This browser can’t decode ${file.name} (${info.videoCodec || 'its video codec'}). Try Chrome or Edge, or convert it to MP4 (H.264).`);
      clips.push({ id: cid, kind: info.hasVideo ? 'video' : 'audio', name: file.name || `${cid}.mp4`, type: file.type || '', duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio, hasVideo: info.hasVideo, audioChannels: info.audioChannels || 0, ...(info.compat ? { compat: true } : {}) });
    }
  }
  let edit;
  if (givenEdit) edit = { ...defaultEdit(), ...givenEdit };
  else {
    edit = defaultEdit();
    edit.layout.mode = 'screen';
    let t = 0;
    edit.segments = clips.map((c, i) => {
      const len = c.kind === 'photo' ? (Number(photoSeconds?.[i]) > 0 ? Number(photoSeconds[i]) : PHOTO_SECONDS) : c.duration;
      const s = { id: `s${i + 1}`, asset: c.id, sourceIn: 0, start: Math.round(t * 1e6) / 1e6, end: Math.round((t + len) * 1e6) / 1e6 };
      t += len;
      return s;
    });
  }
  const segs = (edit.segments || []).filter((s) => s && s.asset);
  const duration = segs.reduce((m, s) => Math.max(m, s.end), 0);
  const visual = clips.find((c) => c.hasVideo) || clips[0];
  const project = {
    id, name, created: Date.now(),
    media: {
      duration, width: visual.width || 0, height: visual.height || 0,
      hasAudio: clips.some((c) => c.hasAudio), hasVideo: clips.some((c) => c.hasVideo), camera: false, cameraOffset: 0,
      audioChannels: Math.max(0, ...clips.map((c) => c.audioChannels || 0)),
      screenType: clips[0].type, cameraType: '', screenName: clips[0].name, cameraName: '', compat: clips.some((c) => c.compat),
      clips,
    },
    thumb: await clipThumb(files[clips.indexOf(visual)], visual).catch(() => null),
    edit,
    autoPolish: !givenEdit,
  };
  for (const [i, file] of files.entries()) await putMedia(`${id}:clip-${clips[i].id}`, file);
  await saveProject(project);
  requestPersistence();
  return project;
}

/** Desktop app: import through the native open dialog (keeps the path). */
async function pickAndImport() {
  const info = await desktop.pickFile({ filters: [{ name: 'Video, audio or Slipstream project', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'm4a', 'mp3', 'wav', 'slipstream'] }], title: 'Import a video' }).catch((err) => { toast(err.message, 'error'); return null; });
  if (!info) return;
  try {
    await importFile(await desktop.readFile(info), { path: info.path });
  } catch (err) {
    toast(`Couldn’t open ${info.name || 'that file'}: ${err.message}`, 'error', 7000);
  }
}

/** opts.path: where the file is on disk (desktop app: opened with the app or picked), for its v1 cursor track. */
async function importFile(file, { path = null } = {}) {
  if (isBundleFile(file)) return openBundleFile(file);
  let prepared;
  try {
    prepared = await desktopPreview(file, path, 'recording');
  } catch (err) {
    toast(`Couldn’t make a preview copy of ${file.name}: ${err.message}`, 'error', 8000);
    return;
  }
  if (!prepared) return; // cancelled
  const busy = h('div.busy-overlay', h('div.busy-card', h('div.spinner'), h('p', `Opening ${file.name}…`)));
  document.body.append(busy);
  try {
    const cursor = desktop.available && path ? await v1CursorTrack(path) : null;
    const p = await createProject({ name: file.name.replace(/\.[^.]+$/, ''), screen: prepared.preview, cursor });
    if (prepared.original) await keepOriginal(p, prepared.original, 'screen');
    location.hash = `#/edit/${encodeURIComponent(p.id)}`;
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    busy.remove();
  }
}

/** A Slipstream 1 Windows recording's pointer track (`<video>.cursor.json` beside it), as project cursor samples. */
async function v1CursorTrack(path) {
  const r = await desktop.cursorSidecar(path).catch(() => null);
  return r?.found && r.samples?.length ? { samples: r.samples, source: r.source || 'v1-sidecar' } : null;
}

// ---- Editor -----------------------------------------------------------------------------------
async function showEditor(id) {
  root.replaceChildren(h('div.loading', h('div.spinner'), h('p', 'Opening project…')));
  const project = await getProject(id);
  if (!project) { toast('Project not found in this browser', 'error'); location.hash = '#/'; return; }
  // Multi-clip projects (AE-01) have no screen recording of their own: the first clip stands in (the editor loads the rest).
  const screenKey = project.media.clips?.length ? `${id}:clip-${project.media.clips[0].id}` : `${id}:screen`;
  const [screen, camera] = await Promise.all([getMedia(screenKey, project.media.screenType), project.media.camera ? getMedia(`${id}:camera`, project.media.cameraType) : null]);
  if (!screen) { toast('Media for this project is missing', 'error'); location.hash = '#/'; return; }
  // Projects written by another surface may only carry the v2 plan (C-01).
  if (!project.edit && project.plan) {
    project.edit = fromV2(project.plan).edit;
    const cursor = takeCursorSamples(project.edit);
    if (cursor && !project.media.cursor) project.media.cursor = cursor;
  }
  project.edit = { ...defaultEdit(), ...project.edit };
  const ed = await openEditor(root, project, { screen, camera }, { onExit: () => { location.hash = '#/'; } });
  current = { cleanup() { /* editor cleans up on exit */ } };
  window.__slipstreamEditor = ed;
}

// ---- Recorder (W-11 web, T-11 Windows/Linux): the card, pill, pickers and overlays live in rec-ui.js ---------------
function showRecorder() {
  const caps = capabilities();
  if (!caps.record) { toast('Screen recording is not available in this browser', 'error'); location.hash = '#/'; return; }
  const rec = mountRecorder(root, {
    onTake: saveTake,
    onExit: () => { location.hash = '#/'; },
    startCursor,
    stopCursor,
    hold: (id) => { holdRecordingLock(id); window.addEventListener('beforeunload', warnUnload); },
    release: () => endRecordingGuards(),
  });
  recorderToggle = () => rec.toggle();
  current = { cleanup() { recorderToggle = null; rec.cleanup(); } };
}

/**
 * A finished take becomes a project: the recording (already on disk when OPFS is available), the camera layer, the
 * pointer samples, an Area take's source crop and "camera off" stretches as screen-only scenes. Then the editor opens
 * and auto-polish runs.
 */
async function saveTake({ pid, backend, res, cursor, mode, crop, cameraOff }) {
  const busy = h('div.busy-overlay', h('div.busy-card', h('div.spinner'), h('p', 'Saving recording…')));
  document.body.append(busy);
  try {
    const ext = res.screen.type.includes('mp4') ? 'mp4' : 'webm';
    const screen = res.stored ? res.screen : new File([res.screen], `screen.${ext}`, { type: res.screen.type });
    const when = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const p = await createProject({ id: pid, name: `${mode === 'camera' ? 'Camera recording' : 'Recording'} ${when}`, screen, camera: res.camera, cameraOffset: res.cameraOffset, stored: res.stored, cursor });
    let changed = false;
    if (crop) { p.edit = applySourceCrop(p.edit, crop); changed = true; }
    // Camera only: the camera is the picture, edge to edge (no wallpaper border, corners or shadow).
    if (mode === 'camera') { p.edit.style = { ...p.edit.style, padding: 0, radius: 0, shadow: 0 }; p.edit.layout = { ...p.edit.layout, fit: 'cover' }; p.media.cameraOnly = true; changed = true; }
    if (res.camera && cameraOff?.length) {
      p.edit.scenes = cameraOff.reduce((sc, r) => setScene(sc, r.start, r.end, { mode: 'screen' }), p.edit.scenes || []);
      changed = true;
    }
    if (changed) await saveProject(p);
    if (backend === 'idb') await deleteChunks(pid).catch(() => {});
    await deleteJournal(pid).catch(() => {});
    endRecordingGuards();
    location.hash = `#/edit/${encodeURIComponent(p.id)}`;
  } finally {
    busy.remove();
  }
}

// ---- Cursor samples (desktop app, T-04) ------------------------------------------------------------
/** Start sampling the pointer for a take. Returns { origin, started }; `started` resolves { supported, reason? } or null. */
function startCursor(display) {
  const s = display.getVideoTracks()[0]?.getSettings?.() || {};
  const origin = performance.now(); // the shell's t = 0 is just after this
  const started = desktop.cursor.start({ width: s.width, height: s.height, displaySurface: s.displaySurface }).catch(() => null);
  return { origin, started };
}

/** Stop sampling and return { samples, source: 'desktop' } on the screen file's timeline, or null (no data). */
async function stopCursor(handle, timeline, duration) {
  if (!handle) return null;
  try {
    const started = await handle.started;
    if (!started?.supported) return null;
    const res = await desktop.cursor.stop();
    if (!res?.supported || !res.samples?.length) return null;
    const samples = compactCursorSamples(alignCursor(res.samples, { origin: handle.origin, ...timeline, duration }));
    return samples.length ? { samples, source: 'desktop' } : null;
  } catch {
    return null; // never lose a take over cursor data
  }
}

/** Plans carry cursor samples inline (edit plan v2 `cursor.samples`); in the web app they live on project.media. */
function takeCursorSamples(edit) {
  const c = edit?.cursor;
  if (!c || typeof c !== 'object' || !Array.isArray(c.samples)) return null;
  const { samples, source, ...settings } = c;
  if (Object.keys(settings).length) edit.cursor = settings; else delete edit.cursor;
  return samples.length ? { samples, source: typeof source === 'string' ? source : 'plan' } : null;
}

// ---- Recording guards and crash recovery (W-02) ----------------------------------------------------
let releaseLock = null;
function warnUnload(e) { e.preventDefault(); e.returnValue = ''; }
/** Hold a Web Lock for the take so other tabs don't offer to "recover" a recording that is still running. */
function holdRecordingLock(id) {
  if (!navigator.locks?.request) return;
  navigator.locks.request(`slipstream-rec-${id}`, () => new Promise((resolve) => { releaseLock = resolve; })).catch(() => {});
}
function endRecordingGuards() {
  window.removeEventListener('beforeunload', warnUnload);
  releaseLock?.();
  releaseLock = null;
  if (desktop.available) {
    desktop.setRecording(false).catch(() => {});
    desktop.teleprompter.close().catch(() => {});
  }
}
async function activeRecordingIds() {
  try { return new Set(((await navigator.locks?.query?.())?.held || []).map((l) => l.name.replace(/^slipstream-rec-/, ''))); } catch { return new Set(); }
}

async function showRecoveries(host) {
  const [journals, active] = await Promise.all([listJournals(), activeRecordingIds()]);
  const lost = journals.filter((j) => !active.has(j.id));
  host.replaceChildren(...lost.map((j) => {
    const when = new Date(j.started).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const label = h('span', h('b', 'A recording didn’t finish. '), `Started ${when}${j.elapsed ? `, about ${fmtTime(j.elapsed)} long` : ''}. Everything up to the last second was saved on this device.`);
    const recover = h('button.btn.small.primary', { onclick: async () => {
      recover.disabled = true; drop.disabled = true;
      recover.textContent = 'Repairing…';
      try {
        const media = await repairRecording(j, (p) => { recover.textContent = `Repairing… ${Math.round(p * 100)}%`; });
        const p = await createProject({ id: j.id, name: `Recovered recording ${when}`, screen: media.screen, camera: media.camera, cameraOffset: media.cameraOffset, stored: media.stored });
        await deleteJournal(j.id);
        toast('Recording recovered', 'ok');
        location.hash = `#/edit/${encodeURIComponent(p.id)}`;
      } catch (err) {
        toast(`Couldn’t recover it: ${err.message}`, 'error', 7000);
        recover.disabled = false; drop.disabled = false; recover.textContent = 'Recover recording';
      }
    } }, 'Recover recording');
    const drop = h('button.btn.small.ghost', { onclick: async () => {
      if (!(await confirmDialog('Discard this recording?', 'The unfinished take will be deleted from this device.', 'Discard'))) return;
      await deleteJournal(j.id);
      await (j.backend === 'idb' ? deleteChunks(j.id) : removeMediaDir(j.id)).catch(() => {});
      showRecoveries(host);
    } }, 'Discard');
    return h('div.banner.recover', icon('record', 16), label, recover, drop);
  }));
}

// ---- Storage (W-01) -------------------------------------------------------------------------------
async function showStorage() {
  const body = h('div.stack', h('p.muted', 'Loading…'));
  const m = modal('Storage on this device', body, { wide: true });
  const render = async () => {
    const [info, projects, orphans] = await Promise.all([storageInfo(), listProjects(), orphanMedia()]);
    const sizes = await Promise.all(projects.map((p) => projectSize(p.id).catch(() => 0)));
    const total = sizes.reduce((a, b) => a + b, 0);
    const persistBtn = info.persisted ? null : h('button.btn.small', { onclick: async () => { const ok = await requestPersistence(); toast(ok ? 'Projects won’t be cleared when space runs low' : 'The browser declined — export projects you want to keep', ok ? 'ok' : 'info'); render(); } }, 'Keep projects when space is low');
    fill(body,
      h('div.storage-summary',
        h('div', h('b', fmtBytes(total)), h('span', 'projects')),
        h('div', h('b', info.quota ? fmtBytes(info.usage) : '—'), h('span', 'all site data')),
        h('div', h('b', info.quota ? fmtBytes(Math.max(0, info.quota - info.usage)) : '—'), h('span', 'available'))),
      h('p.muted.small', icon('lock', 12), `${info.opfs ? 'Media is stored as files in this browser’s private file system.' : 'Media is stored in this browser’s database.'} ${info.persisted ? 'Storage is persistent: the browser won’t clear it on its own.' : 'The browser may clear it if your disk gets full.'}`),
      persistBtn,
      projects.length ? h('ul.storage-list', projects.map((p, i) => h('li',
        h('span.sl-name', p.name), h('span.sl-meta', `${fmtTime(p.media?.duration || 0)} · ${fmtBytes(sizes[i])}`),
        h('button.icon-btn', { title: `Delete ${p.name}`, 'aria-label': `Delete ${p.name}`, onclick: async () => { if (await confirmDialog('Delete project?', `“${p.name}” and its media will be removed from this browser.`)) { await deleteProject(p.id); render(); if (location.hash === '' || location.hash === '#/') showHome(); } } }, icon('trash', 15))))) : h('p.muted', 'No projects yet.'),
      orphans.length ? h('div.row.between', h('span.muted.small', `${orphans.length} leftover media folder${orphans.length > 1 ? 's' : ''} from unfinished sessions`), h('button.btn.small', { onclick: async () => { for (const id of orphans) await removeMediaDir(id).catch(() => {}); render(); } }, 'Clean up')) : null);
  };
  render().catch((err) => body.replaceChildren(h('p.warn', `Couldn’t read storage: ${err.message}`)));
  return m;
}

// ---- Desktop app (T-07): files opened with the app, Slipstream 1 projects, recorder shortcut, updates ---------------
// In a browser `desktop.available` is false and none of this runs.
let recorderToggle = null;

async function openDesktopFiles(list) {
  for (const info of list || []) {
    const ext = String(info.name || info.path).split('.').pop().toLowerCase();
    try {
      if (ext === 'slipproj' || ext === 'reelproj') await openLegacyProject(info);
      else await importFile(await desktop.readFile(info), { path: info.path });
    } catch (err) {
      toast(`Couldn’t open ${info.name || 'that file'}: ${err.message}`, 'error', 7000);
    }
  }
}

/** Slipstream 1 projects (.slipproj / .reelproj): the engine migrates the plan, then the recordings are copied in. */
async function openLegacyProject(target) {
  const res = await desktop.openLegacyProject(target);
  if (!res) return;
  const busy = h('div.busy-overlay', h('div.busy-card', h('div.spinner'), h('p', 'Opening your Slipstream 1 project…')));
  document.body.append(busy);
  try {
    const base = (x) => String(x || '').split(/[\\/]/).pop();
    const find = (role) => { const want = base(res.plan?.sources?.[role]?.path); return want ? res.media.find((m) => base(m.path) === want || m.name === want) : null; };
    const screenInfo = find('screen') || res.media[0];
    if (!screenInfo) throw new Error(`its recording wasn’t found${res.missing?.length ? ` (${res.missing.map(base).join(', ')})` : ''}`);
    const cameraInfo = find('camera');
    const [original, camera] = await Promise.all([desktop.readFile(screenInfo), cameraInfo && cameraInfo !== screenInfo ? desktop.readFile(cameraInfo) : null]);
    busy.hidden = true;
    const prepared = await desktopPreview(original, screenInfo.path, 'recording');
    const cam = prepared && camera ? await desktopPreview(camera, cameraInfo.path, 'camera recording') : null;
    busy.hidden = false;
    if (!prepared || (camera && !cam)) return;
    const { edit, media } = fromV2(res.plan);
    const name = res.plan?.meta?.title || base(target?.path || target).replace(/\.[^.]+$/, '') || 'Slipstream 1 project';
    const cursor = takeCursorSamples(edit) || (await v1CursorTrack(screenInfo.path));
    const p = await createProject({ name, screen: prepared.preview, camera: cam?.preview || null, cameraOffset: media.cameraOffset || 0, edit, cursor });
    if (prepared.original) await keepOriginal(p, prepared.original, 'screen');
    if (cam?.original) await keepOriginal(p, cam.original, 'camera');
    if (res.missing?.length) toast(`Opened without ${res.missing.map(base).join(', ')} (not found)`, 'info', 7000);
    location.hash = `#/edit/${encodeURIComponent(p.id)}`;
  } finally {
    busy.remove();
  }
}

/** Only runs when the user asks (tray or Settings): the update check is a request to GitHub. */
async function checkForUpdates() {
  try {
    const u = await desktop.updater.check();
    if (u && u.configured === false) { toast(u.reason || 'Updates aren’t set up for this build', 'info', 7000); return; }
    if (!u || !u.available) { toast('Slipstream is up to date', 'ok'); return; }
    const ver = u.version ? ` ${u.version}` : '';
    const size = u.size ? ` (${fmtBytes(u.size)})` : '';
    if (!(await confirmDialog(`Update to Slipstream${ver}?`, `${u.notes ? `${String(u.notes).slice(0, 300)} ` : ''}The download${size} is signature-checked, installed, and the app restarts.`, 'Update and restart'))) return;
    const bar = h('div.bar', h('i'));
    const m = modal('Updating Slipstream', h('div.stack', h('p.muted', 'Downloading the update…'), bar));
    await desktop.updater.install((e) => { if (e?.total) bar.firstChild.style.width = `${Math.round((e.downloaded / e.total) * 100)}%`; });
    m.close();
  } catch (err) {
    toast(`Couldn’t check for updates: ${err.message}`, 'error', 7000);
  }
}

if (desktop.available) {
  globalThis.slipstreamDesktop = desktop; // cloud.js sends BYO-key requests through the native layer (no CORS)
  document.documentElement.dataset.desktop = desktop.platform || '';
  desktop.onOpenFiles((list) => openDesktopFiles(list));
  desktop.tray.onAction((a) => { if (a?.action === 'check-updates') checkForUpdates(); });
  desktop.globalShortcut.onToggle(() => {
    if (recorderToggle) recorderToggle();
    else { desktop.window.focus().catch(() => {}); location.hash = '#/record'; }
  });
}

route();
