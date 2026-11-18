// Main-thread side of speaker labels (ticket W-03): runs diarize-worker.js on the editor's 16 kHz PCM and
// returns speaker segments; the pure helpers that put them on transcript words are re-exported below.

/**
 * Two small models, downloaded once on first use and cached by the browser. Measured downloads:
 * segmentation fp32 6.0 MB + voice embedding 8-bit 6.7 MB (+ configs).
 */
export const DIARIZE_MODEL = {
  id: 'onnx-community/pyannote-segmentation-3.0',
  embeddingId: 'onnx-community/wespeaker-voxceleb-resnet34-LM',
  label: 'Speaker labels',
  sizeMB: 13,
  note: 'pyannote segmentation 3.0 + WeSpeaker ResNet34 · ~13 MB once · runs on this device',
  parts: [
    { id: 'onnx-community/pyannote-segmentation-3.0', role: 'Who speaks when', dtype: 'fp32', sizeMB: 6 },
    { id: 'onnx-community/wespeaker-voxceleb-resnet34-LM', role: 'Voice fingerprints', dtype: 'q8', sizeMB: 6.7 },
  ],
};

/**
 * Find who speaks when. pcm: mono Float32Array at 16 kHz (the editor's transcription PCM).
 * Options: numSpeakers (0 = detect), voiceprints (false = segmentation model only, 6 MB, weaker on similar
 * voices and long recordings), preferGPU, and callbacks onDownload(loaded,total), onReady(device), onProgress(p 0..1).
 * Returns { promise: Promise<[{ start, end, speaker: 'S1'|'S2'|… }]>, cancel() }.
 */
export function diarize(pcm, { numSpeakers = 0, voiceprints = true, preferGPU = true, onDownload, onReady, onProgress } = {}) {
  const worker = new Worker(new URL('./diarize-worker.js', import.meta.url), { type: 'module' });
  let cancel;
  const promise = new Promise((resolve, reject) => {
    cancel = () => { worker.terminate(); reject(new DOMException('Speaker detection cancelled', 'AbortError')); };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'download') onDownload?.(m.loaded, m.total);
      else if (m.type === 'ready') onReady?.(m.device);
      else if (m.type === 'progress') onProgress?.(m.p);
      else if (m.type === 'done') { worker.terminate(); resolve(m.segments); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Speaker detection worker failed to start')); };
    worker.postMessage({
      type: 'diarize',
      pcm,
      segModel: DIARIZE_MODEL.id,
      embModel: voiceprints ? DIARIZE_MODEL.embeddingId : null,
      numSpeakers,
      preferGPU,
    });
  });
  return { promise, cancel: () => cancel?.() };
}

export {
  assignSpeakers, speakerTurns, defaultSpeakers, renameSpeaker, speakerStats, speakerColor, SPEAKER_PALETTE,
} from '../../packages/editor-core/src/speakers.js';
