// Slipstream Web editor: transcript editing, preview, timeline, inspector, export.
import { h, $, $$, icon, fmtTime, fmtBytes, toast, modal, segmented, slider, toggle, debounce, fill } from './ui.js';
import {
  computeCuts, keptRanges, totalDuration, srcToOut, cutAt, markFillers, detectWordSilences, detectPeakSilences,
  wordIndexAt, uid, ASPECTS, outputSize, mergeRanges, findRange,
} from './edl.js';
import { detectRetakes, applyRetakes } from '../../packages/editor-core/src/edl.js';
import { exportNLE } from '../../packages/editor-core/src/nle.js';
import { copilotPanel } from './copilot.js';
import { diarize, DIARIZE_MODEL, assignSpeakers, defaultSpeakers, renameSpeaker, speakerColor } from './diarize.js';
import { translateCues, translationModel, translationTargets, TRANSLATION_LANGS } from './translate.js';
import { buildCues, CAPTION_PRESETS, resolvePreset, ensureCaptionFonts, remapCues, toSRT, toVTT, parseSubtitles, cuesToWords } from './captions.js';
import { WALLPAPERS, resolveBackground, wallpaperURL, onWallpaperReady, loadWallpaper } from './wallpapers.js';
import { renderFrame, canvasPointToSource, screenMapping, BACKGROUNDS, dimsOf, usesCamera } from './compositor.js';
import { activeAt, maskRectAt, rectFromDrag, moveRect, resizeRect, hitTest, newMask, newAnnotation, overlayRange, ANNOTATION_COLOR } from '../../packages/editor-core/src/overlays.js';
import { speechIntervals, musicGainAt, musicSourceTime, musicSettings } from '../../packages/editor-core/src/music.js';
import { musicProvider, generateMusic } from './cloud.js';
import { analyzeAudio, activityEvents, PEAKS_PER_SEC, MB, probe } from './media.js';
import { audioOffset } from '../../packages/editor-core/src/sync.js';
import { integratedLoudness, normalizationGain, keptPcm } from '../../packages/editor-core/src/loudness.js';
import { mediaProvider, generateMedia, PROVIDERS } from './cloud.js';
import { openCloudSettings } from './cloud-settings.js';
import { shareButton } from './storage-share.js';
import { sendToDeviceDialog } from './guest.js';
import { autoScenes, setScene, sceneAt, layoutAt, speakerScenes } from '../../packages/editor-core/src/scenes.js';
import { scoreClips, frameQuality, pickThumbnails } from '../../packages/editor-core/src/clips.js';
import { outToSrc } from './edl.js';
import { webcodecsVideo } from './media-compat.js';
import { realtimeMime } from './exporter-realtime.js';
import { zoomsFromActivity, zoomsFromCursor, hasCursorClicks } from './autozoom.js';
import { publishKit, chaptersText } from './publish.js';
import { transcribe, MODELS } from './transcribe.js';
import { exportVideo, downloadBlob, pickCodecs, primeExportAudio } from './exporter.js';
import { saveProject, putMedia, getMedia, getSetting, setSetting } from './store.js';
import { planFor, exportBrand, readBrand } from './projects-io.js';
import desktop from './desktop-bridge.js';
import { desktopPreview, originalRecord } from './preview-copy.js';

const LANGS = [['auto', 'Detect language'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['ar', 'Arabic'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ru', 'Russian'], ['tr', 'Turkish'], ['id', 'Indonesian']];

const TOOL_LABEL = { blur: 'Blur', pixelate: 'Pixelate', solid: 'Solid', arrow: 'Arrow', box: 'Box', highlight: 'Highlight', text: 'Text' };

export async function openEditor(root, project, media, { onExit }) {
  const S = {
    project,
    edit: project.edit,
    duration: project.media.duration,
    screenBlob: media.screen,
    camBlob: media.camera,
    camOffset: project.media.cameraOffset || 0,
    hasAudio: project.media.hasAudio,
    peaks: project.peaks || null,
    pcm: null,
    cuts: [], kept: [], cues: [],
    playing: false, t: 0, dirty: true,
    wsel: null, sel: null, selZoom: null, selCut: null,
    focusPick: false,
    undo: [], redo: [],
    pps: 0, fitPps: 0,
    destroyed: false,
    job: null,
    polish: null,
    activity: project.activity || null,
    selScene: null,
    logoBmp: null,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    copilot: {},
    proposed: null,
    brollMedia: {}, // itemId -> Blob (B-roll assets, S-04)
    brollEls: {},   // itemId -> ImageBitmap | HTMLVideoElement for the preview
    selBroll: null,
    bumpers: { intro: null, outro: null }, // brand intro/outro clips (S-02)
    gen: null,      // running B-roll generation { ctrl, status }
    selOverlay: null, // { list: 'masks' | 'annotations', id } (T-03/T-05)
    drawTool: null,   // { list: 'masks', mode } | { list: 'annotations', kind } while drawing on the preview
    draft: null,      // { a, b } source-fraction points of the shape being drawn
    suppressClick: false,
    musicBlob: null,  // edit.music's audio (S-04)
    musicEl: null,    // <audio> that plays it in the preview, following output time
    musicSpeech: [],  // speech on the output timeline, for ducking
  };
  ensureEditShape(S.edit);

  // ---- media elements ------------------------------------------------------------------------
  const screenURL = URL.createObjectURL(S.screenBlob);
  const camURL = S.camBlob ? URL.createObjectURL(S.camBlob) : null;
  const screenEl = h('video', { src: screenURL, preload: 'auto', playsInline: true });
  const camEl = camURL ? h('video', { src: camURL, preload: 'auto', playsInline: true, muted: true }) : null;
  const mediaBox = h('div.hidden-media', { 'aria-hidden': 'true' }, screenEl, camEl);
  // Camera angles (S-03): the project's camera plus extra angles (other cameras, remote guests), each with
  // its own start offset. The layout (global or per scene) picks which one is shown.
  S.angles = camEl ? [{ id: 'camera', name: (project.media.angles || []).find((a) => a.id === 'camera')?.name || 'Camera', get offset() { return S.camOffset; }, set offset(v) { S.camOffset = v; }, el: camEl, blob: S.camBlob, speaker: (project.media.angles || []).find((a) => a.id === 'camera')?.speaker }] : [];
  const activeAngle = (t) => { const want = layoutAt(S.edit, t).angle; return S.angles.find((a) => a.id === want) || S.angles[0] || null; };
  const hasVideo = project.media.hasVideo;

  // ---- layout ----------------------------------------------------------------------------------
  const nameInput = h('input.title-input', { value: project.name, 'aria-label': 'Project name', onchange: (e) => { project.name = e.target.value.trim() || 'Untitled'; save(); } });
  const savedDot = h('span.saved', 'Saved on this device');
  const polishChip = h('span.polish-chip', { hidden: true });
  const aspectSeg = segmented(Object.keys(ASPECTS).map((a) => [a, a]), S.edit.aspect, (a) => commit((e) => { e.aspect = a; }), 'aspect-seg');
  const undoBtn = h('button.icon-btn', { title: 'Undo (⌘Z)', onclick: () => undo() }, icon('undo'));
  const redoBtn = h('button.icon-btn', { title: 'Redo (⇧⌘Z)', onclick: () => redo() }, icon('redo'));
  const topbar = h('header.topbar',
    h('div.tb-left', h('button.icon-btn', { title: 'Back to projects', onclick: () => exit() }, icon('back')), h('a.mini-brand', { href: '#/', title: 'Projects' }, h('img', { src: '../assets/brand/slipstream-mark.svg', alt: 'Slipstream', width: 22, height: 22 })), nameInput, savedDot, polishChip),
    h('div.tb-center', aspectSeg),
    h('div.tb-right', undoBtn, redoBtn, h('button.icon-btn', { title: 'Keyboard shortcuts (?)', onclick: () => showShortcuts() }, icon('keyboard')), h('button.btn.primary', { onclick: () => openExport() }, icon('download', 16), 'Export')));

  const canvas = h('canvas.preview-canvas');
  const g = canvas.getContext('2d');
  const stageHint = h('div.stage-hint', icon('target', 14), 'Click the preview to aim the zoom', h('button.link', { onclick: () => setFocusPick(false) }, 'Done'));
  const drawHint = h('div.stage-hint.draw-hint', icon('annotate', 14), h('span'), h('button.link', { onclick: () => setDrawTool(null) }, 'Cancel'));
  const canvasWrap = h('div.canvas-wrap', canvas, stageHint, drawHint);
  const playBtn = h('button.play-btn', { title: 'Play / pause (Space)', onclick: () => togglePlay() }, icon('play', 20));
  const timeOut = h('span.tc');
  const timeSrc = h('span.tc.dim');
  const rangeChip = h('button.chip.range-chip', { onclick: () => commit((e) => { e.range = null; }), title: 'Clear clip range' });
  const transport = h('div.transport',
    h('div.tr-left', timeOut, timeSrc),
    h('div.tr-center', h('button.icon-btn', { title: 'Back 5s (⇧←)', onclick: () => seek(S.t - 5) }, icon('back')), playBtn, h('button.icon-btn', { title: 'Forward 5s (⇧→)', onclick: () => seek(S.t + 5) }, icon('chevron'))),
    h('div.tr-right', rangeChip));
  const stage = h('main.stage', canvasWrap, transport);

  const leftTabs = tabs([['transcript', 'Transcript', 'text'], ['copilot', 'Copilot', 'chat'], ['clips', 'Clips', 'sparkles'], ['publish', 'Publish', 'share']], 'transcript', () => renderLeft());
  const leftBody = h('div.panel-body');
  const left = h('aside.panel.left', leftTabs, leftBody);
  const rightTabs = tabs([['layout', 'Layout', 'layout'], ['style', 'Style', 'palette'], ['captions', 'Captions', 'captions'], ['zoom', 'Zoom', 'zoom'], ['annotate', 'Annotate', 'annotate'], ['broll', 'B-roll', 'image'], ['music', 'Music', 'music'], ['brand', 'Brand', 'brand']], 'layout', () => { if (rightTabs.value() !== 'annotate') setDrawTool(null); S.dirty = true; renderRight(); });
  const rightBody = h('div.panel-body');
  // On phones the inspector is a bottom sheet (W-07): tap a tab or the handle to open it.
  const sheetHandle = h('button.sheet-handle', { 'aria-label': 'Show or hide the inspector', onclick: () => right.classList.toggle('open') });
  const right = h('aside.panel.right', { 'aria-label': 'Inspector' }, sheetHandle, rightTabs, rightBody);
  rightTabs.addEventListener('click', () => { if (matchMedia('(max-width: 760px)').matches) right.classList.add('open'); });

  const tl = buildTimeline();
  const el = h('div.editor', topbar, left, stage, right, tl.el, mediaBox);
  root.replaceChildren(el);

  // ---- derived state & persistence -------------------------------------------------------------
  function derive() {
    S.cuts = computeCuts(S.edit, S.duration);
    S.kept = keptRanges(S.cuts, S.duration);
    const p = CAPTION_PRESETS[resolvePreset(S.edit.captions.preset)];
    S.sourceCues = buildCues(S.edit.words, { maxWords: p.maxWords, maxChars: p.maxChars });
    const lang = S.edit.captions.language;
    const tr = lang && S.edit.captions.translations?.[lang];
    S.cues = tr ? translatedCues(tr) : S.sourceCues;
    S.musicSpeech = S.edit.music ? speechIntervals(S.edit.words, S.kept) : [];
    S.dirty = true;
  }
  /** Translated cues carry no word timings; spread them over each cue so the caption renderer can lay them out. */
  function translatedCues(cues) {
    return cues.map((c) => ({ ...c, words: cuesToWords([c]).map(({ text, start, end }) => ({ text, start, end })) }));
  }
  const saveNow = async () => {
    try { project.edit = S.edit; project.peaks = S.peaks; try { project.plan = planFor(project, S.edit); } catch { /* plan mirror is best effort */ } await saveProject(project); savedDot.textContent = 'Saved on this device'; savedDot.classList.remove('busy'); }
    catch (err) { savedDot.textContent = 'Not saved'; toast(`Could not save: ${err.message}`, 'error'); }
  };
  const save = debounce(saveNow, 500);
  function commit(fn, { rerender = 'all' } = {}) {
    S.undo.push(JSON.stringify(S.edit));
    if (S.undo.length > 120) S.undo.shift();
    S.redo = [];
    fn(S.edit);
    afterChange(rerender);
  }
  function afterChange(rerender = 'all') {
    derive();
    savedDot.textContent = 'Saving…';
    savedDot.classList.add('busy');
    save();
    updateUndo();
    if (rerender === 'all' || rerender === 'transcript') renderTranscriptState();
    if (rerender === 'all') { renderRight(); renderLeftIfNot('transcript'); }
    aspectSeg.set(S.edit.aspect);
    resizeCanvas();
    tl.refresh();
    updateRangeChip();
  }
  function undo() {
    if (!S.undo.length) return;
    S.redo.push(JSON.stringify(S.edit));
    S.edit = JSON.parse(S.undo.pop());
    project.edit = S.edit;
    afterChange('all');
    renderTranscript();
  }
  function redo() {
    if (!S.redo.length) return;
    S.undo.push(JSON.stringify(S.edit));
    S.edit = JSON.parse(S.redo.pop());
    project.edit = S.edit;
    afterChange('all');
    renderTranscript();
  }
  function updateUndo() { undoBtn.disabled = !S.undo.length; redoBtn.disabled = !S.redo.length; }
  function updateRangeChip() {
    const r = S.edit.range;
    rangeChip.hidden = !r;
    if (r) rangeChip.replaceChildren(icon('film', 14), `Clip ${fmtTime(r.start)}–${fmtTime(r.end)}`, icon('x', 12));
  }

  // ---- playback --------------------------------------------------------------------------------
  function seek(t) {
    S.t = Math.max(0, Math.min(S.duration - 0.01, t));
    screenEl.currentTime = S.t;
    for (const a of S.angles) a.el.currentTime = Math.max(0, S.t - a.offset);
    S.dirty = true;
  }
  async function play() {
    if (!S.kept.length) return;
    const lastEnd = S.kept[S.kept.length - 1].end;
    if (S.t >= lastEnd - 0.05) seek(S.kept[0].start);
    const c = cutAt(S.cuts, S.t);
    if (c) seek(c.end + 0.001);
    try { await screenEl.play(); } catch { return; }
    activeAngle(S.t)?.el.play().catch(() => {});
    ensurePreviewGain();
    S.playing = true;
    playBtn.replaceChildren(icon('pause', 20));
  }
  function pause() {
    screenEl.pause();
    for (const a of S.angles) a.el.pause();
    for (const el of Object.values(S.brollEls)) if (el instanceof HTMLVideoElement) el.pause();
    S.musicEl?.pause();
    S.playing = false;
    playBtn.replaceChildren(icon('play', 20));
  }
  function togglePlay() { S.playing ? pause() : play(); }

  let lastWord = -1;
  /** Keep the music bed in step with the preview: output time drives where in the song and how loud (ducking). */
  function syncMusic() {
    const el = S.musicEl, M = S.edit.music;
    if (!el) return;
    // Inside a cut the playhead is about to jump; keep the song running instead of seeking it.
    if (S.playing && M && cutAt(S.cuts, S.t)) return;
    const st = M && S.playing ? musicSourceTime(srcToOut(S.kept, S.t), M, el.duration || 0) : null;
    if (st == null) { if (!el.paused) el.pause(); return; }
    if (Math.abs(el.currentTime - st) > 0.3) el.currentTime = st;
    el.volume = Math.max(0, Math.min(1, musicGainAt(srcToOut(S.kept, S.t), M, totalDuration(S.kept), S.musicSpeech)));
    if (el.paused) el.play().catch(() => {});
  }
  function tick() {
    if (S.destroyed) return;
    syncMusic();
    if (S.playing) {
      let t = screenEl.currentTime;
      const c = cutAt(S.cuts, t);
      if (c) {
        if (c.end >= S.duration - 0.03) { pause(); t = c.start; }
        else { screenEl.currentTime = c.end + 0.001; t = c.end; }
      }
      if (screenEl.ended) pause();
      const act = activeAngle(t);
      for (const a of S.angles) {
        if (a !== act) { if (!a.el.paused) a.el.pause(); continue; }
        const want = t - a.offset;
        if (want >= 0 && Math.abs(a.el.currentTime - want) > 0.15) a.el.currentTime = want;
        if (want >= 0 && a.el.paused && S.playing) a.el.play().catch(() => {});
      }
      S.t = t;
      S.dirty = true;
    }
    if (S.dirty) {
      draw();
      S.dirty = false;
      const out = srcToOut(S.kept, S.t);
      timeOut.textContent = `${fmtTime(out, true)} / ${fmtTime(totalDuration(S.kept))}`;
      timeSrc.textContent = `source ${fmtTime(S.t)}`;
      tl.playhead();
      const wi = wordIndexAt(S.edit.words, S.t);
      if (wi !== lastWord) {
        transcriptBox.querySelector('.w.now')?.classList.remove('now');
        const sp = transcriptBox.querySelector(`.w[data-i="${wi}"]`);
        if (sp) { sp.classList.add('now'); if (S.playing) keepInView(sp, transcriptScroller); }
        lastWord = wi;
      }
    }
    requestAnimationFrame(tick);
  }
  function draw() {
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const screenReady = hasVideo && screenEl.readyState >= 2;
    const act = activeAngle(S.t);
    const camReady = act && act.el.readyState >= 2 && S.t >= act.offset;
    renderFrame(g, W, H, { screen: screenReady ? screenEl : null, camera: camReady ? act.el : null, edit: S.edit, t: S.t, cues: S.cues, overlays: { logo: S.logoBmp, broll: brollFrame(S.t) }, reducedMotion: S.reducedMotion });
    if (annotating()) drawOverlayHandles(W, H);
    if (S.focusPick) {
      const z = S.edit.zooms.find((x) => x.id === S.selZoom);
      if (z && hasVideo) {
        g.save();
        g.strokeStyle = '#8b93ff';
        g.lineWidth = Math.max(2, W / 500);
        g.setLineDash([8, 6]);
        g.strokeRect(W * 0.04, H * 0.04, W * 0.92, H * 0.92);
        g.restore();
      }
    }
  }
  screenEl.addEventListener('loadeddata', () => { S.dirty = true; });
  screenEl.addEventListener('seeked', () => { S.dirty = true; });
  camEl?.addEventListener('seeked', () => { S.dirty = true; });
  camEl?.addEventListener('loadeddata', () => { S.dirty = true; });

  function resizeCanvas() {
    const box = canvasWrap.getBoundingClientRect();
    const [a, b] = ASPECTS[S.edit.aspect] || ASPECTS['16:9'];
    const pad = 24;
    let w = box.width - pad * 2, hgt = (w * b) / a;
    if (hgt > box.height - pad * 2) { hgt = box.height - pad * 2; w = (hgt * a) / b; }
    w = Math.max(80, w); hgt = Math.max(80, hgt);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Render at the screen's pixel density, up to the 1080p export size. Capping lower made
    // Retina previews upscale (and look soft) even though the export itself was sharp.
    const out = outputSize(S.edit.aspect, 1080);
    const scale = Math.min(dpr, Math.max(1600, out.width, out.height) / Math.max(w, hgt));
    const cw = Math.round(w * scale), ch = Math.round(hgt * scale);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    S.dirty = true;
  }
  const ro = new ResizeObserver(() => { resizeCanvas(); tl.resize(); });
  ro.observe(canvasWrap);
  ro.observe(tl.el);

  canvas.addEventListener('click', (e) => {
    if (S.suppressClick) { S.suppressClick = false; return; }
    if (!S.focusPick) { togglePlay(); return; }
    const r = canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * canvas.width, py = ((e.clientY - r.top) / r.height) * canvas.height;
    const p = canvasPointToSource(S.edit, canvas.width, canvas.height, dimsOf(screenEl), camEl ? dimsOf(camEl) : null, px, py, S.t);
    if (!p) return;
    let id = S.selZoom;
    commit((e2) => {
      let z = e2.zooms.find((x) => x.id === id);
      if (!z) { z = newZoom(S.t); e2.zooms.push(z); id = z.id; }
      z.x = Math.round(p.x * 1000) / 1000; z.y = Math.round(p.y * 1000) / 1000; z.auto = false;
    });
    S.selZoom = id;
    renderRight();
    tl.refresh();
  });
  // ---- masks and annotations on the preview (T-03/T-05) -------------------------------------------
  const annotating = () => rightTabs.value() === 'annotate';
  const overlayOf = (sel = S.selOverlay) => (sel ? (S.edit[sel.list] || []).find((q) => q.id === sel.id) || null : null);
  const overlayRect = (list, it, t = S.t) => (list === 'masks' ? maskRectAt(it, t) : it.rect);
  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height, k: canvas.width / Math.max(1, r.width) };
  }
  function mappingNow() {
    return hasVideo ? screenMapping(S.edit, canvas.width, canvas.height, dimsOf(screenEl), camEl ? dimsOf(camEl) : null, S.t, { reducedMotion: S.reducedMotion }) : null;
  }
  function setDrawTool(tool) {
    S.drawTool = tool;
    S.draft = null;
    canvasWrap.classList.toggle('drawing', !!tool);
    if (tool) drawHint.children[1].textContent = `Drag on the preview to add ${tool.list === 'masks' ? `a ${TOOL_LABEL[tool.mode].toLowerCase()} mask` : `${tool.kind === 'arrow' ? 'an' : 'a'} ${tool.kind}`}`;
    S.dirty = true;
    if (annotating()) renderRight();
  }
  /** Which mask or annotation (and handle) is under canvas point c. Annotations sit on top of masks. */
  function overlayHit(map, c) {
    const p = map.toSource(c.x, c.y);
    const tol = Math.abs(map.toSource(c.x + 12 * c.k, c.y).x - p.x);
    const a = hitTest(S.edit.annotations, S.t, p, tol, (it) => it.rect);
    if (a) return { list: 'annotations', ...a };
    const m = hitTest(S.edit.masks, S.t, p, tol, (it) => maskRectAt(it, S.t));
    return m ? { list: 'masks', ...m } : null;
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!annotating() || S.focusPick || e.button !== 0) return;
    const map = mappingNow();
    if (!map) return;
    const c = canvasPoint(e);
    const p0 = map.toSource(c.x, c.y);
    if (S.drawTool) {
      if (S.playing) togglePlay();
      S.draft = { a: p0, b: p0 };
      canvas.setPointerCapture(e.pointerId);
      S.suppressClick = true;
      return;
    }
    const hit = overlayHit(map, c);
    if (!hit) { if (S.selOverlay) { S.selOverlay = null; S.dirty = true; renderRight(); } return; }
    if (S.playing) togglePlay();
    S.selOverlay = { list: hit.list, id: hit.id };
    S.suppressClick = true;
    const it = overlayOf();
    const r0 = overlayRect(hit.list, it).slice();
    const kind = hit.list === 'masks' ? 'box' : it.kind;
    const snapshot = JSON.stringify(S.edit);
    let moved = false;
    canvas.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const p = map.toSource(...Object.values(canvasPoint(ev)).slice(0, 2));
      if (Math.hypot(p.x - p0.x, p.y - p0.y) > 0.002) moved = true;
      if (!moved) return;
      const q = overlayOf();
      if (!q) return;
      const next = hit.handle === 'move' ? moveRect(r0, p.x - p0.x, p.y - p0.y, kind) : resizeRect(r0, hit.handle, p, kind);
      if (hit.list === 'masks' && q.keyframes?.length) {
        // A tracked mask: edit (or add) the keyframe at the playhead.
        const t = Math.round(S.t * 100) / 100;
        const k = q.keyframes.find((f) => Math.abs(f.t - t) < 0.02);
        if (k) k.rect = next; else q.keyframes = [...q.keyframes, { t, rect: next }].sort((a, b) => a.t - b.t);
      } else q.rect = next;
      S.dirty = true;
    };
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      if (moved) { S.undo.push(snapshot); S.redo = []; afterChange('none'); }
      renderRight();
      tl.refresh();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (S.draft) {
      const map = mappingNow();
      if (map) { const c = canvasPoint(e); S.draft.b = map.toSource(c.x, c.y); S.dirty = true; }
      return;
    }
    if (!annotating() || e.buttons) return;
    const map = mappingNow();
    const hit = map && !S.drawTool ? overlayHit(map, canvasPoint(e)) : null;
    const cur = S.drawTool ? 'crosshair' : !hit ? '' : hit.handle === 'move' ? 'move' : hit.handle === 'start' || hit.handle === 'end' ? 'crosshair' : hit.handle === 'nw' || hit.handle === 'se' ? 'nwse-resize' : 'nesw-resize';
    if (canvas.style.cursor !== cur) canvas.style.cursor = cur;
  });
  canvas.addEventListener('pointerup', () => {
    if (!S.draft || !S.drawTool) return;
    const { a, b } = S.draft;
    const tool = S.drawTool;
    const kind = tool.list === 'masks' ? 'box' : tool.kind;
    let rect = rectFromDrag(a, b, kind);
    if (Math.abs(b.x - a.x) < 0.01 && Math.abs(b.y - a.y) < 0.01) {
      // A click instead of a drag: a sensible default size around (or pointing at) the point.
      rect = kind === 'arrow' ? rectFromDrag({ x: a.x - 0.14, y: a.y + 0.12 }, a, 'arrow')
        : kind === 'text' ? [a.x, a.y, 0.2, 0.06]
        : rectFromDrag({ x: a.x - 0.1, y: a.y - 0.04 }, { x: a.x + 0.1, y: a.y + 0.04 });
    }
    const range = overlayRange(S.t, S.duration, S.sel);
    const item = tool.list === 'masks' ? newMask({ ...range, rect, mode: tool.mode }) : newAnnotation({ ...range, rect, kind: tool.kind });
    commit((e2) => { e2[tool.list] = [...(e2[tool.list] || []), item]; }, { rerender: 'none' });
    S.selOverlay = { list: tool.list, id: item.id };
    setDrawTool(null);
    tl.refresh();
    if (item.kind === 'text') requestAnimationFrame(() => rightBody.querySelector('.overlay-text')?.select());
  });
  /** Preview-only: outlines for what's on screen now, handles for the selected one, and the shape being drawn. */
  function drawOverlayHandles(W, H) {
    const map = mappingNow();
    if (!map) return;
    const m = Math.min(W, H);
    const hs = Math.max(5, m * 0.009);
    g.save();
    g.lineWidth = Math.max(1.5, m / 600);
    const outline = (list, it, on) => {
      const r = overlayRect(list, it);
      if (!r) return;
      const p0 = map.toCanvas(r[0], r[1]), p1 = map.toCanvas(r[0] + r[2], r[1] + r[3]);
      g.strokeStyle = on ? '#8b93ff' : 'rgba(255,255,255,0.55)';
      g.setLineDash(on ? [] : [6, 5]);
      g.beginPath();
      if (it.kind === 'arrow') { g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); } else g.rect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
      g.stroke();
      if (!on) return;
      g.setLineDash([]);
      const pts = it.kind === 'arrow' ? [p0, p1] : [p0, { x: p1.x, y: p0.y }, { x: p0.x, y: p1.y }, p1];
      for (const q of pts) { g.fillStyle = '#fff'; g.fillRect(q.x - hs / 2, q.y - hs / 2, hs, hs); g.strokeRect(q.x - hs / 2, q.y - hs / 2, hs, hs); }
    };
    for (const list of ['masks', 'annotations']) for (const it of activeAt(S.edit[list], S.t)) outline(list, it, S.selOverlay?.id === it.id);
    if (S.draft && S.drawTool) {
      const kind = S.drawTool.list === 'masks' ? 'box' : S.drawTool.kind;
      const r = rectFromDrag(S.draft.a, S.draft.b, kind);
      outline('annotations', { kind, rect: r }, true);
    }
    g.restore();
  }
  function renderAnnotate() {
    const E = S.edit;
    const same = (t) => S.drawTool && S.drawTool.list === t.list && (S.drawTool.mode ?? S.drawTool.kind) === (t.mode ?? t.kind);
    const tool = (label, ic, t) => h('button.btn.small', { class: same(t) ? 'on' : '', 'aria-pressed': String(!!same(t)), onclick: () => setDrawTool(same(t) ? null : t) }, icon(ic, 13), label);
    const sel = overlayOf();
    const selList = S.selOverlay?.list;
    const upd = (fn) => commit((e) => { const q = (e[selList] || []).find((x) => x.id === sel.id); if (q) fn(q); }, { rerender: 'none' });
    const items = [...(E.masks || []).map((it) => ({ list: 'masks', it })), ...(E.annotations || []).map((it) => ({ list: 'annotations', it }))].sort((a, b) => a.it.start - b.it.start);
    const labelOf = (list, it) => (list === 'masks' ? `${TOOL_LABEL[it.mode] || 'Blur'} mask` : it.kind === 'text' ? `Text “${String(it.text ?? '').slice(0, 24)}”` : TOOL_LABEL[it.kind] || it.kind);
    const COLORS = [ANNOTATION_COLOR, '#ffffff', '#ff6b6b', '#3ddc97', '#4cc2ff'];
    fill(rightBody,
      section('Hide something', h('p.muted.small', 'Drag over an email, a key or a face on the preview. Masks follow zooms and replace every pixel under them in the export.'),
        h('div.row.wrap', tool('Blur', 'mask', { list: 'masks', mode: 'blur' }), tool('Pixelate', 'grid', { list: 'masks', mode: 'pixelate' }), tool('Solid', 'square', { list: 'masks', mode: 'solid' }))),
      section('Point something out', h('p.muted.small', 'Drag on the preview to draw. Each one shows over the selected range, or for 3 seconds from the playhead.'),
        h('div.row.wrap', tool('Arrow', 'arrow', { list: 'annotations', kind: 'arrow' }), tool('Box', 'square', { list: 'annotations', kind: 'box' }), tool('Highlight', 'highlight', { list: 'annotations', kind: 'highlight' }), tool('Text', 'text', { list: 'annotations', kind: 'text' }))),
      sel ? section(labelOf(selList, sel),
        h('p.muted.small', `${fmtTime(sel.start, true)}–${fmtTime(sel.end, true)} on the recording`),
        h('div.row.wrap',
          h('button.btn.small', { onclick: () => { upd((q) => { q.start = Math.min(S.t, q.end - 0.1); }); renderRight(); tl.refresh(); } }, 'Start at playhead'),
          h('button.btn.small', { onclick: () => { upd((q) => { q.end = Math.max(S.t, q.start + 0.1); }); renderRight(); tl.refresh(); } }, 'End at playhead')),
        selList === 'masks' ? segmented([['blur', 'Blur'], ['pixelate', 'Pixelate'], ['solid', 'Solid']], sel.mode || 'blur', (v) => { upd((q) => { q.mode = v; }); tl.refresh(); }) : null,
        selList === 'masks' ? h('p.muted.small', sel.keyframes?.length ? `Tracks a moving area with ${sel.keyframes.length} keyframe${sel.keyframes.length > 1 ? 's' : ''}: drag it at another time to add one.` : 'Something moves under it? Add a keyframe, then drag the mask at other times to follow it.') : null,
        selList === 'masks' && !sel.keyframes?.length ? h('button.btn.small', { onclick: () => { upd((q) => { q.keyframes = [{ t: Math.round(S.t * 100) / 100, rect: q.rect.slice() }]; }); renderRight(); } }, icon('plus', 13), 'Add keyframe') : null,
        selList === 'annotations' && sel.kind === 'text' ? h('label.field', h('span', 'Text'), h('input.overlay-text', { type: 'text', value: sel.text ?? '', maxLength: 120, oninput: debounce((ev) => { upd((q) => { q.text = ev.target.value; }); }, 250) })) : null,
        selList === 'annotations' ? h('div.swatches.small', COLORS.map((c) => h('button.sw', { class: (sel.color || ANNOTATION_COLOR) === c ? 'on' : '', title: c, 'aria-label': `Colour ${c}`, style: { background: c }, onclick: () => { upd((q) => { if (c === ANNOTATION_COLOR) delete q.color; else q.color = c; }); renderRight(); } }))) : null,
        h('button.btn.small.danger', { onclick: () => { commit((e) => { e[selList] = (e[selList] || []).filter((x) => x.id !== sel.id); }); S.selOverlay = null; renderRight(); } }, icon('trash', 13), 'Delete')) : null,
      items.length ? section('On the timeline', h('ul.zoom-list', items.map(({ list, it }) => h('li', { class: S.selOverlay?.id === it.id ? 'on' : '', tabIndex: 0, onclick: () => { S.selOverlay = { list, id: it.id }; seek(it.start + 0.25); renderRight(); tl.refresh(); } },
        icon(list === 'masks' ? 'mask' : it.kind === 'arrow' ? 'arrow' : it.kind === 'text' ? 'text' : it.kind === 'highlight' ? 'highlight' : 'square', 13),
        h('span.grow', labelOf(list, it)), h('span.zl-time', `${fmtTime(it.start)}–${fmtTime(it.end)}`))))) : h('p.muted.small', 'Nothing here yet. Masks and annotations are drawn into every export.'));
  }

  function setFocusPick(on) {
    S.focusPick = on;
    canvasWrap.classList.toggle('picking', on);
    S.dirty = true;
  }
  function newZoom(t) {
    const start = Math.max(0, t - 0.2);
    return { id: uid('z'), start, end: Math.min(S.duration, start + 2.6), scale: 1.8, x: 0.5, y: 0.5 };
  }

  /** Screen-activity events are reused by scenes and clip scoring, so keep a compact copy with the project. */
  function rememberActivity(ev) {
    S.activity = ev.map((e) => ({ t: Math.round(e.t * 100) / 100, x: Math.round(e.x * 1000) / 1000, y: Math.round(e.y * 1000) / 1000, area: Math.round((e.area || 0) * 10000) / 10000 }));
    project.activity = S.activity;
  }
  async function ensureActivity(onProgress) {
    if (S.activity) return S.activity;
    if (!hasVideo) return [];
    rememberActivity(await activityEvents(S.screenBlob, S.duration, { onProgress }));
    save();
    return S.activity;
  }

  // ---- transcript -------------------------------------------------------------------------------
  const transcriptBox = h('div.transcript', { tabIndex: 0, 'aria-label': 'Transcript. Select words and press Delete to cut them.' });
  const transcriptScroller = h('div.transcript-scroll', transcriptBox);
  transcriptBox.setAttribute('aria-label', 'Transcript. Use the arrow keys to move word by word, Shift to select, Delete to cut or restore.');
  const selBar = h('div.sel-bar', { hidden: true });
  const searchInput = h('input.search', { type: 'search', placeholder: 'Find in transcript', oninput: () => renderSearch() });
  const searchCount = h('span.search-count');
  const fillerBtn = h('button.chip', { onclick: () => removeFillers() });
  const pauseBtn = h('button.chip', { onclick: () => shortenPauses() });
  const retakeBtn = h('button.chip', { onclick: () => removeRetakes(), title: 'Cut the earlier take wherever you restarted or repeated a sentence' });
  const speakersBtn = h('button.chip', { title: `Label who is speaking. Downloads ${DIARIZE_MODEL.note}.`, onclick: () => detectSpeakers(speakersBtn) }, icon('people', 14), Object.keys(S.edit.speakers || {}).length ? 'Speakers' : 'Detect speakers');
  const transcriptTools = h('div.tx-tools', h('div.search-wrap', icon('search', 15), searchInput, searchCount), h('div.tx-actions', fillerBtn, pauseBtn, retakeBtn, speakersBtn));

  function paragraphs(words) {
    const paras = [];
    let cur = [];
    for (let i = 0; i < words.length; i++) {
      const prev = words[i - 1];
      if (prev) {
        const gap = words[i].start - prev.end;
        const turn = words[i].speaker && prev.speaker && words[i].speaker !== prev.speaker;
        if (turn || gap > 1.6 || (gap > 0.8 && /[.!?]$/.test(prev.text) && cur.length > 25)) { paras.push(cur); cur = []; }
      }
      cur.push(i);
    }
    if (cur.length) paras.push(cur);
    return paras;
  }

  function renderTranscript() {
    const words = S.edit.words;
    const scroll = transcriptScroller.scrollTop;
    transcriptBox.replaceChildren();
    if (!words.length) { transcriptBox.append(S.polish ? polishCard() : transcribeCard()); return; }
    for (const para of paragraphs(words)) {
      const p = h('p.para');
      const first = words[para[0]];
      if (first.speaker) p.append(speakerTag(first.speaker), ' ');
      p.append(h('span.para-ts', { contentEditable: 'false', onclick: () => seek(first.start) }, fmtTime(first.start)));
      for (const i of para) {
        const w = words[i];
        const prev = words[i - 1];
        if (prev && w.start - prev.end >= 0.75) {
          const gap = w.start - prev.end;
          p.append(h('span.pause', { dataset: { a: String(prev.end), b: String(w.start) }, title: 'Pause — select it and press Delete to cut' }, `${gap.toFixed(1)}s`), ' ');
        }
        p.append(h('span.w', { dataset: { i: String(i) } }, w.text), ' ');
      }
      transcriptBox.append(p);
    }
    renderTranscriptState();
    renderSearch();
    transcriptScroller.scrollTop = scroll;
  }

  // ---- speaker labels (W-03) -----------------------------------------------------------------------
  function speakerTag(id) {
    const sp = S.edit.speakers?.[id] || { name: id, color: speakerColor(id) };
    const tag = h('button.spk', { contentEditable: 'false', style: { '--spk': sp.color || speakerColor(id) }, title: 'Rename speaker', onclick: (e) => {
      e.stopPropagation();
      const input = h('input.spk-edit', { type: 'text', value: sp.name, 'aria-label': `Rename ${sp.name}` });
      const done = (ok) => {
        const name = input.value.trim();
        if (ok && name && name !== sp.name) commit((ed) => { ed.speakers = renameSpeaker(ed.speakers, id, name); }, { rerender: 'none' });
        renderTranscript();
      };
      input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true), { once: true });
      tag.replaceWith(input);
      input.focus(); input.select();
    } }, sp.name);
    return tag;
  }
  async function detectSpeakers(btn) {
    if (!S.hasAudio || !S.edit.words.length) return;
    btn.disabled = true;
    const label = (t) => btn.replaceChildren(h('span.mini-spin'), t);
    label('Reading audio…');
    try {
      const pcm = S.pcm || (S.pcm = (await analyzeAudio(S.screenBlob, S.duration)).pcm);
      if (!pcm) throw new Error('Could not decode the audio track in this browser.');
      S.job = diarize(pcm, {
        onDownload: (loaded, total) => label(`Downloading speaker models once · ${fmtBytes(loaded)} of ${fmtBytes(total)}`),
        onReady: () => label('Finding who speaks when…'),
        onProgress: (p) => label(`Finding who speaks when… ${Math.round(p * 100)}%`),
      });
      const segments = await S.job.promise;
      S.job = null;
      const words = assignSpeakers(S.edit.words, segments);
      const speakers = defaultSpeakers(words, S.edit.speakers);
      const n = Object.keys(speakers).length;
      commit((ed) => { ed.words = words; ed.speakers = speakers; }, { rerender: 'transcript' });
      renderTranscript();
      toast(n > 1 ? `Found ${n} speakers · click a name to rename it` : 'Only one speaker found', 'ok');
    } catch (err) {
      S.job = null;
      if (err.name !== 'AbortError') toast(`Speaker detection failed: ${err.message}`, 'error', 6000);
    } finally {
      btn.disabled = false;
      btn.replaceChildren(icon('people', 14), Object.keys(S.edit.speakers || {}).length ? 'Speakers' : 'Detect speakers');
    }
  }

  function renderTranscriptState() {
    const words = S.edit.words;
    if (!words.length) return;
    for (const sp of transcriptBox.querySelectorAll('.w')) {
      const w = words[Number(sp.dataset.i)];
      if (!w) continue;
      sp.classList.toggle('del', !!w.deleted);
      sp.classList.toggle('filler', w.filler === 'hard');
      sp.classList.toggle('soft', w.filler === 'soft');
      sp.classList.toggle('sel', !!S.wsel && Number(sp.dataset.i) >= S.wsel.a && Number(sp.dataset.i) <= S.wsel.b);
      sp.classList.toggle('retake', !!w.deleted && !!w.retake);
      sp.classList.toggle('prop', !!S.proposed && S.proposed.has(String(w.id)));
      if (w.deleted && w.retake) sp.title = 'Earlier take, cut as a retake. Select and press Delete to restore.'; else if (sp.title) sp.removeAttribute('title');
      if (sp.textContent !== w.text) sp.textContent = w.text;
    }
    for (const ps of transcriptBox.querySelectorAll('.pause')) {
      const a = Number(ps.dataset.a), b = Number(ps.dataset.b);
      const mid = (a + b) / 2;
      ps.classList.toggle('cut', findRange(S.cuts, mid) >= 0);
    }
    const hard = words.filter((w) => w.filler === 'hard' && !w.deleted).length;
    fillerBtn.replaceChildren(icon('wand', 14), hard ? `Remove ${hard} filler${hard > 1 ? 's' : ''}` : 'No fillers');
    fillerBtn.disabled = !hard;
    const sil = detectWordSilences(words, S.duration).filter((r) => !S.edit.cuts.some((c) => c.kind === 'silence' && Math.abs(c.start - r.start) < 0.01));
    pauseBtn.replaceChildren(icon('silence', 14), sil.length ? `Shorten ${sil.length} pause${sil.length > 1 ? 's' : ''}` : 'Pauses tightened');
    pauseBtn.disabled = !sil.length;
    S.retakes = detectRetakes(words);
    retakeBtn.replaceChildren(icon('undo', 14), S.retakes.length ? `Remove ${S.retakes.length} retake${S.retakes.length > 1 ? 's' : ''}` : 'No retakes');
    retakeBtn.disabled = !S.retakes.length;
  }
  function removeRetakes() {
    const props = detectRetakes(S.edit.words);
    if (!props.length) return;
    commit((ed) => { ed.words = applyRetakes(ed.words, props); }, { rerender: 'transcript' });
    toast(`Cut ${props.length} earlier take${props.length > 1 ? 's' : ''} · each is struck through and can be restored`, 'ok');
  }

  function wordsFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !transcriptBox.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0);
    const spans = $$('.w, .pause', transcriptBox).filter((sp) => range.intersectsNode(sp));
    const idx = spans.filter((s) => s.classList.contains('w')).map((s) => Number(s.dataset.i));
    const pauses = spans.filter((s) => s.classList.contains('pause'));
    if (!idx.length && !pauses.length) return null;
    return { a: idx.length ? Math.min(...idx) : null, b: idx.length ? Math.max(...idx) : null, pauses };
  }

  transcriptBox.addEventListener('mouseup', (e) => {
    const r = wordsFromSelection();
    if (r && r.a !== null) { S.wsel = { a: r.a, b: r.b }; renderTranscriptState(); showSelBar(); return; }
    const sp = e.target.closest('.w');
    if (sp) {
      const i = Number(sp.dataset.i);
      if (e.shiftKey && S.wsel) S.wsel = { a: Math.min(S.wsel.a, i), b: Math.max(S.wsel.b, i) };
      else S.wsel = { a: i, b: i };
      seek(S.edit.words[i].start);
      renderTranscriptState();
      showSelBar();
    } else if (!e.target.closest('.pause')) { S.wsel = null; renderTranscriptState(); selBar.hidden = true; }
  });
  // Keyboard selection (W-10): ←/→ move word by word, Shift extends, Home/End jump; Delete cuts (global handler).
  const srStatus = h('div.sr-only', { 'aria-live': 'polite' });
  transcriptBox.addEventListener('keydown', (e) => {
    if (e.target !== transcriptBox || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const words = S.edit.words, n = words.length;
    if (!n) return;
    e.preventDefault(); e.stopPropagation();
    const cur = S.wsel || (() => { const i = Math.max(0, wordIndexAt(words, S.t)); return { a: i, b: i }; })();
    const anchor = cur.anchor ?? cur.a;
    let focus = cur.focus ?? cur.b;
    if (S.wsel) {
      if (e.key === 'ArrowLeft') focus = Math.max(0, focus - 1);
      else if (e.key === 'ArrowRight') focus = Math.min(n - 1, focus + 1);
    }
    if (e.key === 'Home') focus = 0;
    if (e.key === 'End') focus = n - 1;
    const anc = e.shiftKey ? anchor : focus;
    S.wsel = { a: Math.min(anc, focus), b: Math.max(anc, focus), anchor: anc, focus };
    if (!S.playing) seek(words[focus].start);
    renderTranscriptState();
    showSelBar();
    const sp = transcriptBox.querySelector(`.w[data-i="${focus}"]`);
    if (sp) keepInView(sp, transcriptScroller);
    const sel = words.slice(S.wsel.a, S.wsel.b + 1);
    srStatus.textContent = `${sel.length > 1 ? `${sel.length} words selected: ` : ''}${sel.slice(0, 12).map((w) => w.text).join(' ')}${sel.some((w) => w.deleted) ? ' (cut)' : ''}`;
  });
  transcriptBox.addEventListener('click', (e) => {
    const ps = e.target.closest('.pause');
    if (ps) { const a = Number(ps.dataset.a), b = Number(ps.dataset.b); togglePauseCut(a, b); }
  });
  transcriptBox.addEventListener('dblclick', (e) => {
    const sp = e.target.closest('.w');
    if (!sp) return;
    const i = Number(sp.dataset.i);
    sp.contentEditable = 'true';
    sp.classList.add('editing');
    sp.focus();
    const r = document.createRange(); r.selectNodeContents(sp);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    const finish = (ok) => {
      sp.contentEditable = 'false';
      sp.classList.remove('editing');
      const text = sp.textContent.trim();
      if (ok && text && text !== S.edit.words[i].text) commit((ed) => { ed.words[i].text = text; ed.words = markFillers(ed.words); }, { rerender: 'transcript' });
      else sp.textContent = S.edit.words[i].text;
    };
    sp.addEventListener('keydown', function onKey(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); sp.removeEventListener('keydown', onKey); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); sp.removeEventListener('keydown', onKey); finish(false); }
      ev.stopPropagation();
    });
    sp.addEventListener('blur', () => finish(true), { once: true });
  });

  function showSelBar() {
    if (!S.wsel) { selBar.hidden = true; return; }
    const { a, b } = S.wsel;
    const all = S.edit.words.slice(a, b + 1);
    const allDeleted = all.every((w) => w.deleted);
    const span = transcriptBox.querySelector(`.w[data-i="${a}"]`);
    if (!span) return;
    selBar.replaceChildren(
      h('button', { onclick: () => toggleDeleteSelection() }, icon(allDeleted ? 'undo' : 'scissors', 14), allDeleted ? 'Restore' : 'Cut', h('kbd', 'Del')),
      h('button', { onclick: () => zoomOnSelection() }, icon('zoom', 14), 'Zoom', h('kbd', 'Z')),
      h('button', { onclick: () => clipFromSelection() }, icon('film', 14), 'Set clip', h('kbd', 'C')));
    selBar.hidden = false;
    const r = span.getBoundingClientRect(), pr = transcriptScroller.getBoundingClientRect();
    const above = r.top - pr.top + transcriptScroller.scrollTop - 42;
    selBar.style.top = `${above < transcriptScroller.scrollTop + 4 ? r.bottom - pr.top + transcriptScroller.scrollTop + 6 : above}px`;
    selBar.style.left = `${Math.max(8, Math.min(pr.width - selBar.offsetWidth - 8, r.left - pr.left))}px`;
  }

  function toggleDeleteSelection() {
    if (!S.wsel) return;
    const { a, b } = S.wsel;
    const allDeleted = S.edit.words.slice(a, b + 1).every((w) => w.deleted);
    commit((ed) => { for (let i = a; i <= b; i++) ed.words[i].deleted = !allDeleted; }, { rerender: 'transcript' });
    toast(allDeleted ? 'Restored' : `Cut ${b - a + 1} word${b > a ? 's' : ''} · ⌘Z to undo`, 'ok', 1600);
    showSelBar();
  }
  function zoomOnSelection() {
    if (!S.wsel) return;
    const { a, b } = S.wsel;
    const start = Math.max(0, S.edit.words[a].start - 0.3), end = Math.min(S.duration, Math.max(S.edit.words[b].end + 0.6, start + 1.8));
    const z = { ...newZoom(start), start, end };
    commit((ed) => { ed.zooms.push(z); });
    S.selZoom = z.id;
    rightTabs.select('zoom');
    setFocusPick(true);
  }
  function clipFromSelection() {
    if (!S.wsel) return;
    const { a, b } = S.wsel;
    commit((ed) => { ed.range = { start: Math.max(0, ed.words[a].start - 0.1), end: Math.min(S.duration, ed.words[b].end + 0.25) }; });
    toast('Clip range set — export will only include this part', 'ok');
  }
  function togglePauseCut(a, b) {
    const existing = S.edit.cuts.findIndex((c) => c.start >= a - 0.01 && c.end <= b + 0.01);
    commit((ed) => {
      if (existing >= 0) ed.cuts.splice(existing, 1);
      else ed.cuts.push({ id: uid('c'), start: a + 0.12, end: b - 0.12, kind: 'silence' });
    }, { rerender: 'transcript' });
  }
  function removeFillers() {
    let n = 0;
    commit((ed) => { for (const w of ed.words) if (w.filler === 'hard' && !w.deleted) { w.deleted = true; n++; } }, { rerender: 'transcript' });
    toast(`Removed ${n} filler word${n === 1 ? '' : 's'} · ⌘Z to undo`, 'ok');
  }
  function shortenPauses() {
    const sil = detectWordSilences(S.edit.words, S.duration);
    commit((ed) => {
      ed.cuts = ed.cuts.filter((c) => c.kind !== 'silence');
      for (const r of sil) ed.cuts.push({ id: uid('c'), ...r });
    }, { rerender: 'transcript' });
    toast(`Tightened ${sil.length} pause${sil.length === 1 ? '' : 's'} · saved ${totalDuration(sil).toFixed(1)}s`, 'ok');
  }
  function renderSearch() {
    const q = searchInput.value.trim().toLowerCase();
    let n = 0;
    for (const sp of transcriptBox.querySelectorAll('.w')) {
      const hit = !!q && sp.textContent.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, '').includes(q);
      sp.classList.toggle('hit', hit);
      if (hit) n++;
    }
    searchCount.replaceChildren(q ? h('span', `${n} found`) : '', q && n ? h('button.link', { onclick: () => cutMatches(q) }, 'Cut all') : '');
  }
  function cutMatches(q) {
    let n = 0;
    commit((ed) => {
      ed.words.forEach((w) => { if (w.text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, '').includes(q) && !w.deleted) { w.deleted = true; n++; } });
    }, { rerender: 'transcript' });
    toast(`Cut ${n} match${n === 1 ? '' : 'es'}`, 'ok');
  }

  function transcribeCard() {
    let model = (MODELS.find((m) => m.default) || MODELS[0]).id;
    let lang = 'auto';
    const status = h('div.tx-status');
    const go = h('button.btn.primary.wide', { onclick: () => runTranscription(model, lang, status, go) }, icon('cpu', 16), 'Transcribe on this device');
    const file = h('input', { type: 'file', accept: '.srt,.vtt,text/vtt', hidden: true, onchange: (e) => importSubtitles(e.target.files[0]) });
    return h('div.tx-card',
      h('div.tx-card-icon', icon('text', 22)),
      h('h3', 'Edit by editing text'),
      h('p.muted', 'Slipstream transcribes with Whisper running inside your browser. The model downloads once and is cached; your audio never leaves this device.'),
      !S.hasAudio ? h('p.warn', 'This recording has no audio track, so there is nothing to transcribe.') : null,
      h('label.field', h('span', 'Model'), h('select', { onchange: (e) => { model = e.target.value; } }, MODELS.map((m) => h('option', { value: m.id, selected: m.default }, `${m.label} — ${m.note}`)))),
      h('label.field', h('span', 'Language'), h('select', { onchange: (e) => { lang = e.target.value; } }, LANGS.map(([v, l]) => h('option', { value: v }, l)))),
      go,
      desktop.available && S.hasAudio ? h('button.btn.wide', { title: 'whisper.cpp in the Slipstream engine: native speed on this computer', onclick: (e) => runEngineTranscription(model, lang, status, e.currentTarget) }, icon('cpu', 16), 'Transcribe with whisper.cpp') : null,
      h('button.btn.ghost.wide', { onclick: () => file.click() }, icon('upload', 16), 'Import SRT / VTT instead'),
      file,
      status);
  }

  /** Media handed to the desktop engine keeps a real extension, so the shell and FFmpeg know what it is. */
  function namedMedia(blob, role) {
    if (!blob) return null;
    const ext = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[(blob.type || '').split(';')[0]]
      || (/\.([a-z0-9]{2,5})$/i.exec(blob.name || '')?.[1] || 'mp4').toLowerCase();
    return new File([blob], `${role}.${ext}`, { type: blob.type, lastModified: blob.lastModified || project.created || 0 });
  }

  /**
   * Desktop app (T-09/T-10): whisper.cpp through the engine. The runtime and model are downloaded only after the
   * user agrees, with sizes and hosts shown first; the audio itself never leaves this computer.
   */
  async function runEngineTranscription(model, lang, status, btn) {
    const size = /tiny/.test(model) ? 'tiny' : /small/.test(model) ? 'small' : /base\.en/.test(model) ? 'base.en' : 'base';
    btn.disabled = true;
    try {
      status.replaceChildren(progressRow('Checking the speech engine…', 0));
      const list = await desktop.runtime.list();
      const need = ['whisper', `model-${size}`].map((id) => list.find((c) => c.id === id)).filter((c) => c && !c.installed);
      if (need.length) {
        const missing = need.filter((c) => !c.available || !c.verified);
        if (missing.length) throw new Error(`there's no checked download of ${missing.map((c) => c.name).join(' and ')} for this computer. Use “Transcribe on this device” instead.`);
        const total = need.reduce((a, c) => a + (c.size || 0), 0);
        const ok = await confirmInstall(need, total);
        if (!ok) { status.replaceChildren(); return; }
        for (const c of need) {
          await desktop.runtime.install(c.id, {}, (e) => { if (e?.done != null) setProgress(status, e.done, `Installing ${c.name} · ${Math.round(e.done * 100)}%`); });
        }
      }
      const collected = [];
      status.replaceChildren(progressRow('Transcribing with whisper.cpp…', 0));
      const res = await desktop.transcribe(namedMedia(S.screenBlob, 'screen'), {
        model: size, language: lang === 'auto' ? undefined : lang, key: `${project.id}-screen`,
        onWords: (ws) => { collected.push(...ws); setProgress(status, Math.min(0.99, (ws.at(-1)?.end || 0) / Math.max(1, S.duration)), `Transcribing… ${collected.length} words`); },
      }, (e) => { if (e?.done != null && e.kind === 'progress') setProgress(status, e.done, e.stage === 'copy' ? 'Handing the audio to the engine…' : 'Transcribing with whisper.cpp…'); });
      const words = res.words.map((w) => ({ id: uid('w'), ...w }));
      if (!words.length) throw new Error('no speech found in this recording.');
      commit((ed) => { ed.words = markFillers(words); });
      renderTranscript();
      renderLeft();
      toast(`Transcribed ${words.length} words with whisper.cpp on this computer`, 'ok');
    } catch (err) {
      btn.disabled = false;
      if (err.name === 'AbortError') { status.replaceChildren(h('p.muted', 'Cancelled.')); return; }
      status.replaceChildren(h('p.warn', `whisper.cpp couldn’t transcribe: ${err.message}`));
    }
  }
  function confirmInstall(items, total) {
    return new Promise((resolve) => {
      let done = false;
      const m = modal('Download the speech engine?', h('div.stack',
        h('p.muted', `Slipstream needs ${items.map((c) => `${c.name} ${c.version || ''}`.trim()).join(' and ')} (${fmtBytes(total)} in total) to transcribe with whisper.cpp. Downloads come from ${[...new Set(items.map((c) => c.host).filter(Boolean))].join(' and ')} and are checked against their SHA-256 before they're unpacked. Nothing about you or your recordings is sent.`),
        h('div.row.end', h('button.btn', { onclick: () => m.close() }, 'Not now'), h('button.btn.primary', { onclick: () => { done = true; resolve(true); m.close(); } }, icon('download', 15), `Download ${fmtBytes(total)}`))),
        { onClose: () => { if (!done) resolve(false); } });
    });
  }

  async function ensurePcm(status) {
    if (S.pcm) return S.pcm;
    status.replaceChildren(progressRow('Reading audio…', 0));
    const res = await analyzeAudio(S.screenBlob, S.duration, (p) => setProgress(status, p));
    S.pcm = res.pcm;
    if (!S.peaks) { S.peaks = res.peaks; tl.refresh(); }
    return S.pcm;
  }

  async function runTranscription(model, lang, status, btn) {
    if (!S.hasAudio) return;
    btn.disabled = true;
    try {
      const pcm = await ensurePcm(status);
      if (!pcm) throw new Error('Could not decode the audio track in this browser.');
      status.replaceChildren(progressRow('Loading speech model…', 0), h('button.link', { onclick: () => S.job?.cancel() }, 'Cancel'));
      const collected = [];
      S.job = transcribe(pcm, {
        model, language: lang,
        onDownload: (loaded, total) => setProgress(status, total ? loaded / total : 0, `Downloading model · ${fmtBytes(loaded)} of ${fmtBytes(total)} (one time)`),
        onReady: (device) => setProgress(status, 0, `Transcribing on ${device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WebAssembly)'}…`),
        onWords: (words, done, total) => {
          collected.push(...words);
          setProgress(status, done / total, `Transcribing… ${done}/${total} · ${collected.length} words`);
        },
      });
      const words = await S.job.promise;
      S.job = null;
      if (!words.length) throw new Error('No speech found in this recording.');
      commit((ed) => { ed.words = markFillers(words); });
      renderTranscript();
      renderLeft();
      toast(`Transcribed ${words.length} words on-device`, 'ok');
    } catch (err) {
      btn.disabled = false;
      if (err.name === 'AbortError') { status.replaceChildren(h('p.muted', 'Cancelled.')); return; }
      status.replaceChildren(h('p.warn', `Transcription failed: ${err.message}`), h('p.muted', 'Tip: try the Fast model, or import an SRT/VTT file.'));
    }
  }

  async function importSubtitles(file) {
    if (!file) return;
    const cues = parseSubtitles(await file.text());
    if (!cues.length) { toast('No captions found in that file', 'error'); return; }
    const words = cuesToWords(cues, () => uid('w'));
    commit((ed) => { ed.words = markFillers(words); });
    renderTranscript();
    renderLeft();
    toast(`Imported ${cues.length} captions (${words.length} words)`, 'ok');
  }

  // ---- auto-polish: what happens right after recording or import ------------------------------
  // Everything a person would fix by hand is done automatically and non-destructively:
  // zooms from on-screen activity, on-device transcription, fillers cut, long pauses tightened,
  // captions on. Each step is undoable and nothing touches the original media.
  const POLISH_STEPS = [['look', 'Background, padding and camera layout'], ['zoom', 'Zooms on the moments that matter'], ['words', 'Transcribing on this device'], ['clean', 'Fillers and long pauses removed']];
  function polishCard() {
    const P = S.polish;
    const row = ([k, label]) => {
      const st = P.steps[k];
      const mark = st === 'done' ? icon('check', 14) : st === 'run' ? h('span.mini-spin') : st === 'skip' || st === 'error' ? icon('minus', 14) : h('span.dot');
      return h('li', { class: `ps-${st}` }, h('span.ps-mark', mark), h('span.ps-label', label, k === 'words' && st === 'run' && P.detail ? h('small', P.detail) : null, (st === 'skip' || st === 'error') && P.notes[k] ? h('small', P.notes[k]) : null));
    };
    return h('div.polish-card',
      h('h3', 'Polishing your recording'),
      h('p.muted', 'Edits are applied as they finish. You can keep working or export at any point.'),
      h('ol.polish-steps', POLISH_STEPS.map(row)),
      P.pct != null ? h('div.bar', h('i', { style: { width: `${Math.round(P.pct * 100)}%` } })) : null,
      S.job ? h('button.link', { onclick: () => S.job?.cancel() }, 'Skip transcription') : null);
  }
  function renderPolish() {
    const P = S.polish;
    if (!P) { polishChip.hidden = true; return; }
    const doneN = Object.values(P.steps).filter((v) => v === 'done' || v === 'skip' || v === 'error').length;
    polishChip.hidden = false;
    polishChip.classList.toggle('done', P.finished);
    polishChip.replaceChildren(P.finished ? icon('check', 13) : h('span.mini-spin'), P.finished ? 'Ready to export' : `Polishing ${doneN}/${POLISH_STEPS.length}`);
    if (!S.edit.words.length && leftTabs.value() === 'transcript') {
      const card = transcriptBox.querySelector('.polish-card');
      if (card) card.replaceWith(polishCard()); else renderTranscript();
    }
  }
  async function autoPolish() {
    S.polish = { steps: { look: 'done', zoom: hasVideo ? 'run' : 'skip', words: S.hasAudio ? 'run' : 'skip', clean: 'wait' }, notes: {}, detail: '', pct: null, finished: false };
    if (!hasVideo) S.polish.notes.zoom = 'No video track';
    if (!S.hasAudio) S.polish.notes.words = 'No audio track';
    renderTranscript(); renderPolish();
    const summary = [];
    // Zooms follow the clicks the desktop app recorded (T-04) when there are any, else on-screen activity. Activity
    // is analysed either way: scenes and Find clips use it.
    const cursor = project.media?.cursor;
    const fromClicks = hasCursorClicks(cursor?.samples);
    const activityJob = hasVideo ? activityEvents(S.screenBlob, S.duration, {}).then((ev) => { rememberActivity(ev); return ev; }) : null;
    const activityDone = activityJob?.catch(() => {}); // with clicks, a failed analysis only costs scenes and clips
    const zoomJob = hasVideo ? (fromClicks ? Promise.resolve(zoomsFromCursor(cursor.samples, S.duration)) : activityJob.then((ev) => zoomsFromActivity(ev, S.duration, { sensitivity: 0.5 })))
      .then((zooms) => {
        if (S.destroyed) return;
        if (zooms.length) { commit((e) => { e.zooms = [...e.zooms.filter((z) => !z.auto), ...zooms]; }, { rerender: 'none' }); summary.push(`${zooms.length} zoom${zooms.length > 1 ? 's' : ''}${fromClicks ? ' from your clicks' : ''}`); }
        S.polish.steps.zoom = 'done';
        if (!zooms.length) S.polish.notes.zoom = fromClicks ? 'No clicks to zoom on' : 'Nothing busy enough to zoom on';
        renderPolish();
      })
      .then(() => fromClicks && activityDone)
      .catch(() => { S.polish.steps.zoom = 'error'; S.polish.notes.zoom = 'Couldn’t analyse the video'; renderPolish(); }) : Promise.resolve();
    let words = [];
    if (S.hasAudio) {
      try {
        if (!S.pcm) { const res = await analyzeAudio(S.screenBlob, S.duration); S.pcm = res.pcm; if (!S.peaks) { S.peaks = res.peaks; tl.refresh(); } }
        if (!S.pcm) throw new Error('Could not decode the audio track in this browser.');
        const model = (MODELS.find((m) => m.default) || MODELS[0]).id;
        const collected = [];
        S.job = transcribe(S.pcm, {
          model, language: 'auto',
          onDownload: (loaded, total) => { S.polish.detail = `Downloading the speech model once · ${fmtBytes(loaded)} of ${fmtBytes(total)}`; S.polish.pct = total ? loaded / total : null; renderPolish(); },
          onReady: (device) => { S.polish.detail = device === 'webgpu' ? 'Running on your GPU' : 'Running on your CPU'; S.polish.pct = 0; renderPolish(); },
          onWords: (ws, done, total) => { collected.push(...ws); S.polish.detail = `${collected.length} words so far`; S.polish.pct = done / total; renderPolish(); },
        });
        renderPolish();
        words = await S.job.promise;
        S.job = null;
        S.polish.steps.words = words.length ? 'done' : 'skip';
        if (!words.length) S.polish.notes.words = 'No speech found';
      } catch (err) {
        S.job = null;
        S.polish.steps.words = err.name === 'AbortError' ? 'skip' : 'error';
        S.polish.notes.words = err.name === 'AbortError' ? 'Skipped. Transcribe later from this panel.' : err.message;
      }
    }
    S.polish.pct = null;
    await zoomJob;
    if (S.destroyed) return;
    if (words.length) {
      let nf = 0, np = 0, saved = 0;
      commit((ed) => {
        ed.words = markFillers(words);
        for (const w of ed.words) if (w.filler === 'hard' && !w.deleted) { w.deleted = true; nf++; }
        const sil = detectWordSilences(ed.words, S.duration);
        ed.cuts = ed.cuts.filter((c) => c.kind !== 'silence');
        for (const r of sil) ed.cuts.push({ id: uid('c'), ...r });
        np = sil.length; saved = totalDuration(sil);
      });
      S.polish.steps.clean = 'done';
      if (nf) summary.push(`${nf} filler${nf > 1 ? 's' : ''} cut`);
      if (np) summary.push(`${np} pause${np > 1 ? 's' : ''} tightened (${saved.toFixed(1)} s)`);
      summary.push('captions on');
    } else {
      S.polish.steps.clean = 'skip';
    }
    S.polish.finished = true;
    project.autoPolish = false;
    renderPolish();
    renderTranscript(); renderLeft(); renderRight();
    save();
    toast(summary.length ? `Ready to export: ${summary.join(', ')}. ⌘Z undoes any step.` : 'Ready to export.', 'ok', 6000);
    setTimeout(() => { if (S.polish?.finished) { S.polish = null; renderPolish(); } }, 6000);
  }

  // ---- copilot (A-01) and pro handoff ------------------------------------------------------------
  const copilotApi = {
    state: S.copilot,
    duration: S.duration,
    getEdit: () => S.edit,
    commit: (make) => {
      const next = make();
      commit((e) => { for (const k of Object.keys(e)) delete e[k]; Object.assign(e, ensureEditShape(JSON.parse(JSON.stringify(next)))); });
      renderTranscript();
    },
    preview: (ids) => { S.proposed = ids && ids.length ? new Set(ids.map(String)) : null; renderTranscriptState(); tl.refresh(); },
    seek: (t) => seek(t),
    openExport: () => openExport(),
    exportNLE: (format) => downloadNLE(format),
  };
  function nleMedia() {
    const m = project.media;
    return { duration: S.duration, width: m.width, height: m.height, fps: 30, hasAudio: S.hasAudio, screenName: m.screenName || `${safeName(project.name)}.${(m.screenType || '').includes('webm') ? 'webm' : 'mp4'}`, cameraName: m.camera ? (m.cameraName || 'camera.webm') : undefined, cameraOffset: S.camOffset };
  }
  /** FCPXML / EDL / Premiere XML of the kept ranges, linking to the original recording by file name. */
  function downloadNLE(format) {
    try {
      const r = exportNLE(format, S.edit, nleMedia(), { name: project.name });
      downloadBlob(new Blob([r.text], { type: r.mime }), `${safeName(project.name)}.${r.extension}`);
      toast(`Saved ${format === 'xmeml' ? 'Premiere XML' : format.toUpperCase()} · relink to ${nleMedia().screenName} in your editor`, 'ok', 4000);
    } catch (err) { toast(`Couldn’t write the ${format} file: ${err.message}`, 'error'); }
  }

  // ---- left panel ------------------------------------------------------------------------------
  function renderLeftIfNot(name) { if (leftTabs.value() !== name) renderLeft(); }
  function renderLeft() {
    const tab = leftTabs.value();
    if (tab === 'transcript') {
      fill(leftBody, S.edit.words.length ? transcriptTools : null, h('div.tx-wrap', transcriptScroller, selBar), srStatus);
      if (!transcriptBox.childElementCount) renderTranscript();
    } else if (tab === 'copilot') leftBody.replaceChildren(copilotPanel(copilotApi));
    else if (tab === 'clips') leftBody.replaceChildren(clipsPanel());
    else leftBody.replaceChildren(publishPanel());
  }

  function needTranscript(what) {
    return h('div.empty-mini', icon('text', 20), h('p', `${what} needs a transcript.`), h('button.btn', { onclick: () => leftTabs.select('transcript') }, 'Go to Transcript'));
  }

  function clipsPanel() {
    if (!S.edit.words.length) return needTranscript('Finding clips');
    const list = h('div.clip-list');
    let len = 'short';
    let clips = [];
    const batchBtn = h('button.btn.small', { onclick: () => exportReels(clips.slice(0, 3)) }, icon('download', 13), 'Export top 3 as reels');
    const run = () => {
      const opts = len === 'short' ? { minDur: 12, maxDur: 35 } : len === 'medium' ? { minDur: 25, maxDur: 60 } : { minDur: 50, maxDur: 90 };
      clips = scoreClips(S.edit.words, { ...opts, count: 6, peaks: S.peaks, peaksPerSec: PEAKS_PER_SEC, activity: S.activity });
      batchBtn.disabled = !clips.length;
      list.replaceChildren(...(clips.length ? clips.map((c) => h('article.clip-card',
        h('div.clip-top', h('span.score', { title: 'Local score from the transcript (hook, pace, fillers, pauses), delivery energy and screen activity' }, String(c.score)), h('span.clip-time', `${fmtTime(c.start)} – ${fmtTime(c.end)} · ${Math.round(c.end - c.start)}s`)),
        h('p.clip-title', `“${c.title}”`),
        h('div.signals', [['text', 'Words'], ['audio', 'Energy'], ['screen', 'Screen']].map(([k, label]) => h('span.signal', { title: `${label}: ${Math.round(c.signals[k] * 100)}%` }, h('i', { style: { width: `${Math.round(Math.max(0.04, c.signals[k]) * 100)}%` } }), label))),
        h('div.reasons', c.reasons.map((r) => h('span.tag', r))),
        h('div.row', h('button.btn.small', { onclick: () => { seek(c.start); play(); } }, icon('play', 12), 'Preview'),
          h('button.btn.small.primary', { onclick: () => { commit((ed) => { ed.range = { start: c.start, end: c.end }; }); toast('Clip range set · switch to 9:16 for a reel', 'ok'); } }, icon('film', 13), 'Use as clip'),
          h('button.btn.small', { title: 'Export this clip as a 9:16 reel with captions', onclick: () => exportReels([c]) }, icon('download', 13), 'Reel')))) : [h('p.muted', 'No clip-sized moments found yet. Try a longer length.')]));
    };
    const lenSeg = segmented([['short', '≤35s'], ['medium', '≤60s'], ['long', '≤90s']], len, (v) => { len = v; run(); });
    run();
    const analyse = !S.activity && hasVideo ? h('button.link.small', { onclick: async (e) => { e.target.textContent = 'Analyzing screen…'; await ensureActivity().catch(() => {}); run(); e.target.remove(); } }, 'Include screen activity') : null;
    return h('div.stack',
      h('div.panel-intro', h('h3', icon('sparkles', 16), 'Find clips'), h('p.muted', 'Scored on this device from three signals: what you say (hook, pace, fillers, pauses), how you say it (energy) and what happens on screen.')),
      h('div.row.between', lenSeg, batchBtn), analyse, list);
  }

  /** Batch export (A-04): each clip as a 9:16 reel with captions, one after another, all on this device. */
  async function exportReels(list) {
    if (!list.length) return;
    // A proxied import (desktop app) is only exported from its original, through the engine's Export dialog.
    if (desktop.available && hasPreviewCopies()) {
      toast('This video is edited from a preview copy. Set the clip range and use Export, which renders the original with the desktop engine.', 'info', 8000);
      return;
    }
    pause();
    const ctrl = new AbortController();
    const bar = h('div.bar', h('i'));
    const label = h('p.muted.small', 'Preparing…');
    const done = h('ul.reel-done');
    const cancel = h('button.btn', { onclick: () => ctrl.abort() }, 'Cancel');
    const m = modal(`Exporting ${list.length} reel${list.length > 1 ? 's' : ''}`, h('div.stack', label, bar, done, cancel), { onClose: () => ctrl.abort() });
    const finish = () => { cancel.textContent = 'Close'; cancel.onclick = () => m.close(); };
    const { width, height } = outputSize('9:16', 1080);
    const logo = { logo: S.logoBmp };
    try {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const edit = { ...JSON.parse(JSON.stringify(S.edit)), range: { start: c.start, end: c.end }, aspect: '9:16', captions: { ...S.edit.captions, enabled: true } };
        if (edit.layout.fit === 'contain' && edit.layout.mode !== 'split') edit.layout.fit = 'cover';
        const cuts = computeCuts(edit, S.duration);
        const kept = keptRanges(cuts, S.duration);
        const p = CAPTION_PRESETS[resolvePreset(edit.captions.preset)];
        const tr = edit.captions.language && edit.captions.translations?.[edit.captions.language];
        const cues = tr ? translatedCues(tr) : buildCues(edit.words, { maxWords: p.maxWords, maxChars: p.maxChars });
        label.textContent = `Reel ${i + 1} of ${list.length}: “${c.title}”`;
        const res = await exportVideo({ edit, kept, cues, screenBlob: S.screenBlob, cameraBlob: S.camBlob, cameraOffset: S.camOffset, cameras: camerasForExport(), hasAudio: S.hasAudio, overlays: logo, brollMedia: S.brollMedia, audioGainDb: await loudnessGainFor(edit, kept), musicBlob: edit.music ? S.musicBlob : null, ...bumpersFor(edit) }, { width, height, fps: 30, format: 'mp4', quality: 'high', captions: true }, {
          signal: ctrl.signal,
          onProgress: (pr) => { bar.firstChild.style.width = `${Math.round(((i + pr.done) / list.length) * 100)}%`; },
        });
        const ext = res.blob.type.includes('webm') ? 'webm' : 'mp4';
        const name = `${safeName(project.name)}-reel-${i + 1}.${ext}`;
        downloadBlob(res.blob, name);
        done.append(h('li', icon('check', 13), `${name} · ${fmtBytes(res.blob.size)}`));
      }
      label.textContent = 'All reels exported and downloaded.';
      bar.firstChild.style.width = '100%';
      finish();
      toast(`Exported ${list.length} reel${list.length > 1 ? 's' : ''}`, 'ok');
    } catch (err) {
      if (err.name === 'AbortError') { m.close(); toast('Export cancelled'); return; }
      label.textContent = `Export failed: ${err.message}`;
      finish();
    }
  }

  function publishPanel() {
    if (!S.edit.words.length) return needTranscript('The publish kit');
    const out = h('div.stack');
    const gen = h('button.btn.primary.wide', { onclick: async () => {
      gen.disabled = true;
      gen.replaceChildren(icon('sparkles', 16), 'Writing…');
      const kit = await publishKit(S.edit.words);
      const chapters = chaptersText(S.edit.words, S.duration, S.kept);
      out.replaceChildren(
        copyField('Title', kit.title, 2),
        copyField('Description', kit.description, 5),
        copyField('Chapters (YouTube)', chapters || 'Needs at least 3 distinct sections; record a longer video or add pauses between topics.', 6),
        h('p.muted.small', icon('lock', 12), kit.source === 'on-device AI' ? 'Written by the browser’s built-in on-device model.' : 'Drafted from your transcript. In Chrome with built-in AI enabled, this uses the on-device model.'));
      gen.disabled = false;
      gen.replaceChildren(icon('sparkles', 16), 'Regenerate');
    } }, icon('sparkles', 16), 'Write title, description & chapters');
    const thumbs = h('div.thumb-grid');
    const thumbBtn = h('button.btn.wide', { disabled: !hasVideo, onclick: () => suggestThumbnails(thumbs, thumbBtn) }, icon('image', 16), 'Suggest thumbnails');
    return h('div.stack', h('div.panel-intro', h('h3', icon('share', 16), 'Publish kit'), h('p.muted', 'Titles, descriptions and chapter markers for YouTube, LinkedIn and Shorts. Generated locally.')), gen, out,
      h('div.panel-intro', h('h3', icon('image', 16), 'Thumbnail ideas'), h('p.muted', 'Three sharp, well-exposed frames from the edited video, rendered with your background and camera.')), thumbBtn, thumbs);
  }

  /** A-05 (web): sample the edited video, score frames for sharpness/contrast/exposure, render the best three. */
  async function suggestThumbnails(host, btn) {
    btn.disabled = true;
    btn.replaceChildren(h('span.mini-spin'), 'Looking for sharp frames…');
    const inputs = [];
    try {
      if (!webcodecsVideo()) throw new Error('Thumbnail picks need WebCodecs (Chrome, Edge or the desktop app).');
      const open = (blob) => { const i = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS }); inputs.push(i); return i; };
      const track = await open(S.screenBlob).getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) throw new Error('This video can’t be decoded here.');
      const first = await track.getFirstTimestamp();
      const out = totalDuration(S.kept), N = 24;
      const times = Array.from({ length: N }, (_, i) => outToSrc(S.kept, ((i + 0.5) / N) * out));
      const small = new MB.CanvasSink(track, { width: 160, poolSize: 1 });
      const work = new OffscreenCanvas(1, 1);
      const frames = [];
      let i = 0;
      for await (const wr of small.canvasesAtTimestamps(times.map((t) => first + t))) {
        const t = times[i++];
        if (!wr) continue;
        const c = wr.canvas;
        work.width = c.width; work.height = c.height;
        const wg = work.getContext('2d', { willReadFrequently: true });
        wg.drawImage(c, 0, 0);
        const { data } = wg.getImageData(0, 0, c.width, c.height);
        const lum = new Uint8Array(c.width * c.height);
        for (let p = 0, q = 0; q < lum.length; p += 4, q++) lum[q] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
        frames.push({ t, ...frameQuality(lum, c.width, c.height) });
      }
      const picks = pickThumbnails(frames, { count: 3, gap: Math.max(2, out / 8) });
      const big = new MB.CanvasSink(track, { poolSize: 1 });
      const camTrack = S.camBlob ? await open(S.camBlob).getPrimaryVideoTrack() : null;
      const camSink = camTrack && (await camTrack.canDecode()) ? new MB.CanvasSink(camTrack, { width: 960, poolSize: 1 }) : null;
      const camFirst = camTrack ? await camTrack.getFirstTimestamp() : 0;
      const { width, height } = outputSize(S.edit.aspect, 720);
      const cards = [];
      for (const p of picks) {
        const sc = await big.getCanvas(first + p.t);
        const cc = camSink && p.t >= S.camOffset ? await camSink.getCanvas(camFirst + p.t - S.camOffset) : null;
        const cv = Object.assign(document.createElement('canvas'), { width, height });
        renderFrame(cv.getContext('2d'), width, height, { screen: sc?.canvas, camera: cc?.canvas || null, edit: { ...S.edit, captions: { ...S.edit.captions, enabled: false } }, t: p.t, cues: [], overlays: { logo: S.logoBmp } });
        const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
        const url = URL.createObjectURL(blob);
        cards.push(h('figure.thumb', h('img', { src: url, alt: `Frame at ${fmtTime(p.t)}`, onclick: () => seek(p.t) }),
          h('figcaption', h('span.muted.small', `${fmtTime(srcToOut(S.kept, p.t))} · sharpness ${Math.round(p.sharpness * 100)}%`), h('button.link.small', { onclick: () => downloadBlob(blob, `${safeName(project.name)}-thumb-${Math.round(p.t)}s.jpg`) }, 'Download'))));
      }
      fill(host, cards.length ? cards : h('p.muted.small', 'No usable frames found.'));
    } catch (err) {
      fill(host, h('p.warn', err.message));
    } finally {
      inputs.forEach((i) => i.dispose?.());
      btn.disabled = false;
      btn.replaceChildren(icon('image', 16), 'Suggest again');
    }
  }

  function copyField(label, value, rows) {
    const ta = h('textarea', { rows, value });
    return h('label.field', h('span.field-head', label, h('button.link', { onclick: async (e) => { e.preventDefault(); await navigator.clipboard.writeText(ta.value); toast(`${label} copied`, 'ok', 1400); } }, 'Copy')), ta);
  }

  // ---- right panel (inspector) -----------------------------------------------------------------
  function section(title, ...body) { return h('section.insp', h('h4', title), ...body); }

  function renderRight() {
    const tab = rightTabs.value();
    const E = S.edit;
    const set = (fn) => commit(fn, { rerender: 'none' });
    if (tab === 'layout') {
      const hasCam = !!S.camBlob;
      const L = E.layout;
      const corner = h('div.corner-pick', ['tl', 'tr', 'bl', 'br'].map((c) => h('button', { class: L.corner === c ? 'on' : '', title: `Corner ${c}`, onclick: () => { set((e) => { e.layout.corner = c; }); renderRight(); } }, h('span'))));
      fill(rightBody, 
        section('Camera layout',
          segmented([['pip', 'Bubble'], ['split', 'Split'], ['screen', 'Screen'], ['camera', 'Camera']], hasCam ? L.mode : 'screen', (v) => { set((e) => { e.layout.mode = v; }); renderRight(); }, hasCam ? '' : 'disabled'),
          hasCam ? null : h('p.muted.small', 'No camera in this project. Add a separately recorded camera (phone, DSLR, webcam) and Slipstream lines it up by its audio.'),
          hasCam ? null : addCameraButton()),
        hasCam && L.mode === 'pip' ? section('Bubble', h('div.row.gap', corner, h('div.grow',
          segmented([['circle', 'Circle'], ['rounded', 'Rounded'], ['wide', 'Wide']], L.shape, (v) => set((e) => { e.layout.shape = v; })),
          slider('Size', { min: 0.12, max: 0.42, step: 0.01, value: L.size, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((e) => { e.layout.size = v; }) })))) : null,
        hasCam && L.mode === 'split' ? section('Split', slider('Camera share', { min: 0.25, max: 0.6, step: 0.01, value: L.split, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((e) => { e.layout.split = v; }) }), h('p.muted.small', 'Vertical formats stack the camera under the screen; wide formats put it beside.')) : null,
        hasCam ? anglesSection() : null,
        hasCam && S.angles.length < 2 ? section('More angles', h('p.muted.small', 'Add another camera (a second webcam, a phone, a guest) and Slipstream lines it up by audio. Then switch angles per scene or by speaker.'), addCameraButton()) : null,
        hasCam ? section('Camera',
          L.mode !== 'screen' ? toggle('Mirror camera', L.mirror, (v) => set((e) => { e.layout.mirror = v; })) : null,
          slider('Sync', { min: -2, max: 2, step: 0.02, value: 0, format: (v) => { const o = (syncBase ?? S.camOffset) + v; return `${o >= 0 ? '+' : ''}${o.toFixed(2)} s`; }, onInput: debounce((v) => nudgeSync(v), 120) }),
          h('p.muted.small', 'If lips and voice drift apart, nudge the camera. Positive means the camera started after the screen.')) : null,
        section('Screen fit', segmented([['contain', 'Fit'], ['cover', 'Fill frame']], L.fit, (v) => set((e) => { e.layout.fit = v; })), h('p.muted.small', 'Fill crops the screen to the frame and follows your zoom focus — best for 9:16.')),
        hasCam ? scenesSection() : null);
    } else if (tab === 'style') {
      const St = E.style;
      const cur = resolveBackground(St.bg);
      const pick = (k) => { set((e) => { e.style.bg = k; }); loadWallpaper(k); renderRight(); };
      const wallBtn = ([k, w]) => h('button.sw.wall', { class: cur === k ? 'on' : '', title: w.label, 'aria-label': `${w.label} background`, 'aria-pressed': String(cur === k), style: { backgroundImage: `url(${wallpaperURL(k)})`, backgroundColor: w.tone[1] }, onclick: () => pick(k) });
      const grads = Object.entries(WALLPAPERS).filter(([, w]) => w.kind === 'gradient');
      const photos = Object.entries(WALLPAPERS).filter(([, w]) => w.kind === 'photo');
      fill(rightBody,
        section('Background',
          h('div.swatches.walls', grads.map(wallBtn)),
          h('p.sub-label', 'Photos'),
          h('div.swatches.walls', photos.map(wallBtn),
            h('button.sw.wall.blur', { class: cur === 'blur' ? 'on' : '', title: 'Blur of your screen', 'aria-pressed': String(cur === 'blur'), onclick: () => pick('blur') }, h('span', 'Blur')),
            h('label.sw.wall.solid', { class: cur === 'solid' ? 'on' : '', title: 'Solid colour', style: { background: St.solid } }, h('span', 'Colour'), h('input', { type: 'color', value: St.solid, 'aria-label': 'Solid colour', oninput: (ev) => { set((e) => { e.style.bg = 'solid'; e.style.solid = ev.target.value; }); } })))),
        section('Window',
          slider('Padding', { min: 0, max: 0.14, step: 0.005, value: St.padding, format: (v) => `${Math.round(v * 1000) / 10}%`, onInput: (v) => set((e) => { e.style.padding = v; }) }),
          slider('Corners', { min: 0, max: 0.05, step: 0.002, value: St.radius, format: (v) => `${Math.round(v * 1000)}`, onInput: (v) => set((e) => { e.style.radius = v; }) }),
          slider('Shadow', { min: 0, max: 1, step: 0.05, value: St.shadow, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((e) => { e.style.shadow = v; }) })),
        S.hasAudio ? section('Sound',
          toggle('Even out loudness for social (−14 LUFS)', E.audio.normalize !== false, (v) => { set((e) => { e.audio.normalize = v; }); updatePreviewGain(); }),
          h('p.muted.small', soundNote()),
          desktop.available || E.audio.enhance ? toggle('Studio Sound: remove background noise', E.audio.enhance === true, (v) => { set((e) => { e.audio.enhance = v; }); renderRight(); }) : null,
          E.audio.enhance ? h('p.muted.small', desktop.available ? 'Applied when you export with the desktop engine (RNNoise, then −14 LUFS). The preview plays the original sound.' : 'Applied by the Slipstream desktop apps when they export this project. Exports from the browser keep the original sound.') : null) : null);
    } else if (tab === 'captions') {
      const C = E.captions;
      const curP = resolvePreset(C.preset);
      const P = CAPTION_PRESETS[curP];
      const caps = C.uppercase ?? P.uppercase;
      const presets = h('div.preset-grid', Object.entries(CAPTION_PRESETS).map(([k, p]) => h('button.preset', { class: `pv-${k}${curP === k ? ' on' : ''}`, 'aria-pressed': String(curP === k), onclick: () => { commit((e) => { e.captions.preset = k; e.captions.uppercase = null; }, { rerender: 'none' }); renderRight(); } },
        h('span.pv', { style: { '--acc': C.color } }, h('span', h('span', 'Ship it '), h('i', 'now'))), h('span.pl', p.label))));
      const colors = ['#ffd34d', '#ffffff', '#8b93ff', '#5ad1b0', '#ff8a6b', '#f5a8d4'];
      fill(rightBody,
        section('Captions', toggle('Show captions', C.enabled, (v) => set((e) => { e.captions.enabled = v; })), !S.edit.words.length ? h('p.muted.small', S.polish ? 'Captions appear when transcription finishes.' : 'Transcribe first to generate captions.') : null),
        section('Look', presets, h('p.muted.small', { class: 'preset-note' }, ({ studio: 'Clean sans on a soft dark plate. Words brighten as they’re spoken.', cinema: 'Film subtitles: no plate, a soft shadow, up to two balanced lines.', editorial: 'An italic serif for calm, documentary-style pieces.', bold: 'Two or three words at a time for vertical clips.' })[curP])),
        curP === 'bold' ? section('Highlight', h('div.swatches.small', colors.map((c) => h('button.sw', { class: C.color === c ? 'on' : '', style: { background: c }, title: c, 'aria-label': `Highlight ${c}`, onclick: () => { set((e) => { e.captions.color = c; }); renderRight(); } })))) : null,
        section('Placement',
          segmented([['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], C.position, (v) => set((e) => { e.captions.position = v; })),
          slider('Size', { min: 0.7, max: 1.5, step: 0.05, value: C.size, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((e) => { e.captions.size = v; }) }),
          toggle('All caps', caps, (v) => set((e) => { e.captions.uppercase = v; }))),
        S.edit.words.length ? translateSection() : null,
        section('Subtitle files', h('div.row', h('button.btn.small', { disabled: !S.edit.words.length, onclick: () => downloadSubs('srt') }, icon('download', 13), '.srt'), h('button.btn.small', { disabled: !S.edit.words.length, onclick: () => downloadSubs('vtt') }, icon('download', 13), '.vtt')), h('p.muted.small', `Timed to the edited video, after cuts${C.language ? ` · in ${langLabel(C.language)}` : ''}.`)));
    } else if (tab === 'brand') {
      renderBrand();
    } else if (tab === 'annotate') {
      renderAnnotate();
    } else if (tab === 'music') {
      renderMusic();
    } else if (tab === 'broll') {
      renderBroll();
    } else {
      const zs = [...E.zooms].sort((a, b) => a.start - b.start);
      const selZ = zs.find((z) => z.id === S.selZoom);
      let sens = 0.5;
      const autoBtn = h('button.btn.wide', { disabled: !hasVideo, onclick: () => runAutoZoom(autoBtn, sens) }, icon('wand', 16), 'Auto-zoom from screen activity');
      fill(rightBody, 
        S.reducedMotion ? h('p.muted.small', icon('info', 12), 'Your system asks for reduced motion, so the preview jumps straight to each zoom. Exports keep the smooth camera move.') : null,
        section('Smart zoom', autoBtn, slider('Sensitivity', { min: 0.1, max: 0.9, step: 0.1, value: sens, format: (v) => (v < 0.4 ? 'Calm' : v > 0.6 ? 'Lively' : 'Balanced'), onInput: (v) => { sens = v; } }), h('p.muted.small', 'Finds where the picture changes (typing, clicks, new panels) and plans zooms there. Runs locally.')),
        section('Zooms',
          h('button.btn.small', { onclick: () => { const z = newZoom(S.t); commit((e) => { e.zooms.push(z); }); S.selZoom = z.id; renderRight(); setFocusPick(true); } }, icon('plus', 13), 'Add at playhead', h('kbd', 'Z')),
          zs.length ? h('ul.zoom-list', zs.map((z) => h('li', { class: z.id === S.selZoom ? 'on' : '', onclick: () => { S.selZoom = z.id; seek(z.start + 0.5); renderRight(); tl.refresh(); } },
            h('span.zl-time', `${fmtTime(z.start)}–${fmtTime(z.end)}`), h('span.zl-scale', `${z.scale.toFixed(1)}×`), z.auto ? h('span.tag', 'auto') : null))) : h('p.muted.small', 'No zooms yet.'),
          zs.length ? h('button.link.small', { onclick: () => commit((e) => { e.zooms = []; }) }, 'Remove all') : null),
        selZ ? section('Selected zoom',
          slider('Zoom', { min: 1.1, max: 3, step: 0.05, value: selZ.scale, format: (v) => `${v.toFixed(2)}×`, onInput: (v) => commit((e) => { const z = e.zooms.find((x) => x.id === selZ.id); if (z) { z.scale = v; z.auto = false; } }, { rerender: 'none' }) }),
          h('div.row', h('button.btn.small', { class: S.focusPick ? 'on' : '', onclick: () => setFocusPick(!S.focusPick) }, icon('target', 13), S.focusPick ? 'Picking… click preview' : 'Aim on preview'),
            h('button.btn.small.danger', { onclick: () => { commit((e) => { e.zooms = e.zooms.filter((x) => x.id !== selZ.id); }); S.selZoom = null; setFocusPick(false); renderRight(); } }, icon('trash', 13), 'Delete'))) : null);
    }
  }

  // ---- scenes (S-01) ---------------------------------------------------------------------------------
  const MODE_LABEL = { pip: 'Bubble', split: 'Split', screen: 'Screen', camera: 'Camera' };
  function scenesSection() {
    const list = [...S.edit.scenes].sort((a, b) => a.start - b.start);
    const autoBtn = h('button.btn.small', { onclick: () => runAutoScenes(autoBtn) }, icon('wand', 13), 'Auto scenes');
    return section('Scenes',
      h('p.muted.small', 'Change the layout for parts of the video. Auto scenes show your camera while you talk over a still screen and bring the screen back when something happens on it.'),
      h('div.row', autoBtn, h('button.btn.small', { onclick: () => addSceneAt(S.t) }, icon('plus', 13), 'Add at playhead')),
      list.length ? h('ul.zoom-list.scene-list', list.map((sc) => h('li', { class: sc.id === S.selScene ? 'on' : '', onclick: (ev) => { if (ev.target.closest('.seg, button')) return; S.selScene = sc.id; seek(sc.start + 0.05); renderRight(); tl.refresh(); } },
        h('span.zl-time', `${fmtTime(sc.start)}–${fmtTime(sc.end)}`),
        segmented(Object.entries(MODE_LABEL).map(([k, v]) => [k, v]), sc.layout.mode, (v) => commit((e) => { const x = e.scenes.find((q) => q.id === sc.id); if (x) { x.layout = { ...x.layout, mode: v }; x.auto = false; } }, { rerender: 'none' }), 'tiny'),
        S.angles.length > 1 ? segmented(S.angles.map((ang) => [ang.id, ang.name.slice(0, 12)]), sc.layout.angle || S.edit.layout.angle || S.angles[0].id, (v) => commit((e) => { const x = e.scenes.find((q) => q.id === sc.id); if (x) { x.layout = { ...x.layout, angle: v }; x.auto = false; } }, { rerender: 'none' }), 'tiny') : null,
        h('button.icon-btn', { title: 'Remove scene', 'aria-label': `Remove scene ${fmtTime(sc.start)}–${fmtTime(sc.end)}`, onclick: () => { commit((e) => { e.scenes = e.scenes.filter((q) => q.id !== sc.id); }); } }, icon('x', 13))))) : null,
      list.length ? h('button.link.small', { onclick: () => commit((e) => { e.scenes = []; }) }, 'Remove all scenes') : null);
  }
  function addSceneAt(t, end = Math.min(S.duration, t + 4)) {
    const cur = layoutAt(S.edit, t).mode;
    const mode = cur === 'camera' ? (S.edit.layout.mode === 'camera' ? 'pip' : S.edit.layout.mode) : 'camera';
    commit((e) => { e.scenes = setScene(e.scenes, t, end, { mode }); });
    S.selScene = sceneAt(S.edit.scenes, t + 0.01)?.id || null;
    rightTabs.select('layout');
    toast(`${MODE_LABEL[mode]} from ${fmtTime(t)} to ${fmtTime(end)} · change it in Layout → Scenes`, 'ok', 2400);
  }
  async function runAutoScenes(btn) {
    btn.disabled = true;
    try {
      const act = await ensureActivity((p) => { btn.textContent = `Analyzing screen… ${Math.round(p * 100)}%`; });
      const auto = autoScenes(act, S.edit.words, S.duration, { base: S.edit.layout });
      commit((e) => {
        let next = auto;
        for (const m of e.scenes.filter((q) => !q.auto)) next = setScene(next, m.start, m.end, m.layout);
        e.scenes = next;
      });
      toast(auto.length ? `Added ${auto.length} scene${auto.length > 1 ? 's' : ''} · ⌘Z to undo` : 'The layout already fits the whole video', auto.length ? 'ok' : 'info');
    } catch (err) {
      toast(`Auto scenes failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      renderRight();
    }
  }

  // ---- brand kit & templates (S-02) ---------------------------------------------------------------
  async function loadLogo() {
    const blob = project.media.logo ? await getMedia(`${project.id}:logo`, project.media.logoType) : null;
    S.logoBmp = blob ? await createImageBitmap(blob).catch(() => null) : null;
    S.dirty = true;
  }
  async function setLogo(blob) {
    if (!blob) return;
    const stored = await putMedia(`${project.id}:logo`, blob);
    project.media.logo = true; project.media.logoType = blob.type;
    S.logoBmp = await createImageBitmap(stored).catch(() => null);
    if (!S.logoBmp) { toast('That image couldn’t be read', 'error'); return; }
    commit((e) => { e.brand.logo.enabled = true; });
    save();
  }
  function renderBrand() {
    const B = S.edit.brand;
    const set = (fn) => commit(fn, { rerender: 'none' });
    const logoInput = h('input', { type: 'file', accept: 'image/png,image/svg+xml,image/webp,image/jpeg', hidden: true, onchange: (e) => setLogo(e.target.files[0]) });
    const corner = h('div.corner-pick', ['tl', 'tr', 'bl', 'br'].map((c) => h('button', { class: B.logo.corner === c ? 'on' : '', title: `Corner ${c}`, 'aria-label': `Logo corner ${c}`, onclick: () => { set((e) => { e.brand.logo.corner = c; }); renderRight(); } }, h('span'))));
    const lt = B.lowerThird;
    const ltToggle = toggle('Show name and title', lt.enabled, (v) => set((e) => { e.brand.lowerThird.enabled = v; }));
    const text = (label, key, ph) => h('label.field', h('span', label), h('input', { type: 'text', value: lt[key] || '', placeholder: ph, onchange: (ev) => {
      const v = ev.target.value.trim();
      commit((e) => { e.brand.lowerThird[key] = v; if (key === 'title' && v) e.brand.lowerThird.enabled = true; }, { rerender: 'none' });
      if (key === 'title' && v) ltToggle.querySelector('input').checked = true;
    } }));
    const kitHost = h('div.stack');
    fill(rightBody,
      section('Logo',
        S.logoBmp ? toggle('Show logo', B.logo.enabled, (v) => set((e) => { e.brand.logo.enabled = v; })) : null,
        h('div.row', h('button.btn.small', { onclick: () => logoInput.click() }, icon('image', 13), S.logoBmp ? 'Replace logo' : 'Add logo'), logoInput),
        S.logoBmp ? h('div.row.gap', corner, h('div.grow',
          slider('Size', { min: 0.05, max: 0.3, step: 0.01, value: B.logo.size, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((e) => { e.brand.logo.size = v; }) }),
          slider('Opacity', { min: 0.2, max: 1, step: 0.05, value: B.logo.opacity, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((e) => { e.brand.logo.opacity = v; }) }))) : h('p.muted.small', 'PNG or SVG with a transparent background works best.')),
      section('Lower third',
        ltToggle,
        text('Name', 'title', 'Your name'), text('Title', 'subtitle', 'Role · Company'),
        h('div.row.between', h('span.muted.small', `Shows at ${fmtTime(lt.start)} for ${Math.round(lt.duration)} s`), h('button.btn.small', { onclick: () => commit((e) => { e.brand.lowerThird.start = Math.round(S.t * 10) / 10; e.brand.lowerThird.enabled = true; }) }, icon('clock', 13), 'Start at playhead')),
        slider('Duration', { min: 2, max: 12, step: 0.5, value: lt.duration, format: (v) => `${v} s`, onInput: (v) => set((e) => { e.brand.lowerThird.duration = v; }) }),
        h('div.swatches.small', ['#8b93ff', '#5ad1b0', '#f2c06b', '#ffffff', '#ff8a6b', '#f5a8d4'].map((c) => h('button.sw', { class: lt.color === c ? 'on' : '', style: { background: c }, 'aria-label': `Accent ${c}`, onclick: () => { set((e) => { e.brand.lowerThird.color = c; }); renderRight(); } })))),
      bumperSection(),
      section('Brand kit & templates', kitHost));
    renderKit(kitHost);
  }
  // Intro and outro clips (S-02): added in front of and after every export, cover-fit to the frame.
  async function loadBumpers() {
    for (const k of ['intro', 'outro']) {
      if (!project.media[k]) continue;
      S.bumpers[k] = await getMedia(`${project.id}:${k}`, project.media[`${k}Type`] || '').catch(() => null);
    }
  }
  async function setBumper(kind, blob) {
    if (!blob) {
      S.bumpers[kind] = null; project.media[kind] = false;
      commit((e) => { delete e.brand[kind]; });
      return;
    }
    const probeEl = h('video', { src: URL.createObjectURL(blob), muted: true, preload: 'metadata' });
    const duration = await new Promise((r) => { probeEl.onloadedmetadata = () => r(Number.isFinite(probeEl.duration) ? probeEl.duration : 0); probeEl.onerror = () => r(0); });
    URL.revokeObjectURL(probeEl.src);
    if (!duration) { toast('That clip couldn’t be read', 'error'); return; }
    if (duration > 20) toast('Intros and outros work best under 5 seconds', 'info');
    S.bumpers[kind] = await putMedia(`${project.id}:${kind}`, blob);
    project.media[kind] = true; project.media[`${kind}Type`] = blob.type;
    commit((e) => { e.brand[kind] = { enabled: true, name: blob.name || kind, duration: Math.round(duration * 100) / 100 }; });
  }
  function bumperSection() {
    const row = (kind, label) => {
      const b = S.edit.brand[kind];
      const input = h('input', { type: 'file', accept: 'video/*', hidden: true, onchange: (e) => setBumper(kind, e.target.files[0]) });
      return h('div.row.between', h('span.muted.small', b ? `${label}: ${b.name} · ${b.duration.toFixed(1)} s` : `${label}: none`),
        h('div.row', b ? toggle('On', b.enabled !== false, (v) => commit((e) => { e.brand[kind].enabled = v; }, { rerender: 'none' })) : null,
          h('button.btn.small', { onclick: () => input.click() }, b ? 'Replace' : 'Add'), b ? h('button.icon-btn', { title: `Remove ${label.toLowerCase()}`, 'aria-label': `Remove ${label.toLowerCase()}`, onclick: () => setBumper(kind, null) }, icon('x', 13)) : null, input));
    };
    return section('Intro and outro', h('p.muted.small', 'Short branded clips played before and after every export, filling the frame.'), row('intro', 'Intro'), row('outro', 'Outro'));
  }
  const bumpersFor = (edit) => ({
    intro: edit.brand?.intro?.enabled !== false && edit.brand?.intro ? S.bumpers.intro : null,
    outro: edit.brand?.outro?.enabled !== false && edit.brand?.outro ? S.bumpers.outro : null,
  });

  async function renderKit(host) {
    const [kit, templates = []] = await Promise.all([getSetting('brandKit').catch(() => null), getSetting('templates').catch(() => [])]);
    const tplList = (templates || []).map((t) => h('li', h('span.tpl-name', t.name), h('span.tag', t.aspect),
      h('button.btn.small', { onclick: () => applyTemplate(t) }, 'Apply'),
      h('button.icon-btn', { title: `Delete ${t.name}`, 'aria-label': `Delete template ${t.name}`, onclick: async () => { await setSetting('templates', templates.filter((x) => x.id !== t.id)); renderKit(host); } }, icon('trash', 13))));
    const nameInput = h('input', { type: 'text', placeholder: 'Template name', 'aria-label': 'Template name' });
    fill(host,
      h('p.muted.small', 'Your brand kit keeps a logo, lower-third style, caption look and background in this browser. Templates save the whole look of this project.'),
      h('div.row', h('button.btn.small', { onclick: async () => { await saveKit(); renderKit(host); } }, icon('check', 13), kit ? 'Update brand kit' : 'Save as brand kit'),
        kit ? h('button.btn.small.primary', { onclick: () => applyKit(kit) }, 'Apply brand kit') : null),
      h('div.row.tpl-save', nameInput, h('button.btn.small', { onclick: async () => { const name = nameInput.value.trim() || `Template ${templates.length + 1}`; await setSetting('templates', [...templates, templateFrom(name)]); renderKit(host); toast(`Saved “${name}”`, 'ok', 1600); } }, icon('plus', 13), 'Save template')),
      tplList.length ? h('ul.tpl-list', tplList) : null,
      brandFileButtons(kit, () => renderKit(host)));
  }
  function templateFrom(name) {
    const E = S.edit;
    return { id: uid('t'), name, aspect: E.aspect, layout: { ...E.layout }, style: { ...E.style }, captions: { enabled: E.captions.enabled, preset: E.captions.preset, position: E.captions.position, size: E.captions.size, color: E.captions.color, uppercase: E.captions.uppercase }, brand: { logo: { ...E.brand.logo }, lowerThird: { ...E.brand.lowerThird, title: E.brand.lowerThird.title, subtitle: E.brand.lowerThird.subtitle } } };
  }
  function applyTemplate(t) {
    commit((e) => {
      e.aspect = t.aspect; e.layout = { ...e.layout, ...t.layout }; e.style = { ...e.style, ...t.style }; e.captions = { ...e.captions, ...t.captions };
      if (t.brand) { e.brand.logo = { ...e.brand.logo, ...t.brand.logo, enabled: !!(t.brand.logo?.enabled && S.logoBmp) }; e.brand.lowerThird = { ...e.brand.lowerThird, ...t.brand.lowerThird }; }
      if (!S.camBlob) e.layout.mode = 'screen';
    });
    loadWallpaper(S.edit.style.bg);
    toast(`Applied “${t.name}” · ⌘Z to undo`, 'ok');
  }
  async function saveKit() {
    const logo = project.media.logo ? await getMedia(`${project.id}:logo`, project.media.logoType) : null;
    const E = S.edit;
    const bumpers = {};
    for (const k of ['intro', 'outro']) if (S.bumpers[k]) bumpers[k] = new Blob([S.bumpers[k]], { type: S.bumpers[k].type || project.media[`${k}Type`] || 'video/mp4' });
    await setSetting('brandKit', { ...bumpers, name: 'My brand', logo: logo ? new Blob([logo], { type: logo.type || project.media.logoType || 'image/png' }) : null, logoOpts: { corner: E.brand.logo.corner, size: E.brand.logo.size, opacity: E.brand.logo.opacity }, lowerThird: { title: E.brand.lowerThird.title, subtitle: E.brand.lowerThird.subtitle, color: E.brand.lowerThird.color, duration: E.brand.lowerThird.duration }, captions: { preset: E.captions.preset, color: E.captions.color, position: E.captions.position }, style: { ...E.style }, updated: Date.now() });
    toast('Brand kit saved in this browser', 'ok', 1600);
  }
  async function applyKit(kit) {
    if (kit.logo) await setLogo(kit.logo);
    for (const k of ['intro', 'outro']) if (kit[k]) await setBumper(k, kit[k]);
    commit((e) => {
      if (kit.logoOpts) e.brand.logo = { ...e.brand.logo, ...kit.logoOpts, enabled: !!kit.logo };
      if (kit.lowerThird) e.brand.lowerThird = { ...e.brand.lowerThird, ...kit.lowerThird, enabled: !!kit.lowerThird.title };
      if (kit.captions) e.captions = { ...e.captions, ...kit.captions };
      if (kit.style) e.style = { ...e.style, ...kit.style };
    });
    loadWallpaper(S.edit.style.bg);
    toast('Brand kit applied · ⌘Z to undo', 'ok');
  }
  // .slipstream-brand files move a brand kit between browsers and desktop apps (S-02, C-02).
  function brandFileButtons(kit, rerender) {
    const input = h('input', { type: 'file', accept: '.slipstream-brand,application/zip', hidden: true, onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const b = await readBrand(f);
        await setSetting('brandKit', { ...b, updated: Date.now() });
        toast(`Imported brand kit${b.name ? ` “${b.name}”` : ''}`, 'ok');
        rerender();
      } catch (err) { toast(`Couldn’t read that brand kit: ${err.message}`, 'error', 6000); }
    } });
    return h('div.row', kit ? h('button.btn.small', { onclick: async () => downloadBlob(await exportBrand(kit), `${safeName(kit.name || 'brand')}.slipstream-brand`) }, icon('download', 13), 'Export kit') : null,
      h('button.btn.small', { onclick: () => input.click() }, icon('upload', 13), 'Import kit'), input);
  }

  // ---- multi-file: add a separately recorded camera, synced by audio (S-03) -------------------------
  let syncBase = null;
  function nudgeSync(delta) {
    syncBase ??= S.camOffset;
    S.camOffset = Math.round((syncBase + delta) * 1000) / 1000;
    project.media.cameraOffset = S.camOffset;
    seek(S.t);
    save();
  }
  const camerasForExport = () => S.angles.map((a) => ({ id: a.id, blob: a.blob, offset: a.offset }));
  /**
   * Desktop app: recordings the webview couldn't decode are edited from preview copies (main.js desktopPreview);
   * their originals sit beside them (`original`, `camera-original`, `angle-<id>-original`) and only the engine
   * exports them.
   */
  const hasPreviewCopies = () => !!(project.media.original || project.media.cameraOriginal || (project.media.angles || []).some((a) => a.original));
  function saveAngles() {
    project.media.angles = S.angles.map((a) => ({ id: a.id, name: a.name, offset: a.offset, ...(a.speaker ? { speaker: a.speaker } : {}), ...(a.type ? { type: a.type } : {}), ...(a.original ? { original: a.original } : {}) }));
    save();
  }
  async function loadAngles() {
    for (const a of project.media.angles || []) {
      if (a.id === 'camera' || S.angles.some((x) => x.id === a.id)) continue;
      const blob = await getMedia(`${project.id}:angle-${a.id}`, a.type || '').catch(() => null);
      if (!blob) continue;
      const el = h('video', { src: URL.createObjectURL(blob), preload: 'auto', playsInline: true, muted: true });
      el.addEventListener('seeked', () => { S.dirty = true; });
      el.addEventListener('loadeddata', () => { S.dirty = true; });
      mediaBox.append(el);
      S.angles.push({ ...a, el, blob });
    }
    if (rightTabs.value() === 'layout') renderRight();
  }
  function anglesSection() {
    if (S.angles.length < 2) return null;
    const L = S.edit.layout;
    const shown = L.angle || S.angles[0].id;
    const speakers = Object.entries(S.edit.speakers || {});
    const mapping = Object.fromEntries(S.angles.filter((a) => a.speaker).map((a) => [a.speaker, a.id]));
    return section('Camera angles',
      h('ul.zoom-list.angle-list', S.angles.map((a) => h('li', { class: a.id === shown ? 'on' : '' },
        h('span.zl-time', `${a.name}${a.offset ? ` · ${a.offset >= 0 ? '+' : ''}${a.offset.toFixed(2)} s` : ''}`),
        speakers.length ? h('select', { 'aria-label': `Speaker for ${a.name}`, onchange: (e) => { a.speaker = e.target.value || undefined; saveAngles(); renderRight(); } }, h('option', { value: '' }, 'No speaker'), speakers.map(([id, sp]) => h('option', { value: id, selected: a.speaker === id }, sp.name || id))) : null,
        h('button.btn.small', { class: a.id === shown ? 'on' : '', onclick: () => commit((e) => { e.layout.angle = a.id; }) }, a.id === shown ? 'Showing' : 'Show'),
        a.id !== 'camera' ? h('button.icon-btn', { title: `Remove ${a.name}`, 'aria-label': `Remove ${a.name}`, onclick: () => { a.el.pause(); S.angles = S.angles.filter((x) => x !== a); saveAngles(); commit((e) => { if (e.layout.angle === a.id) delete e.layout.angle; e.scenes = (e.scenes || []).filter((sc) => sc.layout?.angle !== a.id); }); } }, icon('x', 13)) : null))),
      Object.keys(mapping).length >= 2
        ? h('button.btn.small', { onclick: () => { const sc = speakerScenes(S.edit.words, mapping, S.duration); commit((e) => { e.scenes = sc; }); toast(`Cut between ${S.angles.length} angles at ${sc.length} speaker turns · ⌘Z to undo`, 'ok'); } }, icon('people', 13), 'Switch angles by speaker')
        : h('p.muted.small', speakers.length ? 'Assign a speaker to each angle to switch automatically when they talk.' : 'Detect speakers in the transcript to switch angles automatically.'),
      addCameraButton());
  }

  function addCameraButton() {
    const input = h('input', { type: 'file', accept: 'video/*,.mov,.mkv', hidden: true, onchange: (e) => e.target.files[0] && addCamera(e.target.files[0], btn) });
    const btn = h('button.btn.small', { onclick: () => input.click() }, icon('camera', 13), 'Add camera recording');
    return h('div.row', btn, input);
  }
  async function addCamera(picked, btn) {
    btn.disabled = true;
    btn.textContent = 'Reading camera…';
    try {
      // Desktop app: a camera file this webview can't decode is edited from a preview copy; the original exports.
      const prepared = await desktopPreview(picked, null, 'camera recording');
      if (!prepared) { btn.disabled = false; btn.replaceChildren(icon('camera', 13), 'Add camera recording'); return; }
      const file = prepared.preview;
      const original = prepared.original ? originalRecord(prepared.original) : null;
      const info = await probe(file);
      if (!info.hasVideo) throw new Error('That file has no video.');
      let offset = 0, note = 'Placed at the start (no audio to match).';
      if (info.hasAudio && S.hasAudio) {
        btn.textContent = 'Matching audio…';
        const screenPcm = S.pcm || (await analyzeAudio(S.screenBlob, S.duration)).pcm;
        S.pcm = screenPcm;
        const cam = await analyzeAudio(file, info.duration);
        const r = screenPcm && cam.pcm ? audioOffset(screenPcm, cam.pcm, 16000, { maxLag: Math.min(300, Math.max(S.duration, info.duration)) }) : null;
        if (r && r.confidence > 0.2) { offset = r.offset; note = `Synced by audio: the camera ${offset >= 0 ? 'starts' : 'started'} ${Math.abs(offset).toFixed(2)} s ${offset >= 0 ? 'after' : 'before'} the screen (match ${Math.round(r.confidence * 100)}%).`; }
        else note = 'Couldn’t match the audio, so the camera starts with the screen. Nudge it in Layout → Camera → Sync.';
      }
      if (S.camBlob) {
        // Already have a camera: add this one as another angle (S-03) without reopening.
        const id = uid('ang');
        if (original) await putMedia(`${project.id}:angle-${id}-original`, picked);
        await putMedia(`${project.id}:angle-${id}`, file);
        const el = h('video', { src: URL.createObjectURL(file), preload: 'auto', playsInline: true, muted: true });
        el.addEventListener('seeked', () => { S.dirty = true; });
        el.addEventListener('loadeddata', () => { S.dirty = true; });
        mediaBox.append(el);
        S.angles.push({ id, name: picked.name.replace(/\.[^.]+$/, '') || `Angle ${S.angles.length + 1}`, offset, el, blob: file, type: file.type, ...(original ? { original } : {}) });
        saveAngles();
        toast(`${note} Added as angle ${S.angles.length}.`, 'ok', 5000);
        btn.disabled = false;
        btn.replaceChildren(icon('camera', 13), 'Add camera recording');
        seek(S.t);
        renderRight();
        return;
      }
      if (original) await putMedia(`${project.id}:camera-original`, picked);
      const stored = await putMedia(`${project.id}:camera`, file);
      Object.assign(project.media, { camera: true, cameraOffset: offset, cameraType: file.type || stored.type || '', cameraName: file.name || 'camera' });
      if (original) project.media.cameraOriginal = original; else delete project.media.cameraOriginal;
      project.edit = S.edit;
      if (S.edit.layout.mode === 'screen') S.edit.layout.mode = 'pip';
      await saveNow();
      toast(`${note} Reopening with the camera…`, 'ok', 5000);
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      toast(`Couldn’t add the camera: ${err.message}`, 'error', 6000);
      btn.disabled = false;
      btn.replaceChildren(icon('camera', 13), 'Add camera recording');
    }
  }

  // ---- translated subtitles (A-06) ------------------------------------------------------------------
  const langLabel = (code) => TRANSLATION_LANGS.find((l) => l.code === code)?.label || code;
  function translateSection() {
    const C = S.edit.captions;
    const source = C.source || 'en';
    const done = Object.keys(C.translations || {});
    const targets = translationTargets(source);
    let target = targets.find((l) => !done.includes(l.code))?.code || targets[0]?.code;
    const status = h('p.muted.small');
    const sizeNote = () => { const r = target && translationModel(source, target); status.textContent = r ? `${r.sizeMB} MB model, downloaded once and cached. Runs on this device.` : 'No on-device model for this pair.'; };
    const go = h('button.btn.small', { onclick: () => runTranslate(source, target, go, status) }, icon('translate', 13), 'Translate');
    sizeNote();
    return section('Translate',
      h('label.field', h('span', 'Spoken language'), h('select', { onchange: (e) => commit((ed) => { ed.captions.source = e.target.value; }) }, TRANSLATION_LANGS.map((l) => h('option', { value: l.code, selected: l.code === source }, l.label)))),
      h('div.row', h('select', { 'aria-label': 'Translate captions into', onchange: (e) => { target = e.target.value; sizeNote(); } }, targets.map((l) => h('option', { value: l.code, selected: l.code === target }, `${l.label}${done.includes(l.code) ? ' ✓' : ''}`))), go),
      status,
      done.length ? h('div.field', h('span', 'Show and export captions in'), segmented([['', langLabel(source)], ...done.map((c) => [c, langLabel(c)])], C.language || '', (v) => commit((ed) => { ed.captions.language = v || null; }), 'tiny')) : null,
      done.length ? h('p.muted.small', 'Translations keep the original timings. Re-translate after big transcript edits.') : null);
  }
  async function runTranslate(source, target, btn, status) {
    if (!target) return;
    btn.disabled = true;
    try {
      const cues = S.sourceCues.map(({ start, end, text }) => ({ start, end, text }));
      S.job = translateCues(cues, {
        source, target,
        onDownload: (loaded, total) => { status.textContent = `Downloading ${langLabel(target)} model once · ${fmtBytes(loaded)} of ${fmtBytes(total)}`; },
        onReady: () => { status.textContent = 'Translating on this device…'; },
        onProgress: (p) => { status.textContent = `Translating on this device… ${Math.round(p * 100)}%`; },
      });
      const out = await S.job.promise;
      S.job = null;
      commit((ed) => { ed.captions.translations = { ...(ed.captions.translations || {}), [target]: out }; ed.captions.language = target; });
      toast(`Captions translated to ${langLabel(target)} · switch languages under Captions → Translate`, 'ok', 4000);
    } catch (err) {
      S.job = null;
      if (err.name !== 'AbortError') { status.textContent = `Translation failed: ${err.message}`; }
    } finally { btn.disabled = false; }
  }

  // ---- Music (S-04): one bed under the whole video, on the output timeline -----------------------------
  const musicKey = () => `${project.id}:music`;
  function attachMusic(blob) {
    if (S.musicEl) { S.musicEl.pause(); URL.revokeObjectURL(S.musicEl.src); S.musicEl.remove(); }
    S.musicBlob = blob;
    S.musicEl = blob ? h('audio', { src: URL.createObjectURL(blob), preload: 'auto' }) : null;
    if (S.musicEl) {
      S.musicEl.addEventListener('loadedmetadata', () => { if (rightTabs.value() === 'music') renderRight(); });
      mediaBox.append(S.musicEl);
    }
  }
  async function loadMusic() {
    const blob = await getMedia(musicKey(), S.edit.music?.type || '').catch(() => null);
    if (blob) attachMusic(blob);
  }
  async function setMusic(blob, { prompt, generatedBy, name } = {}) {
    if (!blob.type.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i.test(blob.name || '')) throw new Error('That doesn’t look like an audio file.');
    await putMedia(musicKey(), blob);
    attachMusic(blob);
    const keep = S.edit.music ? { volume: S.edit.music.volume, duck: S.edit.music.duck, duckLevel: S.edit.music.duckLevel } : {};
    const item = { id: uid('mu'), assetId: 'music', type: blob.type || 'audio/mpeg', name: name || blob.name || 'Music', ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)), ...(prompt ? { prompt } : {}), ...(generatedBy ? { generatedBy } : {}) };
    commit((e) => { e.music = item; }, { rerender: 'none' });
    renderRight();
    toast(`${generatedBy ? 'Generated music' : `“${item.name}”`} added under the whole video`, 'ok');
  }
  function renderMusic() {
    const M = S.edit.music;
    const set = (fn) => commit((e) => { if (e.music) fn(e.music); }, { rerender: 'none' });
    const file = h('input', { type: 'file', accept: 'audio/*,.mp3,.m4a,.wav,.ogg,.flac', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (f) setMusic(f).catch((err) => toast(err.message, 'error')); } });
    const genHost = h('div.stack');
    const about = h('p.muted.small', 'A music bed plays under the whole video (after your cuts), loops if it’s shorter, fades in and out, and gets quieter while you talk.');
    if (!M) {
      fill(rightBody, section('Music', about, h('div.row', h('button.btn.small', { onclick: () => file.click() }, icon('upload', 13), 'Add a song…'), file)), section('Generate', genHost));
      renderMusicGenerate(genHost);
      return;
    }
    const m = musicSettings(M);
    const songLen = S.musicEl?.duration || 0;
    fill(rightBody,
      section('Music',
        h('div.row.music-row', icon('music', 15), h('span.grow', M.name || 'Music'), M.generatedBy ? h('span.tag', 'Generated') : null),
        !S.musicBlob ? h('p.warn.small', 'The audio file for this music isn’t in this browser. Add it again to hear and export it.') : null,
        h('div.row', h('button.btn.small', { onclick: () => file.click() }, 'Replace…'), file,
          h('button.btn.small.danger', { onclick: () => { commit((e) => { delete e.music; }); renderRight(); } }, icon('trash', 13), 'Remove'))),
      section('Mix',
        slider('Volume', { min: 0, max: 1, step: 0.01, value: m.volume, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((x) => { x.volume = v; }) }),
        toggle('Quieter while you talk', m.duck, (v) => { set((x) => { x.duck = v; }); renderRight(); }),
        m.duck ? slider('While talking', { min: 0, max: 1, step: 0.05, value: m.duckLevel, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((x) => { x.duckLevel = v; }) }) : null,
        slider('Fade in', { min: 0, max: 6, step: 0.1, value: m.fadeIn, format: (v) => `${v.toFixed(1)} s`, onInput: (v) => set((x) => { x.fadeIn = v; }) }),
        slider('Fade out', { min: 0, max: 8, step: 0.1, value: m.fadeOut, format: (v) => `${v.toFixed(1)} s`, onInput: (v) => set((x) => { x.fadeOut = v; }) }),
        songLen > 2 ? slider('Start the song at', { min: 0, max: Math.max(0, Math.floor(songLen - 1)), step: 0.5, value: Math.min(m.trimIn, songLen - 1), format: (v) => fmtTime(v), onInput: (v) => set((x) => { x.trimIn = v; }) }) : null,
        toggle('Loop when the video is longer', m.loop, (v) => set((x) => { x.loop = v; }))),
      section('Generate', genHost));
    renderMusicGenerate(genHost);
  }
  async function renderMusicGenerate(host) {
    const prov = await musicProvider().catch(() => null);
    if (!prov) {
      fill(host, h('p.muted.small', 'Make a track from a prompt with your own ElevenLabs key. Optional and off by default; only your prompt and the length are sent.'),
        h('button.btn.small', { onclick: async () => { if (await openCloudSettings()) renderRight(); } }, icon('sparkles', 13), 'Set up a provider…'));
      return;
    }
    const prompt = h('textarea', { rows: 3, placeholder: 'e.g. Calm lo-fi beat, warm keys, no vocals, steady 85 BPM', maxLength: 2000, 'aria-label': 'Music prompt' });
    const len = Math.min(600, Math.max(10, Math.ceil(totalDuration(S.kept))));
    const status = h('span.muted.small');
    let ctrl = null;
    const go = h('button.btn.small.primary', { onclick: async () => {
      if (!prompt.value.trim()) { prompt.focus(); return; }
      ctrl = new AbortController();
      go.disabled = true;
      try {
        const blob = await generateMusic(prov, { prompt: prompt.value.trim(), seconds: len, signal: ctrl.signal, onStatus: (t) => { status.textContent = t; } });
        await setMusic(new File([blob], 'Generated music.mp3', { type: blob.type || 'audio/mpeg' }), { prompt: prompt.value.trim(), generatedBy: prov.id, name: 'Generated music' });
      } catch (err) {
        status.textContent = err.name === 'AbortError' ? 'Cancelled.' : err.message;
      } finally { go.disabled = false; }
    } }, icon('sparkles', 13), `Generate ${fmtTime(len)} of music`);
    fill(host, h('div.row', h('span.cp-badge.cloud', icon('info', 11), `Cloud · ${prov.label}`), h('button.link.small', { onclick: async () => { if (await openCloudSettings()) renderRight(); } }, 'Settings')),
      h('p.muted.small', 'Only this prompt and the length are sent. The track is saved with the project on this device.'), prompt, h('div.row', go, status));
  }

  // ---- B-roll (S-04): local or generated images and clips over the screen ---------------------------
  const brollKey = (id) => `${project.id}:broll-${id}`;
  async function loadBroll() {
    for (const b of S.edit.broll || []) {
      if (S.brollMedia[b.id]) continue;
      const blob = await getMedia(brollKey(b.id), b.type || '').catch(() => null);
      if (blob) await attachBroll(b, blob);
    }
    S.dirty = true;
  }
  async function attachBroll(b, blob) {
    S.brollMedia[b.id] = blob;
    if (b.kind === 'video') {
      const el = h('video', { src: URL.createObjectURL(blob), muted: true, playsInline: true, preload: 'auto' });
      el.addEventListener('loadeddata', () => { S.dirty = true; });
      el.addEventListener('seeked', () => { S.dirty = true; });
      mediaBox.append(el);
      S.brollEls[b.id] = el;
    } else {
      S.brollEls[b.id] = await createImageBitmap(blob).catch(() => null);
    }
  }
  /** Drawables for the compositor at time t; keeps B-roll clips in step with the playhead. */
  function brollFrame(t) {
    const out = {};
    for (const b of S.edit.broll || []) {
      const el = S.brollEls[b.id];
      if (!el) continue;
      const active = t >= b.start && t < b.end;
      if (el instanceof HTMLVideoElement) {
        if (!active) { if (!el.paused) el.pause(); continue; }
        const want = (b.trimIn || 0) + (t - b.start);
        if (Math.abs(el.currentTime - want) > (S.playing ? 0.25 : 0.04)) el.currentTime = want;
        if (S.playing && el.paused) el.play().catch(() => {});
        if (!S.playing && !el.paused) el.pause();
        if (el.readyState >= 2) out[b.id] = el;
      } else if (active) out[b.id] = el;
    }
    return out;
  }
  async function addBroll(blob, { kind, prompt, generatedBy, at = S.t } = {}) {
    kind ??= blob.type.startsWith('video') ? 'video' : 'image';
    let len = 4;
    if (kind === 'video') {
      const probeEl = h('video', { src: URL.createObjectURL(blob), muted: true, preload: 'metadata' });
      len = await new Promise((r) => { probeEl.onloadedmetadata = () => r(Number.isFinite(probeEl.duration) ? probeEl.duration : 4); probeEl.onerror = () => r(4); });
      URL.revokeObjectURL(probeEl.src);
    }
    const start = Math.max(0, Math.min(at, S.duration - 0.5));
    const item = { id: uid('br'), assetId: '', start, end: Math.min(S.duration, start + len), kind, fit: 'cover', opacity: 1, area: 'screen', type: blob.type, ...(prompt ? { prompt } : {}), ...(generatedBy ? { generatedBy } : {}) };
    item.assetId = `broll-${item.id}`;
    await putMedia(brollKey(item.id), blob);
    await attachBroll(item, blob);
    commit((e) => { e.broll = [...(e.broll || []), item]; });
    S.selBroll = item.id;
    rightTabs.select('broll');
    toast(`${kind === 'video' ? 'Clip' : 'Image'} added at ${fmtTime(start)} · drag it on the B-roll lane`, 'ok');
  }
  function renderBroll() {
    const items = [...(S.edit.broll || [])].sort((a, b) => a.start - b.start);
    const file = h('input', { type: 'file', accept: 'image/*,video/*', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (f) addBroll(f).catch((err) => toast(err.message, 'error')); } });
    const genHost = h('div.stack');
    fill(rightBody,
      section('B-roll', h('p.muted.small', 'Cut away to an image or clip while you keep talking. B-roll covers the screen area (or the whole frame) and fades in and out.'),
        h('div.row', h('button.btn.small', { onclick: () => file.click() }, icon('upload', 13), 'Add image or clip'), file)),
      section('Generate', genHost),
      items.length ? section('On the timeline', h('ul.zoom-list.broll-list', items.map((b) => h('li', { class: b.id === S.selBroll ? 'on' : '', onclick: (ev) => { if (ev.target.closest('.seg, button')) return; S.selBroll = b.id; seek(b.start + 0.05); renderRight(); tl.refresh(); } },
        h('span.zl-time', `${fmtTime(b.start)}–${fmtTime(b.end)} · ${b.kind === 'video' ? 'clip' : 'image'}${b.generatedBy ? ' · generated' : ''}`),
        segmented([['screen', 'Screen'], ['full', 'Full frame']], b.area || 'screen', (v) => commit((e) => { const q = e.broll.find((x) => x.id === b.id); if (q) q.area = v; }, { rerender: 'none' }), 'tiny'),
        segmented([['cover', 'Fill'], ['contain', 'Fit']], b.fit || 'cover', (v) => commit((e) => { const q = e.broll.find((x) => x.id === b.id); if (q) q.fit = v; }, { rerender: 'none' }), 'tiny'),
        h('button.icon-btn', { title: 'Remove', 'aria-label': `Remove B-roll at ${fmtTime(b.start)}`, onclick: () => commit((e) => { e.broll = e.broll.filter((x) => x.id !== b.id); }) }, icon('x', 13)))))) : null);
    renderGenerate(genHost);
  }
  async function renderGenerate(host) {
    const prov = await mediaProvider().catch(() => null);
    if (!prov) {
      fill(host, h('p.muted.small', 'Generate images or short clips from a prompt with your own OpenRouter, Higgsfield or OpenAI-compatible key. Optional and off by default; only your prompt is sent.'),
        h('button.btn.small', { onclick: async () => { if (await openCloudSettings()) renderRight(); } }, icon('sparkles', 13), 'Set up a provider…'));
      return;
    }
    const aspect = S.edit.aspect === '9:16' || S.edit.aspect === '4:5' ? '9:16' : S.edit.aspect === '1:1' ? '1:1' : '16:9';
    let kind = prov.video ? (S.gen?.kind || 'video') : 'image';
    let duration = 4;
    const prompt = h('textarea', { rows: 3, placeholder: 'e.g. Slow dolly over a tidy desk with a laptop showing charts, morning light', 'aria-label': 'Prompt' });
    const status = h('p.muted.small');
    const go = h('button.btn.small.primary', { onclick: () => runGenerate(prov, { kind, prompt: prompt.value.trim(), aspect, duration }, status, go) }, icon('sparkles', 13), 'Generate');
    const dur = h('div', segmented([[4, '4 s'], [6, '6 s'], [8, '8 s']], duration, (v) => { duration = v; }, 'tiny'));
    dur.hidden = kind !== 'video';
    fill(host,
      h('div.row', h('span.cp-badge.cloud', icon('info', 11), `Cloud · ${prov.label}`), h('button.link.small', { onclick: async () => { if (await openCloudSettings()) renderRight(); } }, 'Settings')),
      prov.video ? segmented([['video', 'Clip'], ['image', 'Image']], kind, (v) => { kind = v; dur.hidden = v !== 'video'; }, 'tiny') : null,
      prompt,
      prov.video ? dur : null,
      h('div.row', go, S.gen ? h('button.btn.small', { onclick: () => S.gen?.ctrl.abort() }, 'Cancel') : null),
      status,
      h('p.muted.small', `Only the prompt is sent to ${prov.label}; it’s billed to your account. ${aspect} to match this project.`));
    if (S.gen) status.textContent = S.gen.status;
  }
  async function runGenerate(prov, { kind, prompt, aspect, duration }, status, btn) {
    if (!prompt) { toast('Describe what to generate first', 'error'); return; }
    if (prov.desktopOnly && !globalThis.slipstreamDesktop) { status.textContent = `${prov.label} only accepts calls from apps. Use the Slipstream desktop app, or pick OpenRouter in Settings.`; return; }
    const at = S.t;
    btn.disabled = true;
    S.gen = { ctrl: new AbortController(), status: 'Starting…', kind };
    try {
      const blob = await generateMedia(prov, { kind, prompt, aspect, duration, signal: S.gen.ctrl.signal, onStatus: (t) => { S.gen.status = t; status.textContent = t; } });
      const model = kind === 'video' ? prov.config.videoModel : prov.config.imageModel;
      await addBroll(blob, { kind, prompt, generatedBy: `${prov.id}:${model}`, at });
    } catch (err) {
      status.textContent = err.name === 'AbortError' ? 'Cancelled.' : `Couldn’t generate: ${err.message}`;
    } finally {
      S.gen = null;
      btn.disabled = false;
    }
  }

  // ---- loudness (M-01/T-01 web half): one gain for preview and export ---------------------------------
  let previewAudio = null;
  function ensurePreviewGain() {
    if (previewAudio || !S.hasAudio) { updatePreviewGain(); return; }
    try {
      const ac = new AudioContext();
      const gain = ac.createGain();
      ac.createMediaElementSource(screenEl).connect(gain).connect(ac.destination);
      previewAudio = { ac, gain };
      updatePreviewGain();
    } catch { /* element already routed or audio blocked: preview plays at the original level */ }
  }
  let lastLoud = null;
  function measureLoudness(kept) {
    if (!S.pcm) return null;
    const key = JSON.stringify(kept);
    if (lastLoud?.key === key) return lastLoud.r;
    const r = integratedLoudness([keptPcm(S.pcm, 16000, kept)], 16000);
    // S.pcm is a mono downmix; BS.1770 sums channel energy, so a stereo recording of one voice (the usual case)
    // reads 10·log10(channels) dB louder than its downmix. Older projects didn't store the count: assume stereo.
    const ch = project.media.audioChannels || 2;
    if (Number.isFinite(r.lufs) && ch > 1) r.lufs += 10 * Math.log10(ch);
    lastLoud = { key, r };
    return r;
  }
  function gainDbFor(edit, kept) {
    if (!S.hasAudio || edit.audio?.normalize === false) return 0;
    const r = measureLoudness(kept);
    return r ? normalizationGain(r, { target: edit.audio?.loudnessLufs ?? -14 }) : 0;
  }
  async function loudnessGainFor(edit, kept) {
    if (!S.hasAudio || edit.audio?.normalize === false) return 0;
    if (!S.pcm) S.pcm = (await analyzeAudio(S.screenBlob, S.duration).catch(() => ({}))).pcm || null;
    return gainDbFor(edit, kept);
  }
  function updatePreviewGain() {
    if (previewAudio) previewAudio.gain.gain.value = Math.pow(10, gainDbFor(S.edit, S.kept) / 20);
  }
  function soundNote() {
    if (!S.pcm && S.hasAudio && !S.pcmLoading) {
      S.pcmLoading = analyzeAudio(S.screenBlob, S.duration).then((res) => { S.pcm = res.pcm; if (!S.peaks) S.peaks = res.peaks; if (rightTabs.value() === 'style') renderRight(); }).catch(() => {});
    }
    const r = measureLoudness(S.kept);
    if (!r || !Number.isFinite(r.lufs)) return 'Measures the edited audio and sets one gain so it plays at the level YouTube, TikTok and Instagram use, without clipping.';
    const g = gainDbFor(S.edit, S.kept);
    return `Edited audio measures ${r.lufs.toFixed(1)} LUFS (peak ${r.samplePeakDb.toFixed(1)} dBFS); export applies ${g >= 0 ? '+' : ''}${g.toFixed(1)} dB.`;
  }

  async function runAutoZoom(btn, sensitivity) {
    btn.disabled = true;
    const label = btn.innerHTML;
    try {
      // Recorded clicks (desktop app, T-04) beat guessing from the picture.
      const cursor = project.media?.cursor;
      if (hasCursorClicks(cursor?.samples)) {
        const zooms = zoomsFromCursor(cursor.samples, S.duration);
        commit((e) => { e.zooms = [...e.zooms.filter((z) => !z.auto), ...zooms]; });
        toast(zooms.length ? `Added ${zooms.length} zoom${zooms.length > 1 ? 's' : ''} from your clicks — drag them on the timeline to adjust` : 'No clicks to zoom on in this recording', zooms.length ? 'ok' : 'info');
        return;
      }
      const events = await activityEvents(S.screenBlob, S.duration, { onProgress: (p) => { btn.textContent = `Analyzing screen… ${Math.round(p * 100)}%`; } });
      rememberActivity(events);
      const zooms = zoomsFromActivity(events, S.duration, { sensitivity });
      commit((e) => { e.zooms = [...e.zooms.filter((z) => !z.auto), ...zooms]; });
      toast(zooms.length ? `Added ${zooms.length} zoom${zooms.length > 1 ? 's' : ''} — drag them on the timeline to adjust` : 'No focused activity found — try higher sensitivity', zooms.length ? 'ok' : 'info');
    } catch (err) {
      toast(`Auto-zoom failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  function downloadSubs(kind) {
    const cues = remapCues(S.cues, S.kept);
    const text = kind === 'srt' ? toSRT(cues) : toVTT(cues);
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${safeName(project.name)}.${kind}`);
  }

  // ---- timeline --------------------------------------------------------------------------------
  function buildTimeline() {
    const coarse = matchMedia('(pointer: coarse)').matches;
    const LANES = { ruler: 22, wave: 64, zoom: coarse ? 34 : 26, scene: coarse ? 30 : 22, notes: coarse ? 30 : 22, broll: coarse ? 30 : 22, cap: 22 };
    const hasCamLane = !!S.camBlob;
    const heads = h('div.tl-heads', h('div', { style: { height: `${LANES.ruler}px` } }), h('div.tl-label', { style: { height: `${LANES.wave}px` } }, icon('film', 13), 'Video'), h('div.tl-label', { style: { height: `${LANES.zoom}px` } }, icon('zoom', 13), 'Zoom'), hasCamLane ? h('div.tl-label', { style: { height: `${LANES.scene}px` } }, icon('scenes', 13), 'Scenes') : null, h('div.tl-label', { style: { height: `${LANES.notes}px` } }, icon('annotate', 13), 'Annotate'), h('div.tl-label', { style: { height: `${LANES.broll}px` } }, icon('image', 13), 'B-roll'), h('div.tl-label', { style: { height: `${LANES.cap}px` } }, icon('captions', 13), 'Captions'));
    const cv = h('canvas.tl-canvas');
    const cg = cv.getContext('2d');
    const cutsLayer = h('div.tl-cuts', { role: 'group', 'aria-label': 'Cuts. Each cut can be clicked to restore it.' });
    const selLayer = h('div.tl-sel', { hidden: true });
    const propLayer = h('div.tl-props', { 'aria-hidden': 'true' });
    const zoomLane = h('div.tl-lane.zoom', { style: { height: `${LANES.zoom}px` }, role: 'group', 'aria-label': 'Zoom lane. Tab to a zoom, arrow keys move it, Shift+arrows resize, Delete removes.' });
    const brollLane = h('div.tl-lane.broll', { style: { height: `${LANES.broll}px` }, role: 'group', 'aria-label': 'B-roll lane: images and clips over the screen' });
    const notesLane = h('div.tl-lane.notes', { style: { height: `${LANES.notes}px` }, role: 'group', 'aria-label': 'Annotate lane: privacy masks and annotations. Drag to move, drag the edges to change when they show.' });
    const sceneLane = hasCamLane ? h('div.tl-lane.scene', { style: { height: `${LANES.scene}px` }, role: 'group', 'aria-label': 'Scenes lane: per-segment camera layouts' }) : null;
    const capLane = h('div.tl-lane.cap', { style: { height: `${LANES.cap}px` }, role: 'group', 'aria-label': 'Captions lane' });
    const ph = h('div.tl-playhead', h('span'));
    const inner = h('div.tl-inner', cv, h('div.tl-lane.ruler', { style: { height: `${LANES.ruler}px` }, title: 'Drag to scrub (with sound)' }), h('div.tl-lane.wave', { style: { height: `${LANES.wave}px` }, role: 'group', 'aria-label': 'Video and audio. Drag to select a range, Shift-drag to extend it.' }, cutsLayer, propLayer, selLayer), zoomLane, sceneLane, notesLane, brollLane, capLane, ph);
    const view = h('div.tl-view', inner);
    const zoomIn = slider('', { min: 1, max: 60, step: 1, value: 1, format: () => '', onInput: (v) => { setScale(v); } });
    const selActions = h('div.tl-actions', { hidden: true });
    const el = h('section.timeline', h('div.tl-bar', h('div.tl-bar-left', h('span.tl-title', 'Timeline'), h('span.muted.small', 'Drag to select · Del cuts · Z zooms · C sets clip')), selActions, h('div.tl-scale', icon('search', 13), zoomIn)), h('div.tl-body', heads, view));
    let mult = 1;

    function setScale(m) {
      const center = (view.scrollLeft + view.clientWidth / 2) / (S.pps || 1);
      mult = m;
      S.pps = S.fitPps * mult;
      layout();
      view.scrollLeft = Math.max(0, center * S.pps - view.clientWidth / 2);
    }
    function resize() {
      const w = view.clientWidth || 600;
      S.fitPps = (w - 16) / Math.max(1, S.duration);
      S.pps = S.fitPps * mult;
      layout();
    }
    function x(t) { return t * S.pps; }
    function layout() {
      inner.style.width = `${Math.max(view.clientWidth, x(S.duration) + 16)}px`;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = view.clientWidth, hgt = LANES.ruler + LANES.wave;
      cv.style.width = `${w}px`; cv.style.height = `${hgt}px`; cv.style.marginBottom = `${-hgt}px`;
      cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr);
      refresh();
    }
    function drawCanvas() {
      const dpr = cv.width / (cv.clientWidth || 1);
      cg.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = cv.clientWidth, sl = view.scrollLeft;
      cg.clearRect(0, 0, w, LANES.ruler + LANES.wave);
      // ruler
      const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      const step = steps.find((s) => s * S.pps >= 70) || 600;
      cg.fillStyle = 'rgba(255,255,255,0.45)';
      cg.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const t0 = Math.floor(sl / S.pps / step) * step;
      for (let t = t0; t <= (sl + w) / S.pps; t += step) {
        const px = x(t) - sl;
        cg.fillRect(px, 14, 1, 8);
        cg.fillText(fmtTime(t, step < 1), px + 4, 11);
        for (let k = 1; k < 4; k++) cg.fillRect(px + (step * S.pps * k) / 4, 18, 1, 4);
      }
      // filmstrip (W-05): thumbnails tiled under the waveform
      const top = LANES.ruler, mid = top + LANES.wave / 2, amp = LANES.wave / 2 - 6;
      cg.fillStyle = 'rgba(255,255,255,0.025)';
      cg.fillRect(0, top + 3, w, LANES.wave - 6);
      if (strip.frames.length) {
        const th = LANES.wave - 6, tw = Math.max(24, th * strip.aspect);
        cg.save();
        cg.globalAlpha = 0.34;
        for (let px = -(sl % tw); px < w; px += tw) {
          const t = (sl + px + tw / 2) / S.pps;
          const f = strip.frames[Math.max(0, Math.min(strip.frames.length - 1, Math.round(t / strip.step)))];
          if (f) cg.drawImage(f, px, top + 3, tw - 1, th);
        }
        cg.restore();
      }
      if (S.peaks && S.peaks.length) {
        const per = PEAKS_PER_SEC / S.pps;
        cg.fillStyle = 'rgba(160,166,255,0.62)';
        for (let px = 0; px < w; px++) {
          const a = Math.floor((sl + px) * per), b = Math.max(a + 1, Math.floor((sl + px + 1) * per));
          let m = 0;
          for (let i = a; i < b && i < S.peaks.length; i++) if (S.peaks[i] > m) m = S.peaks[i];
          const hh = Math.max(1, Math.min(1, m * 1.4) * amp);
          cg.fillRect(px, mid - hh, 1, hh * 2);
        }
      } else {
        cg.fillStyle = 'rgba(255,255,255,0.25)';
        cg.fillText('Analyzing audio…', 10, mid + 3);
      }
    }
    function refresh() {
      drawCanvas();
      const props = S.proposed ? S.edit.words.filter((w) => S.proposed.has(String(w.id))) : [];
      propLayer.replaceChildren(...mergeRanges(props.map((w) => ({ start: w.start, end: w.end })), 0.3).map((r) => h('div.tl-prop', { style: { left: `${x(r.start)}px`, width: `${Math.max(2, x(r.end) - x(r.start))}px` }, title: 'Proposed cut' })));
      cutsLayer.replaceChildren(...S.cuts.map((c) => h('div.tl-cut', { style: { left: `${x(c.start)}px`, width: `${Math.max(2, x(c.end) - x(c.start))}px` }, title: `Cut ${fmtTime(c.start, true)}–${fmtTime(c.end, true)} · click to restore`, onpointerdown: (e) => { e.stopPropagation(); }, onclick: () => restoreCut(c) })));
      zoomLane.replaceChildren(...S.edit.zooms.map((z) => zoomBlock(z)));
      sceneLane?.replaceChildren(...(S.edit.scenes || []).map((sc) => sceneBlock(sc)));
      const pickOverlay = (list, id) => { S.selOverlay = { list, id }; if (rightTabs.value() !== 'annotate') rightTabs.select('annotate'); else renderRight(); S.dirty = true; refresh(); };
      notesLane.replaceChildren(
        ...(S.edit.masks || []).map((m) => rangeBlock(m, { cls: `tl-note mask${m.id === S.selOverlay?.id ? ' on' : ''}`, label: TOOL_LABEL[m.mode] || 'Blur', list: 'masks', min: 0.2, select: () => pickOverlay('masks', m.id) })),
        ...(S.edit.annotations || []).map((a) => rangeBlock(a, { cls: `tl-note ann${a.id === S.selOverlay?.id ? ' on' : ''}`, label: TOOL_LABEL[a.kind] || a.kind, list: 'annotations', min: 0.2, select: () => pickOverlay('annotations', a.id) })));
      brollLane.replaceChildren(...(S.edit.broll || []).map((b) => rangeBlock(b, {
        cls: `tl-broll${b.id === S.selBroll ? ' on' : ''}`, label: b.kind === 'video' ? 'Clip' : 'Image', list: 'broll', min: 0.5,
        select: () => { S.selBroll = b.id; rightTabs.select('broll'); refresh(); },
      })));
      capLane.replaceChildren(...(S.edit.captions.enabled ? S.cues : []).map((c) => h('div.tl-cue', { style: { left: `${x(c.start)}px`, width: `${Math.max(2, x(c.end) - x(c.start) - 1)}px` }, title: c.text })));
      if (S.sel) {
        selLayer.hidden = false;
        selLayer.style.left = `${x(S.sel.start)}px`;
        selLayer.style.width = `${x(S.sel.end) - x(S.sel.start)}px`;
        selActions.hidden = false;
        selActions.replaceChildren(h('span.muted.small', `${(S.sel.end - S.sel.start).toFixed(1)}s selected`),
          h('button.btn.small', { onclick: () => cutSelection() }, icon('scissors', 13), 'Cut'),
          h('button.btn.small', { onclick: () => zoomSelection() }, icon('zoom', 13), 'Zoom'),
          h('button.btn.small', { onclick: () => clipSelection() }, icon('film', 13), 'Clip'),
          hasCamLane ? h('button.btn.small', { title: 'Change the camera layout for this range', onclick: () => { const r = S.sel; S.sel = null; addSceneAt(r.start, r.end); } }, icon('scenes', 13), 'Scene') : null,
          h('button.icon-btn', { title: 'Clear selection', onclick: () => { S.sel = null; refresh(); } }, icon('x', 14)));
      } else { selLayer.hidden = true; selActions.hidden = true; }
      playhead();
    }
    function playhead() {
      ph.style.transform = `translateX(${x(S.t)}px)`;
      if (S.playing) {
        const px = x(S.t) - view.scrollLeft;
        if (px > view.clientWidth - 40 || px < 0) view.scrollLeft = x(S.t) - 60;
      }
    }
    function zoomBlock(z) {
      const b = h('div.tl-zoom', { class: z.id === S.selZoom ? 'on' : '', tabIndex: 0, role: 'button', 'aria-label': `Zoom ${z.scale.toFixed(1)}× from ${fmtTime(z.start)} to ${fmtTime(z.end)}${z.auto ? ', automatic' : ''}`, style: { left: `${x(z.start)}px`, width: `${Math.max(8, x(z.end) - x(z.start))}px` } },
        h('span.zh.l'), h('span.zlabel', `${z.scale.toFixed(1)}×`), h('span.zh.r'));
      b.addEventListener('keydown', (e) => {
        const step = e.altKey ? 0.04 : 0.25;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.selZoom = z.id; seek(z.start + 0.4); renderRight(); rightTabs.select('zoom'); refresh(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); commit((ed) => { ed.zooms = ed.zooms.filter((q) => q.id !== z.id); }); S.selZoom = null; renderRight(); return; }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault(); e.stopPropagation();
        const d = e.key === 'ArrowLeft' ? -step : step;
        commit((ed) => {
          const q = ed.zooms.find((v) => v.id === z.id);
          if (!q) return;
          if (e.shiftKey) q.end = Math.min(S.duration, Math.max(q.start + 0.6, q.end + d));
          else { const len = q.end - q.start; q.start = Math.max(0, Math.min(S.duration - len, q.start + d)); q.end = q.start + len; }
          q.auto = false;
        }, { rerender: 'none' });
        S.selZoom = z.id;
        setTimeout(() => [...zoomLane.children][S.edit.zooms.findIndex((q) => q.id === z.id)]?.focus(), 0);
      });
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
        const startX = e.clientX, s0 = z.start, e0 = z.end;
        let moved = false;
        const snapshot = JSON.stringify(S.edit);
        b.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dt = (ev.clientX - startX) / S.pps;
          if (Math.abs(ev.clientX - startX) > 2) moved = true;
          const zz = S.edit.zooms.find((q) => q.id === z.id);
          if (!zz) return;
          if (mode === 'move') { const len = e0 - s0; zz.start = Math.max(0, Math.min(S.duration - len, s0 + dt)); zz.end = zz.start + len; }
          if (mode === 'l') zz.start = Math.max(0, Math.min(zz.end - 0.6, s0 + dt));
          if (mode === 'r') zz.end = Math.min(S.duration, Math.max(zz.start + 0.6, e0 + dt));
          zz.auto = false;
          b.style.left = `${x(zz.start)}px`; b.style.width = `${x(zz.end) - x(zz.start)}px`;
          S.dirty = true;
        };
        const up = () => {
          b.removeEventListener('pointermove', move);
          b.removeEventListener('pointerup', up);
          S.selZoom = z.id;
          if (moved) { S.undo.push(snapshot); S.redo = []; afterChange('none'); }
          else { seek(z.start + 0.4); refresh(); }
          renderRight();
          if (rightTabs.value() !== 'zoom') rightTabs.select('zoom');
        };
        b.addEventListener('pointermove', move);
        b.addEventListener('pointerup', up);
      });
      return b;
    }
    /** Generic draggable range block (move, resize from either edge) for edit[list] items. */
    function rangeBlock(item, { cls, label, list, min = 0.5, select }) {
      const b = h(`div.${cls.split(' ')[0]}`, { class: cls.split(' ').slice(1).join(' '), tabIndex: 0, role: 'button', 'aria-label': `${label} from ${fmtTime(item.start)} to ${fmtTime(item.end)}`, style: { left: `${x(item.start)}px`, width: `${Math.max(8, x(item.end) - x(item.start))}px` } },
        h('span.zh.l'), h('span.zlabel', label), h('span.zh.r'));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seek(item.start + 0.05); select(); }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); commit((ed) => { ed[list] = ed[list].filter((q) => q.id !== item.id); }); }
      });
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
        const startX = e.clientX, s0 = item.start, e0 = item.end;
        let moved = false;
        const snapshot = JSON.stringify(S.edit);
        b.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dt = (ev.clientX - startX) / S.pps;
          if (Math.abs(ev.clientX - startX) > 2) moved = true;
          const q = S.edit[list].find((v) => v.id === item.id);
          if (!q) return;
          if (mode === 'move') { const len = e0 - s0; q.start = Math.max(0, Math.min(S.duration - len, s0 + dt)); q.end = q.start + len; }
          if (mode === 'l') { const ns = Math.max(0, Math.min(q.end - min, s0 + dt)); if (q.kind === 'video') q.trimIn = Math.max(0, (q.trimIn || 0) + (ns - q.start)); q.start = ns; }
          if (mode === 'r') q.end = Math.min(S.duration, Math.max(q.start + min, e0 + dt));
          b.style.left = `${x(q.start)}px`; b.style.width = `${x(q.end) - x(q.start)}px`;
          S.dirty = true;
        };
        const up = () => {
          b.removeEventListener('pointermove', move);
          b.removeEventListener('pointerup', up);
          if (moved) { S.undo.push(snapshot); S.redo = []; afterChange('none'); } else seek(item.start + 0.05);
          select();
        };
        b.addEventListener('pointermove', move);
        b.addEventListener('pointerup', up);
      });
      return b;
    }

    function sceneBlock(sc) {
      const b = h('div.tl-scene', { class: `m-${sc.layout.mode}${sc.id === S.selScene ? ' on' : ''}`, tabIndex: 0, role: 'button', 'aria-label': `Scene: ${MODE_LABEL[sc.layout.mode]} from ${fmtTime(sc.start)} to ${fmtTime(sc.end)}`, style: { left: `${x(sc.start)}px`, width: `${Math.max(8, x(sc.end) - x(sc.start))}px` } },
        h('span.zh.l'), h('span.zlabel', MODE_LABEL[sc.layout.mode]), h('span.zh.r'));
      const select = () => { S.selScene = sc.id; rightTabs.select('layout'); refresh(); };
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seek(sc.start + 0.05); select(); }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); commit((ed) => { ed.scenes = ed.scenes.filter((q) => q.id !== sc.id); }); }
      });
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
        const startX = e.clientX, s0 = sc.start, e0 = sc.end;
        let moved = false;
        const snapshot = JSON.stringify(S.edit);
        b.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dt = (ev.clientX - startX) / S.pps;
          if (Math.abs(ev.clientX - startX) > 2) moved = true;
          const q = S.edit.scenes.find((v) => v.id === sc.id);
          if (!q) return;
          if (mode === 'move') { const len = e0 - s0; q.start = Math.max(0, Math.min(S.duration - len, s0 + dt)); q.end = q.start + len; }
          if (mode === 'l') q.start = Math.max(0, Math.min(q.end - 0.5, s0 + dt));
          if (mode === 'r') q.end = Math.min(S.duration, Math.max(q.start + 0.5, e0 + dt));
          q.auto = false;
          b.style.left = `${x(q.start)}px`; b.style.width = `${x(q.end) - x(q.start)}px`;
          S.dirty = true;
        };
        const up = () => {
          b.removeEventListener('pointermove', move);
          b.removeEventListener('pointerup', up);
          if (moved) { S.undo.push(snapshot); S.redo = []; afterChange('none'); } else seek(sc.start + 0.05);
          select();
        };
        b.addEventListener('pointermove', move);
        b.addEventListener('pointerup', up);
      });
      return b;
    }

    // Filmstrip: ≤ 1 thumbnail per second, at most ~240, decoded once at low resolution and cached.
    const strip = { frames: [], step: 1, aspect: 16 / 9, loading: false };
    async function loadFilmstrip() {
      if (strip.loading || !hasVideo || !webcodecsVideo()) return;
      strip.loading = true;
      let input = null;
      try {
        input = new MB.Input({ source: new MB.BlobSource(S.screenBlob), formats: MB.ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) return;
        strip.aspect = track.displayWidth / Math.max(1, track.displayHeight);
        strip.step = Math.max(1, S.duration / 240);
        const first = await track.getFirstTimestamp();
        const times = [];
        for (let t = 0; t < S.duration; t += strip.step) times.push(first + t);
        const sink = new MB.CanvasSink(track, { width: 96, poolSize: 0 });
        let i = 0;
        for await (const wrapped of sink.canvasesAtTimestamps(times)) {
          if (S.destroyed) return;
          if (wrapped) strip.frames[i] = await createImageBitmap(wrapped.canvas).catch(() => null);
          if (++i % 20 === 0) drawCanvas();
        }
        drawCanvas();
      } catch { /* filmstrip is decoration; ignore */ } finally { input?.dispose?.(); }
    }

    // Scrub audio (W-05): short grains of the 16 kHz PCM while dragging the playhead on the ruler.
    let scrubAc = null, lastGrain = 0;
    function scrubGrain(t) {
      if (!S.pcm) return;
      const now = performance.now();
      if (now - lastGrain < 45) return;
      lastGrain = now;
      try {
        scrubAc ??= new AudioContext();
        const n = Math.round(0.07 * 16000), i0 = Math.max(0, Math.round(t * 16000));
        const buf = scrubAc.createBuffer(1, n, 16000);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) { const env = Math.min(1, i / 80, (n - i) / 80); d[i] = (S.pcm[i0 + i] || 0) * env; }
        const src = scrubAc.createBufferSource();
        src.buffer = buf;
        src.connect(scrubAc.destination);
        src.start();
      } catch { /* audio not allowed yet */ }
    }

    function timeAt(clientX) {
      const r = inner.getBoundingClientRect();
      return Math.max(0, Math.min(S.duration, (clientX - r.left) / S.pps));
    }
    inner.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const onRuler = e.target.classList.contains('ruler') || (e.offsetY < LANES.ruler && e.target === inner);
      let t0 = timeAt(e.clientX);
      let dragging = false;
      // Shift-drag extends the existing selection from its far edge.
      if (e.shiftKey && S.sel && !onRuler) {
        t0 = Math.abs(t0 - S.sel.start) < Math.abs(t0 - S.sel.end) ? S.sel.end : S.sel.start;
        dragging = true;
        S.sel = { start: Math.min(t0, timeAt(e.clientX)), end: Math.max(t0, timeAt(e.clientX)) };
        refresh();
      }
      inner.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const t = timeAt(ev.clientX);
        if (onRuler) { seek(t); scrubGrain(t); return; }
        if (!dragging && Math.abs(ev.clientX - e.clientX) > 4) dragging = true;
        if (dragging) { S.sel = { start: Math.min(t0, t), end: Math.max(t0, t) }; refresh(); }
      };
      const up = () => {
        inner.removeEventListener('pointermove', move);
        inner.removeEventListener('pointerup', up);
        if (!dragging) { S.sel = null; seek(t0); refresh(); }
      };
      inner.addEventListener('pointermove', move);
      inner.addEventListener('pointerup', up);
      if (onRuler) { seek(t0); scrubGrain(t0); }
    });
    view.addEventListener('scroll', () => drawCanvas(), { passive: true });
    view.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const m = Math.max(1, Math.min(60, mult * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      zoomIn.querySelector('input').value = String(m);
      setScale(m);
    }, { passive: false });
    return { el, refresh, playhead, resize, loadFilmstrip };
  }

  function restoreCut(c) {
    const words = S.edit.words;
    commit((ed) => {
      ed.cuts = ed.cuts.filter((x) => !(x.start < c.end && x.end > c.start));
      ed.words.forEach((w) => { if (w.deleted && w.start < c.end && w.end > c.start) w.deleted = false; });
      if (ed.range && (c.start <= 0.001 || c.end >= S.duration - 0.001)) ed.range = null;
    }, { rerender: 'transcript' });
    toast(words.length ? 'Restored that part' : 'Cut removed', 'ok', 1400);
  }
  function cutSelection() {
    if (!S.sel) return;
    const sel = S.sel;
    commit((ed) => { ed.cuts.push({ id: uid('c'), start: sel.start, end: sel.end, kind: 'manual' }); ed.cuts = mergeCutsKeepKind(ed.cuts); }, { rerender: 'transcript' });
    S.sel = null;
    tl.refresh();
  }
  function zoomSelection() {
    if (!S.sel) return;
    const z = { ...newZoom(S.sel.start), start: S.sel.start, end: Math.max(S.sel.end, S.sel.start + 1.2) };
    commit((ed) => { ed.zooms.push(z); });
    S.selZoom = z.id; S.sel = null;
    rightTabs.select('zoom');
    setFocusPick(true);
  }
  function clipSelection() {
    if (!S.sel) return;
    const sel = S.sel;
    commit((ed) => { ed.range = { ...sel }; });
    S.sel = null;
    toast('Clip range set', 'ok');
  }
  function mergeCutsKeepKind(cuts) {
    const manual = mergeRanges(cuts.filter((c) => c.kind === 'manual')).map((r) => ({ id: uid('c'), ...r, kind: 'manual' }));
    return [...cuts.filter((c) => c.kind !== 'manual'), ...manual];
  }

  // ---- export ----------------------------------------------------------------------------------
  async function openExport() {
    pause();
    const opts = { format: 'mp4', res: 1080, fps: 30, quality: 'high', captions: S.edit.captions.enabled && S.edit.words.length > 0 };
    const bump = bumpersFor(S.edit);
    const outDur = totalDuration(S.kept) + (bump.intro ? S.edit.brand.intro.duration : 0) + (bump.outro ? S.edit.brand.outro.duration : 0);
    const info = h('p.muted.small');
    const body = h('div.export');
    const updateInfo = async () => {
      const { width, height } = outputSize(S.edit.aspect, opts.res);
      const c = await pickCodecs(opts.format, width, height);
      if (!c.video) {
        // W-06: no WebCodecs encoder, so the export is recorded in real time.
        const kind = c.realtime ? (c.realtime.includes('mp4') ? 'MP4' : 'WebM') : null;
        info.replaceChildren(`${width}×${height} · ${opts.fps} fps · ${fmtTime(outDur)} · `, kind ? `real-time ${kind}` : 'no encoder available',
          kind ? h('span.warn', ` · this browser can’t encode quickly, so the export plays through once (about ${fmtTime(outDur)}). Keep this tab in front.${kind.toLowerCase() !== opts.format ? ` It will be ${kind}.` : ''}`) : '');
        return;
      }
      info.replaceChildren(`${width}×${height} · ${opts.fps} fps · ${fmtTime(outDur)} · `, `${c.video.toUpperCase()}${c.audio ? ' + ' + c.audio.toUpperCase() : ''}`,
        c.audio === 'opus' && opts.format === 'mp4' ? h('span.warn', ' · this browser can’t encode AAC, so audio uses Opus (plays everywhere except some older players)') : '');
    };
    const go = h('button.btn.primary.wide', { onclick: () => run() }, icon('download', 16), 'Export video');
    // Desktop app (T-07/T-08): the local engine renders the same plan with FFmpeg and hardware encoders, including
    // B-roll, camera angles, intro/outro and music. It's the default where the webview can't encode quickly.
    const engineRow = h('div.stack');
    opts.engine = false;
    // A video imported through a preview copy (this webview can't decode the original) is only ever exported from
    // the original, by the engine: the in-app exporter would render the 1280-wide preview.
    const proxied = !!(desktop.available && hasPreviewCopies());
    if (proxied) {
      opts.engine = true;
      go.disabled = true;
      fill(engineRow, h('p.muted.small', 'Checking the desktop engine…'));
    }
    if (desktop.available) {
      desktop.info().then((i) => {
        if (!i?.engine?.available) {
          if (proxied) fill(engineRow, h('p.warn', 'This video is edited from a preview copy, so it exports through the desktop engine, which isn’t available. Reinstall Slipstream to export it.'));
          return;
        }
        go.disabled = false;
        if (proxied) {
          fill(engineRow, h('p.muted.small', 'Renders the original recording at full quality with the desktop engine (the editor shows a smaller preview copy).'));
          return;
        }
        opts.engine = !webcodecsVideo() || S.edit.audio?.enhance === true;
        fill(engineRow,
          toggle('Render with the desktop engine (hardware encoder)', opts.engine, (v) => { opts.engine = v; }),
          S.edit.audio?.enhance ? h('p.muted.small', 'Studio Sound is on: it only applies to engine exports.') : null);
      }).catch(() => {});
    }
    const form = h('div.stack',
      h('div.export-summary', h('div', h('b', fmtTime(outDur)), h('span', 'length')), h('div', h('b', S.edit.aspect), h('span', 'frame')), h('div', h('b', S.cuts.length), h('span', 'cuts')), h('div', h('b', S.edit.zooms.length), h('span', 'zooms'))),
      field('Format', segmented([['mp4', 'MP4'], ['webm', 'WebM']], opts.format, (v) => { opts.format = v; updateInfo(); })),
      field('Resolution', segmented([[720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K']], opts.res, (v) => { opts.res = v; updateInfo(); })),
      field('Frame rate', segmented([[30, '30 fps'], [60, '60 fps']], opts.fps, (v) => { opts.fps = v; updateInfo(); })),
      field('Quality', segmented([['high', 'High'], ['medium', 'Smaller file']], opts.quality, (v) => { opts.quality = v; })),
      toggle('Burn in captions', opts.captions, (v) => { opts.captions = v; }),
      engineRow,
      info, go,
      h('div.nle-row', h('span.muted.small', 'Finish in another editor:'), h('button.btn.small', { onclick: () => downloadNLE('fcpxml') }, 'Final Cut (FCPXML)'), h('button.btn.small', { onclick: () => downloadNLE('xmeml') }, 'Premiere / Resolve (XML)'), h('button.btn.small', { onclick: () => downloadNLE('edl') }, 'EDL')),
      h('p.muted.small', icon('lock', 12), webcodecsVideo() ? 'Rendered on this device with WebCodecs. Nothing is uploaded.' : 'Rendered on this device in real time. Nothing is uploaded.'));
    body.append(form);
    updateInfo();
    let ctrl = null;
    const m = modal('Export', body, { onClose: () => ctrl?.abort() });

    async function run() {
      if (opts.engine || proxied) return runEngine();
      const { width, height } = outputSize(S.edit.aspect, opts.res);
      // The real-time path (W-06) plays audio, which needs this click's user activation.
      const audioContext = !webcodecsVideo() && (S.hasAudio || (S.edit.music && S.musicBlob)) ? primeExportAudio() : null;
      ctrl = new AbortController();
      const bar = h('div.bar', h('i'));
      const label = h('p.muted.small', 'Preparing…');
      body.replaceChildren(h('div.stack', h('h3', 'Rendering…'), bar, label, h('button.btn', { onclick: () => ctrl.abort() }, 'Cancel')));
      try {
        const res = await exportVideo({ edit: S.edit, kept: S.kept, cues: S.cues, screenBlob: S.screenBlob, cameraBlob: S.camBlob, cameraOffset: S.camOffset, cameras: camerasForExport(), hasAudio: S.hasAudio, overlays: { logo: S.logoBmp }, audioContext, brollMedia: S.brollMedia, audioGainDb: await loudnessGainFor(S.edit, S.kept), musicBlob: S.edit.music ? S.musicBlob : null, ...bumpersFor(S.edit) }, { width, height, fps: opts.fps, format: opts.format, quality: opts.quality, captions: opts.captions }, {
          signal: ctrl.signal,
          onProgress: (p) => { bar.firstChild.style.width = `${Math.round(p.done * 100)}%`; label.textContent = `${Math.round(p.done * 100)}% · frame ${p.frame} of ${p.total}${p.eta != null ? ` · about ${Math.ceil(p.eta)}s left` : ''}`; },
        });
        const ext = res.blob.type.includes('webm') ? 'webm' : 'mp4';
        const name = `${safeName(project.name)}-${S.edit.aspect.replace(':', 'x')}.${ext}`;
        const url = URL.createObjectURL(res.blob);
        const file = new File([res.blob], name, { type: res.blob.type });
        const canShare = navigator.canShare && navigator.canShare({ files: [file] });
        body.replaceChildren(h('div.stack',
          h('video.export-preview', { src: url, controls: true, playsInline: true }),
          h('p.muted.small', `${name} · ${fmtBytes(res.blob.size)}`),
          h('div.row', h('button.btn.primary', { onclick: () => downloadBlob(res.blob, name) }, icon('download', 15), 'Download'),
            canShare ? h('button.btn', { onclick: () => navigator.share({ files: [file], title: project.name }).catch(() => {}) }, icon('share', 15), 'Share') : null,
            folderButton(res.blob, name),
            shareButton(res.blob, name),
            h('button.btn', { title: 'Send directly to another device running Slipstream', onclick: () => sendToDeviceDialog(res.blob, name) }, icon('download', 15), 'Send to a device'),
            S.edit.words.length ? h('button.btn', { onclick: () => downloadSubs('srt') }, icon('captions', 15), 'Captions .srt') : null)));
        toast('Export finished', 'ok');
      } catch (err) {
        if (err.name === 'AbortError') { m.close(); toast('Export cancelled'); return; }
        body.replaceChildren(h('div.stack', h('p.warn', `Export failed: ${err.message}`), h('button.btn', { onclick: () => { m.close(); openExport(); } }, 'Try again')));
      }
    }

    async function runEngine() {
      const { width, height } = outputSize(S.edit.aspect, opts.res);
      ctrl = new AbortController();
      const bar = h('div.bar', h('i'));
      const label = h('p.muted.small', 'Preparing…');
      const name = `${safeName(project.name)}-${S.edit.aspect.replace(':', 'x')}.${opts.format}`;
      try {
        const plan = planFor(project, S.edit);
        body.replaceChildren(h('div.stack', h('h3', 'Rendering with the desktop engine…'), bar, label, h('button.btn', { onclick: () => ctrl.abort() }, 'Cancel')));
        // Everything the plan points at goes to the engine as real files (copied once, reused while unchanged).
        label.textContent = 'Handing the media to the engine…';
        const stage = (blob, key) => desktop.stageMedia(namedMedia(blob, key), { key: `${project.id}-${key}`, signal: ctrl.signal });
        if (project.media.logo && plan.brand?.logo) {
          const logo = await getMedia(`${project.id}:logo`, project.media.logoType || '');
          if (logo) plan.brand.logo = { ...plan.brand.logo, path: await stage(logo, 'logo') };
        }
        for (const b of plan.broll || []) { const blob = S.brollMedia[b.id]; if (blob) b.path = await stage(blob, `broll-${b.id}`); }
        if (plan.music && S.musicBlob) plan.music.path = await stage(S.musicBlob, 'music');
        const bump = bumpersFor(S.edit);
        for (const k of ['intro', 'outro']) if (plan.brand?.[k] && bump[k]) plan.brand[k] = { ...plan.brand[k], path: await stage(bump[k], k) };
        // Recordings edited from a preview copy render from their originals, never from the copy.
        const originalOf = async (key, rec, what) => {
          if (!rec) return null;
          const blob = await getMedia(`${project.id}:${key}`, rec.type || '');
          if (!blob) throw new Error(`the original ${what} is missing from this project, and its preview copy is too small to export`);
          return blob;
        };
        for (const a of plan.sources?.angles || []) {
          const ang = S.angles.find((x) => x.id === a.id);
          const orig = await originalOf(`angle-${a.id}-original`, ang?.original, `camera angle “${ang?.name || a.id}”`);
          if (orig) a.path = await stage(orig, `angle-${a.id}-original`);
          else if (ang?.blob) a.path = await stage(ang.blob, `angle-${a.id}`);
        }
        const original = await originalOf('original', project.media.original, 'recording');
        const camOriginal = S.camBlob ? await originalOf('camera-original', project.media.cameraOriginal, 'camera recording') : null;
        const screenMedia = original ? namedMedia(original, 'original') : namedMedia(S.screenBlob, 'screen');
        const camMedia = camOriginal ? namedMedia(camOriginal, 'camera-original') : namedMedia(S.camBlob, 'camera');
        const res = await desktop.render(plan, { name, width, height, fps: opts.fps, format: opts.format, quality: opts.quality, captions: opts.captions, media: { screen: screenMedia, camera: camMedia }, projectId: project.id, signal: ctrl.signal }, (p) => {
          if (p?.done == null) return;
          bar.firstChild.style.width = `${Math.round(p.done * 100)}%`;
          label.textContent = `${p.stage === 'copy' ? 'Handing the recording to the engine' : 'Encoding'} · ${Math.round(p.done * 100)}%${p.eta != null ? ` · about ${Math.ceil(p.eta)}s left` : ''}`;
        });
        if (!res) { m.close(); return; } // save dialog cancelled
        const file = String(res.path).split(/[\\/]/).pop();
        body.replaceChildren(h('div.stack',
          h('video.export-preview', { src: res.url, controls: true, playsInline: true }),
          h('p.muted.small', `${file} · ${fmtBytes(res.size || 0)}${res.engine?.encoder ? ` · ${res.engine.encoder}` : ''}`),
          h('div.row', h('button.btn.primary', { onclick: () => desktop.revealInFolder(res.path).catch(() => {}) }, icon('file', 15), 'Show in folder'),
            S.edit.words.length ? h('button.btn', { onclick: () => downloadSubs('srt') }, icon('captions', 15), 'Captions .srt') : null)));
        toast('Export finished', 'ok');
      } catch (err) {
        if (err.name === 'AbortError') { m.close(); toast('Export cancelled'); return; }
        if (/FFmpeg was not found/i.test(err.message)) { offerFfmpeg(); return; }
        body.replaceChildren(h('div.stack', h('p.warn', `The desktop engine couldn’t export: ${err.message}`),
          h('div.row', h('button.btn', { onclick: () => { m.close(); openExport(); } }, 'Try again'),
            proxied ? null : h('button.btn.primary', { onclick: () => { opts.engine = false; run(); } }, 'Export in the app instead'))));
      }
    }

    /** T-09: the engine needs FFmpeg. Nothing downloads until the user picks it; size and host are shown first. */
    async function offerFfmpeg() {
      const list = await desktop.runtime.list().catch(() => []);
      const ff = list.find((c) => c.id === 'ffmpeg');
      const status = h('p.muted.small');
      const bar = h('div.bar', h('i'));
      bar.hidden = true;
      const install = async (fromZip) => {
        status.textContent = fromZip ? 'Installing…' : 'Downloading…';
        try {
          const r = await desktop.runtime.install('ffmpeg', { fromZip }, (e) => {
            if (e?.done == null) return;
            bar.hidden = false;
            bar.firstChild.style.width = `${Math.round(e.done * 100)}%`;
            status.textContent = `${e.stage === 'verify' ? 'Checking' : e.stage === 'extract' ? 'Unpacking' : 'Downloading'} · ${Math.round(e.done * 100)}%`;
          });
          if (r === null) { status.textContent = ''; return; }
          toast('FFmpeg installed', 'ok');
          runEngine();
        } catch (err) { status.textContent = `Couldn’t install FFmpeg: ${err.message}`; }
      };
      const canDownload = ff?.available && ff?.verified;
      body.replaceChildren(h('div.stack',
        h('h3', 'The desktop engine needs FFmpeg'),
        h('p.muted', canDownload
          ? `Slipstream can download FFmpeg ${ff.version} (${ff.sizeText || fmtBytes(ff.size || 0)}) from ${ff.host}. The download is checked against its SHA-256 before it’s unpacked, and nothing about you or your recordings is sent.`
          : 'There’s no checked download of FFmpeg for this computer. Install it from your package manager, or pick an FFmpeg archive you already have.'),
        ff?.license ? h('p.muted.small', `Licence: ${ff.license}`) : null,
        bar, status,
        h('div.row',
          canDownload ? h('button.btn.primary', { onclick: () => install(false) }, icon('download', 15), `Download FFmpeg (${ff.sizeText || fmtBytes(ff.size || 0)})`) : null,
          h('button.btn', { onclick: () => install(true) }, 'Install from a file…'),
          proxied ? null : h('button.btn.ghost', { onclick: () => { opts.engine = false; run(); } }, 'Export in the app instead'))));
    }
  }
  function field(label, control) { return h('div.field', h('span', label), control); }

  /**
   * Upload-free sharing (S-05): save exports straight into a folder you pick once — typically your Dropbox,
   * Google Drive or iCloud Drive folder, so your own sync client shares it. No Slipstream server involved.
   */
  function folderButton(blob, name) {
    if (!('showDirectoryPicker' in window)) return null;
    const btn = h('button.btn', { title: 'Save into a folder such as your Dropbox, Google Drive or iCloud Drive folder' }, icon('file', 15), 'Save to folder…');
    getSetting('exportDir').then((dir) => { if (dir) btn.replaceChildren(icon('file', 15), `Save to ${dir.name}`); }).catch(() => {});
    btn.onclick = async () => {
      try {
        let dir = await getSetting('exportDir').catch(() => null);
        if (dir && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') dir = null;
        if (!dir) { dir = await window.showDirectoryPicker({ id: 'slipstream-exports', mode: 'readwrite' }); await setSetting('exportDir', dir).catch(() => {}); }
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        btn.replaceChildren(icon('check', 15), `Saved to ${dir.name}`);
        toast(`Saved ${name} to ${dir.name}`, 'ok');
      } catch (err) { if (err.name !== 'AbortError') toast(`Couldn’t save there: ${err.message}`, 'error'); }
    };
    return btn;
  }

  // ---- keyboard --------------------------------------------------------------------------------
  function onKey(e) {
    if (S.destroyed) return;
    if (document.querySelector('.modal-back')) return;
    const tgt = e.target;
    const typing = tgt.closest?.('input, textarea, select, [contenteditable="true"]');
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); leftTabs.select('transcript'); searchInput.focus(); return; }
    if (typing) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); seek(S.t - (e.shiftKey ? 5 : 1)); break;
      case 'ArrowRight': e.preventDefault(); seek(S.t + (e.shiftKey ? 5 : 1)); break;
      case ',': seek(S.t - 1 / 30); break;
      case '.': seek(S.t + 1 / 30); break;
      case 'Delete': case 'Backspace':
        e.preventDefault();
        if (S.sel) cutSelection();
        else if (S.wsel) toggleDeleteSelection();
        else if (S.selOverlay && annotating()) { const { list, id } = S.selOverlay; commit((ed) => { ed[list] = (ed[list] || []).filter((q) => q.id !== id); }); S.selOverlay = null; renderRight(); }
        else if (S.selZoom) { commit((ed) => { ed.zooms = ed.zooms.filter((z) => z.id !== S.selZoom); }); S.selZoom = null; renderRight(); }
        break;
      case 'z': case 'Z': if (S.sel) zoomSelection(); else if (S.wsel) zoomOnSelection(); else { const z = newZoom(S.t); commit((ed) => { ed.zooms.push(z); }); S.selZoom = z.id; rightTabs.select('zoom'); setFocusPick(true); } break;
      case 'c': case 'C': if (S.sel) clipSelection(); else if (S.wsel) clipFromSelection(); break;
      case 'e': case 'E': openExport(); break;
      case 'Escape': S.sel = null; S.wsel = null; setFocusPick(false); if (S.drawTool) setDrawTool(null); selBar.hidden = true; renderTranscriptState(); tl.refresh(); break;
      case '?': showShortcuts(); break;
      default:
    }
  }
  document.addEventListener('keydown', onKey);

  function showShortcuts() {
    const rows = [['Space', 'Play / pause'], ['← / →', 'Back / forward 1s (⇧ for 5s)'], [', / .', 'Step one frame'], ['Delete', 'Cut selected words or timeline range'], ['Z', 'Zoom on selection or at playhead'], ['C', 'Set clip range from selection'], ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘F', 'Find in transcript'], ['Double-click word', 'Fix a transcription typo'], ['E', 'Export'], ['Esc', 'Clear selection']];
    modal('Keyboard shortcuts', h('dl.shortcuts', rows.map(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)])));
  }

  function exit() {
    pause();
    S.destroyed = true;
    S.job?.cancel();
    S.offWall?.();
    document.removeEventListener('keydown', onKey);
    ro.disconnect();
    saveNow().finally(() => {
      URL.revokeObjectURL(screenURL);
      if (camURL) URL.revokeObjectURL(camURL);
      if (S.musicEl) URL.revokeObjectURL(S.musicEl.src);
      onExit?.();
    });
  }

  // ---- boot ------------------------------------------------------------------------------------
  derive();
  updateUndo();
  updateRangeChip();
  renderLeft();
  renderRight();
  resizeCanvas();
  tl.resize();
  requestAnimationFrame(tick);
  const offWall = onWallpaperReady(() => { S.dirty = true; });
  loadWallpaper(S.edit.style.bg);
  ensureCaptionFonts().then(() => { S.dirty = true; });
  if (project.media.logo) loadLogo();
  if (S.edit.broll.length) loadBroll();
  if (S.edit.music) loadMusic();
  if (project.media.intro || project.media.outro) loadBumpers();
  if ((project.media.angles || []).length > 1) loadAngles();
  setTimeout(() => tl.loadFilmstrip(), project.autoPolish ? 4000 : 300);
  if (project.autoPolish && !S.edit.words.length) autoPolish();
  else if (!S.peaks && S.hasAudio) {
    analyzeAudio(S.screenBlob, S.duration).then((r) => { S.peaks = r.peaks; S.pcm = r.pcm; tl.refresh(); save(); }).catch(() => {});
  }
  S.offWall = offWall;
  return { exit };
}

function tabs(items, initial, onChange) {
  let value = initial;
  const el = h('div.tabs', { role: 'tablist' });
  const render = () => el.replaceChildren(...items.map(([v, label, ic]) => h('button', { role: 'tab', 'aria-selected': String(v === value), class: v === value ? 'on' : '', onclick: () => { value = v; render(); onChange(v); } }, icon(ic, 15), label)));
  render();
  el.value = () => value;
  el.select = (v) => { value = v; render(); onChange(v); };
  return el;
}

function progressRow(label, p) {
  return h('div.prog', h('span.prog-label', label), h('div.bar', h('i', { style: { width: `${Math.round(p * 100)}%` } })));
}
function setProgress(container, p, label) {
  const row = container.querySelector('.prog');
  if (!row) { container.prepend(progressRow(label || '', p)); return; }
  if (label) row.querySelector('.prog-label').textContent = label;
  row.querySelector('.bar i').style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
}
function keepInView(el, scroller) {
  const r = el.getBoundingClientRect(), s = scroller.getBoundingClientRect();
  if (r.top < s.top + 40 || r.bottom > s.bottom - 40) scroller.scrollTop += r.top - s.top - s.height / 3;
}

/** Fill in fields newer than the project (scenes, brand overlays, speakers, B-roll, audio) so older projects open cleanly. */
export function ensureEditShape(e) {
  e.scenes ??= [];
  e.brand ??= {};
  e.brand.logo = { enabled: false, corner: 'tr', size: 0.12, opacity: 0.9, ...(e.brand.logo || {}) };
  e.brand.lowerThird = { enabled: false, title: '', subtitle: '', start: 0.5, duration: 5, color: '#8b93ff', ...(e.brand.lowerThird || {}) };
  e.speakers ??= {};
  e.broll ??= [];
  e.audio = { normalize: true, loudnessLufs: -14, ...(e.audio || {}) };
  return e;
}

export function safeName(s) { return String(s || 'slipstream').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'slipstream'; }
