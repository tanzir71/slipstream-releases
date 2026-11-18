// Settings dialog for the optional bring-your-own-key cloud providers (A-02 copilot, S-04 B-roll generation).
import { h, icon, modal, toast, fill } from './ui.js';
import { PROVIDERS, loadCloud, saveCloud, clearCloud, openRouterTextModels } from './cloud.js';

const FIELD_LABEL = {
  apiKey: 'API key', keyId: 'Key ID', keySecret: 'Key secret', model: 'Copilot model', baseURL: 'Base URL',
  imageModel: 'Image model (B-roll)', videoModel: 'Video model (B-roll)',
};

/** Opens the dialog; resolves true when saved or removed, false when cancelled. */
export function openCloudSettings() {
  return new Promise(async (resolve) => {
    const s = await loadCloud();
    const draft = JSON.parse(JSON.stringify(s || {}));
    let copilot = draft.copilot || '';
    let media = draft.media || '';
    let music = draft.music || '';
    const consent = h('input', { type: 'checkbox', checked: !!draft.consent });
    const providerHost = h('div.stack');
    const inputs = {};

    const input = (pid, field) => {
      const p = PROVIDERS[pid];
      const secret = field === 'apiKey' || field === 'keySecret';
      const value = draft[pid]?.[field] ?? (field in (p.defaults || {}) ? p.defaults[field] : '');
      const el = h('input', { type: secret ? 'password' : 'text', value, autocomplete: 'off', spellcheck: false, placeholder: field === 'apiKey' ? p.keyHint || '' : (p.defaults?.[field] || ''), 'aria-label': `${p.label} ${FIELD_LABEL[field]}` });
      (inputs[pid] ??= {})[field] = el;
      return el;
    };
    const render = () => {
      const used = [...new Set([copilot, media, music].filter(Boolean))];
      fill(providerHost, used.map((pid) => {
        const p = PROVIDERS[pid];
        const fields = p.fields.filter((f) => (f === 'model' ? copilot === pid : f === 'imageModel' || f === 'videoModel' ? media === pid : true));
        const rows = fields.map((f) => h('label.field', h('span', FIELD_LABEL[f]), input(pid, f)));
        if (pid === 'openrouter' && copilot === 'openrouter') {
          const list = h('datalist', { id: 'or-models' });
          inputs.openrouter.model.setAttribute('list', 'or-models');
          rows.push(list, h('button.link.small', { onclick: async (e) => { e.preventDefault(); e.target.textContent = 'Loading…'; try { const ms = await openRouterTextModels(); fill(list, ms.map((m) => h('option', { value: m }))); e.target.textContent = `${ms.length} models with structured output — start typing`; } catch (err) { e.target.textContent = `Couldn’t load the list (${err.message})`; } } }, 'Load OpenRouter models'));
        }
        return h('fieldset.cloud-provider', h('legend', p.label, p.desktopOnly ? h('span.tag', 'desktop app') : null), rows,
          p.desktopOnly ? h('p.muted.small', 'Higgsfield only accepts calls from apps, not web pages, so generation runs in the Slipstream desktop apps.') : null);
      }));
    };
    const select = (label, role, value, onChange) => h('label.field', h('span', label), h('select', { onchange: (e) => { onChange(e.target.value); render(); } },
      h('option', { value: '' }, 'Off (on this device only)'),
      Object.entries(PROVIDERS).filter(([, p]) => p.roles.includes(role)).map(([k, p]) => h('option', { value: k, selected: k === value }, `${p.label}${role === 'media' && p.video ? ' · images and video' : role === 'media' ? ' · images' : ''}`))));

    render();
    let finished = false;
    const finish = (v) => { finished = true; resolve(v); m.close(); };
    const save = h('button.btn.primary', { onclick: async () => {
      const next = { consent: consent.checked, copilot: copilot || null, media: media || null, music: music || null };
      for (const pid of new Set([copilot, media, music].filter(Boolean))) {
        next[pid] = {};
        for (const [f, el] of Object.entries(inputs[pid] || {})) next[pid][f] = el.value.trim();
      }
      if ((next.copilot || next.media || next.music) && !next.consent) { toast('Tick the box to confirm what gets sent', 'error'); return; }
      if (next.copilot === 'openrouter' && !next.openrouter.model) { toast('Choose an OpenRouter model for the copilot', 'error'); return; }
      if (next.copilot === 'openai' && !next.openai.model) { toast('Add the model name for your endpoint', 'error'); return; }
      await saveCloud(next);
      toast(next.copilot || next.media || next.music ? 'Cloud settings saved in this browser' : 'Cloud models are off', 'ok');
      finish(true);
    } }, 'Save');
    const remove = s && (s.copilot || s.media || s.music) ? h('button.btn.danger', { onclick: async () => { await clearCloud(); toast('Cloud keys removed from this browser', 'ok'); finish(true); } }, 'Remove all keys') : null;
    const m = modal('Cloud models (optional)', h('div.stack.cloud-settings',
      h('p.cloud-warning', icon('info', 14), 'Slipstream works fully on this device. Cloud models are optional, use your own keys and are billed by your provider.'),
      select('Copilot for open-ended requests', 'copilot', copilot, (v) => { copilot = v; }),
      select('B-roll generation', 'media', media, (v) => { media = v; }),
      select('Music generation', 'music', music, (v) => { music = v; }),
      providerHost,
      h('label.cloud-consent', consent, h('span', 'I understand that when I use these, Slipstream sends my request, the transcript text and a short edit summary (copilot), or the prompt I type (B-roll and music), to the provider I chose. Recorded video and audio are never sent. Keys are stored only on this device.')),
      h('div.row.end', remove, h('button.btn', { onclick: () => m.close() }, 'Cancel'), save)), { wide: true, onClose: () => { if (!finished) resolve(false); } });
  });
}
