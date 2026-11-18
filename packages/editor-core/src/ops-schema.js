// Shared edit-op vocabulary (docs/handover/ai-agents.md, "Shared op vocabulary").
// One definition serves the web copilot, the MCP server (as tool inputSchemas) and LLM prompts, so
// descriptions are written for a model: short, concrete, with units. Pure data, no imports.
// schema/ops.v1.schema.json is generated from this file: `node scripts/gen-ops-schema.mjs`.

const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const sec = (what) => num(`${what}, in seconds on the source (original recording) timeline.`, { minimum: 0 });
const wordRange = (verb) => obj({
  from_word_id: str(`Id of the first word to ${verb}, as shown in the transcript (e.g. "w_12").`, { minLength: 1 }),
  to_word_id: str(`Id of the last word to ${verb}, inclusive. Same as from_word_id for a single word.`, { minLength: 1 }),
}, ['from_word_id', 'to_word_id']);

const zoomFields = {
  start: sec('Zoom start'),
  end: sec('Zoom end; after start'),
  scale: num('Magnification: 1.3 subtle, 1.8 default, 2.5 tight.', { minimum: 1, maximum: 4 }),
  x: num('Focus point across the frame: 0 left, 0.5 centre, 1 right.', { minimum: 0, maximum: 1 }),
  y: num('Focus point down the frame: 0 top, 0.5 centre, 1 bottom.', { minimum: 0, maximum: 1 }),
};

export const ASPECT_VALUES = ['16:9', '9:16', '1:1', '4:5'];
export const LAYOUT_MODES = ['pip', 'split', 'screen', 'camera'];
export const CORNERS = ['tl', 'tr', 'bl', 'br'];
export const SHAPES = ['circle', 'rounded', 'square', 'wide'];
export const CAPTION_PRESET_IDS = ['studio', 'cinema', 'editorial', 'bold'];
export const CAPTION_POSITIONS = ['top', 'middle', 'bottom'];
export const NLE_FORMATS = ['fcpxml', 'edl', 'xmeml'];
export const RENDER_FORMATS = ['mp4', 'webm'];

export const OPS = {
  cut_words: {
    description: 'Cut a run of transcript words (inclusive). Use word ids from the transcript. Cut words stay visible as struck-through text and can be restored.',
    inputSchema: wordRange('cut'),
  },
  restore_words: {
    description: 'Bring back previously cut transcript words (inclusive range of word ids).',
    inputSchema: wordRange('restore'),
  },
  cut_range: {
    description: 'Cut a span of the timeline by time. Prefer cut_words for speech; use this for silence, setup or screen-only stretches.',
    inputSchema: obj({ start: sec('Start of the cut'), end: sec('End of the cut; after start') }, ['start', 'end']),
  },
  restore_range: {
    description: 'Undo every cut (words, pauses, manual cuts, clip range) that removes any part of this span.',
    inputSchema: obj({ start: sec('Start of the span to restore'), end: sec('End of the span; after start') }, ['start', 'end']),
  },
  remove_fillers: {
    description: 'Cut filler words. Always cuts hard fillers (um, uh, er, ah, hmm). With include_soft, also cuts soft fillers (like, you know, I mean, basically, actually, so, right, okay), which can carry meaning.',
    inputSchema: obj({ include_soft: bool('Also cut soft fillers. Default false.', { default: false }) }),
  },
  shorten_pauses: {
    description: 'Shorten every pause between words longer than min_gap seconds so that keep seconds remain. Replaces earlier pause cuts, so it can be re-run with new values.',
    inputSchema: obj({
      min_gap: num('Only pauses at least this long are shortened. Default 0.75.', { minimum: 0.1, maximum: 10, default: 0.75 }),
      keep: num('Seconds of pause to leave. Default 0.25.', { minimum: 0, maximum: 5, default: 0.25 }),
    }),
  },
  remove_retakes: {
    description: 'Find sentences the speaker restarted or repeated within 20 seconds and cut the earlier take. Each retake can be restored.',
    inputSchema: obj({}),
  },
  add_zoom: {
    description: 'Add a smooth zoom on part of the screen recording. Defaults: scale 1.8, centred.',
    inputSchema: obj({
      id: str('Optional id for the new zoom; generated when omitted.', { minLength: 1 }),
      ...zoomFields,
      scale: { ...zoomFields.scale, default: 1.8 },
      x: { ...zoomFields.x, default: 0.5 },
      y: { ...zoomFields.y, default: 0.5 },
    }, ['start', 'end']),
  },
  update_zoom: {
    description: 'Change an existing zoom. Only the given fields change.',
    inputSchema: obj({ id: str('Id of the zoom to change.', { minLength: 1 }), ...zoomFields }, ['id']),
  },
  remove_zoom: {
    description: 'Remove one zoom by id, or every zoom overlapping start–end (use 0 to the video length to remove all).',
    inputSchema: obj({ id: str('Id of the zoom to remove.', { minLength: 1 }), start: sec('Start of the span'), end: sec('End of the span') }),
  },
  set_layout: {
    description: 'Arrange camera and screen. pip = camera bubble in a corner, split = side by side (stacked in vertical formats), screen = screen only, camera = camera only.',
    inputSchema: obj({
      mode: { enum: LAYOUT_MODES, description: 'Layout mode.' },
      corner: { enum: CORNERS, description: 'Bubble corner for pip: tl top-left, tr top-right, bl bottom-left, br bottom-right.' },
      size: num('Bubble size as a fraction of the frame (pip). Default 0.22.', { minimum: 0.08, maximum: 0.5 }),
      shape: { enum: SHAPES, description: 'Bubble shape (pip).' },
      split: num('Share of the frame given to the camera (split). Default 0.4.', { minimum: 0.25, maximum: 0.7 }),
    }, ['mode']),
  },
  set_aspect: {
    description: 'Set the output frame: 16:9 landscape (YouTube), 9:16 vertical (TikTok, Reels, Shorts), 1:1 square, 4:5 portrait feed post.',
    inputSchema: obj({ aspect: { enum: ASPECT_VALUES, description: 'Output aspect ratio.' } }, ['aspect']),
  },
  set_captions: {
    description: 'Turn burned-in captions on or off and style them. Only the given fields change.',
    inputSchema: obj({
      enabled: bool('Show captions.'),
      preset: { enum: CAPTION_PRESET_IDS, description: 'Look: studio = clean boxed sans (default), cinema = subtle film subtitles, editorial = italic serif, bold = big caps, 2–3 words at a time (short-form).' },
      position: { enum: CAPTION_POSITIONS, description: 'Vertical placement.' },
      size: num('Size relative to the look\'s default (1).', { minimum: 0.7, maximum: 1.5 }),
      color: str('Highlight colour for the active word, as #rrggbb.', { pattern: '^#[0-9a-fA-F]{6}$' }),
    }),
  },
  set_clip_range: {
    description: 'Export only one part of the recording (start–end in source seconds), e.g. for a short clip. Omit start and end (or pass null) to export the whole recording again.',
    inputSchema: obj({
      start: { type: ['number', 'null'], minimum: 0, description: 'Clip start, source seconds; null to clear.' },
      end: { type: ['number', 'null'], minimum: 0, description: 'Clip end, source seconds; null to clear.' },
    }),
  },
  find_clips: {
    description: 'Suggest short-form clips scored for hook, pace and a clean ending. Read-only: returns candidates { start, end, score, title, reasons }; apply one with set_clip_range.',
    inputSchema: obj({
      min_dur: num('Shortest clip, seconds. Default 12.', { minimum: 1, maximum: 600, default: 12 }),
      max_dur: num('Longest clip, seconds. Default 60.', { minimum: 1, maximum: 900, default: 60 }),
      count: int('How many candidates. Default 5.', { minimum: 1, maximum: 20, default: 5 }),
    }),
  },
  render: {
    description: 'Render the edited video to a file on this device. Does not change the edit. Defaults follow the project (aspect at 1080p, 30 fps, MP4, captions if on).',
    inputSchema: obj({
      width: int('Output width in pixels (even).', { minimum: 16, maximum: 7680 }),
      height: int('Output height in pixels (even).', { minimum: 16, maximum: 7680 }),
      fps: num('Frames per second.', { minimum: 1, maximum: 120 }),
      format: { enum: RENDER_FORMATS, description: 'mp4 (H.264 + AAC) or webm (VP9 + Opus).' },
      captions: bool('Burn in captions.'),
    }),
  },
  export_nle: {
    description: 'Export the edit as a timeline for a pro editor, linked to the original media: fcpxml = Final Cut Pro / DaVinci Resolve, edl = CMX3600 (any NLE), xmeml = Premiere Pro / Resolve XML.',
    inputSchema: obj({ format: { enum: NLE_FORMATS, description: 'Timeline format.' } }, ['format']),
  },
};

export const OP_NAMES = Object.keys(OPS);
/** Ops that never change the edit. find_clips returns candidates; the rest are effects for the host. */
export const READ_ONLY_OPS = ['find_clips', 'render', 'export_nle'];
/** Ops the host must carry out (they produce files); applyOps returns them in `effects`. */
export const EFFECT_OPS = ['render', 'export_nle'];

/** JSON Schema for a model's reply: { ops: [{ op, args }], reply? }. */
export const OP_LIST_SCHEMA = {
  title: 'Slipstream edit ops',
  description: 'A list of edit operations applied in order to a Slipstream project. Times are seconds on the source timeline; words are addressed by transcript word id.',
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      description: 'Operations, applied in order. Each one can be previewed, accepted or rejected.',
      items: {
        oneOf: OP_NAMES.map((name) => ({
          type: 'object',
          description: OPS[name].description,
          properties: {
            op: { const: name },
            args: name === 'set_clip_range' ? { anyOf: [OPS[name].inputSchema, { type: 'null' }] } : OPS[name].inputSchema,
          },
          // args may be omitted when the op has no required arguments.
          required: OPS[name].inputSchema.required ? ['op', 'args'] : ['op'],
          additionalProperties: false,
        })),
      },
    },
    reply: { type: 'string', description: 'One short sentence for the user describing the plan.' },
  },
  required: ['ops'],
  additionalProperties: false,
};
