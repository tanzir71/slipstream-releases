// Small DOM helpers, icons, toasts and dialogs. No framework.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div.cls#id', {attrs}, ...children) */
export function h(tag, attrs = {}, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else if (k === 'value') el.value = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const P = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
  record: '<circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  scissors: '<circle cx="6" cy="6.5" r="2.5"/><circle cx="6" cy="17.5" r="2.5"/><path d="M8 8l12 10M8 16L20 6"/>',
  wand: '<path d="M4 20L15 9M14 4v3M18.5 5.5l-2 2M20 10h-3M9.5 5.5l2 2"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20M10.5 7.5v6M7.5 10.5h6"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 14h4M13 14h4M7 10.5h10"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="16" cy="15" r="2.6"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1 0 1.6-.8 1.6-1.6 0-1.4-1.1-1.6-1.1-2.7 0-.9.7-1.6 1.6-1.6h2.1A4.8 4.8 0 0021 10.3C21 6.2 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.3" r="1"/><circle cx="14.5" cy="7.3" r="1"/>',
  undo: '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9.5a5 5 0 010 10H12"/>',
  redo: '<path d="M15 7l4.5 4.5L15 16"/><path d="M19 11.5H9.5a5 5 0 000 10H12"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  camera: '<rect x="3" y="6.5" width="13" height="11" rx="2"/><path d="M16 10.5l5-3v9l-5-3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 9.5h5v5h-5zM9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M6 12h12"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  text: '<path d="M5 6h14M12 6v13M8.5 19h7"/>',
  silence: '<path d="M4 12h3M17 12h3M9 8v8M15 8v8"/>',
  share: '<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12v7.5h14V12"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.01"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  aspect: '<rect x="3" y="6" width="11" height="12" rx="1.5"/><rect x="16" y="3" width="5" height="9" rx="1"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  brand: '<path d="M12 3.5l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/>',
  scenes: '<rect x="3" y="5" width="8" height="14" rx="1.5"/><rect x="13" y="5" width="8" height="14" rx="1.5"/><circle cx="17" cy="9.5" r="1.6"/>',
  people: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0111 0"/><circle cx="17" cy="9.5" r="2.4"/><path d="M15.5 14.2A4.6 4.6 0 0120.5 19"/>',
  translate: '<path d="M4 6h9M8.5 4v2M6 6c.5 3 2.6 5.4 5.5 6.5M11 6c-.6 3.4-3 6.3-6.5 7.5"/><path d="M13 20l3.5-8 3.5 8M14.2 17.5h4.6"/>',
  chat: '<path d="M5 5h14a1.5 1.5 0 011.5 1.5v9A1.5 1.5 0 0119 17h-8l-4.5 3.5V17H5a1.5 1.5 0 01-1.5-1.5v-9A1.5 1.5 0 015 5z"/><path d="M8 10h8M8 13h5"/>',
  box: '<path d="M3.5 7.5L12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5L12 11.5l8.5-4M12 11.5v9"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8 8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  annotate: '<path d="M4 20h4L19.2 8.8a2.1 2.1 0 00-3-3L5 17z"/><path d="M14.5 7.5l2 2"/>',
  mask: '<path d="M3.5 3.5l17 17"/><path d="M10.6 6.1A9.5 9.5 0 0112 6c5 0 8.5 4.6 9 6-.3.8-1.2 2.3-2.7 3.6M6.4 7.6C4.6 8.8 3.4 10.6 3 12c.5 1.4 4 6 9 6 1.6 0 3-.4 4.2-1"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>',
  arrow: '<path d="M5 19L18.5 5.5"/><path d="M9.5 5h9.5v9.5"/>',
  square: '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/>',
  highlight: '<path d="M4 20h16"/><path d="M6.5 15.5l7.8-9.4a1.6 1.6 0 012.3-.2l1.6 1.4a1.6 1.6 0 01.1 2.3l-8.5 8.6H6.5z"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>',
  music: '<path d="M9 17.5V5.5l11-2v12"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  return span;
}

/** replaceChildren that skips null/false/'' */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));
  return el;
}

export function fmtTime(sec, withMs = false) {
  if (!Number.isFinite(sec)) sec = 0;
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  const base = `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return withMs ? `${base}.${String(Math.floor((s % 1) * 10))}` : base;
}

export function fmtBytes(n) {
  if (!n) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

let toastHost;
export function toast(msg, kind = 'info', ms = 3200) {
  if (!toastHost) { toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const t = h(`div.toast.${kind}`, icon(kind === 'error' ? 'info' : kind === 'ok' ? 'check' : 'info', 16), h('span', msg));
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
}

/** Modal dialog. Returns { el, close }. */
export function modal(title, body, { wide = false, onClose } = {}) {
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const panel = h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header.modal-head', h('h2', title), h('button.icon-btn', { title: 'Close', onclick: close }, icon('x'))),
    h('div.modal-body', body));
  const back = h('div.modal-back', { onmousedown: (e) => { if (e.target === back) close(); } }, panel);
  document.body.append(back);
  document.addEventListener('keydown', esc);
  setTimeout(() => panel.querySelector('button.primary, input, select, textarea')?.focus(), 30);
  return { el: panel, close };
}

export function confirmDialog(title, text, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { resolve(v); m.close(); };
    m = modal(title, [h('p.muted', text), h('div.row.end', h('button.btn', { onclick: () => done(false) }, 'Cancel'), h('button.btn.danger', { onclick: () => done(true) }, okLabel))], { onClose: () => resolve(false) });
  });
}

/** Segmented control. options: [[value, label|Node]] */
export function segmented(options, value, onChange, cls = '') {
  const wrap = h(`div.seg${cls ? '.' + cls : ''}`, { role: 'radiogroup' });
  const render = (v) => {
    wrap.replaceChildren(...options.map(([val, label, title]) => h('button', {
      role: 'radio', 'aria-checked': String(val === v), class: val === v ? 'on' : '', title: title || undefined,
      onclick: () => { render(val); onChange(val); },
    }, label)));
  };
  render(value);
  wrap.set = render;
  return wrap;
}

export function slider(label, { min, max, step, value, format = (v) => v, onInput }) {
  const out = h('output', format(value));
  const input = h('input', { type: 'range', min, max, step, value, oninput: (e) => { const v = Number(e.target.value); out.textContent = format(v); onInput(v); } });
  return h('label.slider', h('span.slider-head', h('span', label), out), input);
}

export function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
  return h('label.toggle', input, h('span.track', h('span.knob')), h('span', label));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
