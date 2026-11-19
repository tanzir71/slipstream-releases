// Project bundles in the web app (tickets C-01 step 4, C-02, W-09): export a project as a `.slipstream`
// file (edit plan v2 + media + thumbnail) and open one made by any Slipstream surface. Everything happens
// on this device: the bundle is built from local files and downloaded, never uploaded.
import { packBundle, unpackBundle, packBrand, unpackBrand, BundleError, BUNDLE_EXT, BRAND_EXT } from '../../packages/editor-core/src/bundle.js';
import { toV2, fromV2, migratePlan, validatePlan } from '../../packages/editor-core/src/plan.js';
import { sha256Blob } from '../../packages/editor-core/src/sha256.js';
import { getMedia } from './store.js';

export const APP_INFO = { name: 'Slipstream Web', surface: 'web', version: '2.0.0' };
export { BUNDLE_EXT, BRAND_EXT, BundleError };

/**
 * The v2 plan mirror saved with every project (C-01): what desktop apps and the MCP server read. A desktop project
 * edited from a preview copy describes its original recording (`media.original`), which is what bundles carry and
 * the engine exports.
 */
export function planFor(project, edit = project.edit) {
  const o = project.media?.original;
  const media = o?.width && o?.height ? { ...project.media, width: o.width, height: o.height } : project.media;
  return toV2(edit, media, { name: project.name, created: project.created, updated: Date.now() });
}

async function dataUrlToBlob(url) {
  if (!url) return null;
  try { return await (await fetch(url)).blob(); } catch { return null; }
}

/** Build a `.slipstream` bundle for a stored project. planOnly keeps media as references (small file). */
export async function exportBundle(project, { planOnly = false, onProgress } = {}) {
  // Recordings edited from a preview copy (desktop app) travel as their originals, never the 1280-wide copy.
  const m = project.media;
  const screenRef = m.original ? { key: 'original', type: m.original.type, name: m.original.name } : { key: 'screen', type: m.screenType, name: m.screenName };
  const cameraRef = m.cameraOriginal ? { key: 'camera-original', type: m.cameraOriginal.type, name: m.cameraOriginal.name } : { key: 'camera', type: m.cameraType, name: m.cameraName };
  const [screen, camera] = await Promise.all([
    getMedia(`${project.id}:${screenRef.key}`, screenRef.type),
    m.camera ? getMedia(`${project.id}:${cameraRef.key}`, cameraRef.type) : null,
  ]);
  if (!screen) throw new Error('The media for this project is missing from this browser.');
  // Stored media is named 'screen'/'camera' internally; bundles and plan-only refs use the original file name.
  const named = (blob, name, type) => (blob && name && blob.name !== name ? new File([blob], name, { type: type || blob.type }) : blob);
  const plan = planFor(project);
  const check = validatePlan(plan);
  if (!check.valid) console.warn('Plan does not match the v2 schema', check.errors.slice(0, 5));
  // Extra assets: camera angles (S-03), B-roll (S-04) and the brand logo (S-02).
  const assets = [];
  if (!planOnly) {
    for (const a of project.media.angles || []) {
      if (a.id === 'camera') continue;
      const blob = a.original
        ? await getMedia(`${project.id}:angle-${a.id}-original`, a.original.type || '')
        : await getMedia(`${project.id}:angle-${a.id}`, a.type || '');
      if (blob) assets.push({ key: `angle-${a.id}`, blob, name: a.original?.name || a.name });
    }
    for (const b of project.edit.broll || []) {
      const blob = await getMedia(`${project.id}:broll-${b.id}`, b.type || '');
      if (blob) assets.push({ key: `broll-${b.id}`, blob });
    }
    for (const k of ['intro', 'outro']) {
      if (!project.media[k]) continue;
      const blob = await getMedia(`${project.id}:${k}`, project.media[`${k}Type`] || '');
      if (blob) assets.push({ key: k, blob });
    }
    if (project.media.logo) {
      const blob = await getMedia(`${project.id}:logo`, project.media.logoType || '');
      if (blob) assets.push({ key: 'logo', blob });
    }
    // Background music (S-04).
    if (project.edit.music) {
      const blob = await getMedia(`${project.id}:music`, project.edit.music.type || '');
      if (blob) assets.push({ key: 'music', blob });
    }
  }
  return packBundle({
    plan,
    media: { screen: named(screen, screenRef.name, screenRef.type), camera: named(camera, cameraRef.name, cameraRef.type) },
    assets,
    thumb: await dataUrlToBlob(project.thumb),
    app: APP_INFO,
    planOnly,
    onProgress,
  });
}

/**
 * Read a bundle. Returns { name, edit, media: { screen, camera }, cameraOffset, external, problems }.
 * Throws BundleError on hash mismatches unless `verify` is false ("open anyway").
 */
export async function readBundle(file, { verify = true, onProgress } = {}) {
  const res = await unpackBundle(file, { verify, onProgress });
  const plan = migratePlan(res.plan);
  const { edit, media, meta } = fromV2(plan);
  return {
    name: meta?.name || file.name.replace(/\.slipstream$/i, '') || 'Imported project',
    edit,
    plan,
    media: res.media,
    assets: res.assets || {},
    angles: media?.angles || null,
    cameraOffset: media?.cameraOffset ?? plan.sources?.cameraOffset ?? 0,
    external: res.problems.filter((p) => p.kind === 'external'),
    problems: res.problems.filter((p) => p.kind !== 'external'),
  };
}

/** For plan-only bundles: does a picked file match the reference (same size, and hash when listed)? */
export async function matchesRef(file, ref, onProgress) {
  if (ref.size && file.size !== ref.size) return false;
  if (!ref.sha256) return true;
  return (await sha256Blob(file, onProgress)) === ref.sha256.toLowerCase();
}

export async function exportBrand(kit) {
  const { logo, ...brand } = kit;
  return packBrand(brand, logo ? { logo } : {});
}

export async function readBrand(file) {
  const res = await unpackBrand(file);
  return { ...res.brand, logo: res.logo || null };
}

export function isBundleFile(file) { return /\.slipstream$/i.test(file?.name || ''); }
export function isBrandFile(file) { return /\.slipstream-brand$/i.test(file?.name || ''); }
