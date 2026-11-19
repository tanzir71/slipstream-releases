// Auto edit in Slipstream Web (tickets AE-07 and AE-08; docs/handover/auto-edit.md, Figma "Auto edit" A1–A13).
//   AE-07: the timeline's split button (Auto edit with Rough length, Auto edit to music…), the result as one commit with
//          an Undo toast, the inspector panel (no music A6, music A8/A9, long recording A7 with the keep map and Cut
//          first), the Pick clips → Music → Style and shape → Making the edit flow (A1–A4) and the A13 warnings.
//   AE-08: the source strip (A10: −1 beat / +1 beat / +1 bar, Push later clips or Keep length, Option/Alt to trim
//          freely), the Left out tray (A11: drag onto the timeline to the nearest beat, or +), the cut popover (A12:
//          why, Earlier / Later, Land the move on the beat, Replace clip, Show whole clip, Lock) and locks.
// Everything runs on this device: analysis in workers (autoedit-analysis.js), the solver in editor-core (autoedit.js),
// tweaks in editor-core (autoedit-tweaks.js). Each Auto edit and each tweak is one commit, so one undo step.
import { h, icon, fmtTime, toast, modal, segmented, slider, toggle, fill } from './ui.js';
import { solveAutoEdit, lengthPresets, paceShot, paceBeats, LONG_FOOTAGE, DEFAULT_SETTINGS } from '../../packages/editor-core/src/autoedit.js';
import { analyzeMusicFile, analyzeClipMotion } from './autoedit-analysis.js';
import { outputBeats, barBeatAt, snapTo, trimSegment, moveCut, insertMoment, replaceClip, landOnBeat, toggleLock, fillCrops, motionTrack } from '../../packages/editor-core/src/autoedit-tweaks.js';
import { AUTO_ASPECTS } from '../../packages/editor-core/src/focus.js';
import { bestWindow } from '../../packages/editor-core/src/beats.js';
import { sequenceSegments, segmentSpeed } from '../../packages/editor-core/src/edl.js';

const PRESET_LABEL = { auto: 'Auto', most: 'Keep most', song: 'Whole song', '15s': '15 s', '30s': '30 s', '60s': '60 s', '1m': '1 min', '5m': '5 min', '10m': '10 min', '20m': '20 min' };
const REASON_LABEL = { pauses: 'Silences and long pauses', retakes: 'Retakes and false starts', idle: 'Stretches where nothing happens', repeats: 'Points made twice', lowScore: 'Weaker moments', unused: 'Not used' };
const GROW_KEY = 'slipstream.autoedit.grow';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const ALT = isMac ? 'Option' : 'Alt';
const readSession = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const writeSession = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } };

/**
 * api = { S, project, clipList, clipNumber(id), commit(fn, opts), undo(), seek(t), selectTab(name), renderRight(),
 *         refreshTimeline(), setMusic(file), clipThumb(id), addClips() }
 */
export function createAutoEdit(api) {
  const { S, project, clipList } = api;
  const st = { running: null, music: null, musicKey: '', motion: {}, takes: [], showMinor: false, sub: 'edit', strip: null, pending: null, warning: null };

  // ---- inputs ---------------------------------------------------------------------------------------------
  const durations = () => Object.fromEntries(clipList.map((c) => [c.id, c.kind === 'photo' ? Infinity : c.duration || 0]));
  const footageTotal = () => clipList.reduce((t, c) => t + (c.kind === 'photo' ? 3 : c.duration || 0), 0);
  /** Clips in the user's order: as they first appear on the timeline, then the rest. */
  function orderedClips(ids = null) {
    const seen = [];
    for (const s of sequenceSegments(S.edit.segments)) if (!seen.includes(s.asset)) seen.push(s.asset);
    for (const c of clipList) if (!seen.includes(c.id)) seen.push(c.id);
    return seen.map((id) => clipList.find((c) => c.id === id)).filter((c) => c && S.clipBlobs[c.id] && (!ids || ids.includes(c.id)));
  }
  async function musicAnalysis(onProgress) {
    if (!S.edit.music || !S.musicBlob) return null;
    const key = `${S.musicBlob.size}:${S.edit.music.bpm || ''}`;
    if (st.music && st.musicKey === key) return st.music;
    st.music = await analyzeMusicFile(S.musicBlob, { hash: `${project.id}:music:${S.musicBlob.size}`, bpm: S.edit.music.bpm || null, onProgress });
    st.musicKey = key;
    return st.music;
  }
  async function clipInputs(list, onProgress) {
    const out = [];
    const vids = list.filter((c) => c.kind === 'video');
    let n = 0;
    for (const c of list) {
      const item = { id: c.id, kind: c.kind === 'photo' ? 'photo' : 'video', duration: c.duration, aspect: c.width && c.height ? c.width / c.height : 16 / 9, peaksPerSec: 100 };
      if (c.kind === 'video') {
        if (!st.motion[c.id]) {
          const r = await analyzeClipMotion(S.clipBlobs[c.id], { hash: `${project.id}:${c.id}:${S.clipBlobs[c.id].size}`, duration: c.duration, onProgress: (p) => onProgress?.((n + p) / vids.length, n + 1, vids.length) });
          st.motion[c.id] = r;
        }
        item.motion = st.motion[c.id].motion;
        if (Number.isFinite(st.motion[c.id].quality)) item.quality = st.motion[c.id].quality;
        n++;
        onProgress?.(n / Math.max(1, vids.length), n, vids.length);
      }
      const words = (S.edit.words || []).filter((w) => w.clip === c.id && !w.deleted);
      if (words.length) item.words = words;
      if (S.clipAudio[c.id]?.peaks?.length) item.peaks = S.clipAudio[c.id].peaks;
      out.push(item);
    }
    return out;
  }

  // ---- one press --------------------------------------------------------------------------------------------
  /**
   * Make (or re-solve) the Auto edit. settings: plan autoEdit fields; ids: clips to use (default all, in order).
   * steps(name, p): progress for the A4 card. Locked segments are kept (previous).
   */
  async function run({ settings = {}, ids = null, steps = null, quiet = false, cancelled = null } = {}) {
    if (st.running) return null;
    const list = orderedClips(ids);
    if (!list.length) { toast('Add clips first', 'info'); return null; }
    st.running = { label: 'Auto edit…' };
    renderButton();
    // A re-solve reports against the footage the first Auto edit started from.
    const before = S.edit.autoEdit?.result?.from ?? S.duration;
    try {
      steps?.('music', 0);
      const music = await musicAnalysis((p) => steps?.('music', p));
      steps?.('music', 1);
      const clips = await clipInputs(list, (p, i, n) => { steps?.('motion', p, i, n); st.running.label = `Finding motion ${i} of ${n}…`; renderButton(); });
      steps?.('match', 0.3);
      const prev = S.edit.autoEdit || {};
      const merged = { ...DEFAULT_SETTINGS, ...strip(prev), ...settings };
      if (!music && merged.match !== 'motion') merged.match = 'motion';
      const locked = sequenceSegments(S.edit.segments).some((s) => s.locked);
      const t0 = performance.now();
      if (cancelled?.()) return null;
      const moves = clips.reduce((n, c) => n + (c.motion?.moves?.length || 0), 0);
      steps?.('motion', 1, null, null, { moves, music });
      const res = solveAutoEdit({ clips, music, settings: merged, previous: locked ? { segments: S.edit.segments, trimIn: S.edit.music?.trimIn } : null });
      steps?.('match', 1, null, null, { seed: merged.seed });
      steps?.('frame', 1);
      if (cancelled?.()) return null;
      if (!res.segments.length) throw new Error('Nothing usable in these clips');
      const leftOut = res.leftOut.map(({ _ci, ...m }) => m);
      api.commit((e) => {
        e.segments = res.segments;
        // why is kept by segment id, so it still finds its segment after tweaks reorder or split the others.
        e.autoEdit = { ...res.autoEdit, result: { why: Object.fromEntries(res.segments.map((x, k) => [x.id, res.why[k]])), leftOut, keepMap: res.keepMap, from: before, solveMs: Math.round(performance.now() - t0) } };
        if (music && e.music) e.music = { ...e.music, trimIn: res.music.trimIn, start: 0 };
        e.zooms = (e.zooms || []).filter((z) => !z.auto);
        e.cuts = []; e.range = null;
      }, { raw: true });
      const seed = res.autoEdit.seed;
      st.takes = [...st.takes.filter((x) => x !== seed), seed].slice(-3);
      st.warning = music && !music.clearBeat ? 'beat' : music && res.target && res.duration < res.target - 0.5 ? { short: res.duration, want: res.target } : null;
      S.selSeg = null;
      api.selectTab('autoedit');
      if (!quiet) {
        const n = new Set(res.segments.map((s) => s.asset)).size;
        const how = [merged.order === 'mine' ? 'Your order kept' : music ? 'Ordered to the music' : 'Ordered by energy', music ? (merged.match === 'motion' ? 'cut to the motion' : 'cut on the beat') : 'cut to the motion', music ? 'with music' : 'no music'].join(' · ');
        actionToast(`${n} clip${n === 1 ? '' : 's'} tightened from ${fmtTime(before)} to ${fmtTime(res.duration)}`, how, 'Undo', () => api.undo());
      }
      return res;
    } catch (err) {
      toast(`Auto edit failed: ${err.message}`, 'error', 6000);
      return null;
    } finally {
      st.running = null;
      renderButton();
    }
  }
  const strip = (ae) => { const { result, music, ...rest } = ae || {}; return rest; };
  const settingsNow = () => ({ ...DEFAULT_SETTINGS, ...strip(S.edit.autoEdit) });
  const resolve = (patch) => run({ settings: { ...settingsNow(), ...patch }, quiet: true });

  function actionToast(msg, sub, label, fn) {
    let host = document.querySelector('.toasts');
    if (!host) { host = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
    const btn = h('button.btn.small', { onclick: () => { fn(); el.remove(); } }, label);
    const el = h('div.toast.ok.ae-toast', icon('check', 16), h('span.ae-toast-text', h('b', msg), sub ? h('small', sub) : null), btn);
    host.append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 300); }, 9000);
  }

  // ---- A5 split button ---------------------------------------------------------------------------------------
  const mainBtn = h('button.btn.small.ae-main', { title: 'Tighten every clip and cut to the motion (or to the beat when there is music)', onclick: () => run({ settings: { length: { preset: S.edit.autoEdit?.length?.preset || 'auto' } } }) });
  const moreBtn = h('button.btn.small.ae-more', { 'aria-haspopup': 'menu', 'aria-label': 'More Auto edit options', onclick: (e) => { e.stopPropagation(); toggleMenu(); } }, icon('chevron', 12));
  const button = h('div.ae-split', mainBtn, moreBtn);
  let menu = null;
  function renderButton() {
    fill(mainBtn, st.running ? h('span.mini-spin') : icon('wand', 13), st.running ? st.running.label : 'Auto edit');
    mainBtn.disabled = !!st.running; moreBtn.disabled = !!st.running;
  }
  renderButton();
  function toggleMenu() {
    if (menu) { closeMenu(); return; }
    const total = footageTotal();
    const presets = lengthPresets(total);
    const cur = S.edit.autoEdit?.length?.preset || 'auto';
    menu = h('div.ae-menu', { role: 'menu' },
      h('button.ae-item', { role: 'menuitem', onclick: () => { closeMenu(); run({ settings: { length: { preset: cur } } }); } }, icon('wand', 16), h('span', h('b', 'Auto edit'), h('small', S.edit.music ? 'Cut to the music on the timeline, in your order.' : 'Tighten each clip and cut to its motion. Keeps your order and sound.'))),
      h('div.ae-len', h('span.muted.small', 'Rough length'), h('div.ae-chips', presets.map((p) => h('button.chip', { class: p === cur ? 'on' : '', role: 'menuitemradio', 'aria-checked': String(p === cur), onclick: () => { closeMenu(); run({ settings: { length: { preset: p } } }); } }, PRESET_LABEL[p] || p)))),
      h('button.ae-item', { role: 'menuitem', onclick: () => { closeMenu(); openFlow('music'); } }, icon('music', 16), h('span', h('b', 'Auto edit to music…'), h('small', 'Pick a song and cut on the beat.'))),
      h('button.ae-item', { role: 'menuitem', onclick: () => { closeMenu(); openFlow('pick'); } }, icon('grid', 16), h('span', h('b', 'Pick clips…'), h('small', 'Choose clips, then music or skip it.'))),
      h('p.ae-foot', 'If the timeline already has music, Auto edit cuts to it.'));
    button.append(menu);
    setTimeout(() => menu?.querySelector('button')?.focus(), 0);
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); moreBtn.focus(); } });
    setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  }
  function outside(e) { if (menu && !button.contains(e.target)) closeMenu(); }
  function closeMenu() { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside); }

  // ---- A1–A4 flow --------------------------------------------------------------------------------------------
  function openFlow(start = 'pick') {
    const order = orderedClips().map((c) => c.id);
    const f = { step: start, picks: order.slice(), best: true, music: S.edit.music ? 'project' : 'none', file: null, analysis: null, length: '30s', settings: { ...settingsNow(), order: S.edit.music ? 'energy' : 'mine' }, aspect: S.edit.aspect };
    const body = h('div.ae-flow');
    const m = modal('Auto edit', body, { wide: true, onClose: () => { f.closed = true; } });
    const stepsBar = () => h('ol.ae-steps', [['pick', 'Clips'], ['music', 'Music'], ['style', 'Style and shape'], ['make', 'Making the edit']].map(([k, l], i) => h('li', { class: k === f.step ? 'on' : '' }, h('span', String(i + 1)), l)));
    const nav = (back, next, nextLabel = 'Next', extra = null) => h('div.row.end', extra, back ? h('button.btn', { onclick: () => { f.step = back; render(); } }, 'Back') : null, h('button.btn.primary', { onclick: next }, nextLabel));
    async function chooseFile(file) {
      f.file = file; f.music = 'file'; f.analysis = null; render();
      try { f.analysis = await analyzeMusicFile(file, { hash: `music:${file.name}:${file.size}` }); } catch (err) { toast(`Couldn’t read that song: ${err.message}`, 'error'); f.music = 'none'; }
      if (!f.closed) render();
    }
    async function ensureProjectAnalysis() {
      if (f.music !== 'project' || f.analysis) return;
      try { f.analysis = await musicAnalysis(); } catch { /* shown as no beat */ }
      if (!f.closed) render();
    }
    function render() {
      if (f.step === 'pick') {
        const picked = (id) => f.picks.indexOf(id);
        fill(body, stepsBar(),
          h('p.muted', 'Pick the clips to use, in the order you want them. Numbers show the order.'),
          h('div.ae-grid', clipList.map((c) => {
            const i = picked(c.id);
            return h('button.ae-pick', { class: i >= 0 ? 'on' : '', 'aria-pressed': String(i >= 0), onclick: () => { if (i >= 0) f.picks.splice(i, 1); else f.picks.push(c.id); render(); }, style: api.clipThumb(c.id) ? { backgroundImage: `url("${api.clipThumb(c.id)}")` } : {} },
              i >= 0 ? h('span.ae-n', String(i + 1)) : null, h('span.ae-name', c.name || c.id), h('span.ae-dur', c.kind === 'photo' ? 'Photo' : fmtTime(c.duration)));
          })),
          toggle('Use only the best moments of long clips', f.best, (v) => { f.best = v; }),
          (() => {
            const chosen = f.picks.map((id) => clipList.find((c) => c.id === id)).filter(Boolean);
            const photos = chosen.filter((c) => c.kind === 'photo').length;
            const footage = chosen.reduce((t, c) => t + (c.kind === 'photo' ? 0 : c.duration || 0), 0);
            return h('p.muted.small', h('b', `${chosen.length} picked`), ` · ${fmtTime(footage)} of footage${photos ? ` · ${photos} photo${photos > 1 ? 's' : ''}` : ''}`);
          })(),
          nav(null, () => { if (!f.picks.length) return toast('Pick at least one clip', 'info'); f.step = 'music'; render(); }, 'Next',
            h('button.btn.ghost', { title: 'Put the picked clips on the timeline in this order, whole, without Auto edit', onclick: () => { if (!f.picks.length) return; addToTimeline(f.picks); m.close(); } }, 'Add to timeline')));
      } else if (f.step === 'music') {
        ensureProjectAnalysis();
        const fileIn = h('input', { type: 'file', accept: 'audio/*,.mp3,.m4a,.wav,.ogg,.flac', hidden: true, onchange: (e) => e.target.files[0] && chooseFile(e.target.files[0]) });
        const opt = (k, label, sub, onclick) => h('button.ae-opt', { class: f.music === k ? 'on' : '', 'aria-pressed': String(f.music === k), onclick }, h('b', label), sub ? h('small', sub) : null);
        const a = f.analysis;
        const lens = ['15s', '30s', '60s', 'song'];
        fill(body, stepsBar(),
          h('div.ae-opts',
            S.edit.music ? opt('project', S.edit.music.name || 'This project’s music', 'Already on the timeline', () => { f.music = 'project'; f.analysis = null; render(); }) : null,
            opt('file', f.file ? f.file.name : 'Add a music file', 'From this computer', () => fileIn.click()),
            opt('none', 'No music', 'Cut to the motion and keep the clip sound', () => { f.music = 'none'; f.analysis = null; render(); }),
            fileIn),
          h('p.muted.small', 'Want something new? Generate a track with your own key in the Music tab.'),
          f.music !== 'none' && !a ? h('p.muted.small', h('span.mini-spin'), ' Reading the beats…') : null,
          a ? musicView(a, f.length) : null,
          a && !a.clearBeat ? warning('No clear beat found', 'This track is free-time, so cuts follow its loudest moments and phrases instead.', [['Set BPM…', () => { const v = Number(prompt('Beats per minute', '120')); if (v > 30 && v < 300) { f.analysis = null; analyzeMusicFile(f.file || S.musicBlob, { bpm: v, hash: `bpm:${v}:${(f.file || S.musicBlob)?.size}` }).then((x) => { f.analysis = x; render(); }); } }], ['Pick another song', () => fileIn.click()]]) : null,
          a ? h('div.row', h('span.muted.small', 'Length'), segmented(lens.map((k) => [k, PRESET_LABEL[k]]), f.length, (v) => { f.length = v; render(); })) : null,
          nav(start === 'pick' ? 'pick' : null, () => { f.step = 'style'; if (f.music !== 'none' && !f.touched) { f.settings.order = 'energy'; f.settings.match = 'both'; f.settings.keepClipSound = false; f.touched = true; } render(); }, 'Next', h('button.btn.ghost', { onclick: () => { f.music = 'none'; f.analysis = null; f.step = 'style'; f.settings.order = 'mine'; render(); } }, 'Skip, cut to the motion')));
      } else if (f.step === 'style') {
        const music = f.music !== 'none';
        const s = f.settings;
        fill(body, stepsBar(),
          h('p.sub-label', 'Match'),
          segmented([['beat', 'Beat'], ['motion', 'Motion'], ['both', 'Both']], music ? s.match : 'motion', (v) => { s.match = v; }, music ? 'full-seg' : 'full-seg.disabled'),
          slider('Pace', { min: 0, max: 1, step: 0.05, value: Number(s.pace) || 0.5, format: (v) => (music ? `Every ${paceBeats(v) === 1 ? 'beat' : paceBeats(v) === 4 ? 'bar' : '2 beats'}` : `About ${Math.round(paceShot(v) * 10) / 10} s a shot`), onInput: (v) => { s.pace = v; } }),
          h('p.sub-label', 'Order'),
          segmented([['energy', music ? 'Match the music' : 'Match the energy'], ['mine', 'Keep my order']], s.order, (v) => { s.order = v; }, 'full-seg'),
          h('p.sub-label', 'Shape'),
          segmented([['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5']], f.aspect, (v) => { f.aspect = v; }, 'full-seg'),
          music ? h('div.stack', toggle('Zoom punch on downbeats', !!s.transitions?.punch, (v) => { s.transitions = { ...s.transitions, punch: v }; }), toggle('Flash on the drop', !!s.transitions?.flash, (v) => { s.transitions = { ...s.transitions, flash: v }; }), toggle('Crossfade between sections', s.transitions?.sectionFade !== false, (v) => { s.transitions = { ...s.transitions, sectionFade: v }; }), toggle('Keep clip sound under the music', !!s.keepClipSound, (v) => { s.keepClipSound = v; })) : null,
          nav('music', () => make(), 'Make the edit'));
      }
    }
    async function make() {
      f.step = 'make';
      const prog = { music: 0, motion: 0, match: 0, frame: 0 };
      const n = f.picks.filter((id) => clipList.find((c) => c.id === id)?.kind === 'video').length;
      const a = f.analysis;
      const chorus = a?.sections?.find((x) => /chorus/i.test(x.label || ''));
      const detail = {
        music: a ? `${Math.round(a.bpm)} BPM, ${a.meter || 4}/4${chorus ? `, chorus at ${fmtTime(chorus.start)}` : ''}` : '',
        motion: '', match: '', frame: `for ${f.aspect} · movement`,
      };
      const strip = h('div.ae-make-strip', f.picks.map((id) => h('span', { style: api.clipThumb(id) ? { backgroundImage: `url("${api.clipThumb(id)}")` } : {} })));
      const draw = () => fill(body, stepsBar(),
        h('div.ae-make-head', icon('wand', 16), h('span', h('b', 'Making your edit'), h('small.muted', 'On this computer'))),
        strip,
        h('ol.polish-steps.ae-make', [['music', 'Reading the music'], ['motion', `Finding motion in ${n} clip${n === 1 ? '' : 's'}`], ['match', f.music !== 'none' ? 'Matching cuts to beats' : 'Matching cuts'], ['frame', 'Reframing']].filter(([k]) => k !== 'music' || f.music !== 'none').map(([k, l]) => {
          const p = prog[k];
          return h('li', { class: p >= 1 ? 'ps-done' : p > 0 ? 'ps-run' : 'ps-wait' }, h('span.ps-mark', p >= 1 ? icon('check', 14) : p > 0 ? h('span.mini-spin') : h('span.dot')), h('span.ps-label', l), h('span.ps-detail.muted.small', detail[k] || ''));
        })),
        h('div.row', h('button.btn', { onclick: () => { f.cancelled = true; m.close(); toast('Auto edit cancelled · nothing changed', 'info'); } }, 'Cancel')));
      draw();
      // Music first: the chosen song goes on the timeline (it is what the edit is cut to).
      if (f.music === 'file' && f.file) { await api.setMusic(f.file); st.music = f.analysis; st.musicKey = `${f.file.size}:`; }
      if (f.music === 'none' && S.edit.music) api.commit((e) => { delete e.music; }, { raw: true });
      if (f.aspect !== S.edit.aspect) api.commit((e) => { e.aspect = f.aspect; }, { raw: true });
      const length = f.music !== 'none' ? { preset: f.length } : { preset: f.best ? 'auto' : 'most' };
      const res = await run({
        settings: { ...f.settings, length, match: f.music === 'none' ? 'motion' : f.settings.match }, ids: f.picks, cancelled: () => f.cancelled,
        steps: (k, p, i, total, info) => {
          if (f.closed) return;
          prog[k] = p;
          if (k === 'motion' && total) detail.motion = `${i} of ${total} clips`;
          if (k === 'motion' && info) detail.motion = `${info.moves} move${info.moves === 1 ? '' : 's'} worth ${info.music ? 'landing on a beat' : 'cutting to'}`;
          if (k === 'match' && info) detail.match = `take ${Math.max(1, st.takes.length + (st.takes.includes(info.seed) ? 0 : 1))} of 3`;
          draw();
        },
      });
      if (f.cancelled) return;
      if (res) m.close(); else if (!f.closed) { f.step = 'style'; render(); }
    }
    render();
  }

  function musicView(a, lengthPreset) {
    const W = 640, H = 64;
    const c = h('canvas.ae-wave', { width: W * 2, height: H * 2, 'aria-label': `Song: ${Math.round(a.bpm || 0)} BPM, ${fmtTime(a.duration)}` });
    const g = c.getContext('2d');
    g.scale(2, 2);
    const sec = (t) => (t / Math.max(1, a.duration)) * W;
    const L = lengthPreset === 'song' ? Infinity : parseInt(lengthPreset, 10);
    const win = bestWindow(a, L);
    g.fillStyle = 'rgba(139,147,255,.14)';
    g.fillRect(sec(win.start), 0, sec(win.end) - sec(win.start), H);
    const env = Array.isArray(a.energy) || ArrayBuffer.isView(a.energy) ? a.energy : Array.isArray(a.energy?.values) ? a.energy.values : [];
    g.fillStyle = 'rgba(160,166,255,.6)';
    for (let x = 0; x < W && env.length; x++) { const v = env[Math.floor((x / W) * env.length)] || 0; const hh = Math.max(1, Math.min(1, v) * (H / 2 - 4)); g.fillRect(x, H / 2 - hh, 1, hh * 2); }
    g.fillStyle = 'rgba(255,255,255,.35)';
    for (const b of a.beats || []) g.fillRect(sec(b), H - 6, 1, 6);
    g.fillStyle = 'rgba(255,255,255,.8)';
    for (const b of a.downbeats || []) g.fillRect(sec(b), H - 12, 1, 12);
    for (const s of a.sections || []) { g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '10px ui-monospace, monospace'; g.fillText(s.label || '', sec(s.start) + 3, 11); }
    return h('div.ae-music', c, h('p.muted.small', `${a.clearBeat ? `${Math.round(a.bpm)} BPM` : 'No clear beat'} · ${fmtTime(a.duration)} · best ${fmtTime(win.end - win.start)} from ${fmtTime(win.start)}`));
  }

  function warning(title, text, actions) {
    return h('div.ae-warn', { role: 'alert' }, h('b', icon('info', 14), title), h('p.muted.small', text), h('div.row', actions.map(([l, fn], i) => h(`button.btn.small${i === 0 ? '.primary' : ''}`, { onclick: fn }, l))));
  }

  // ---- the panel (A6 / A7 / A8) ------------------------------------------------------------------------------
  function renderPanel(host) {
    const ae = S.edit.autoEdit;
    const res = ae?.result;
    const left = (res?.leftOut || []).filter((m) => st.showMinor || !m.minor);
    const tabsEl = segmented([['edit', 'Auto edit'], ['left', `Left out${res?.leftOut?.length ? ` ${res.leftOut.length}` : ''}`]], st.sub, (v) => { st.sub = v; renderPanel(host); }, 'full-seg');
    if (!ae) {
      fill(host, h('section.insp', h('h4', 'Auto edit'),
        h('p.muted.small', 'Put clips in the order you want, then press Auto edit. Music is optional.'),
        h('button.btn.wide', { disabled: !!st.running, onclick: () => run() }, icon('wand', 15), 'Auto edit'),
        h('button.btn.wide.ghost', { onclick: () => openFlow('music') }, icon('music', 15), 'Auto edit to music…')));
      return;
    }
    if (st.sub === 'left') { fill(host, tabsEl, leftOutView(left, res)); return; }
    const music = !!(S.edit.music && ae.music);
    const s = settingsNow();
    const total = res?.keepMap?.total || footageTotal();
    const long = total >= LONG_FOOTAGE;
    const presets = lengthPresets(total, { music });
    const preset = s.length?.preset || (music ? 'song' : 'auto');
    const grid = outputBeats(S.edit);
    const takeN = st.takes.indexOf(s.seed) + 1 || 1;
    const beats = (v) => { const n = paceBeats(v); return n === 1 ? 'Every beat' : n === 2 ? 'Every 2 beats' : 'Every bar'; };
    fill(host, tabsEl,
      st.warning === 'beat' ? warning('No clear beat found', 'This track is free-time, so cuts follow its loudest moments and phrases instead.', [['Set BPM…', () => { const v = Number(prompt('Beats per minute', '120')); if (v > 30 && v < 300) { api.commit((e) => { if (e.music) e.music.bpm = v; }, { raw: true }); st.music = null; resolve({}); } }], ['Pick another song', () => openFlow('music')]]) : null,
      st.warning?.short ? warning(`Not enough footage for ${fmtTime(st.warning.want)}`, `The clips cover ${fmtTime(st.warning.short)} of the song.`, [[`Make it ${Math.round(st.warning.short)} s`, () => resolve({ length: { preset: 'custom', target: Math.floor(st.warning.short) } })], ['Reuse best moments', () => resolve({ length: { preset: 'custom', target: st.warning.want } })], ['Add clips', () => api.addClips()]]) : null,
      h('section.insp', h('h4', 'Match'),
        h('div.frame-pick.three', { role: 'radiogroup', 'aria-label': 'Match' }, [['beat', 'Beat'], ['motion', 'Motion'], ['both', 'Both']].map(([k, l]) => h('button', { role: 'radio', 'aria-checked': String(s.match === k), class: s.match === k ? 'on' : '', disabled: !music && k !== 'motion', onclick: () => resolve({ match: k }) }, h('span', l)))),
        music ? h('p.muted.small', s.match === 'beat' ? 'Cuts land on the beat.' : s.match === 'both' ? 'Cuts land on the beat, and each clip’s biggest move lands on a beat too, nudged up to 12% faster or slower.' : 'Cuts follow the motion in each clip; the music plays under it.')
          : h('button.btn.wide', { onclick: () => openFlow('music') }, icon('music', 14), 'Add music to cut on the beat')),
      h('section.insp', h('div.row.between', h('h4', 'Rough length'), h('span.muted.small.mono', `${fmtTime(total)} → about ${fmtTime(S.duration)}`)),
        segmented(presets.map((p) => [p, PRESET_LABEL[p] || p]), preset, (v) => resolve({ length: { preset: v } }), 'full-seg'),
        long ? h('div.stack', h('p.sub-label', 'Cut first'),
          ...['pauses', 'retakes', 'idle', 'repeats'].map((k) => toggle(REASON_LABEL[k], s.cutFirst?.[k] !== false && (k !== 'repeats' || !!s.cutFirst?.repeats), (v) => resolve({ cutFirst: { ...s.cutFirst, [k]: v } }))),
          h('p.muted.small', 'Speech is kept in whole sentences. Shorter targets cut deeper down this list.')) : null),
      h('section.insp', h('div.row.between', h('h4', 'Pace'), h('span.muted.small.mono', music ? beats(s.pace) : `About ${Math.round(paceShot(s.pace))} s a shot`)),
        slider('', { min: 0, max: 1, step: 0.05, value: Number(s.pace) || 0.5, format: () => '', onInput: debounced((v) => resolve({ pace: v })) }),
        h('div.slider-scale', h('span', 'Relaxed'), h('span', 'Energetic'))),
      h('section.insp', h('h4', 'Sound'),
        toggle(music ? 'Keep clip sound under the music' : 'Keep clip sound', !!s.keepClipSound, (v) => resolve({ keepClipSound: v })),
        toggle('Don’t cut mid-sentence', s.sentences !== false, (v) => resolve({ sentences: v }))),
      music ? h('section.insp', h('h4', 'Transitions'),
        toggle('Zoom punch on downbeats', !!s.transitions?.punch, (v) => api.commit((e) => { e.autoEdit.transitions = { ...e.autoEdit.transitions, punch: v }; }, { raw: true })),
        toggle('Flash on the drop', !!s.transitions?.flash, (v) => api.commit((e) => { e.autoEdit.transitions = { ...e.autoEdit.transitions, flash: v }; }, { raw: true })),
        toggle('Crossfade between sections', s.transitions?.sectionFade !== false, (v) => api.commit((e) => { e.autoEdit.transitions = { ...e.autoEdit.transitions, sectionFade: v }; }, { raw: true }))) : null,
      h('section.insp', h('h4', 'Order'),
        segmented([['energy', music ? 'Match the music' : 'Match the energy'], ['mine', 'Keep my order']], s.order, (v) => resolve({ order: v }), 'full-seg')),
      h('section.insp',
        h('div.row.between', h('button.btn', { disabled: !!st.running, onclick: () => resolve({ seed: (Number(s.seed) || 1) + 1 }) }, icon('sparkles', 14), music ? 'Shuffle' : 'Try another take'), h('span.muted.small', `Take ${takeN} of ${Math.max(1, st.takes.length)}`), h('button.btn.primary', { onclick: () => api.selectTab('layout') }, 'Keep this edit')),
        h('p.muted.small', 'Your trims and locked clips stay put when you shuffle or change the pace.'),
        grid ? h('p.muted.small.mono', `${Math.round(grid.bpm)} BPM`) : null));
  }
  function debounced(fn) { let t; return (v) => { clearTimeout(t); t = setTimeout(() => fn(v), 350); }; }


  // ---- A11 Left out --------------------------------------------------------------------------------------------
  function leftOutView(list, res) {
    return h('section.insp',
      h('p.muted.small', 'Moments the edit didn’t use, best first. Drag one onto the timeline: it lands on the nearest beat (or cut). + adds it at the playhead.'),
      list.length ? h('ul.ae-left', list.map((m) => {
        const n = api.clipNumber(m.asset);
        const li = h('li', { draggable: 'true', tabIndex: 0, 'aria-label': `Clip ${n}, ${fmtTime(m.start)} to ${fmtTime(m.end)}${m.highMotion ? ', lots of motion' : ''}`,
          ondragstart: (e) => { e.dataTransfer.setData('application/x-slipstream-moment', JSON.stringify(m)); e.dataTransfer.effectAllowed = 'copy'; } },
        h('span.ae-thumb', { style: api.clipThumb(m.asset) ? { backgroundImage: `url("${api.clipThumb(m.asset)}")` } : {} }, h('span', String(n))),
        h('span.grow', h('b', `Clip ${n} · ${fmtTime(m.start)}–${fmtTime(m.end)}`), h('small.muted', `${m.highMotion ? '◆ lots of motion · ' : ''}${REASON_LABEL[m.reason] || m.reason || ''}`)),
        h('button.icon-btn', { title: 'Add at the playhead', 'aria-label': 'Add at the playhead', onclick: () => insertAt(m, S.t) }, icon('plus', 14)));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') insertAt(m, S.t); });
        return li;
      })) : h('p.muted.small', 'Nothing left out.'),
      res?.leftOut?.some((m) => m.minor) ? toggle('Show photos and short bits', st.showMinor, (v) => { st.showMinor = v; api.renderRight(); }) : null);
  }
  function insertAt(m, t) {
    const grid = outputBeats(S.edit);
    api.commit((e) => { Object.assign(e, fillCrops(insertMoment(e, m, t, { grid, durations: durations() }), AUTO_ASPECTS, reframeInputs())); dropLeftOut(e, m); }, { raw: true });
    const bb = grid ? barBeatAt(grid, snapTo(grid.beats, t)) : null;
    toast(bb ? `Inserted at bar ${bb.bar} · beat ${bb.beat}` : `Inserted at ${fmtTime(t)}`, 'ok', 2000);
  }
  function dropLeftOut(e, m) {
    const r = e.autoEdit?.result;
    if (r?.leftOut) r.leftOut = r.leftOut.filter((x) => !(x.asset === m.asset && Math.abs(x.start - m.start) < 1e-6));
  }
  /** The editor's Clips lane calls this for a moment dropped at output time t. */
  function dropMoment(json, t) {
    try { insertAt(JSON.parse(json), t); } catch { /* not ours */ }
  }

  // ---- A12 cut popover ---------------------------------------------------------------------------------------
  const pop = h('div.tl-pop.ae-pop', { role: 'dialog', 'aria-label': 'Cut', hidden: true });
  function closeCut() { pop.hidden = true; st.cutFor = null; }
  /** Open the popover for the cut at the start of segment id, anchored at clientX over `lane`. */
  function openCut(id, anchor) {
    const segs = sequenceSegments(S.edit.segments);
    const i = segs.findIndex((s) => s.id === id);
    if (i < 0 || !S.edit.autoEdit) return;
    st.cutFor = id;
    const s = segs[i];
    const res = S.edit.autoEdit.result;
    const why = res?.why?.[id];
    const grid = outputBeats(S.edit);
    const bb = grid ? barBeatAt(grid, s.start) : null;
    const step = grid ? grid.beat : 0.5;
    const sp = segmentSpeed(s);
    const moveSrc = why?.moveAt != null && grid ? s.sourceIn + (why.moveAt - s.start) * sp : null;
    const moveOut = moveSrc != null ? s.start + (moveSrc - s.sourceIn) / sp : null;
    const onBeat = grid && moveOut != null ? Math.abs(snapTo(grid.beats, moveOut) - moveOut) < 0.02 : false;
    const move = (d) => { if (i === 0) return; api.commit((e) => { Object.assign(e, moveCut(e, i - 1, d, { durations: durations() })); }, { raw: true }); openCut(id, anchor); };
    const alt = (res?.leftOut || []).find((m) => m.asset !== s.asset) || (res?.leftOut || [])[0];
    fill(pop,
      h('div.tl-pop-head', h('b', bb ? `Cut at bar ${bb.bar}, beat ${bb.beat}` : `Cut at ${fmtTime(s.start, true)}`), h('button.icon-btn', { title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeCut }, icon('x', 13))),
      why?.text ? h('p.ae-why', icon('info', 13), why.text) : null,
      h('div.seg.full-seg', h('button', { disabled: i === 0, onclick: () => move(-step) }, '◀ Earlier'), h('button.on', { disabled: true }, bb ? `On bar ${bb.bar}` : fmtTime(s.start)), h('button', { disabled: i === 0, onclick: () => move(step) }, 'Later ▶')),
      moveSrc != null ? toggle('Land the move on the beat', onBeat, (v) => { if (v) { api.commit((e) => { Object.assign(e, landOnBeat(e, id, moveSrc, grid, { durations: durations() })); }, { raw: true }); openCut(id, anchor); } }) : null,
      h('div.tl-pop-foot',
        h('button.link', { disabled: !alt, onclick: () => { api.commit((e) => { Object.assign(e, fillCrops(replaceClip(e, id, alt, { durations: durations() }), AUTO_ASPECTS, reframeInputs())); dropLeftOut(e, alt); }, { raw: true }); closeCut(); } }, '⇄ Replace clip'),
        h('button.link', { onclick: () => { openStrip(id); closeCut(); } }, '↔ Show whole clip'),
        h('button.link', { onclick: () => { api.commit((e) => { Object.assign(e, toggleLock(e, id)); }, { raw: true }); openCut(id, anchor); } }, s.locked ? 'Unlock' : 'Lock')));
    pop.hidden = false;
    pop.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeCut(); } };
    requestAnimationFrame(() => {
      const box = pop.offsetParent?.getBoundingClientRect();
      if (!box || !anchor) return;
      const w = pop.offsetWidth || 280;
      pop.style.left = `${Math.max(8, Math.min(box.width - w - 8, anchor.x - box.left - w / 2))}px`;
      pop.style.bottom = `${Math.max(8, box.bottom - anchor.top + 8)}px`;
    });
  }

  // ---- A10 source strip --------------------------------------------------------------------------------------
  const stripEl = h('div.ae-strip', { hidden: true });
  function openStrip(id) { st.strip = id; renderStrip(); }
  function closeStrip() { st.strip = null; st.pending = null; stripEl.hidden = true; }
  function grow(edge, amount) {
    const mode = readSession(GROW_KEY);
    if (!mode) { st.pending = { edge, amount }; renderStrip(); return; }
    api.commit((e) => { Object.assign(e, trimSegment(e, st.strip, edge, amount, { mode, durations: durations() })); }, { raw: true });
    renderStrip();
  }
  function renderStrip() {
    const segs = sequenceSegments(S.edit.segments);
    const s = segs.find((x) => x.id === st.strip);
    if (!s) { closeStrip(); return; }
    const c = clipList.find((x) => x.id === s.asset) || {};
    const grid = outputBeats(S.edit);
    const dur = c.kind === 'photo' ? Math.max(3, s.end - s.start) : c.duration || 1;
    const sp = segmentSpeed(s);
    const a = s.sourceIn, b = s.sourceIn + (s.end - s.start) * sp;
    const pct = (t) => `${(Math.max(0, Math.min(dur, t)) / dur) * 100}%`;
    const unit = grid ? grid.beat : 0.5;
    const bar = grid ? grid.beat * 4 : 1;
    const mode = readSession(GROW_KEY);
    const body = h('div.ae-strip-body', { style: api.clipThumb(s.asset) ? { backgroundImage: `url("${api.clipThumb(s.asset)}")` } : {} },
      h('span.ae-out', { style: { left: 0, width: pct(a) } }, a > 0.3 ? h('small', `Left out · ${fmtTime(0)}–${fmtTime(a)}`) : null),
      h('span.ae-used', { style: { left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` } }, h('span.ae-h.l', { title: `Drag to change the start (${ALT} to trim freely)` }), h('span.ae-h.r', { title: `Drag to change the end (${ALT} to trim freely)` })),
      h('span.ae-out', { style: { left: pct(b), right: 0 } }, dur - b > 0.3 ? h('small', `Left out · ${fmtTime(b)}–${fmtTime(dur)}`) : null));
    for (const hd of body.querySelectorAll('.ae-h')) {
      hd.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const edge = hd.classList.contains('l') ? 'start' : 'end';
        const r = body.getBoundingClientRect();
        hd.setPointerCapture(e.pointerId);
        let last = 0;
        const move = (ev) => {
          const t = ((ev.clientX - r.left) / r.width) * dur;
          let g = edge === 'end' ? (t - b) / sp : (a - t) / sp;
          if (!ev.altKey) g = Math.round(g / unit) * unit; // snaps to whole beats (or half seconds without music)
          last = g;
          hd.parentElement.style.outline = g ? '2px dashed var(--accent)' : '';
        };
        const up = () => { hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); if (Math.abs(last) > 1e-3) grow(edge, last); else renderStrip(); };
        hd.addEventListener('pointermove', move);
        hd.addEventListener('pointerup', up);
      });
    }
    const choose = (v) => { writeSession(GROW_KEY, v); const p = st.pending; st.pending = null; if (p) grow(p.edge, p.amount); else renderStrip(); };
    fill(stripEl,
      h('div.ae-strip-head',
        h('b', `Clip ${api.clipNumber(s.asset)} · ${c.name || ''}`), h('span.muted.small', `${fmtTime(dur)} long · using ${fmtTime(a)}–${fmtTime(b)}`),
        h('div.seg', h('button', { onclick: () => grow('end', -unit) }, grid ? '−1 beat' : '−0.5 s'), h('button', { onclick: () => grow('end', unit) }, grid ? '+1 beat' : '+0.5 s'), h('button', { onclick: () => grow('end', bar) }, grid ? '+1 bar' : '+1 s')),
        h('button.icon-btn', { title: 'Close', 'aria-label': 'Close the source strip', onclick: () => { closeStrip(); api.refreshTimeline(); } }, icon('x', 13))),
      body,
      h('div.ae-strip-foot', { class: st.pending ? 'ask' : '' },
        h('span.muted.small', st.pending ? 'When it grows, choose once:' : 'When it grows'),
        h('div.seg', h('button', { class: mode === 'push' ? 'on' : '', onclick: () => choose('push') }, grid ? 'Push later clips · every cut stays on the beat' : 'Push later clips'),
          h('button', { class: mode === 'keep' ? 'on' : '', onclick: () => choose('keep') }, `Keep ${fmtTime(S.duration)} · trim the next clip`)),
        h('span.muted.small', `Hold ${ALT} to trim freely`)));
    stripEl.hidden = false;
  }

  /** "Add to timeline" (A1): the picked clips, whole, in pick order, as one commit; no Auto edit. */
  function addToTimeline(ids) {
    const chosen = ids.map((id) => clipList.find((c) => c.id === id)).filter(Boolean);
    api.commit((e) => {
      let t = 0;
      e.segments = chosen.map((c, i) => {
        const len = c.kind === 'photo' ? 3 : c.duration || 0;
        const s = { id: `s${i + 1}`, asset: c.id, sourceIn: 0, start: Math.round(t * 1e6) / 1e6, end: Math.round((t + len) * 1e6) / 1e6 };
        t += len;
        return s;
      });
      delete e.autoEdit;
      e.zooms = (e.zooms || []).filter((z) => !z.auto);
    }, { raw: true });
    toast(`${chosen.length} clip${chosen.length === 1 ? '' : 's'} on the timeline in your order · ⌘Z to undo`, 'ok');
  }

  // ---- A7: "From the recording", the keep map under the timeline for long footage --------------------------------
  const keepEl = h('div.ae-from', { hidden: true });
  function renderKeep() {
    const km = S.edit.autoEdit?.result?.keepMap;
    if (!km || !(km.total >= LONG_FOOTAGE) || !km.ranges?.length) { keepEl.hidden = true; return; }
    // Footage laid end to end in clip order, as the solver tiled it.
    const order = [];
    for (const r of km.ranges) if (!order.includes(r.asset)) order.push(r.asset);
    const offset = {};
    let at = 0;
    for (const id of order) { offset[id] = at; at += Math.max(...km.ranges.filter((r) => r.asset === id).map((r) => r.end)); }
    const total = Math.max(1e-6, at);
    const pct = (v) => `${(v / total) * 100}%`;
    const removed = Object.entries(km.removed || {}).filter(([k, v]) => v >= 1 && k !== 'unused').sort((a, b) => b[1] - a[1]);
    const chapters = (km.chapters || []).map((c) => { const a = sequenceTimeOf(c.start); return a ? { ...c, at: offset[a.asset] + a.local } : null; }).filter(Boolean);
    fill(keepEl,
      h('div.ae-from-head', h('b', 'From the recording'), h('span.muted.small.mono', `${fmtTime(km.total)} → ${fmtTime(S.duration)} · ${Math.round((km.kept / km.total) * 100)}% kept`),
        h('span.ae-from-legend', removed.slice(0, 3).map(([k, v]) => h('span', h('i', { class: `k-${k}` }), `${{ pauses: 'Pauses', retakes: 'Retakes', idle: 'Nothing happening', repeats: 'Said twice', lowScore: 'Weaker moments' }[k] || k} −${fmtTime(v)}`)))),
      h('div.ae-from-bar', km.ranges.filter((r) => r.kept).map((r) => h('span', { style: { left: pct(offset[r.asset] + r.start), width: pct(r.end - r.start) }, title: `Kept ${fmtTime(r.start)}–${fmtTime(r.end)} of clip ${api.clipNumber(r.asset)}` }))),
      chapters.length ? h('div.ae-from-chapters', chapters.map((c) => h('button.link', { style: { left: pct(c.at) }, title: `Go to ${c.title}`, onclick: () => api.seek(c.start) }, c.title))) : null);
    keepEl.hidden = false;
  }
  const sequenceTimeOf = (t) => {
    const segs = sequenceSegments(S.edit.segments);
    const s = segs.find((x) => t >= x.start && t < x.end) || segs[segs.length - 1];
    return s ? { asset: s.asset, local: s.sourceIn + (Math.max(s.start, Math.min(s.end, t)) - s.start) * segmentSpeed(s) } : null;
  };

  // ---- transport label (A6 / A7 / A8): "118 BPM · bar 5", "From 48:12 · no music" ---------------------------------
  let gridFor = null, gridCache = null;
  function transportLabel(t) {
    if (gridFor !== S.edit) { gridFor = S.edit; gridCache = outputBeats(S.edit); }
    if (gridCache) return `${Math.round(gridCache.bpm)} BPM · bar ${barBeatAt(gridCache, t).bar}`;
    const from = S.edit.autoEdit?.result?.from;
    return from ? `From ${fmtTime(from)} · no music` : 'No music';
  }

  // ---- AE-06 on the surface: reframing inputs from the cached motion analysis (faces aren't available on the web) ----
  /** { tracks, sourceAspects } for autoedit-tweaks.fillCrops: a focus track per analysed video clip. */
  function reframeInputs() {
    const tracks = {}, sourceAspects = {};
    for (const c of clipList) {
      if (c.width && c.height) sourceAspects[c.id] = c.width / c.height;
      const m = st.motion[c.id]?.motion;
      const tr = m ? motionTrack(m, c.duration) : null;
      if (tr) tracks[c.id] = tr;
    }
    return { tracks, sourceAspects };
  }
  /** Analyse every video clip's motion in the background (cached by hash), for reframing and the Motion lane. */
  async function prefetchMotion() {
    for (const c of clipList) {
      if (c.kind !== 'video' || st.motion[c.id] || !S.clipBlobs[c.id] || S.destroyed) continue;
      try { st.motion[c.id] = await analyzeClipMotion(S.clipBlobs[c.id], { hash: `${project.id}:${c.id}:${S.clipBlobs[c.id].size}`, duration: c.duration }); } catch { /* reframing falls back to the centre */ }
      api.refreshTimeline();
    }
  }

  return {
    button, pop, stripEl, keepEl, run, renderPanel, openCut, closeCut, openStrip, closeStrip, dropMoment, openFlow, reframeInputs, prefetchMotion, transportLabel,
    motionOf: (id) => st.motion[id]?.motion || null,
    refresh() { if (st.strip) renderStrip(); if (st.cutFor && !pop.hidden) closeCut(); renderKeep(); },
    get active() { return !!S.edit.autoEdit; },
  };
}
