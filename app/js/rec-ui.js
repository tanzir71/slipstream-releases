// The minimal recorder (docs/handover/minimal-states.md): Slipstream Web's recorder card (W-11) and, in the desktop app,
// the Windows/Linux recorder (T-11).
//
// Web: a compact card. Modes Screen · Window · Tab · Area · Camera. The browser's own picker chooses the screen,
// window or tab (so the Mac's hover and area pickers don't apply); Area records the shared surface and hands the
// editor a source crop drawn on the preview; Camera records the camera alone. While recording, a Document
// Picture-in-Picture window floats the camera and the pill above every app (Chrome/Edge 116+); elsewhere the pill
// sits in the tab and the camera goes to video picture-in-picture.
//
// Desktop (Tauri, Windows/Linux): modes Display · Window · Area · Camera. On-screen pickers (desktop/rec.html)
// choose the display, window (with size presets that are undone after) or area (snapping to windows); the
// webview's share picker or the desktop portal then confirms the source, and the recorder checks the shared size
// matches. The pill, corner marks and countdown are capture-excluded overlay windows (Windows; Linux can't
// exclude windows, so marks stay outside the recorded area), the tray mirrors the pill, and the main window stays
// out of the way until the take stops.
//
// After stop the take becomes a project and opens in the editor, where auto-polish runs (export-ready on stop).
// Nothing leaves this device.
import { h, icon, toast, modal, fill } from './ui.js';
import { listDevices, openCamera, openMic, meter, levelMonitor, Session, pickDisplay } from './recorder.js';
import { createSinks } from './rec-sinks.js';
import { saveJournal, deleteJournal, deleteChunks, removeMediaDir } from './store.js';
import { uid } from './edl.js';
import * as L from './rec-logic.js';
import { createPill, createCountdown, recIcon, ensureRecStyles, el, WEB_SHORTCUTS } from './rec-pill.js';
import desktop from './desktop-bridge.js';

ensureRecStyles(document);

/**
 * The source crop an Area take hands the editor: edit plan v2 `frame.crop` = [x, y, w, h] fractions of the source
 * frame. The web editor owns the field; this is the one place that writes it, so a rename is one line.
 */
export function applySourceCrop(edit, crop) {
  if (!crop) return edit;
  return { ...edit, frame: { ...(edit?.frame || {}), crop: [...crop] } };
}

const SETUP_KEY = 'slipstream.rec.setup';
const AREA_KEY = 'slipstream.rec.areas';
const DESKTOP_SHORTCUTS = { pause: 'Alt+Shift+P', mute: 'Alt+Shift+M', stop: 'Ctrl+Shift+R', expand: 'Alt+Shift+H' };
const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const WEB_MODES = [['screen', 'Screen', 'display'], ['window', 'Window', 'window'], ['tab', 'Tab', 'tab'], ['area', 'Area', 'area'], ['camera', 'Camera', 'person']];
const DESKTOP_MODES = [['display', 'Display', 'display'], ['window', 'Window', 'window'], ['area', 'Area', 'area'], ['camera', 'Camera', 'person']];
const SURFACE = { screen: 'monitor', display: 'monitor', area: 'monitor', window: 'window', tab: 'browser' };

/**
 * Mount the recorder in `root`. deps (from main.js): onTake(take) saves the take as a project and opens it;
 * startCursor(display) / stopCursor(handle, timeline, duration) sample the pointer in the desktop app; hold(id) /
 * release() guard the tab while a take runs; onExit() leaves. Returns { cleanup(), toggle() }.
 */
export function mountRecorder(root, deps) {
  const isDesktop = desktop.available;
  const modes = isDesktop ? DESKTOP_MODES : WEB_MODES;
  const saved = readJSON(SETUP_KEY, {});
  const st = {
    mode: modes.some((m) => m[0] === saved.mode) ? saved.mode : modes[0][0],
    display: null, info: null, cam: null, camId: '', mic: null, micId: '', meter: null, devices: { cameras: [], mics: [], labelled: false },
    systemAudio: saved.systemAudio !== false, countdown: Number.isFinite(saved.countdown) ? saved.countdown : 3, notes: '', prompterOpen: false,
    area: null, aspect: saved.aspect || 'free', mirror: saved.mirror !== false,
    // desktop
    targets: null, displayId: saved.displayId ?? null, win: null, preset: saved.preset || 'native', deskArea: null,
    // the take
    phase: 'setup', session: null, pid: null, backend: null, journal: null, cursor: null, float: null, monitor: null,
    level: 0, db: -Infinity, nudger: null, nudge: null, confirm: false, muted: false, cameraOn: true, timer: 0, raf: 0, offControl: null,
  };
  const remember = () => writeJSON(SETUP_KEY, { mode: st.mode, camId: st.camId, micId: st.micId, systemAudio: st.systemAudio, countdown: st.countdown, aspect: st.aspect, mirror: st.mirror, displayId: st.displayId, preset: st.preset });

  // ---- layout ----------------------------------------------------------------------------------------------------
  const stage = h('div.recw-stage');
  const side = h('aside.recw-side');
  const back = h('button.icon-btn', { title: 'Back', 'aria-label': 'Back', onclick: () => deps.onExit() }, icon('back'));
  const view = h('div.recw', h('header.topbar', h('div.tb-left', back, h('span.tb-title', 'New recording')), h('div.tb-center'), h('div.tb-right')), h('div.recw-body', stage, side));
  root.replaceChildren(view);

  const screenVideo = h('video.recw-video', { muted: true, autoplay: true, playsInline: true });
  const camVideo = h('video', { muted: true, autoplay: true, playsInline: true });
  const bubble = h('video.recw-bubble', { muted: true, autoplay: true, playsInline: true });
  const thumb = h('video.rthumb', { muted: true, autoplay: true, playsInline: true });

  // ---- devices ---------------------------------------------------------------------------------------------------
  async function refreshDevices() {
    try { st.devices = await listDevices(); } catch { /* keep the old list */ }
    if (st.phase === 'setup') renderCard();
  }
  async function setCam(id) {
    st.cam?.getTracks().forEach((t) => t.stop());
    st.cam = null; st.camId = '';
    if (id) {
      try {
        st.cam = await openCamera(id === '__ask' ? undefined : id);
        st.camId = st.cam.getVideoTracks()[0].getSettings().deviceId || id;
      } catch (err) { toast(`Camera unavailable: ${err.message}`, 'error'); }
    }
    for (const v of [camVideo, bubble, thumb]) v.srcObject = st.cam;
    remember();
    await refreshDevices();
    renderStage();
  }
  async function setMic(id) {
    st.mic?.getTracks().forEach((t) => t.stop());
    st.meter?.close(); st.meter = null; st.mic = null; st.micId = '';
    if (id) {
      try {
        st.mic = await openMic(id === '__ask' ? undefined : id);
        st.micId = st.mic.getAudioTracks()[0].getSettings().deviceId || id;
        st.meter = meter(st.mic);
      } catch (err) { toast(`Microphone unavailable: ${err.message}`, 'error'); }
    }
    remember();
    await refreshDevices();
  }
  const micName = () => st.devices.mics.find((d) => d.deviceId === st.micId)?.label || 'your microphone';

  // ---- choosing what to record ---------------------------------------------------------------------------------------
  function setMode(m) {
    if (st.phase !== 'setup' || m === st.mode) return;
    st.mode = m;
    remember();
    // A Tab share isn't a Screen share: pick again when the kind of surface changes (Area works on any share).
    if (st.display && !isDesktop && m !== 'camera' && m !== 'area' && SURFACE[m] !== st.info?.surfaceKind) dropDisplay();
    if (m === 'area' && st.display && !isDesktop && !st.area) st.area = defaultArea();
    renderCard(); renderStage();
  }
  function dropDisplay() {
    st.display?.getTracks().forEach((t) => t.stop());
    st.display = null; st.info = null; st.area = null;
    screenVideo.srcObject = null;
  }
  async function choose() {
    try {
      const controller = typeof CaptureController === 'function' ? new CaptureController() : null;
      const d = await pickDisplay({ systemAudio: st.systemAudio, surface: SURFACE[st.mode] || null, controller });
      // Stay on Slipstream after picking (Chrome would jump to the shared tab or window): Start comes next.
      try { controller?.setFocusBehavior?.('no-focus-change'); } catch { /* too late or unsupported */ }
      dropDisplay();
      st.display = d;
      const tr = d.getVideoTracks()[0];
      const s = tr.getSettings();
      st.info = { label: tr.label || 'Screen', width: s.width || 0, height: s.height || 0, surface: s.displaySurface || '', surfaceKind: SURFACE[st.mode], audio: d.getAudioTracks().length > 0 };
      screenVideo.srcObject = d;
      tr.addEventListener('ended', () => { if (st.phase === 'setup' && st.display === d) { dropDisplay(); renderCard(); renderStage(); } });
      if (st.mode === 'area') st.area = lastArea() || defaultArea();
      renderCard(); renderStage();
      return true;
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast(err.message, 'error');
      return false;
    }
  }
  const areaKey = () => `${st.info?.label || ''}|${st.info?.width}x${st.info?.height}`;
  function lastArea() {
    const a = readJSON(AREA_KEY, {})[areaKey()];
    return a && st.info && a.x + a.w <= st.info.width + 1 && a.y + a.h <= st.info.height + 1 ? a : null;
  }
  function saveArea() {
    if (!st.area || !st.info) return;
    const all = readJSON(AREA_KEY, {});
    all[areaKey()] = st.area;
    writeJSON(AREA_KEY, all);
  }
  function defaultArea() {
    const W = st.info?.width || 1920, H = st.info?.height || 1080;
    const ar = L.aspectRatio(st.aspect);
    let w = W * 0.6, hh = H * 0.6;
    if (ar) { if (w / ar <= hh) hh = w / ar; else w = hh * ar; }
    return { x: Math.round((W - w) / 2), y: Math.round((H - hh) / 2), w: Math.round(w), h: Math.round(hh) };
  }

  // ---- the card ----------------------------------------------------------------------------------------------------
  function select(list, current, onPick, none, kind) {
    const s = h('select', { 'aria-label': kind, onchange: (e) => onPick(e.target.value) },
      h('option', { value: '' }, none),
      list.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || `${kind} ${i + 1}`)),
      st.devices.labelled ? null : h('option', { value: '__ask' }, `Allow ${kind.toLowerCase()} access…`));
    return s;
  }
  const row = (iconName, ...kids) => h('div.rrow', recIcon(iconName, 16), ...kids);
  const switchEl = (checked, onChange, label) => h('label.rswitch', { title: label }, h('input', { type: 'checkbox', checked, 'aria-label': label, onchange: (e) => onChange(e.target.checked) }), h('span'));
  const bars = Array.from({ length: 4 }, () => h('i'));

  function targetRows() {
    if (st.mode === 'camera') return null;
    if (isDesktop) return desktopTargetRows();
    const what = { screen: 'Entire screen', window: 'A window', tab: 'A browser tab', area: 'Area of a screen' }[st.mode];
    const ic = { screen: 'display', window: 'window', tab: 'tab', area: 'area' }[st.mode];
    const browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : 'Your browser';
    let sub = `${browser} confirms next`;
    if (st.info) sub = st.mode === 'area' && st.area ? `${L.areaLabel(st.area)} of ${st.info.label}` : `${st.info.label}${st.info.width ? ` · ${st.info.width}×${st.info.height}` : ''}`;
    return h('div.rgroup', row(ic, h('div.rrow-main', h('b', st.info ? (st.mode === 'area' ? 'Area' : what) : what), h('span', sub)), h('button.rrow-act', { onclick: () => choose() }, st.info ? 'Change' : 'Choose')));
  }

  function renderCard() {
    if (st.phase !== 'setup') return;
    const tiles = h('div.rmodes', { role: 'tablist', 'aria-label': 'What to record' }, modes.map(([id, label, ic], i) => h('button', { role: 'tab', class: id === st.mode ? 'on' : '', 'aria-selected': String(id === st.mode), title: `${label} (${i + 1})`, onclick: () => setMode(id) }, recIcon(ic, 17), label)));
    const camSel = select(st.devices.cameras, st.camId, setCam, st.mode === 'camera' ? 'Choose a camera' : 'No camera', 'Camera');
    const micSel = select(st.devices.mics, st.micId, setMic, 'No microphone', 'Microphone');
    const audioLabel = st.mode === 'tab' ? 'Tab audio' : 'System audio';
    const devices = h('div.rgroup',
      row('camera', camSel, st.cam ? thumb : null),
      row('mic', micSel, st.mic ? h('span.rbars', bars) : null),
      st.mode === 'camera' || (isDesktop && desktop.platform === 'linux') ? null : row('speaker', h('div.rrow-main', h('b', audioLabel)), switchEl(st.systemAudio, (v) => { st.systemAudio = v; remember(); if (st.display && !isDesktop) toast('Choose again to change audio sharing', 'info'); }, audioLabel)));
    const chips = h('div.rchips',
      h('button.rchip', { class: st.countdown ? 'on' : '', title: 'Countdown before recording', onclick: () => { st.countdown = L.nextCountdown(st.countdown); remember(); renderCard(); } }, recIcon('timer', 14), st.countdown ? `${st.countdown} s` : 'No countdown'),
      h('button.rchip', { class: st.notes.trim() ? 'on' : '', title: 'Talking points that scroll while you record', 'aria-expanded': String(st.prompterOpen), onclick: () => { st.prompterOpen = !st.prompterOpen; renderCard(); } }, recIcon('lines', 14), 'Teleprompter'),
      st.mode === 'camera' ? h('button.rchip', { class: st.mirror ? 'on' : '', title: 'Mirror the preview (the recording is never mirrored)', onclick: () => { st.mirror = !st.mirror; remember(); renderCard(); renderStage(); } }, 'Mirror') : null);
    const notes = st.prompterOpen ? h('textarea', { placeholder: 'Paste talking points. They scroll slowly while you record, and only you can see them.', oninput: (e) => { st.notes = e.target.value; } }, st.notes) : null;
    if (notes) notes.value = st.notes;
    const ready = readyToStart();
    const start = h('button.rstart', { disabled: !ready.ok, title: ready.ok ? '' : ready.why, onclick: () => startTake() }, h('i'), startLabel(), h('kbd', isDesktop ? 'Ctrl+Shift+R' : '↩'));
    const note = ready.note ? h('p.rcard-note', recIcon('warn', 14), ready.note) : null;
    fill(side, h('section.rcard', { 'aria-label': 'New recording' },
      h('div.rcard-head', h('span.rcard-dot'), h('b', 'New recording')),
      tiles, targetRows(), devices, chips, notes, start, note,
      h('p.rcard-foot', 'Stops into an edited project: zooms, captions and tidy pauses. Recorded straight to this device.')));
  }
  function startLabel() {
    return { screen: 'Start recording', window: 'Start recording', tab: 'Start recording', area: 'Record area', camera: 'Record camera', display: 'Record display' }[st.mode] || 'Start recording';
  }
  function readyToStart() {
    if (st.mode === 'camera') return st.cam ? { ok: true } : { ok: false, why: 'Choose a camera first' };
    if (isDesktop) {
      if (st.mode === 'window' && st.targets?.windowsSupported && !st.win) return { ok: false, why: 'Pick a window first' };
      if (st.mode === 'area' && !st.deskArea) return { ok: false, why: 'Draw the area first' };
      const note = st.targets && !st.targets.excludedFromCapture && st.mode === 'display' ? 'On Linux the recording controls can show up in a full-display recording. Hide them from the tray, or record a window or an area.' : null;
      return { ok: true, note };
    }
    if (st.mode === 'area' && st.info && !st.area) return { ok: false, why: 'Draw the area first' };
    return { ok: true };
  }

  // ---- the stage (preview) -------------------------------------------------------------------------------------------
  function renderStage() {
    if (st.phase !== 'setup') return;
    if (st.mode === 'camera') {
      camVideo.classList.toggle('mirror', st.mirror);
      camVideo.style.transform = st.mirror ? 'scaleX(-1)' : '';
      fill(stage, st.cam
        ? h('div.recw-camframe', camVideo, h('div.recw-thirds'))
        : h('div.recw-empty', recIcon('person', 30), h('p', 'Records only your camera. The editor opens with it full frame.'), h('button.btn.primary', { onclick: () => setCam('__ask') }, 'Turn on the camera')));
      return;
    }
    if (isDesktop) { fill(stage, desktopStage()); return; }
    if (!st.display) {
      const what = { screen: 'screen', window: 'window', tab: 'tab', area: 'screen, then draw the area to keep' }[st.mode];
      fill(stage, h('div.recw-empty', recIcon(st.mode === 'tab' ? 'tab' : st.mode === 'window' ? 'window' : st.mode === 'area' ? 'area' : 'display', 30),
        h('p', `Pick the ${what}. Your browser asks which one to share.`), h('button.btn.primary', { onclick: () => choose() }, 'Choose…')));
      return;
    }
    // The camera bubble is a reminder of the camera layer; it would sit on top of an area being drawn.
    const box = h('div', { style: { position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: '100%', lineHeight: '0' } }, screenVideo, st.cam && st.mode !== 'area' ? bubble : null);
    fill(stage, box);
    if (st.mode === 'area') mountAreaPicker(box);
  }

  // ---- area on the preview (web) --------------------------------------------------------------------------------------
  function mountAreaPicker(box) {
    const layer = h('div.rarea');
    const sel = h('div.rarea-sel');
    const size = h('span.rarea-size');
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((k) => h('span.rarea-h', { dataset: { h: k } }));
    sel.append(size, ...handles);
    layer.append(sel);
    const tools = h('div.rbar', { onpointerdown: (e) => e.stopPropagation() },
      h('div.rbar-seg', L.AREA_ASPECTS.map(([id, label]) => h('button', { class: id === st.aspect ? 'on' : '', onclick: () => { st.aspect = id; remember(); const ar = L.aspectRatio(id); if (ar && st.area) { st.area = fitAspectAround(st.area, ar); saveArea(); } draw(); renderToolbar(); renderCard(); } }, label))),
      h('button', { title: 'Use the area from last time', disabled: !lastArea(), onclick: () => { st.area = lastArea(); draw(); renderCard(); } }, 'Last area'),
      h('button.rbar-go', { onclick: () => startTake() }, h('i'), 'Record area', h('kbd', '↩')));
    const renderToolbar = () => { [...tools.firstChild.children].forEach((b, i) => b.classList.toggle('on', L.AREA_ASPECTS[i][0] === st.aspect)); };
    box.append(layer, tools);
    const W = () => st.info.width || screenVideo.videoWidth || 1920, Hh = () => st.info.height || screenVideo.videoHeight || 1080;
    const bounds = () => ({ x: 0, y: 0, w: W(), h: Hh() });
    const scale = () => W() / Math.max(1, layer.clientWidth); // video px per CSS px
    const toVideo = (e) => { const r = layer.getBoundingClientRect(); return { x: (e.clientX - r.left) * scale(), y: (e.clientY - r.top) * scale() }; };
    function draw() {
      if (!st.area) { sel.hidden = true; return; }
      const k = 1 / scale();
      sel.hidden = false;
      Object.assign(sel.style, { left: `${st.area.x * k}px`, top: `${st.area.y * k}px`, width: `${st.area.w * k}px`, height: `${st.area.h * k}px` });
      size.textContent = L.areaLabel(st.area);
      const pos = { nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50] };
      for (const hd of handles) { const [x, y] = pos[hd.dataset.h]; hd.style.left = `${x}%`; hd.style.top = `${y}%`; }
    }
    let drag = null;
    layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      layer.setPointerCapture(e.pointerId);
      const p = toVideo(e);
      const handle = e.target.dataset?.h || (e.target === sel || sel.contains(e.target) ? 'move' : null);
      drag = handle ? { handle, start: p, rect: { ...st.area } } : { handle: 'draw', start: p };
    });
    layer.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = toVideo(e);
      const ar = L.aspectRatio(st.aspect);
      if (drag.handle === 'draw') { const r = L.dragRect(drag.start, p, ar, bounds()); if (r.w > 4 && r.h > 4) st.area = r; }
      else if (drag.handle === 'move') st.area = L.resizeRect(drag.rect, 'move', { dx: p.x - drag.start.x, dy: p.y - drag.start.y }, ar, bounds());
      else st.area = L.resizeRect(drag.rect, drag.handle, p, ar, bounds());
      draw();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      if (st.area && (st.area.w < L.MIN_AREA || st.area.h < L.MIN_AREA)) st.area = L.clampRect({ ...st.area, w: Math.max(L.MIN_AREA, st.area.w), h: Math.max(L.MIN_AREA, st.area.h) }, bounds());
      if (st.area) st.area = roundRect(st.area);
      saveArea(); draw(); renderCard();
    };
    layer.addEventListener('pointerup', end);
    layer.addEventListener('pointercancel', end);
    new ResizeObserver(draw).observe(layer);
    screenVideo.addEventListener('loadedmetadata', draw, { once: true });
    draw();
  }
  const roundRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
  function fitAspectAround(r, ar) {
    let w = r.w, hh = r.h;
    if (w / ar > hh) w = hh * ar; else hh = w / ar;
    return L.clampRect(roundRect({ x: r.x + (r.w - w) / 2, y: r.y + (r.h - hh) / 2, w, h: hh }), { x: 0, y: 0, w: st.info?.width || 1920, h: st.info?.height || 1080 });
  }

  // ---- desktop: displays, windows, areas (T-11) ------------------------------------------------------------------------
  async function loadTargets() {
    try { st.targets = await desktop.capture.targets(); } catch (err) { st.targets = { displays: [], windows: [], windowsSupported: false, reason: err.message, excludedFromCapture: false }; }
    if (!st.targets.displays.some((d) => d.id === st.displayId)) st.displayId = (st.targets.displays.find((d) => d.primary) || st.targets.displays[0])?.id ?? null;
    if (st.win) st.win = st.targets.windows.find((w) => w.id === st.win.id) || null;
    renderCard(); renderStage();
  }
  const chosenDisplay = () => st.targets?.displays.find((d) => d.id === st.displayId) || st.targets?.displays[0] || null;
  function desktopTargetRows() {
    const t = st.targets;
    if (!t) return h('div.rgroup', row('display', h('div.rrow-main', h('span', 'Looking for displays and windows…'))));
    const d = chosenDisplay();
    const displayRow = t.displays.length > 1
      ? row('display', h('select', { 'aria-label': 'Display', onchange: (e) => { st.displayId = e.target.value; st.deskArea = null; remember(); renderCard(); } }, t.displays.map((x) => h('option', { value: x.id, selected: x.id === st.displayId }, `${x.name} · ${x.rect.w} × ${x.rect.h}`))), h('button.rrow-act', { onclick: () => pickOnScreen('display') }, 'Pick'))
      : row('display', h('div.rrow-main', h('b', d?.name || 'Display'), h('span', d ? `${d.rect.w} × ${d.rect.h}` : '')));
    if (st.mode === 'display') return h('div.rgroup', displayRow);
    if (st.mode === 'area') {
      return h('div.rgroup', t.displays.length > 1 ? displayRow : null,
        row('area', h('div.rrow-main', h('b', st.deskArea ? 'Area' : 'Draw an area'), h('span', st.deskArea ? `${L.areaLabel(st.deskArea.rect)} on ${st.deskArea.display.name}` : 'Snaps to window edges')), h('button.rrow-act', { onclick: () => pickOnScreen('area') }, st.deskArea ? 'Redraw' : 'Draw')));
    }
    // window
    if (!t.windowsSupported) {
      return h('div.rgroup', row('window', h('div.rrow-main', h('b', 'A window'), h('span', 'The system picker chooses it next'))), h('p.rhint', t.reason || ''));
    }
    const w = st.win;
    return h('div.rgroup',
      row('window', h('div.rrow-main', h('b', w ? (w.app || w.title) : 'Pick a window'), h('span', w ? `${w.title} · ${w.rect.w} × ${w.rect.h}` : `${t.windows.length} open`)),
        h('button.rrow-act', { onclick: () => pickOnScreen('window') }, w ? 'Change' : 'Pick'),
        h('button.rrow-act', { title: 'Search all windows', 'aria-label': 'Search all windows', onclick: () => searchWindows() }, recIcon('search', 13))),
      w ? h('div', { style: { padding: '0 10px 10px' } }, h('p.rhint', { style: { padding: '0 0 6px' } }, 'Record the window at'), sizeButtons()) : null);
  }
  function sizeButtons() {
    return h('div.rsize', L.SIZE_PRESETS.map((p) => h('button', { class: p.id === st.preset ? 'on' : '', onclick: () => { st.preset = p.id; remember(); renderCard(); } }, p.label)));
  }
  function desktopStage() {
    const t = st.targets;
    const what = { display: 'a display', window: 'a window', area: 'an area of a display' }[st.mode];
    const lines = [h('p', `Record ${what}. Slipstream’s controls stay out of the recording${t && !t.excludedFromCapture ? ' where your system allows it' : ''}.`)];
    if (st.mode === 'window' && st.win) lines.push(h('p.muted.small', `${st.win.title} · ${st.preset === 'native' ? 'at its size' : `resized to ${L.SIZE_PRESETS.find((p) => p.id === st.preset)?.label} for the take, then put back`}`));
    if (st.mode === 'area' && st.deskArea) lines.push(h('p.muted.small', `${L.areaLabel(st.deskArea.rect)} on ${st.deskArea.display.name}: the whole display is recorded and the editor keeps this area.`));
    return h('div.recw-empty', recIcon(st.mode === 'window' ? 'window' : st.mode === 'area' ? 'area' : 'display', 30), ...lines,
      st.cam ? h('video.rthumb', { muted: true, autoplay: true, playsInline: true, style: { width: '120px', height: '120px' }, srcObject: st.cam }) : null);
  }

  /** On-screen picker overlay (desktop/rec.html, kind picker) for a display, a window or an area. */
  let pickWait = null;
  async function pickOnScreen(kind, displayId = null) {
    if (!st.targets) await loadTargets();
    const t = st.targets;
    const d = t.displays.find((x) => x.id === displayId) || (kind === 'area' ? chosenDisplay() : (t.displays.find((x) => x.primary) || t.displays[0]));
    if (!d) return;
    if (kind === 'display' && t.displays.length < 2) { st.displayId = d.id; renderCard(); return; }
    const windows = t.windows.filter((w) => !w.minimized && w.rect.x < d.rect.x + d.rect.w && w.rect.x + w.rect.w > d.rect.x && w.rect.y < d.rect.y + d.rect.h && w.rect.y + w.rect.h > d.rect.y);
    const lastAreas = readJSON(AREA_KEY, {});
    const params = { mode: kind, display: d, displays: t.displays, windows, aspect: st.aspect, lastArea: lastAreas[`desktop|${d.name}|${d.rect.w}x${d.rect.h}`] || null, presets: L.SIZE_PRESETS, preset: st.preset, excludedFromCapture: t.excludedFromCapture };
    try { await desktop.overlay.open('picker', d.rect, params); } catch (err) { toast(`Couldn’t open the picker: ${err.message}`, 'error'); return; }
    pickWait = { kind, display: d };
  }
  function onPicked(data) {
    const pw = pickWait;
    pickWait = null;
    desktop.overlay.close('picker').catch(() => {});
    if (!pw || !data) return;
    if (data.kind === 'display') st.displayId = data.displayId ?? st.displayId;
    if (data.kind === 'window') {
      st.win = st.targets.windows.find((w) => w.id === data.windowId) || st.win;
      if (data.preset) st.preset = data.preset;
    }
    if (data.kind === 'area' && data.rect) {
      const display = st.targets.displays.find((x) => x.id === data.displayId) || pw.display;
      st.deskArea = { display, rect: roundRect(data.rect) };
      st.displayId = display.id;
      if (data.aspect) st.aspect = data.aspect;
      const all = readJSON(AREA_KEY, {});
      all[`desktop|${display.name}|${display.rect.w}x${display.rect.h}`] = st.deskArea.rect;
      writeJSON(AREA_KEY, all);
    }
    remember(); renderCard(); renderStage();
    desktop.window.focus().catch(() => {});
  }

  /** Frame 3: every window as a live thumbnail, keyboard first. */
  function searchWindows() {
    const wins = st.targets?.windows || [];
    let q = '', focus = Math.max(0, wins.findIndex((w) => w.id === st.win?.id)), timer = 0;
    const thumbs = new Map();
    const grid = h('div.rsheet-grid', { role: 'listbox', 'aria-label': 'Windows' });
    const input = h('input', { type: 'search', placeholder: 'Search windows', 'aria-label': 'Search windows', oninput: (e) => { q = e.target.value.toLowerCase(); focus = 0; render(); } });
    const shown = () => wins.filter((w) => !q || `${w.title} ${w.app}`.toLowerCase().includes(q));
    const pick = (w) => { st.win = w; remember(); m.close(); renderCard(); renderStage(); };
    function render() {
      const list = shown();
      fill(grid, list.length ? list.map((w, i) => {
        const img = h('div.rwin-img', { style: thumbs.get(w.id) ? { backgroundImage: `url(${thumbs.get(w.id)})` } : {} });
        return h('button.rwin', { role: 'option', 'aria-selected': String(i === focus), class: i === focus ? 'on' : '', onclick: () => pick(w), dataset: { id: w.id } }, img, h('span.rwin-name', h('b', w.app || w.title), h('span', w.title)));
      }) : h('p.muted', 'No windows match.'));
    }
    async function refresh() {
      for (const w of shown().slice(0, 24)) {
        const url = await desktop.capture.thumbnail(w.id, { width: 360, height: 225 }).catch(() => null);
        if (url) thumbs.set(w.id, url);
      }
      render();
    }
    const body = h('div.rsheet', { onkeydown: (e) => {
      const list = shown();
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { focus = Math.min(list.length - 1, focus + (e.key === 'ArrowDown' ? 3 : 1)); render(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { focus = Math.max(0, focus - (e.key === 'ArrowUp' ? 3 : 1)); render(); e.preventDefault(); }
      else if (e.key === 'Enter' && list[focus]) { pick(list[focus]); e.preventDefault(); }
    } }, h('div.rsheet-top', h('div.rsheet-search', recIcon('search', 15), input)), grid, h('p.muted.small', 'Arrows move · Return records · Esc closes. Thumbnails refresh every 2 seconds and stay on this computer.'));
    const m = modal('All windows', body, { wide: true, onClose: () => clearInterval(timer) });
    render();
    refresh();
    timer = setInterval(refresh, 2000);
    setTimeout(() => input.focus(), 0);
  }

  // ---- the take ----------------------------------------------------------------------------------------------------
  /** Start pressed (or the shortcut): choose if needed, float the controls, count down, record. */
  async function startTake() {
    if (st.phase !== 'setup') return;
    const ready = readyToStart();
    if (!ready.ok) { toast(ready.why, 'info'); return; }
    if (isDesktop) return startDesktop();
    if (st.mode !== 'camera' && !st.display && !(await choose())) return;
    if (st.mode === 'area' && !st.area) { toast('Draw the area to keep, then press Record area', 'info'); return; }
    st.phase = 'countdown';
    st.float = await openFloating();
    const go = await runCountdown(st.countdown);
    if (!go) { st.float?.close(); st.float = null; st.phase = 'setup'; renderCard(); renderStage(); return; }
    await begin();
  }

  async function begin() {
    st.pid = uid('p');
    const cameraLayer = st.mode !== 'camera' && !!st.cam;
    const { sinks, backend } = await createSinks(st.pid, { camera: cameraLayer });
    st.backend = backend;
    const display = st.mode === 'camera' ? st.cam : st.display;
    st.session = new Session({ display, camera: cameraLayer ? st.cam : null, mic: st.mic, sinks });
    st.session.setMuted(st.muted);
    st.journal = { id: st.pid, started: Date.now(), backend, hasCamera: cameraLayer, elapsed: 0 };
    st.session.onstarted = (info) => { Object.assign(st.journal, info); saveJournal(st.journal).catch(() => {}); };
    st.session.onstop = () => finish();
    deps.hold(st.pid);
    if (isDesktop && st.mode !== 'camera') st.cursor = deps.startCursor(display);
    try { st.session.start(); } catch (err) {
      toast(`Couldn’t start recording: ${err.message}`, 'error', 7000);
      deps.release();
      st.session = null; st.phase = 'setup'; st.float?.close(); st.float = null;
      renderCard(); renderStage();
      return;
    }
    st.phase = 'recording';
    st.cameraOn = true;
    st.nudger = L.createNudger();
    st.nudge = null; st.confirm = false;
    if (st.mic) {
      st.monitor?.close();
      st.monitor = levelMonitor(st.mic, ({ db, level }) => { st.db = db; st.level = level; tick(); });
    }
    if (isDesktop) {
      desktop.setRecording(true).catch(() => {});
      if (st.notes.trim()) desktop.teleprompter.open(st.notes).catch(() => {});
      await showDesktopOverlays();
    }
    renderLive();
    const loopWin = st.float?.win || window;
    st.timer = loopWin.setInterval(tick, 250);
  }

  let lastJournal = 0, lastTick = 0;
  function tick() {
    const s = st.session;
    if (!s || s.state === 'stopped') return;
    const now = performance.now();
    if (now - lastTick < 60) return;
    lastTick = now;
    const paused = s.state === 'paused';
    if (st.nudger && st.mic) {
      const n = st.nudger.update({ t: now / 1000, db: st.db, muted: st.muted, paused });
      st.nudge = n ? { kind: n.kind, mic: micName() } : null;
    }
    const state = pillState();
    st.float?.pill.update(state);
    livePill?.update(state);
    if (liveTime) liveTime.textContent = L.fmtClock(state.time);
    if (isDesktop) desktop.overlay.broadcast(state).catch(() => {});
    if (now - lastJournal > 5000 && st.journal) { lastJournal = now; st.journal.elapsed = s.time(); saveJournal(st.journal).catch(() => {}); }
    if (prompter) prompter.scrollTop += 0.35 * 4;
  }
  function pillState() {
    const s = st.session;
    return {
      phase: st.phase === 'saving' ? 'saving' : s?.state === 'paused' ? 'paused' : 'recording',
      time: s?.time() || 0,
      level: st.level,
      muted: st.muted,
      hasMic: !!st.mic,
      cameraOn: st.cameraOn,
      hasCamera: !!st.cam && st.mode !== 'camera',
      nudge: st.nudge,
      confirm: st.confirm,
    };
  }

  // The tab while recording: a status view with the pill (in the tab when PiP isn't open) and the teleprompter.
  let livePill = null, liveTime = null, prompter = null;
  function renderLive() {
    if (st.phase === 'setup') return;
    livePill?.destroy(); livePill = null;
    const inTab = !st.float || st.float.kind === 'tab';
    liveTime = h('span.hud-time', L.fmtClock(st.session?.time() || 0));
    prompter = st.notes.trim() && !isDesktop ? h('div.recw-prompter', st.notes) : null;
    const where = isDesktop ? 'The pill and the tray control the take. This window stays out of the way.' : st.float?.kind === 'pip' ? 'The controls float above your other windows. You can also stop from the browser’s sharing bar.' : 'Recording. You can also stop from the browser’s sharing bar.';
    const popout = !isDesktop && inTab && 'documentPictureInPicture' in window ? h('button.btn.small', { onclick: async () => { const f = await openFloating(); if (f.kind === 'pip') { st.float?.close(); st.float = f; renderLive(); } else f.close(); } }, recIcon('popout', 14), 'Float the controls') : null;
    if (!inTab) {
      fill(stage, h('div.recw-live', h('div.hud-top', h('span.rec-dot'), liveTime), h('p', where), popout, prompter));
    } else {
      livePill = createPill({ doc: document, onAction: (a) => onAction(a), shortcuts: isDesktop ? DESKTOP_SHORTCUTS : WEB_SHORTCUTS });
      livePill.update({ ...pillState(), expanded: true });
      fill(stage, h('div.recw-live', livePill.el, h('p', where), popout, prompter));
    }
    fill(side, h('section.rcard', h('div.rcard-head', h('span.rcard-dot'), h('b', 'Recording')),
      h('p.muted.small', `${{ screen: 'Screen', window: 'Window', tab: 'Tab', area: 'Area', camera: 'Camera', display: 'Display' }[st.mode]}${st.info ? ` · ${st.info.label}` : ''}`),
      h('p.muted.small', 'Shortcuts: pause ', h('kbd', 'Alt+Shift+P'), ' · mute ', h('kbd', 'Alt+Shift+M'), ' · stop ', h('kbd', isDesktop ? 'Ctrl+Shift+R' : 'Alt+Shift+R'))));
  }

  /** Every pill, tray and shortcut action lands here. */
  async function onAction(action) {
    const s = st.session;
    if (st.phase === 'countdown') { if (action === 'countdown-cancel' || action === 'countdown-skip' || action === 'countdown-done') countdownSignal?.(action); return; }
    if (!s || s.state === 'stopped') return;
    switch (action) {
      case 'stop': return finish();
      case 'pause': s.pause(); break;
      case 'resume': s.resume(); break;
      case 'toggle-pause': if (s.state === 'paused') s.resume(); else s.pause(); break;
      case 'mute': case 'unmute': case 'toggle-mute':
        st.muted = action === 'toggle-mute' ? !st.muted : action === 'mute';
        s.setMuted(st.muted);
        if (!st.muted) st.nudger?.dismiss();
        break;
      case 'camera-off': case 'camera-on':
        st.cameraOn = action === 'camera-on';
        s.setCameraOn(st.cameraOn);
        st.float?.setCamOn?.(st.cameraOn);
        break;
      case 'discard': st.confirm = true; break;
      case 'discard-cancel': st.confirm = false; break;
      case 'discard-confirm': return discardTake();
      case 'restart': return restartTake();
      case 'switch-mic': return switchMic();
      default: return;
    }
    lastTick = 0;
    tick();
  }

  async function switchMic() {
    const mics = st.devices.mics.filter((d) => d.deviceId);
    if (mics.length < 2) { toast('No other microphone found', 'info'); return; }
    const i = mics.findIndex((d) => d.deviceId === st.micId);
    const next = mics[(i + 1) % mics.length];
    try {
      const stream = await openMic(next.deviceId);
      if (!st.session.setMic(stream)) { stream.getTracks().forEach((t) => t.stop()); toast('Can’t switch microphones during this take', 'info'); return; }
      st.mic = stream; st.micId = next.deviceId;
      st.monitor?.close();
      st.monitor = levelMonitor(stream, ({ db, level }) => { st.db = db; st.level = level; tick(); });
      st.nudger = L.createNudger({ silentSec: 5 });
      st.nudge = null;
      remember();
      toast(`Now recording from ${next.label || 'the next microphone'}`, 'ok');
    } catch (err) { toast(`Couldn’t switch: ${err.message}`, 'error'); }
  }

  async function restartTake() {
    const s = st.session;
    clearTimers();
    s.discard({ keepStreams: true });
    if (st.cursor) { desktop.cursor.stop().catch(() => {}); st.cursor = null; }
    const id = st.pid;
    deleteJournal(id).catch(() => {});
    (st.backend === 'idb' ? deleteChunks(id) : removeMediaDir(id)).catch(() => {});
    st.session = null;
    st.phase = 'countdown';
    st.confirm = false; st.nudge = null;
    const go = isDesktop ? await desktopCountdown() : await runCountdown(st.countdown);
    if (!go) return discardTake({ already: true });
    await begin();
  }

  function clearTimers() {
    (st.float?.win || window).clearInterval(st.timer);
    clearInterval(st.timer);
    st.monitor?.close(); st.monitor = null;
  }

  let finishing = false;
  async function finish() {
    if (finishing || !st.session) return;
    finishing = true;
    st.phase = 'saving';
    st.confirm = false;
    const saving = pillState();
    st.float?.pill.update(saving); livePill?.update(saving);
    if (isDesktop) desktop.overlay.broadcast(saving).catch(() => {});
    clearTimers();
    try {
      const timeline = st.session.timeline();
      const res = await st.session.stop();
      const cursor = await deps.stopCursor(st.cursor, timeline, res.duration);
      st.cursor = null;
      st.float?.close(); st.float = null;
      if (isDesktop) { await desktop.capture.restoreWindow().catch(() => {}); desktop.overlay.close('all').catch(() => {}); }
      const take = {
        pid: st.pid, backend: st.backend, res, cursor,
        mode: st.mode,
        crop: cropForTake(res),
        cameraOff: res.camera ? L.cameraOffRanges(timeline.cameraOffs, timeline, res.duration) : [],
        source: st.info?.label || null,
      };
      st.session = null;
      await deps.onTake(take);
    } catch (err) {
      // The journal stays, so the take can still be recovered from the home screen.
      deps.release();
      st.session = null;
      toast(`Could not save the recording: ${err.message}. It can be recovered from the home screen.`, 'error', 8000);
      deps.onExit();
    } finally {
      finishing = false;
    }
  }

  function cropForTake() {
    if (st.mode !== 'area') return null;
    if (isDesktop) {
      if (!st.deskArea || !st.areaShareMatches) return null;
      return L.cropFraction(st.deskArea.rect, st.deskArea.display.rect);
    }
    if (!st.area || !st.info) return null;
    return L.cropFraction(st.area, { x: 0, y: 0, w: st.info.width, h: st.info.height });
  }

  function discardTake({ already = false } = {}) {
    clearTimers();
    if (st.session && !already) st.session.discard({ keepStreams: true });
    if (st.cursor) { desktop.cursor.stop().catch(() => {}); st.cursor = null; }
    if (st.pid) {
      const id = st.pid;
      deleteJournal(id).catch(() => {});
      (st.backend === 'idb' ? deleteChunks(id) : removeMediaDir(id)).catch(() => {});
    }
    st.session = null; st.pid = null;
    st.float?.close(); st.float = null;
    livePill?.destroy(); livePill = null;
    deps.release();
    if (isDesktop) { desktop.capture.restoreWindow().catch(() => {}); desktop.overlay.close('all').catch(() => {}); desktop.window.focus().catch(() => {}); }
    st.phase = 'setup'; st.confirm = false; st.nudge = null; st.muted = false;
    // Streams the browser ended while recording are gone; pick again.
    if (st.display && st.display.getVideoTracks().every((t) => t.readyState === 'ended')) dropDisplay();
    toast('Take discarded', 'info');
    renderCard(); renderStage();
  }

  // ---- countdown (frame 7) ---------------------------------------------------------------------------------------------
  let countdownSignal = null;
  function runCountdown(seconds) {
    const steps = L.countdownSteps(seconds);
    if (!steps.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const views = [];
      const tab = createCountdown(document, { hint: 'Esc cancels · click to start now' });
      const host = h('div.rcountdown', { onclick: () => done(true) }, tab.el);
      document.body.append(host);
      views.push(tab);
      let pipHost = null;
      if (st.float?.kind === 'pip') { const c = createCountdown(st.float.doc); pipHost = c.el; st.float.doc.body.append(pipHost); views.push(c); pipHost.addEventListener('click', () => done(true)); }
      let i = 0, t = 0;
      const show = () => { for (const v of views) v.set(steps[i]); };
      const next = () => { i++; if (i >= steps.length) done(true); else { show(); t = setTimeout(next, 1000); } };
      const key = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter' || (e.altKey && e.shiftKey && e.code === 'KeyR')) { e.preventDefault(); done(true); }
      };
      function done(ok) {
        clearTimeout(t);
        host.remove(); pipHost?.remove();
        document.removeEventListener('keydown', key, true);
        st.float?.doc?.removeEventListener('keydown', key, true);
        countdownSignal = null;
        resolve(ok);
      }
      countdownSignal = (a) => done(a !== 'countdown-cancel');
      document.addEventListener('keydown', key, true);
      if (st.float?.kind === 'pip') st.float.doc.addEventListener('keydown', key, true);
      show();
      t = setTimeout(next, 1000);
    });
  }

  // ---- floating controls (frame 17) ------------------------------------------------------------------------------------
  /** Document Picture-in-Picture with the camera and the pill; falls back to a pill in the tab + video PiP. */
  async function openFloating() {
    const withCam = !!st.cam && st.mode !== 'camera';
    const onAct = (a) => onAction(a);
    const keys = (doc) => (e) => {
      if (!(e.altKey && e.shiftKey)) return;
      const map = { KeyP: 'toggle-pause', KeyM: 'toggle-mute', KeyR: 'stop' };
      if (map[e.code]) { e.preventDefault(); onAction(map[e.code]); }
    };
    let pip = null;
    if ('documentPictureInPicture' in window && navigator.userActivation?.isActive !== false) {
      try { pip = await window.documentPictureInPicture.requestWindow({ width: withCam ? 400 : 380, height: withCam ? 320 : 96 }); } catch { pip = null; }
    }
    if (pip) {
      const d = pip.document;
      d.documentElement.classList.add('rec-doc');
      d.title = 'Slipstream';
      ensureRecStyles(d);
      const pill = createPill({ doc: d, onAction: onAct });
      let camBox = null;
      if (withCam) {
        const v = el(d, 'video', { autoplay: true, muted: true, playsinline: true });
        v.srcObject = st.cam;
        camBox = el(d, 'div.rpip-cam', v);
        v.play().catch(() => {});
      }
      d.body.append(el(d, `div.rpip${withCam ? '' : '.nocam'}`, camBox, el(d, 'div.rpip-bar', pill.el)));
      const onKey = keys(d);
      d.addEventListener('keydown', onKey);
      const ctl = {
        kind: 'pip', win: pip, doc: d, pill,
        setCamOn(on) { camBox?.classList.toggle('off', !on); },
        close() { d.removeEventListener('keydown', onKey); pill.destroy(); try { pip.close(); } catch { /* gone */ } },
      };
      pip.addEventListener('pagehide', () => {
        if (st.float !== ctl) return;
        // Closed by the user: the pill comes back into the tab.
        st.float = null;
        if (st.phase === 'recording' || st.phase === 'saving') { st.timer && clearInterval(st.timer); st.timer = setInterval(tick, 250); renderLive(); }
      });
      return ctl;
    }
    // Fallback: the pill lives in the tab (the stage shows it), the camera floats in video picture-in-picture.
    let video = null;
    if (withCam && document.pictureInPictureEnabled) {
      video = h('video', { muted: true, autoplay: true, playsInline: true, style: { position: 'fixed', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none', right: '0', bottom: '0' } });
      video.srcObject = st.cam;
      document.body.append(video);
      try { await video.play(); await video.requestPictureInPicture(); } catch { /* needs a click; the camera is still recorded */ }
    }
    const onKey = keys(document);
    document.addEventListener('keydown', onKey);
    const pill = { update() {}, destroy() {} }; // the stage's pill (renderLive) is the one shown in the tab
    return {
      kind: 'tab', win: window, doc: document, pill,
      setCamOn() {},
      close() {
        document.removeEventListener('keydown', onKey);
        if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
        video?.remove();
      },
    };
  }

  // ---- desktop take: pickers confirmed, overlays, countdown (T-11) ---------------------------------------------------------
  async function startDesktop() {
    const t = st.targets;
    // Camera only: no screen at all.
    if (st.mode === 'camera') {
      st.phase = 'countdown';
      st.target = null;
      const go = await desktopCountdown();
      if (!go) { st.phase = 'setup'; renderCard(); return; }
      return begin();
    }
    let target = null, display = chosenDisplay();
    try {
      if (st.mode === 'window' && st.win) {
        const work = displayFor(st.win.rect)?.work;
        const size = work ? L.presetSize(st.preset, work) : null;
        target = size ? await desktop.capture.resizeWindow(st.win.id, size.w, size.h) : st.win.rect;
        await desktop.capture.focus(st.win.id).catch(() => {});
        display = displayFor(target) || display;
      } else if (st.mode === 'area' && st.deskArea) {
        display = st.deskArea.display;
        target = st.deskArea.rect;
      } else target = display?.rect || null;
      // The webview's share picker (or the portal) confirms the source.
      await desktop.window.focus().catch(() => {});
      const ok = await choose();
      if (!ok) { await desktop.capture.restoreWindow().catch(() => {}); return; }
    } catch (err) {
      await desktop.capture.restoreWindow().catch(() => {});
      toast(err.message, 'error', 7000);
      return;
    }
    const track = { width: st.info?.width, height: st.info?.height };
    const expect = st.mode === 'window' ? target : display?.rect;
    const matches = L.sizeMatches(track, expect ? { w: expect.w, h: expect.h } : null);
    st.areaShareMatches = st.mode !== 'area' || matches;
    if (!matches) toast(st.mode === 'area' ? 'You shared a different screen from the one with the area, so the whole screen is kept. Crop it in the editor.' : 'What you shared isn’t the one you picked. Recording what you shared.', 'info', 8000);
    st.target = matches ? { rect: target, display, windowId: st.mode === 'window' ? st.win?.id : null, kind: st.mode } : null;
    st.phase = 'countdown';
    const go = await desktopCountdown();
    if (!go) {
      desktop.overlay.close('all').catch(() => {});
      await desktop.capture.restoreWindow().catch(() => {});
      st.phase = 'setup'; renderCard(); renderStage();
      return;
    }
    await begin();
  }
  const displayFor = (r) => {
    const ds = st.targets?.displays || [];
    const area = (d) => Math.max(0, Math.min(r.x + r.w, d.rect.x + d.rect.w) - Math.max(r.x, d.rect.x)) * Math.max(0, Math.min(r.y + r.h, d.rect.y + d.rect.h) - Math.max(r.y, d.rect.y));
    return ds.slice().sort((a, b) => area(b) - area(a))[0] || null;
  };
  const markMargin = (d) => Math.round(10 * (d?.scale || 1));

  /** Marks in accent around the target, the countdown over its centre; resolves false when cancelled (Esc). */
  async function desktopCountdown() {
    const tgt = st.target;
    const d = tgt?.display || chosenDisplay();
    if (tgt && tgt.kind !== 'display') {
      const m = markMargin(d);
      const r = tgt.rect;
      await desktop.overlay.open('marks', { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m }, { state: 'choosing', windowId: tgt.windowId || null, margin: m }).catch(() => {});
    }
    const steps = L.countdownSteps(st.countdown);
    // The main window steps aside first, so the take starts without it showing.
    await desktop.window.minimize().catch(() => {});
    if (!steps.length) return true;
    const scale = d?.scale || 1;
    const [cw, ch] = [Math.round(380 * scale), Math.round(250 * scale)];
    const c = tgt?.rect || d?.rect || { x: 0, y: 0, w: cw, h: ch };
    const hint = tgt?.kind === 'window' && st.win ? `Recording ${st.win.app || st.win.title} · Esc cancels` : 'Esc cancels';
    const done = new Promise((resolve) => { countdownSignal = (a) => resolve(a !== 'countdown-cancel'); });
    try {
      await desktop.overlay.open('countdown', { x: Math.round(c.x + (c.w - cw) / 2), y: Math.round(c.y + (c.h - ch) / 2), w: cw, h: ch }, { seconds: st.countdown, hint });
    } catch { countdownSignal = null; return true; }
    const go = await done;
    countdownSignal = null;
    desktop.overlay.close('countdown').catch(() => {});
    if (!go) desktop.window.focus().catch(() => {});
    return go;
  }

  async function showDesktopOverlays() {
    const tgt = st.target;
    const d = tgt?.display || chosenDisplay() || st.targets?.displays?.[0];
    const scale = d?.scale || 1;
    const pill = { w: Math.round(300 * scale), h: Math.round(64 * scale) };
    const work = d?.work || d?.rect || { x: 0, y: 0, w: 1920, h: 1040 };
    const pos = L.dockPill(tgt && tgt.kind !== 'display' ? tgt.rect : null, work, pill, { display: !tgt || tgt.kind === 'display', gap: Math.round(22 * scale) });
    await desktop.overlay.open('pill', { ...pos, ...pill }, { shortcuts: DESKTOP_SHORTCUTS }).catch((err) => toast(`Couldn’t show the controls: ${err.message}. Use the tray.`, 'info', 7000));
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------------
  const onKey = (e) => {
    if (st.phase !== 'setup' || e.target.closest?.('input,textarea,select')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= modes.length && !e.altKey && !e.ctrlKey && !e.metaKey) { setMode(modes[n - 1][0]); e.preventDefault(); }
    else if (e.key === 'Enter' && !e.target.closest?.('button')) { startTake(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  if (isDesktop) st.offControl = desktop.overlay.onControl(({ action, data } = {}) => {
    if (action === 'picked') return onPicked(data);
    if (action === 'pick-cancel') { pickWait = null; desktop.overlay.close('picker').catch(() => {}); desktop.window.focus().catch(() => {}); return; }
    if (action === 'picker-display') return pickOnScreen(pickWait?.kind || 'display', data?.displayId);
    if (action === 'search-windows') { pickWait = null; desktop.overlay.close('picker').catch(() => {}); desktop.window.focus().catch(() => {}); return searchWindows(); }
    return onAction(action);
  });

  const loop = () => {
    if (st.phase === 'setup' && st.meter) {
      const lv = L.levelBars(st.meter.level());
      bars.forEach((b, i) => { b.style.transform = `scaleY(${lv[i]})`; });
    }
    st.raf = requestAnimationFrame(loop);
  };
  loop();

  (async () => {
    await refreshDevices();
    // Remember the last setup: reopen the camera and mic it used, if the browser already allows them.
    if (st.devices.labelled) {
      if (saved.camId && st.devices.cameras.some((d) => d.deviceId === saved.camId)) await setCam(saved.camId);
      if (saved.micId && st.devices.mics.some((d) => d.deviceId === saved.micId)) await setMic(saved.micId);
    }
    if (isDesktop) await loadTargets();
    renderCard(); renderStage();
  })();
  renderCard(); renderStage();

  return {
    /** Shortcut / tray: start when set up, stop when recording. */
    toggle() {
      if (st.session && st.session.state !== 'stopped') return finish();
      if (st.phase === 'countdown') return countdownSignal?.('countdown-skip');
      if (st.phase === 'setup') { if (readyToStart().ok) return startTake(); desktop.window.focus().catch(() => {}); toast(readyToStart().why || 'Choose what to record first', 'info'); }
    },
    cleanup() {
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(st.raf);
      st.offControl?.();
      if (st.session && st.session.state !== 'stopped') discardTake();
      clearTimers();
      st.float?.close();
      livePill?.destroy();
      for (const s of [st.display, st.cam, st.mic]) s?.getTracks().forEach((t) => t.stop());
      st.meter?.close();
      if (isDesktop) desktop.overlay.close('all').catch(() => {});
    },
  };
}
