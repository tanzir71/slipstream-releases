// Pro handoff: export the edit as an NLE timeline that links to the ORIGINAL media.
// - toFCPXML: Final Cut Pro 10.6+ / DaVinci Resolve (FCPXML 1.10, rational times)
// - toEDL:    CMX3600 (any NLE; one video track, so the camera is not included)
// - toXMEML:  Premiere Pro / Resolve "Final Cut Pro 7 XML" (xmeml v4)
// The kept ranges (computeCuts + keptRanges) become clips laid end to end. A camera recording, when
// present and the layout shows it, goes on a second video track in sync (media.cameraOffset).
// Chapters and zoom starts become markers. Zooms, layout and captions themselves are not carried over.
// Pure: returns strings; the host writes the file next to the media.

import { computeCuts, keptRanges } from './edl.js';

// ---- frame rates and timecode ---------------------------------------------------------------------

/**
 * Rate info for fps. NTSC rates (23.976, 29.97, 59.94) use timebase 24/30/60 with 1001/n frame
 * durations; 29.97 and 59.94 default to drop-frame timecode.
 * Returns { fps, timebase, ntsc, num, den, dropFrame } where one frame lasts num/den seconds.
 */
export function frameRate(fps = 30, { dropFrame } = {}) {
  const f = Number(fps) > 0 ? Number(fps) : 30;
  const base = Math.max(1, Math.round(f));
  const ntsc = Math.abs(f - base) > 0.001 && Math.abs(f - (base * 1000) / 1001) < 0.01;
  const df = ntsc && (base === 30 || base === 60) && dropFrame !== false;
  return ntsc
    ? { fps: (base * 1000) / 1001, timebase: base, ntsc: true, num: 1001, den: base * 1000, dropFrame: df }
    : { fps: base, timebase: base, ntsc: false, num: 100, den: base * 100, dropFrame: false };
}

const dropCount = (r) => Math.round(r.timebase / 15); // 2 for 29.97, 4 for 59.94

/** Frame count → 'HH:MM:SS:FF' (non-drop) or 'HH:MM:SS;FF' (drop-frame). */
export function framesToTimecode(frames, r) {
  let n = Math.max(0, Math.round(frames));
  const tb = r.timebase;
  if (r.dropFrame) {
    const d = dropCount(r);
    const per10 = tb * 600 - d * 9;
    const perMin = tb * 60 - d;
    const tens = Math.floor(n / per10), rem = n % per10;
    n += d * 9 * tens + (rem > d ? d * Math.floor((rem - d) / perMin) : 0);
  }
  const ff = n % tb, ss = Math.floor(n / tb) % 60, mm = Math.floor(n / (tb * 60)) % 60, hh = Math.floor(n / (tb * 3600)) % 24;
  const p = (x) => String(x).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}${r.dropFrame ? ';' : ':'}${p(ff)}`;
}

/** 'HH:MM:SS:FF' or 'HH:MM:SS;FF' → frame count. */
export function timecodeToFrames(tc, r) {
  const m = /^(\d+):(\d{2}):(\d{2})[:;.](\d{2})$/.exec(String(tc).trim());
  if (!m) throw new Error(`Bad timecode ${tc}`);
  const [hh, mm, ss, ff] = m.slice(1).map(Number);
  let n = (hh * 3600 + mm * 60 + ss) * r.timebase + ff;
  if (r.dropFrame) {
    const mins = hh * 60 + mm;
    n -= dropCount(r) * (mins - Math.floor(mins / 10));
  }
  return n;
}

/** Frames as an FCPXML rational time, e.g. 1001/30000s per frame at 29.97. */
function rational(frames, r) {
  return frames ? `${frames * r.num}/${r.den}s` : '0s';
}

// ---- shared timeline ------------------------------------------------------------------------------

/**
 * Kept ranges quantised to frames. Record positions come from rounding the cumulative output time,
 * so the total is within half a frame of the edit's output duration.
 * Returns { r, clips: [{ srcIn, srcOut, recIn, recOut, start, end }], totalFrames, mediaFrames, markers }.
 */
export function nleTimeline(edit, media, opts = {}) {
  const r = frameRate(media.fps ?? 30, opts);
  const duration = media.duration;
  if (!(duration > 0)) throw new Error('media.duration is required');
  const mediaFrames = Math.round(duration * r.fps);
  const kept = keptRanges(computeCuts(edit, duration), duration);
  const clips = [];
  let acc = 0;
  for (const k of kept) {
    const recIn = Math.round(acc * r.fps);
    acc += k.end - k.start;
    const srcIn = Math.min(mediaFrames, Math.round(k.start * r.fps));
    const len = Math.min(Math.round(acc * r.fps) - recIn, mediaFrames - srcIn);
    if (len <= 0) continue;
    clips.push({ srcIn, srcOut: srcIn + len, recIn, recOut: recIn + len, start: k.start, end: k.end });
  }
  const totalFrames = clips.length ? clips[clips.length - 1].recOut : 0;

  // Markers: chapters and zoom starts, snapped forward out of cuts.
  const raw = [
    ...(edit.chapters || []).map((c) => ({ t: c.start, name: c.title || 'Chapter', kind: 'chapter' })),
    ...(edit.zooms || []).map((z) => ({ t: z.start, name: `Zoom ${Number(z.scale || 1).toFixed(1)}x`, kind: 'zoom' })),
  ].sort((a, b) => a.t - b.t);
  const markers = [];
  for (const m of raw) {
    const f = Math.round(m.t * r.fps);
    const ci = clips.findIndex((c) => f < c.srcOut);
    if (ci < 0) continue;
    const c = clips[ci];
    const src = Math.max(f, c.srcIn);
    markers.push({ ...m, clip: ci, src, rec: c.recIn + (src - c.srcIn) });
  }
  return { r, clips, totalFrames, mediaFrames, markers };
}

/** Second video track: the camera clip for each kept range, in sync with the screen. */
function cameraClips(tl, media) {
  const off = Math.round((media.cameraOffset || 0) * tl.r.fps);
  const camFrames = media.cameraDuration > 0 ? Math.round(media.cameraDuration * tl.r.fps) : tl.mediaFrames - off;
  const out = [];
  tl.clips.forEach((c, i) => {
    const from = Math.max(c.srcIn, off);
    const to = Math.min(c.srcOut, off + camFrames);
    if (to <= from) return;
    out.push({ clip: i, srcIn: from - off, srcOut: to - off, recIn: c.recIn + (from - c.srcIn), recOut: c.recIn + (to - c.srcIn), parentSrc: from });
  });
  return out;
}

const showCamera = (edit, media) => !!media.cameraName && (edit.layout?.mode || 'pip') !== 'screen';

// ---- XML helpers ----------------------------------------------------------------------------------

export function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
    // Control characters are not allowed in XML 1.0.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop() || 'media';

/**
 * file://localhost/ URL for a media path or bare file name (relative names resolve against
 * opts.mediaDir when given; otherwise the NLE relinks by name).
 */
export function pathUrl(p, mediaDir = '') {
  let s = String(p || '').replace(/\\/g, '/');
  if (/^file:\/\//i.test(s)) return s;
  const isAbs = s.startsWith('/') || /^[A-Za-z]:\//.test(s);
  if (!isAbs && mediaDir) s = `${String(mediaDir).replace(/\\/g, '/').replace(/\/+$/, '')}/${s}`;
  const parts = s.replace(/^\/+/, '').split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  return `file://localhost/${parts.join('/')}`;
}

/** CMX3600 reel name: up to 8 upper-case letters, digits or underscores from the file name. */
export function reelName(fileName) {
  const stem = String(fileName || '').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
  const r = stem.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 8);
  return r || 'AX';
}

// ---- FCPXML ---------------------------------------------------------------------------------------

/**
 * FCPXML 1.10. media = { duration, width, height, fps = 30, screenName, screenPath?, cameraName?,
 * cameraPath?, cameraOffset?, cameraDuration?, hasAudio (default true) }. opts = { name, mediaDir, dropFrame }.
 */
export function toFCPXML(edit, media, opts = {}) {
  const tl = nleTimeline(edit, media, opts);
  const { r } = tl;
  const t = (f) => rational(f, r);
  const name = opts.name || 'Slipstream edit';
  const W = media.width || 1920, Hh = media.height || 1080;
  const tcFormat = r.dropFrame ? 'DF' : 'NDF';
  const screenName = media.screenName || baseName(media.screenPath) || 'screen';
  const cam = showCamera(edit, media);
  const cams = cam ? cameraClips(tl, media) : [];
  const audio = media.hasAudio !== false ? ' hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"' : ' hasAudio="0"';
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE fcpxml>', '<fcpxml version="1.10">', '  <resources>');
  L.push(`    <format id="r1" frameDuration="${r.num}/${r.den}s" width="${W}" height="${Hh}"/>`);
  L.push(`    <asset id="r2" name="${escapeXml(screenName)}" start="0s" duration="${t(tl.mediaFrames)}" hasVideo="1" format="r1"${audio}>`);
  L.push(`      <media-rep kind="original-media" src="${escapeXml(pathUrl(media.screenPath || screenName, opts.mediaDir))}"/>`);
  L.push('    </asset>');
  if (cam) {
    const camFrames = media.cameraDuration > 0 ? Math.round(media.cameraDuration * r.fps) : tl.mediaFrames - Math.round((media.cameraOffset || 0) * r.fps);
    L.push(`    <asset id="r3" name="${escapeXml(media.cameraName)}" start="0s" duration="${t(Math.max(1, camFrames))}" hasVideo="1" format="r1" hasAudio="0">`);
    L.push(`      <media-rep kind="original-media" src="${escapeXml(pathUrl(media.cameraPath || media.cameraName, opts.mediaDir))}"/>`);
    L.push('    </asset>');
  }
  L.push('  </resources>', '  <library>', `    <event name="${escapeXml(name)}">`, `      <project name="${escapeXml(name)}">`);
  L.push(`        <sequence format="r1" duration="${t(tl.totalFrames)}" tcStart="0s" tcFormat="${tcFormat}" audioLayout="stereo" audioRate="48k">`);
  L.push('          <spine>');
  tl.clips.forEach((c, i) => {
    const len = c.srcOut - c.srcIn;
    L.push(`            <asset-clip ref="r2" name="${escapeXml(screenName)}" offset="${t(c.recIn)}" start="${t(c.srcIn)}" duration="${t(len)}" format="r1" tcFormat="${tcFormat}">`);
    // Connected clips come before markers (FCPXML DTD order). Their offset is in the parent's source time.
    for (const k of cams.filter((x) => x.clip === i)) {
      L.push(`              <asset-clip ref="r3" lane="1" name="${escapeXml(media.cameraName)}" offset="${t(k.parentSrc)}" start="${t(k.srcIn)}" duration="${t(k.srcOut - k.srcIn)}" format="r1" srcEnable="video"/>`);
    }
    for (const m of tl.markers.filter((x) => x.clip === i)) {
      const tag = m.kind === 'chapter' ? 'chapter-marker' : 'marker';
      const extra = m.kind === 'chapter' ? ' posterOffset="0s"' : '';
      L.push(`              <${tag} start="${t(m.src)}" duration="${t(1)}" value="${escapeXml(m.name)}"${extra}/>`);
    }
    L.push('            </asset-clip>');
  });
  L.push('          </spine>', '        </sequence>', '      </project>', '    </event>', '  </library>', '</fcpxml>');
  return `${L.join('\n')}\n`;
}

// ---- CMX3600 EDL ----------------------------------------------------------------------------------

/**
 * CMX3600 EDL: one event per kept range on the screen recording (reel from its file name),
 * track AA/V with audio or V without. Markers become `* LOC:` comments. CMX3600 has one video
 * track, so the camera is not included. opts = { title, startTimecode = '01:00:00:00', dropFrame, eol }.
 */
export function toEDL(edit, media, opts = {}) {
  const tl = nleTimeline(edit, media, opts);
  const { r } = tl;
  const eol = opts.eol || '\n';
  const fileName = media.screenName || baseName(media.screenPath) || 'screen';
  const reel = reelName(fileName);
  const track = media.hasAudio === false ? 'V' : 'AA/V';
  const recStart = timecodeToFrames(opts.startTimecode || (r.dropFrame ? '01:00:00;00' : '01:00:00:00'), r);
  const tc = (f) => framesToTimecode(f, r);
  const title = String(opts.title || 'Slipstream edit').replace(/[\r\n]+/g, ' ').slice(0, 70);
  const L = [`TITLE: ${title}`, `FCM: ${r.dropFrame ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
  tl.clips.forEach((c, i) => {
    const num = String(i + 1).padStart(3, '0');
    L.push(`${num}  ${reel.padEnd(8)} ${track.padEnd(5)} ${'C'.padEnd(8)} ${tc(c.srcIn)} ${tc(c.srcOut)} ${tc(recStart + c.recIn)} ${tc(recStart + c.recOut)}`);
    L.push(`* FROM CLIP NAME: ${fileName}`);
    if (media.screenPath) L.push(`* SOURCE FILE: ${media.screenPath}`);
    for (const m of tl.markers.filter((x) => x.clip === i)) {
      L.push(`* LOC: ${tc(recStart + m.rec)} ${(m.kind === 'chapter' ? 'BLUE' : 'YELLOW').padEnd(7)} ${String(m.name).replace(/[\r\n]+/g, ' ')}`);
    }
    L.push('');
  });
  return L.join(eol);
}

// ---- xmeml (Premiere Pro / Resolve) ----------------------------------------------------------------

/**
 * Final Cut Pro 7 XML (xmeml v4) sequence for Premiere Pro and DaVinci Resolve: V1 screen,
 * V2 camera (when shown), A1 screen audio linked to V1, sequence markers for chapters and zooms.
 * opts = { name, mediaDir, dropFrame }.
 */
export function toXMEML(edit, media, opts = {}) {
  const tl = nleTimeline(edit, media, opts);
  const { r } = tl;
  const name = opts.name || 'Slipstream edit';
  const W = media.width || 1920, Hh = media.height || 1080;
  const screenName = media.screenName || baseName(media.screenPath) || 'screen';
  const cam = showCamera(edit, media);
  const cams = cam ? cameraClips(tl, media) : [];
  const audio = media.hasAudio !== false;
  const disp = r.dropFrame ? 'DF' : 'NDF';
  const rate = (ind) => `${ind}<rate><timebase>${r.timebase}</timebase><ntsc>${r.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const timecode = (ind, frames) => `${ind}<timecode>${rate('').trim()}<string>${framesToTimecode(frames, r)}</string><frame>${frames}</frame><displayformat>${disp}</displayformat></timecode>`;
  const vchar = (ind) => `${ind}<samplecharacteristics>${rate('').trim()}<width>${W}</width><height>${Hh}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;
  const achar = (ind) => `${ind}<samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics>`;
  const defined = new Set();
  const fileEl = (ind, id, fname, path, frames, hasAudio) => {
    if (defined.has(id)) return [`${ind}<file id="${id}"/>`];
    defined.add(id);
    const out = [`${ind}<file id="${id}">`, `${ind}  <name>${escapeXml(fname)}</name>`, `${ind}  <pathurl>${escapeXml(pathUrl(path || fname, opts.mediaDir))}</pathurl>`, rate(`${ind}  `), `${ind}  <duration>${frames}</duration>`, timecode(`${ind}  `, 0), `${ind}  <media>`, `${ind}    <video>`, vchar(`${ind}      `), `${ind}    </video>`];
    if (hasAudio) out.push(`${ind}    <audio>`, achar(`${ind}      `), `${ind}      <channelcount>2</channelcount>`, `${ind}    </audio>`);
    out.push(`${ind}  </media>`, `${ind}</file>`);
    return out;
  };
  const link = (ind, ref, type, trackIndex, clipIndex) => `${ind}<link><linkclipref>${ref}</linkclipref><mediatype>${type}</mediatype><trackindex>${trackIndex}</trackindex><clipindex>${clipIndex}</clipindex>${type === 'audio' ? '<groupindex>1</groupindex>' : ''}</link>`;
  const clipItem = (ind, { id, fname, fileId, path, frames, c, type, trackIndex, links, hasAudio }) => [
    `${ind}<clipitem id="${id}">`,
    `${ind}  <masterclipid>master-${fileId}</masterclipid>`,
    `${ind}  <name>${escapeXml(fname)}</name>`,
    `${ind}  <enabled>TRUE</enabled>`,
    `${ind}  <duration>${frames}</duration>`,
    rate(`${ind}  `),
    `${ind}  <start>${c.recIn}</start>`,
    `${ind}  <end>${c.recOut}</end>`,
    `${ind}  <in>${c.srcIn}</in>`,
    `${ind}  <out>${c.srcOut}</out>`,
    ...fileEl(`${ind}  `, fileId, fname, path, frames, hasAudio),
    `${ind}  <sourcetrack><mediatype>${type}</mediatype><trackindex>${trackIndex}</trackindex></sourcetrack>`,
    ...links.map((l) => link(`${ind}  `, ...l)),
    `${ind}</clipitem>`,
  ];
  const camFrames = media.cameraDuration > 0 ? Math.round(media.cameraDuration * r.fps) : Math.max(1, tl.mediaFrames - Math.round((media.cameraOffset || 0) * r.fps));
  const screenLinks = (i) => (audio ? [[`screen-v-${i + 1}`, 'video', 1, i + 1], [`screen-a-${i + 1}`, 'audio', 1, i + 1]] : []);

  const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE xmeml>', '<xmeml version="4">', '  <sequence id="sequence-1">'];
  L.push(`    <name>${escapeXml(name)}</name>`, `    <duration>${tl.totalFrames}</duration>`, rate('    '));
  L.push('    <media>', '      <video>', '        <format>', vchar('          '), '        </format>', '        <track>');
  tl.clips.forEach((c, i) => L.push(...clipItem('          ', { id: `screen-v-${i + 1}`, fname: screenName, fileId: 'file-screen', path: media.screenPath, frames: tl.mediaFrames, c, type: 'video', trackIndex: 1, links: screenLinks(i), hasAudio: audio })));
  L.push('          <enabled>TRUE</enabled>', '          <locked>FALSE</locked>', '        </track>');
  if (cams.length) {
    L.push('        <track>');
    cams.forEach((k, i) => L.push(...clipItem('          ', { id: `camera-v-${i + 1}`, fname: media.cameraName, fileId: 'file-camera', path: media.cameraPath, frames: camFrames, c: k, type: 'video', trackIndex: 1, links: [], hasAudio: false })));
    L.push('          <enabled>TRUE</enabled>', '          <locked>FALSE</locked>', '        </track>');
  }
  L.push('      </video>');
  if (audio) {
    L.push('      <audio>', '        <numOutputChannels>2</numOutputChannels>', '        <format>', achar('          '), '        </format>', '        <track>');
    tl.clips.forEach((c, i) => L.push(...clipItem('          ', { id: `screen-a-${i + 1}`, fname: screenName, fileId: 'file-screen', path: media.screenPath, frames: tl.mediaFrames, c, type: 'audio', trackIndex: 1, links: screenLinks(i), hasAudio: audio })));
    L.push('          <enabled>TRUE</enabled>', '          <locked>FALSE</locked>', '        </track>', '      </audio>');
  }
  L.push('    </media>', timecode('    ', 0));
  for (const m of tl.markers) {
    L.push(`    <marker><comment>${m.kind === 'chapter' ? 'Chapter' : 'Zoom'}</comment><name>${escapeXml(m.name)}</name><in>${m.rec}</in><out>-1</out></marker>`);
  }
  L.push('  </sequence>', '</xmeml>');
  return `${L.join('\n')}\n`;
}

/** Dispatch by export_nle format. Returns { text, extension, mime }. */
export function exportNLE(format, edit, media, opts = {}) {
  if (format === 'fcpxml') return { text: toFCPXML(edit, media, opts), extension: 'fcpxml', mime: 'application/xml' };
  if (format === 'edl') return { text: toEDL(edit, media, opts), extension: 'edl', mime: 'text/plain' };
  if (format === 'xmeml') return { text: toXMEML(edit, media, opts), extension: 'xml', mime: 'application/xml' };
  throw new Error(`Unknown NLE format ${format}`);
}
