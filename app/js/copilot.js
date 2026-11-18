// Copilot panel (tickets A-01, A-02 web column, A-07, W-08). Natural language → edit ops from the shared
// vocabulary (packages/editor-core/src/ops-schema.js), shown as a reviewable diff with accept/reject per op.
// Nothing is applied until you press Apply, and every apply is one normal undo step.
//
// Who answers, in order — all on this device:
//   1. the rule-based parser (intent.js): instant, deterministic, handles the common requests;
//   2. Chrome's built-in model (Prompt API) when the browser has it;
//   3. a small open model run in the browser (opt-in, download size shown first).
import { h, icon, fmtTime, fmtBytes, toast, fill } from './ui.js';
import { parseIntent } from '../../packages/editor-core/src/intent.js';
import { applyOps, validateOp, summarizeEdit, transcriptForPrompt } from '../../packages/editor-core/src/ops.js';
import { OPS, OP_LIST_SCHEMA } from '../../packages/editor-core/src/ops-schema.js';
import { clarityCuts } from '../../packages/editor-core/src/clarity.js';
import { computeCuts, keptRanges, totalDuration } from '../../packages/editor-core/src/edl.js';
import { getSetting, setSetting } from './store.js';
import { copilotProvider, cloudOps } from './cloud.js';
import { openCloudSettings } from './cloud-settings.js';

const SUGGESTIONS = [
  'Remove fillers and tighten the pauses',
  'Make a 30-second reel about pricing',
  'Cut everything about the old UI',
  'Make it vertical with bold captions',
  'Remove repeated takes',
];

let llmModule = null;
async function llm() {
  if (llmModule !== null) return llmModule;
  try { llmModule = await import('./llm.js'); } catch { llmModule = false; }
  return llmModule;
}

/** Compact op list for prompts: name, description and argument names. */
function opsForPrompt() {
  return Object.entries(OPS).filter(([n]) => n !== 'render').map(([name, d]) => {
    const props = Object.entries(d.inputSchema.properties || {}).map(([k, s]) => `${k}${(d.inputSchema.required || []).includes(k) ? '' : '?'}:${s.enum ? s.enum.join('|') : s.type || 'any'}`).join(', ');
    return `${name}(${props}) — ${d.description}`;
  }).join('\n');
}

/**
 * api = { state, getEdit(), duration, words(), commit(fn, label), preview(ids|null), seek(t), openExport(), exportNLE(format) }
 * Returns the panel element. Chat history lives in api.state so it survives tab switches.
 */
export function copilotPanel(api) {
  const st = api.state;
  st.messages ??= [];
  st.tier ??= null;
  const log = h('div.cp-log', { 'aria-live': 'polite' });
  const input = h('textarea.cp-input', { rows: 2, placeholder: 'Tell Slipstream what to change…', 'aria-label': 'Ask the copilot' });
  const send = h('button.btn.primary.small', { onclick: () => ask(input.value) }, icon('sparkles', 13), 'Ask');
  const tierEl = h('div.cp-tier');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); } e.stopPropagation(); });

  function renderLog() {
    fill(log, st.messages.length ? st.messages.map(renderMsg) : h('div.cp-empty',
      h('p.muted.small', 'Ask for an edit in plain words. Proposals appear here for you to review — nothing changes until you apply it.'),
      h('div.cp-sugs', SUGGESTIONS.map((s) => h('button.chip', { onclick: () => ask(s) }, s)))));
    log.scrollTop = log.scrollHeight;
  }

  function renderMsg(m) {
    if (m.role === 'user') return h('div.cp-msg.user', m.text);
    if (m.pending) return h('div.cp-msg.bot', h('span.mini-spin'), m.text || 'Thinking…');
    const body = [h('p', m.text)];
    if (m.proposal?.length) {
      const allOn = m.proposal.every((x) => x.on);
      body.push(h('ul.cp-ops', m.proposal.map((x, i) => h('li', { class: x.on ? 'on' : '' },
        h('label', h('input', { type: 'checkbox', checked: x.on, disabled: m.applied, onchange: (e) => { x.on = e.target.checked; preview(m); renderLog(); } }),
          h('span.cp-op', x.diff?.summary || x.op.op),
          x.excerpt ? h('span.cp-ex', x.excerpt) : null,
          x.seconds ? h('span.tag', `${x.seconds > 0 ? '+' : '−'}${Math.abs(x.seconds).toFixed(1)} s`) : null)))));
      if (!m.applied && !m.dismissed) {
        body.push(h('div.row', h('button.btn.small.primary', { disabled: !m.proposal.some((x) => x.on), onclick: () => apply(m) }, icon('check', 13), m.proposal.length > 1 ? `Apply ${m.proposal.filter((x) => x.on).length}` : 'Apply'),
          m.proposal.length > 1 ? h('button.btn.small', { onclick: () => { m.proposal.forEach((x) => { x.on = !allOn; }); preview(m); renderLog(); } }, allOn ? 'Select none' : 'Select all') : null,
          h('button.btn.small.ghost', { onclick: () => { m.dismissed = true; api.preview(null); renderLog(); } }, 'Dismiss')));
      } else body.push(h('p.muted.small', m.applied ? 'Applied · ⌘Z to undo' : 'Dismissed'));
    }
    if (m.clips?.length) body.push(h('ul.cp-clips', m.clips.map((c) => h('li', h('button.link', { onclick: () => api.seek(c.start) }, `${fmtTime(c.start)}–${fmtTime(c.end)}`), ` “${c.title}”`))));
    if (m.effects?.length) body.push(h('div.row', m.effects.map((e) => e.op === 'render'
      ? h('button.btn.small', { onclick: () => api.openExport() }, icon('download', 13), 'Open export')
      : h('button.btn.small', { onclick: () => api.exportNLE(e.args.format) }, icon('download', 13), `Download ${e.args.format.toUpperCase()}`))));
    if (m.source?.startsWith('cloud:')) body.push(h('p.cp-src.cloud', icon('info', 11), `Cloud · written by ${m.source.slice(6)} with your key. Only text was sent.`));
    else if (m.source) body.push(h('p.cp-src', icon(m.source === 'rules' ? 'cpu' : 'lock', 11), m.source === 'rules' ? 'Understood on this device' : `Written by ${m.source} on this device`));
    return h('div.cp-msg.bot', body);
  }

  /** Dry-run each op on the current edit so every row shows its own diff and the words it touches. */
  function proposalFrom(ops) {
    const edit = api.getEdit();
    const words = edit.words || [];
    const idx = new Map(words.map((w, i) => [String(w.id), i]));
    return ops.map((op) => {
      const r = applyOps(edit, [op], { duration: api.duration });
      const diff = r.diffs[0] || null;
      const ids = diff?.words?.deleted || [];
      const excerpt = ids.length ? `“${ids.slice(0, 14).map((id) => words[idx.get(String(id))]?.text).filter(Boolean).join(' ')}${ids.length > 14 ? '…' : ''}”` : '';
      return { op, diff, ids, excerpt, seconds: diff?.seconds || 0, on: !r.errors.length, error: r.errors[0]?.message };
    }).filter((x) => x.diff && !x.error);
  }

  function preview(m) {
    api.preview(m && !m.applied && !m.dismissed ? m.proposal.filter((x) => x.on).flatMap((x) => x.ids) : null);
  }

  function apply(m) {
    const chosen = m.proposal.filter((x) => x.on).map((x) => x.op);
    const edits = chosen.filter((o) => !['render', 'export_nle', 'find_clips'].includes(o.op));
    const res = applyOps(api.getEdit(), edits, { duration: api.duration });
    if (res.errors.length) toast(res.errors[0].message, 'error');
    if (res.diffs.length) api.commit(() => res.edit, `${res.diffs.length} copilot edit${res.diffs.length > 1 ? 's' : ''}`);
    m.applied = true;
    m.effects = chosen.filter((o) => o.op === 'render' || o.op === 'export_nle').map((o) => ({ op: o.op, args: o.args || {} }));
    api.preview(null);
    renderLog();
  }

  async function ask(text) {
    text = String(text || '').trim();
    if (!text) return;
    input.value = '';
    st.messages.forEach((m) => { if (m.proposal && !m.applied) m.dismissed = true; });
    st.messages.push({ role: 'user', text });
    const reply = { role: 'bot', pending: true, text: 'Reading your transcript…' };
    st.messages.push(reply);
    renderLog();
    try {
      const edit = api.getEdit();
      const parsed = parseIntent(text, { edit, duration: api.duration });
      let ops = parsed.understood ? parsed.ops : [];
      let source = 'rules', note = parsed.reply;
      const cloud = !ops.length ? await copilotProvider().catch(() => null) : null;
      if (cloud) {
        // Bring-your-own-key cloud model (A-02): only text leaves the device, labelled "Cloud" in the reply.
        reply.text = `Asking ${cloud.label} (cloud, your key)…`;
        renderLog();
        const r = await askCloud(text, edit, cloud);
        ops = r.ops; note = r.reply; source = `cloud:${cloud.label}`;
      } else if (!ops.length) {
        const tier = await currentTier();
        if (tier && tier.tier !== 'none' && (tier.tier === 'builtin' || st.browserModelEnabled)) {
          reply.text = tier.tier === 'builtin' ? 'Asking the browser’s built-in model…' : 'Thinking with the on-device model…';
          renderLog();
          const r = await askModel(text, edit, tier);
          ops = r.ops; note = r.reply; source = tier.label;
        } else if (tier && tier.tier === 'browser' && !st.browserModelEnabled) {
          note = `${parsed.reply} For open-ended requests you can turn on the on-device model below (${tier.sizeMB ? `${Math.round(tier.sizeMB)} MB, ` : ''}downloads once).`;
        }
      }
      const valid = ops.filter((o) => validateOp(o).valid);
      const clipsOp = valid.find((o) => o.op === 'find_clips');
      Object.assign(reply, { pending: false, text: note || (valid.length ? 'Here’s what I’d change:' : 'I didn’t find anything to change.'), source: valid.length ? source : null });
      if (clipsOp) reply.clips = applyOps(edit, [clipsOp], { duration: api.duration }).diffs[0]?.candidates || [];
      const edits = valid.filter((o) => o.op !== 'find_clips');
      reply.proposal = proposalFrom(edits);
      // Small models sometimes name words or zooms that don't exist; those ops can't apply, so drop them.
      const skipped = ops.length - valid.length + (edits.length - reply.proposal.length);
      if (skipped) reply.text += ` (${skipped} suggestion${skipped > 1 ? 's' : ''} didn’t fit this project and ${skipped > 1 ? 'were' : 'was'} skipped.)`;
      if (!reply.proposal.length && !reply.clips?.length && source !== 'rules') reply.text = 'I couldn’t turn that into an edit I can apply. Try naming what to cut, zoom or restyle.';
      preview(reply);
    } catch (err) {
      Object.assign(reply, { pending: false, text: err.name === 'AbortError' ? 'Stopped.' : `Something went wrong: ${err.message}` });
    }
    renderLog();
  }

  async function currentTier() {
    const m = await llm();
    if (!m?.detectLLM) return null;
    st.tier ??= await m.detectLLM().catch(() => null);
    return st.tier;
  }

  async function askModel(text, edit, tier) {
    const m = await llm();
    st.session ??= await m.createLLM({ tier: tier.tier, model: tier.model, onDownload: (loaded, total) => { const last = st.messages[st.messages.length - 1]; last.text = `Downloading the on-device model once · ${fmtBytes(loaded)} of ${fmtBytes(total)}`; renderLog(); } });
    const messages = m.buildCopilotMessages({
      instruction: text,
      transcript: transcriptForPrompt(edit.words || [], { maxChars: tier.tier === 'builtin' ? 9000 : 5000 }),
      summary: summarizeEdit(edit, { duration: api.duration }).text,
      opsSchema: opsForPrompt(),
      ...(tier.maxChars ? { maxChars: tier.maxChars } : {}),
    });
    const out = await st.session.generateJSON(messages, OP_LIST_SCHEMA, {});
    const ops = Array.isArray(out?.ops) ? out.ops.map((o) => ({ op: o.op, args: o.args || {} })) : [];
    return { ops, reply: typeof out?.reply === 'string' ? out.reply : ops.length ? 'Here’s what I’d change:' : 'I couldn’t turn that into an edit. Try naming what to cut, zoom or restyle.' };
  }

  async function askCloud(text, edit, settings) {
    const opNames = Object.keys(OPS).filter((n) => n !== 'render');
    const system = [
      'You edit screen recordings in Slipstream by returning edit operations. Reply with JSON only, matching the schema.',
      'Use only these ops. Address transcript words by the ids shown in brackets ([first..last] gives the first and last word id of a line). Times are seconds on the source timeline. Put each op\'s arguments in args_json as a JSON object string.',
      'If the request cannot be expressed with these ops, return no ops and say why in reply. Never invent word ids.',
      '',
      opsForPrompt(),
    ].join('\n');
    const user = [
      `Request: ${text}`,
      '',
      `Current edit:\n${summarizeEdit(edit, { duration: api.duration }).text}`,
      '',
      `Transcript:\n${transcriptForPrompt(edit.words || [], { maxChars: 60000 })}`,
    ].join('\n');
    return cloudOps(settings, { system, user, opNames });
  }

  // Edit for clarity (A-07): target length → ranked sentence cuts, reviewed like any other proposal.
  function clarityBox() {
    const edit = api.getEdit();
    if (!edit.words?.length) return null;
    const cur = totalDuration(keptRanges(computeCuts(edit, api.duration), api.duration));
    let target = Math.max(5, Math.round(cur * 0.8));
    const out = h('output', fmtTime(target));
    const range = h('input', { type: 'range', min: Math.max(5, Math.round(cur * 0.4)), max: Math.max(6, Math.round(cur)), step: 1, value: target, 'aria-label': 'Target length', oninput: (e) => { target = Number(e.target.value); out.textContent = fmtTime(target); } });
    // With a language model available (your cloud key, the browser's built-in model, or the on-device model you
    // turned on), it picks the sentences; otherwise, or if it suggests nothing usable, the offline rules do.
    const go = h('button.btn.small', { onclick: async () => {
      go.disabled = true;
      const e2 = api.getEdit();
      const kept = keptRanges(computeCuts(e2, api.duration), api.duration);
      const now = totalDuration(kept);
      st.messages.push({ role: 'user', text: `Tighten to about ${fmtTime(target)}` });
      const reply = { role: 'bot', pending: true, text: 'Reading your transcript…' };
      st.messages.push(reply);
      renderLog();
      try {
        const cloud = await copilotProvider().catch(() => null);
        const tier = cloud ? null : await currentTier();
        const local = tier && tier.tier !== 'none' && (tier.tier === 'builtin' || st.browserModelEnabled);
        let ops = [], source = 'rules', note = '';
        if (cloud || local) {
          const instruction = `Edit for clarity: cut complete sentences that repeat an earlier point, wander off topic, restart, or add little, so the video runs about ${fmtTime(target)} (it is ${fmtTime(now)} now, so remove about ${Math.max(1, Math.round(now - target))} seconds). Use only cut_words, each covering whole sentences. Keep the main points, the steps and any numbers.`;
          reply.text = cloud ? `Asking ${cloud.label} (cloud, your key)…` : tier.tier === 'builtin' ? 'Asking the browser’s built-in model…' : 'Thinking with the on-device model…';
          renderLog();
          const r = await (cloud ? askCloud(instruction, e2, cloud) : askModel(instruction, e2, tier)).catch((err) => ({ ops: [], reply: '', error: err }));
          ops = (r.ops || []).filter((o) => o.op === 'cut_words' && validateOp(o).valid);
          if (ops.length) { source = cloud ? `cloud:${cloud.label}` : tier.label; note = r.reply || ''; }
        }
        let proposal;
        if (ops.length) {
          proposal = proposalFrom(ops);
          const left = totalDuration(keptRanges(computeCuts(applyOps(e2, proposal.map((p) => p.op), { duration: api.duration }).edit, api.duration), api.duration));
          note = `${proposal.length} cut${proposal.length > 1 ? 's that bring' : ' that brings'} it to about ${fmtTime(left)}. Untick any you want to keep.${note ? ` ${note}` : ''}`;
        } else {
          const props = clarityCuts(e2.words, { duration: api.duration, targetDuration: target, kept });
          const reasons = { restart: 'restart', repeat: 'repeats an earlier point', tangent: 'tangent', 'filler-heavy': 'mostly filler', 'low-information': 'adds little' };
          proposal = proposalFrom(props.map((p) => ({ op: 'cut_words', args: { from_word_id: p.from_word_id, to_word_id: p.to_word_id } })))
            .map((x, i) => ({ ...x, diff: x.diff && { ...x.diff, summary: `${x.diff.summary} — ${reasons[props[i]?.reason] || props[i]?.reason}` } }));
          note = (cloud || local ? 'The model didn’t suggest cuts I could use, so these come from the offline rules. ' : '')
            + (props.length ? `${props.length} sentence${props.length > 1 ? 's' : ''} I’d cut to get there. Untick any you want to keep.` : 'Nothing obvious to cut — it’s already tight.');
        }
        Object.assign(reply, { pending: false, text: note, proposal, source });
        preview(reply);
      } catch (err) {
        Object.assign(reply, { pending: false, text: `Something went wrong: ${err.message}` });
      } finally {
        go.disabled = false;
        renderLog();
      }
    } }, icon('scissors', 13), 'Suggest cuts');
    return h('section.cp-clarity', h('div.slider-head', h('span', `Tighten for clarity · now ${fmtTime(cur)}`), out), range, h('div.row.between', h('span.muted.small', 'Never applied without your review.'), go));
  }

  async function renderTier() {
    const cloud = await copilotProvider().catch(() => null);
    const cloudLink = h('button.link.small', { onclick: async () => { await openCloudSettings(); renderTier(); } }, cloud ? 'Cloud settings' : 'Use your own cloud key…');
    if (cloud) { fill(tierEl, h('span.cp-badge.cloud', icon('info', 11), `Cloud · ${cloud.label}`), h('span.muted.small', 'Common edits stay on this device; open-ended requests send text to your provider.'), cloudLink); return; }
    const t = await currentTier();
    if (!t || t.tier === 'none') { fill(tierEl, h('span.cp-badge', icon('cpu', 11), 'Rules on this device'), h('span.muted.small', 'Common edits work offline; open-ended requests need Chrome’s built-in AI, the optional model or your own cloud key.'), cloudLink); return; }
    if (t.tier === 'builtin') { fill(tierEl, h('span.cp-badge.ok', icon('lock', 11), 'On-device'), h('span.muted.small', `${t.label}. Your transcript stays in this browser.`), cloudLink); return; }
    const enabled = !!st.browserModelEnabled;
    fill(tierEl, h('span.cp-badge', icon('lock', 11), enabled ? 'On-device model on' : 'Rules on this device'),
      enabled ? h('span.muted.small', `${t.label} runs in this tab.`) : h('button.link.small', { onclick: async () => { st.browserModelEnabled = true; await setSetting('copilotModel', true).catch(() => {}); renderTier(); } }, `Use ${t.label} for open-ended requests (${Math.round(t.sizeMB || 0)} MB download)`), cloudLink);
  }

  getSetting('copilotModel').then((v) => { if (v) { st.browserModelEnabled = true; renderTier(); } }).catch(() => {});
  renderLog();
  renderTier();
  return h('div.copilot',
    h('div.panel-intro', h('h3', icon('chat', 16), 'Copilot'), h('p.muted', 'Describe an edit; review it as a diff; apply what you like. Runs on this device.')),
    tierEl, log, h('div.cp-compose', input, send), clarityBox());
}
