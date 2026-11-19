// The recording pill (docs/handover/minimal-states.md frames 8–12 and 17), shared by Slipstream Web's floating controls
// (Document Picture-in-Picture or in the tab) and the desktop app's pill window (desktop/tauri/frontend/rec.js).
//
// Collapsed (40 px): red stop button, timer, live 4-bar mic level, drag grip. Hover (or Alt+Shift+H) expands it:
// pause, restart take, mute, camera on/off, discard; it collapses 1.5 s after the pointer leaves and fades to 60%
// after 3 s idle. Paused turns amber with a white Resume. Muted shows a red mic chip; nudges sit above it; Discard
// always confirms inline. The owner keeps the state and calls update(); every button calls onAction(name).
//
// No imports beyond rec-logic.js, and every node is created in the document it is shown in (`doc`), so the same
// code renders into a PiP window or an overlay page.
import { fmtClock, levelBars } from './rec-logic.js';

const PATHS = {
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.6" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 6h3v12H8zM13 6h3v12h-3z" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
  mic: '<rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3.5"/>',
  'mic-off': '<path d="M9 9V6.5a3 3 0 0 1 5.6-1.5M15 11v.5a3 3 0 0 1-4.6 2.5"/><path d="M6 11a6 6 0 0 0 9.4 4.9M18 11a6 6 0 0 1-.4 2.2M12 17v3.5M4 4l16 16"/>',
  camera: '<rect x="3" y="7" width="12.5" height="10" rx="2"/><path d="M15.5 10.5l5-2.8v8.6l-5-2.8"/>',
  'camera-off': '<path d="M9 7h4.5a2 2 0 0 1 2 2v1.5l5-2.8v8.6l-2.6-1.5M15.5 15.5a2 2 0 0 1-2 1.5H5a2 2 0 0 1-2-2V9a2 2 0 0 1 1.5-1.9M3 3l18 18"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  grip: '<circle cx="9" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="17.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>',
  warn: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4M12 16.8v.2"/>',
  display: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  window: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18"/>',
  tab: '<path d="M3 8.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5H11.5L9.5 5H5a2 2 0 0 0-2 2z"/>',
  area: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/>',
  person: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  speaker: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  timer: '<circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.5 1.5M9.5 3h5"/>',
  lines: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  pointer: '<path d="M6 4l12 7.5-5.5 1.5L10 19z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevron: '<path d="M8 10l4 4 4-4"/>',
  popout: '<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
};

/** One of the recorder's line icons as an <svg>, created in `doc`. */
export function recIcon(name, size = 16, doc = document) {
  // Parsed as HTML so the <svg> lands in the SVG namespace without spelling the namespace URL out.
  const t = doc.createElement('template');
  t.innerHTML = `<svg class="ri" viewBox="0 0 24 24" width="${Number(size) || 16}" height="${Number(size) || 16}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
  return t.content.firstChild;
}

/** recorder.css in `doc` (the main page, a PiP window or an overlay page), once. */
export function ensureRecStyles(doc = document, href = new URL('../recorder.css', import.meta.url).href) {
  if (doc.querySelector('link[data-rec-css]')) return;
  const l = doc.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  l.dataset.recCss = '';
  doc.head.append(l);
}

/** el(doc, 'button.cls', { attrs }, ...children): a tiny h() that creates nodes in a given document. */
export function el(doc, tag, attrs = {}, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const n = doc.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) part[0] === '.' ? n.classList.add(part.slice(1)) : (n.id = part.slice(1));
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof doc.defaultView.Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(typeof c === 'object' ? c : doc.createTextNode(String(c)));
  return n;
}

/** Default shortcut labels, shown in the tooltips (the desktop app passes its own). */
export const WEB_SHORTCUTS = { pause: 'Alt+Shift+P', mute: 'Alt+Shift+M', stop: 'Alt+Shift+R', expand: 'Alt+Shift+H' };

/**
 * Build a pill in `doc`. onAction(name, data): 'stop', 'pause', 'resume', 'restart', 'mute', 'unmute',
 * 'camera-off', 'camera-on', 'discard', 'discard-confirm', 'discard-cancel', 'switch-mic'.
 * state: { phase: 'recording'|'paused'|'saving'|'countdown', time, level, muted, hasMic, cameraOn, hasCamera,
 * nudge: null | { kind: 'muted'|'silent', mic }, confirm, expanded }. Returns { el, update(state), destroy() }.
 */
export function createPill({ doc = document, onAction = () => {}, shortcuts = WEB_SHORTCUTS, dragRegion = false } = {}) {
  const act = (name, data) => (e) => { e?.stopPropagation?.(); onAction(name, data); };
  const tip = (label, key) => (key ? `${label} (${key})` : label);
  const btn = (cls, icon, label, action, key) => {
    const b = el(doc, `button.rp-btn.${cls}`, { type: 'button', title: tip(label, key), 'aria-label': label }, recIcon(icon, 15, doc));
    b.onclick = act(action); // a property, so update() can swap the action without stacking listeners
    return b;
  };
  // Swap a button's icon only when it changes: replacing the node under the pointer would swallow the click.
  const setIcon = (b, name) => { if (b.dataset.icon !== name) { b.dataset.icon = name; b.replaceChildren(recIcon(name, 15, doc)); } };

  const stop = el(doc, 'button.rp-stop', { type: 'button', title: tip('Stop recording', shortcuts.stop), 'aria-label': 'Stop recording', onclick: act('stop') }, recIcon('stop', 14, doc));
  const time = el(doc, 'span.rp-time', { role: 'timer', 'aria-live': 'off' }, '0:00');
  const resume = el(doc, 'button.rp-resume', { type: 'button', title: tip('Resume', shortcuts.pause), onclick: act('resume') }, recIcon('play', 12, doc), 'Resume');
  const bars = Array.from({ length: 4 }, () => el(doc, 'i'));
  const level = el(doc, 'span.rp-level', { 'aria-hidden': 'true' }, bars);
  const mutedChip = el(doc, 'button.rp-muted', { type: 'button', title: tip('Unmute', shortcuts.mute), 'aria-label': 'Microphone muted. Unmute', onclick: act('unmute') }, recIcon('mic-off', 14, doc));
  const pauseBtn = btn('rp-pause', 'pause', 'Pause', 'pause', shortcuts.pause);
  const restartBtn = btn('rp-restart', 'restart', 'Restart take', 'restart');
  const micBtn = btn('rp-mic', 'mic', 'Mute microphone', 'mute', shortcuts.mute);
  const camBtn = btn('rp-cam', 'camera', 'Turn camera off', 'camera-off');
  const trashBtn = btn('rp-trash', 'trash', 'Discard take', 'discard');
  const more = el(doc, 'span.rp-more', el(doc, 'span.rp-sep'), pauseBtn, restartBtn, micBtn, camBtn, trashBtn);
  const grip = el(doc, 'span.rp-grip', { title: 'Drag to move', ...(dragRegion ? { 'data-tauri-drag-region': true } : {}) }, recIcon('grip', 14, doc));
  const spinner = el(doc, 'span.rp-spin', { 'aria-hidden': 'true' });
  const saving = el(doc, 'span.rp-saving', spinner, 'Saving…');
  const bar = el(doc, 'div.rp-bar', stop, time, resume, level, mutedChip, saving, more, grip);

  const nudgeText = el(doc, 'span.rp-nudge-text');
  const nudgeIcon = el(doc, 'span.rp-nudge-icon');
  const nudgeBtn = el(doc, 'button.rp-chip', { type: 'button' });
  const nudge = el(doc, 'div.rp-nudge', { role: 'status' }, nudgeIcon, nudgeText, nudgeBtn);
  const confirm = el(doc, 'div.rp-confirm', { role: 'alertdialog', 'aria-label': 'Discard this take?' },
    el(doc, 'span.rp-confirm-dot'),
    el(doc, 'span.rp-confirm-text', el(doc, 'b', 'Discard this take?'), el(doc, 'span', 'The recording so far won’t be saved.')),
    el(doc, 'button.rp-keep', { type: 'button', onclick: act('discard-cancel') }, 'Keep recording'),
    el(doc, 'button.rp-discard', { type: 'button', onclick: act('discard-confirm') }, 'Discard'));
  const root = el(doc, 'div.rp', { role: 'toolbar', 'aria-label': 'Recording controls', dataset: { phase: 'recording' } }, nudge, bar, confirm);

  let state = {};
  let hover = false, collapseT = 0, idleT = 0;
  const win = doc.defaultView;
  const setExpanded = (on) => { root.classList.toggle('rp-open', !!on); };
  const poke = () => {
    root.classList.remove('rp-idle');
    win.clearTimeout(idleT);
    idleT = win.setTimeout(() => { if (!hover && state.phase === 'recording' && !state.nudge && !state.confirm) root.classList.add('rp-idle'); }, 3000);
  };
  root.addEventListener('mouseenter', () => { hover = true; win.clearTimeout(collapseT); setExpanded(true); poke(); });
  root.addEventListener('mouseleave', () => { hover = false; win.clearTimeout(collapseT); collapseT = win.setTimeout(() => { if (!state.expanded) setExpanded(false); }, 1500); poke(); });
  root.addEventListener('focusin', () => setExpanded(true));
  const onKey = (e) => { if (e.altKey && e.shiftKey && e.code === 'KeyH') { e.preventDefault(); setExpanded(!root.classList.contains('rp-open')); } };
  doc.addEventListener('keydown', onKey);
  poke();

  function update(next) {
    state = { ...state, ...next };
    const s = state;
    root.dataset.phase = s.phase || 'recording';
    const paused = s.phase === 'paused';
    time.textContent = paused ? `Paused · ${fmtClock(s.time)}` : fmtClock(s.time);
    const lv = levelBars(s.muted ? 0 : s.level);
    bars.forEach((b, i) => { b.style.transform = `scaleY(${lv[i]})`; });
    level.hidden = !s.hasMic || s.muted || paused || s.phase === 'saving';
    mutedChip.hidden = !(s.hasMic && s.muted) || paused || s.phase === 'saving';
    resume.hidden = !paused;
    pauseBtn.hidden = paused;
    micBtn.hidden = !s.hasMic;
    setIcon(micBtn, s.muted ? 'mic-off' : 'mic');
    micBtn.title = tip(s.muted ? 'Unmute microphone' : 'Mute microphone', shortcuts.mute);
    micBtn.setAttribute('aria-label', s.muted ? 'Unmute microphone' : 'Mute microphone');
    micBtn.onclick = act(s.muted ? 'unmute' : 'mute');
    micBtn.classList.toggle('on', !!s.muted);
    camBtn.hidden = !s.hasCamera;
    setIcon(camBtn, s.cameraOn === false ? 'camera-off' : 'camera');
    camBtn.title = s.cameraOn === false ? 'Turn camera on' : 'Turn camera off';
    camBtn.setAttribute('aria-label', camBtn.title);
    camBtn.onclick = act(s.cameraOn === false ? 'camera-on' : 'camera-off');
    camBtn.classList.toggle('on', s.cameraOn === false);
    saving.hidden = s.phase !== 'saving';
    for (const n of [stop, time, more, grip]) n.hidden = s.phase === 'saving';
    if (s.expanded != null) setExpanded(s.expanded || hover);
    root.classList.toggle('rp-paused', paused);
    // Nudges (frame 10).
    const n = s.phase === 'recording' && s.nudge && !s.confirm ? s.nudge : null;
    nudge.hidden = !n;
    const key = n ? `${n.kind}|${n.mic || ''}` : '';
    if (n && nudge.dataset.key !== key) {
      const muted = n.kind === 'muted';
      nudgeIcon.replaceChildren(recIcon(muted ? 'mic-off' : 'warn', 14, doc));
      nudgeIcon.className = `rp-nudge-icon ${muted ? 'red' : 'amber'}`;
      nudgeText.textContent = muted ? 'You’re talking while muted' : `No sound from ${n.mic || 'your microphone'}`;
      nudgeBtn.replaceChildren(muted ? 'Unmute' : 'Switch', ...(muted && shortcuts.mute ? [el(doc, 'kbd', shortcuts.mute.replace(/Alt\+Shift\+/, '⌥⇧'))] : []));
      nudgeBtn.onclick = act(muted ? 'unmute' : 'switch-mic');
    }
    nudge.dataset.key = key;
    confirm.hidden = !s.confirm;
    bar.hidden = !!s.confirm;
    if (s.confirm || s.nudge || paused) { root.classList.remove('rp-idle'); win.clearTimeout(idleT); } else poke();
  }
  update({ phase: 'recording', time: 0, level: 0, muted: false, hasMic: false, cameraOn: true, hasCamera: false, nudge: null, confirm: false });
  return {
    el: root,
    update,
    get state() { return state; },
    destroy() { doc.removeEventListener('keydown', onKey); win.clearTimeout(idleT); win.clearTimeout(collapseT); root.remove(); },
  };
}

/**
 * The countdown circle (frame 7 / "Also in the set"): a glass ring with the number. Returns { el, set(n) }.
 */
export function createCountdown(doc = document, { hint = '' } = {}) {
  const num = el(doc, 'span.rc-num', '3');
  const ring = el(doc, 'div.rc-ring', num);
  const root = el(doc, 'div.rc', ring, hint ? el(doc, 'p.rc-hint', hint) : null);
  return {
    el: root,
    set(n) { num.textContent = String(n); ring.classList.remove('rc-tick'); void ring.offsetWidth; ring.classList.add('rc-tick'); },
  };
}
