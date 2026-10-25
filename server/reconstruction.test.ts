import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Memory, ReconstructionSpec, WorldCompletion } from '../src/types.js';
import { PHOTO_DEPTH_CONFIG, SceneReconstructor, allowedReconstructionUrl, downloadReconstructionSource, type DepthEstimator } from './reconstruction.js';
import { VIDEO_CACHE_VERSION } from './video-reconstruction.js';
import { WorldCompleter } from './world-completion.js';

const photo: Memory = { id: 'test-photo', title: 'A photo', description: '', date: '', location: '', tags: [], source: 'upload', mediaType: 'image', url: '/uploads/photo.jpg', thumbnailUrl: '/uploads/photo.jpg' };
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-depth-'));
  const uploads = path.join(directory, 'uploads');
  await mkdir(uploads);
  await sharp({ create: { width: 640, height: 400, channels: 3, background: '#9c8864' } }).jpeg().toFile(path.join(uploads, 'photo.jpg'));
  return { uploads, cleanup: async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^memoir-depth-/);
    await rm(resolved, { recursive: true, force: true });
  } };
}

test('photo cache preserves native model depth details beyond the former 256 pixel reduction', async () => {
  const { uploads, cleanup } = await fixture();
  const width = 518, height = 324;
  const samples = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) samples[y * width + 257] = 255;
  try {
    const reconstructor = new SceneReconstructor(uploads, { estimator: async () => ({ data: samples, width, height, channels: 1 }) });
    const result = await reconstructor.reconstruct(photo);
    const saved = await sharp(path.join(uploads, result.depthUrl.slice('/uploads/'.length))).grayscale().raw().toBuffer({resolveWithObject: true});
    assert.equal(saved.info.width, width);
    assert.equal(saved.info.height, height);
    assert.equal(saved.data[100 * width + 257], 255, 'one-pixel foreground survives archival');
    assert.equal(saved.data[100 * width + 256], 0, 'depth boundary is not blurred');
  } finally { await cleanup(); }
});

test('depth cache upgrades retain source identity, reviewed completion assets and unchanged source framing', async () => {
  const { uploads, cleanup } = await fixture();
  const originalVersion = 'depth-anything-v2-small-fp32-518-v1';
  let calls = 0, cloudCalls = 0;
  try {
    const source = await readFile(path.join(uploads, 'photo.jpg'));
    const fingerprint = createHash('sha256').update(originalVersion).update(source).digest('hex').slice(0, 32);
    const prefix = `/uploads/reconstructions/${fingerprint}`;
    const artifacts = path.join(uploads, 'reconstructions');
    await mkdir(artifacts);
    const prepared = await sharp(source).rotate().flatten({ background: '#101722' }).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    await writeFile(path.join(artifacts, `${fingerprint}-source.jpg`), prepared);
    await sharp({ create: { width: 256, height: 160, channels: 3, background: '#444444' } }).grayscale().png().toFile(path.join(artifacts, `${fingerprint}-depth.png`));
    const legacy: ReconstructionSpec = { version: 1, kind: 'depth-mesh', sourceUrl: `${prefix}-source.jpg`, depthUrl: `${prefix}-depth.png`, width: 640, height: 400, depthSource: 'depth-anything-v2', near: 2, far: 12, fov: 60, mediaBasis: 'image' };
    const legacyMetadata = JSON.stringify({ fingerprint, reconstruction: legacy });
    const cacheKey = (version: string) => createHash('sha256').update(`${version}:image:${photo.url}`).digest('hex').slice(0, 32);
    await writeFile(path.join(artifacts, `${cacheKey(originalVersion)}.json`), legacyMetadata);
    // Even a copied old manifest at the new lookup key cannot bypass the version check.
    const metadataPath = path.join(artifacts, `${cacheKey(PHOTO_DEPTH_CONFIG.cacheVersion)}.json`);
    await writeFile(metadataPath, legacyMetadata);
    const maskUrl = `${prefix}-mask-0.png`;
    await sharp({ create: { width: 64, height: 40, channels: 3, background: '#ffffff' } }).grayscale().png().toFile(path.join(artifacts, `${fingerprint}-mask-0.png`));
    await writeFile(path.join(artifacts, `${fingerprint}-rear.jpg`), prepared);
    const neuralAsset = { url: `${prefix}-reviewed.glb`, model: 'makehuman' as const, upAxis: 'y' as const, frontYaw: 0, appearance: 'pbr' as const, inputKind: 'anatomical-template' as const };
    const reviewedBytes = Buffer.from('reviewed asset sentinel');
    await writeFile(path.join(artifacts, `${fingerprint}-reviewed.glb`), reviewedBytes);
    const world: WorldCompletion = { version: 1, generatedBy: 'local-segmentation', textureSource: 'source-inpaint', backgroundUrl: legacy.sourceUrl, rearAtlasUrl: `${prefix}-rear.jpg`, subjects: [{ id: 'reviewed-person', label: 'person', kind: 'person', box: [0, 0, 1, 1], maskUrl, neuralAsset }] };
    const worldPath = path.join(artifacts, `${fingerprint}-world.json`);
    const worldJson = JSON.stringify(world);
    await writeFile(worldPath, worldJson);
    const reconstructor = new SceneReconstructor(uploads, { estimator: async input => {
      calls++;
      assert.equal(input.width, 518); assert.equal(input.height, 324);
      if (calls === 1) throw new Error('Transient upgrade failure');
      return { data: new Uint8Array(input.width * input.height).fill(203), width: input.width, height: input.height, channels: 1 };
    } });
    await assert.rejects(reconstructor.reconstruct(photo), /depth model could not run/);
    const previousDepth = await sharp(path.join(artifacts, `${fingerprint}-depth.png`)).metadata();
    assert.equal(previousDepth.width, 256); assert.equal(previousDepth.height, 160);
    assert.equal(await readFile(worldPath, 'utf8'), worldJson);
    assert.equal(await readFile(metadataPath, 'utf8'), legacyMetadata);
    const result = await reconstructor.reconstruct(photo);
    assert.deepEqual(result, legacy, 'only the depth artifact changes; camera and completion identity stay stable');
    assert.equal(calls, 2);
    const depth = await sharp(path.join(artifacts, `${fingerprint}-depth.png`)).metadata();
    assert.equal(depth.width, 518); assert.equal(depth.height, 324);
    assert.deepEqual(await readFile(path.join(artifacts, `${fingerprint}-source.jpg`)), prepared);
    assert.equal(await readFile(worldPath, 'utf8'), worldJson, 'depth reconstruction does not rewrite the reviewed world');
    assert.equal(JSON.parse(await readFile(metadataPath, 'utf8')).depthCacheVersion, PHOTO_DEPTH_CONFIG.cacheVersion);
    const completer = new WorldCompleter(uploads, { localSegmenter: false, poseEstimator: false, provider: {
      segment: async () => { cloudCalls++; throw new Error('An upgrade must reuse completion'); },
      textures: async () => { cloudCalls++; throw new Error('An upgrade must reuse textures'); },
    } });
    const completed = await completer.complete(result);
    assert.equal(completed.completionUrl, `${prefix}-world.json`);
    assert.equal(cloudCalls, 0);
    const retained = JSON.parse(await readFile(worldPath, 'utf8')) as WorldCompletion;
    assert.deepEqual(retained.subjects[0].neuralAsset, neuralAsset);
    assert.equal(retained.rearAtlasUrl, world.rearAtlasUrl);
    assert.deepEqual(await readFile(path.join(artifacts, `${fingerprint}-rear.jpg`)), prepared);
    assert.deepEqual(await readFile(path.join(artifacts, `${fingerprint}-reviewed.glb`)), reviewedBytes);
    const reopened = new SceneReconstructor(uploads, { estimator: async () => { throw new Error('New worker must reuse upgraded cache'); } });
    assert.deepEqual(await reopened.reconstruct(photo), result);
    assert.ok(!(await readdir(artifacts)).some(name => name.endsWith('.tmp')));
  } finally { await cleanup(); }
});

test('photo inference and saved depth stay bounded without cropping oriented source framing', async () => {
  const { uploads, cleanup } = await fixture();
  try {
    // EXIF rotation turns this landscape file into a portrait; use the same
    // orientation and aspect ratio for source texture and inference.
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#336699' } }).withMetadata({ orientation: 6 }).jpeg().toFile(path.join(uploads, 'photo.jpg'));
    const reconstructor = new SceneReconstructor(uploads, { estimator: async input => {
      assert.equal(input.width, 345); assert.equal(input.height, 518);
      assert.equal(input.data.length, 345 * 518 * 3);
      // An oversized estimator result is bounded by the artifact contract.
      return { data: new Uint8Array(690 * 1036).fill(127), width: 690, height: 1036, channels: 1 };
    } });
    const result = await reconstructor.reconstruct(photo);
    assert.equal(result.width, 800); assert.equal(result.height, 1200);
    const texture = await sharp(path.join(uploads, result.sourceUrl.slice('/uploads/'.length))).metadata();
    assert.equal(texture.width, 800); assert.equal(texture.height, 1200);
    assert.equal(texture.orientation, undefined);
    const depth = await sharp(path.join(uploads, result.depthUrl.slice('/uploads/'.length))).metadata();
    assert.equal(depth.width, 345); assert.equal(depth.height, 518);
  } finally { await cleanup(); }
});

test('photo depth upgrade leaves video fingerprint, frame resolution and reopened cache unchanged', async () => {
  const { uploads, cleanup } = await fixture();
  let calls = 0;
  try {
    const bytes = Buffer.from('video bytes; sampler injected');
    await writeFile(path.join(uploads, 'clip.mp4'), bytes);
    const frame = await sharp({ create: { width: 640, height: 400, channels: 3, background: '#778899' } }).jpeg().toBuffer();
    const video: Memory = { ...photo, mediaType: 'video', url: '/uploads/clip.mp4' };
    const reconstructor = new SceneReconstructor(uploads, { videoSampler: { duration: async () => 1, frame: async () => frame }, estimator: async input => {
      calls++;
      assert.equal(input.width, 512); assert.equal(input.height, 320);
      return { data: new Uint8Array(512 * 320).fill(103), width: 512, height: 320, channels: 1 };
    } });
    const result = await reconstructor.reconstruct(video);
    const expected = createHash('sha256').update('depth-anything-v2-small-fp32-518-v1').update(VIDEO_CACHE_VERSION).update(bytes).digest('hex').slice(0, 32);
    assert.equal(result.sourceUrl, `/uploads/reconstructions/${expected}-source.jpg`);
    assert.equal(result.mediaBasis, 'video-sequence');
    assert.equal(result.video?.frames.length, 2); assert.equal(calls, 2);
    for (const value of result.video!.frames) {
      const depth = await sharp(path.join(uploads, value.depthUrl.slice('/uploads/'.length))).metadata();
      assert.equal(depth.width, 128); assert.equal(depth.height, 80);
    }
    const reopened = new SceneReconstructor(uploads, { estimator: async () => { throw new Error('Video inference must remain cached'); }, videoSampler: { duration: async () => { throw new Error('Video sampling must remain cached'); }, frame: async () => { throw new Error('Video sampling must remain cached'); } } });
    assert.deepEqual(await reopened.reconstruct(video), result);
  } finally { await cleanup(); }
});

test('reconstruction saves the inferred depth and original photo, deduplicates requests, and reopens cache without inference', async () => {
  const { uploads, cleanup } = await fixture();
  let calls = 0;
  const estimator: DepthEstimator = async input => {
    calls++;
    assert.equal(input.width, 518); assert.equal(input.height, 324);
    assert.equal(input.data.length, input.width * input.height * 3);
    // Deliberately independent of the uniform source image: geometry must come from the estimator.
    return { data: Uint8Array.from([0, 32, 64, 96, 128, 160, 192, 255]), width: 4, height: 2, channels: 1 };
  };
  try {
    const reconstructor = new SceneReconstructor(uploads, { estimator });
    const [first, simultaneous] = await Promise.all([reconstructor.reconstruct(photo), reconstructor.reconstruct({ ...photo, id: 'another-id', title: 'Changed title' })]);
    assert.deepEqual(first, simultaneous); assert.equal(calls, 1);
    assert.equal(first.mediaBasis, 'image'); assert.equal(first.width, 640); assert.equal(first.height, 400);
    assert.match(first.depthUrl, /^\/uploads\/reconstructions\/[a-f0-9]{32}-depth\.png$/);
    const depth = await sharp(path.join(uploads, first.depthUrl.replace('/uploads/', ''))).raw().toBuffer({ resolveWithObject: true });
    const values = Array.from({ length: 8 }, (_, pixel) => depth.data[pixel * depth.info.channels]);
    assert.deepEqual(values, [0, 32, 64, 96, 128, 160, 192, 255]);
    const source = await sharp(path.join(uploads, first.sourceUrl.replace('/uploads/', ''))).metadata();
    assert.equal(source.width, 640); assert.equal(source.height, 400);
    const reopened = new SceneReconstructor(uploads, { estimator: async () => { throw new Error('A persisted cache must skip inference.'); } });
    assert.deepEqual(await reopened.reconstruct(photo), first);
    // A file replacement at the same upload URL cannot silently reuse stale geometry.
    await sharp({ create: { width: 640, height: 400, channels: 3, background: '#4488cc' } }).jpeg().toFile(path.join(uploads, 'photo.jpg'));
    const changed = await reconstructor.reconstruct(photo);
    assert.notEqual(changed.depthUrl, first.depthUrl); assert.equal(calls, 2);
  } finally { await cleanup(); }
});

test('model failure is actionable, creates no invented depth, and can retry successfully', async () => {
  const { uploads, cleanup } = await fixture();
  let calls = 0;
  const estimator: DepthEstimator = async () => {
    if (++calls === 1) throw new Error('Download failed with a provider secret that must not escape.');
    return { data: Uint8Array.of(0, 255), width: 2, height: 1, channels: 1 };
  };
  try {
    const reconstructor = new SceneReconstructor(uploads, { estimator });
    await assert.rejects(reconstructor.reconstruct(photo), error => {
      assert.equal((error as { status: number }).status, 503);
      assert.match((error as Error).message, /Hugging Face/);
      assert.doesNotMatch((error as Error).message, /secret/); return true;
    });
    const retried = await reconstructor.reconstruct(photo);
    assert.equal(retried.kind, 'depth-mesh'); assert.equal(calls, 2);
    assert.ok((await readFile(path.join(uploads, retried.depthUrl.replace('/uploads/', '')))).length);
  } finally { await cleanup(); }
});

test('corrupt persisted reconstruction metadata is rebuilt instead of sent to a shared room', async () => {
  const { uploads, cleanup } = await fixture(); let calls = 0;
  try {
    const reconstructor = new SceneReconstructor(uploads, { estimator: async () => { calls++; return { data: Uint8Array.of(0, 255), width: 2, height: 1, channels: 1 }; } });
    await reconstructor.reconstruct(photo);
    const filename = (await readdir(reconstructor.artifactDir)).find(name => name.endsWith('.json'))!;
    const metadataPath = path.join(reconstructor.artifactDir, filename);
    const saved = JSON.parse(await readFile(metadataPath, 'utf8'));
    saved.reconstruction.near = 1000;
    await writeFile(metadataPath, JSON.stringify(saved));
    const rebuilt = await reconstructor.reconstruct(photo);
    assert.equal(rebuilt.near, 2); assert.equal(calls, 2);
  } finally { await cleanup(); }
});

test('reconstruction rejects arbitrary remote URLs and local traversal before image decoding or inference', async () => {
  assert.equal(allowedReconstructionUrl('https://images.unsplash.com/photo-example?width=500'), true);
  for (const url of ['https://images.unsplash.com.evil.test/x', 'https://evil-images.unsplash.com/x', 'https://user:pass@images.unsplash.com/x', 'http://images.unsplash.com/x', 'https://images.unsplash.com:444/x', 'https://127.0.0.1/private', 'file:///etc/passwd']) {
    assert.equal(allowedReconstructionUrl(url), false, url);
    await assert.rejects(downloadReconstructionSource(url), /Archive or upload/);
  }
  const { uploads, cleanup } = await fixture();
  const reconstructor = new SceneReconstructor(uploads, { estimator: async () => { throw new Error('Inference must not run.'); } });
  try {
    for (const url of ['/uploads/../private.jpg', '/uploads/..%2fprivate.jpg', '/uploads/subdir/photo.jpg', '/uploads/C:\\private.jpg', '/uploads/photo.jpg?x=1']) {
      await assert.rejects(reconstructor.reconstruct({ ...photo, url }), /image path/);
    }
    await assert.rejects(reconstructor.reconstruct({ ...photo, url: '/uploads/missing.jpg' }), /original photo is missing/);
    await writeFile(path.join(uploads, 'broken.jpg'), Buffer.from('this is not an image'));
    await assert.rejects(reconstructor.reconstruct({ ...photo, url: '/uploads/broken.jpg' }), /valid photo/);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#112233' } }).jpeg().toFile(path.join(uploads, 'tiny.jpg'));
    await assert.rejects(reconstructor.reconstruct({ ...photo, url: '/uploads/tiny.jpg' }), /at least 16 pixels/);
    await assert.rejects(reconstructor.reconstruct({ ...photo, mediaType: 'video', url: 'https://example.com/movie.mp4' }), /Upload or archive this video/);
  } finally { await cleanup(); }
});

test('inference is serialized for different photos so concurrent viewers cannot allocate concurrent model runs', async () => {
  const { uploads, cleanup } = await fixture();
  let active = 0; let maximum = 0; let calls = 0;
  const estimator: DepthEstimator = async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 20)); active--;
    return { data: Uint8Array.of(0, 255), width: 2, height: 1, channels: 1 };
  };
  try {
    await sharp({ create: { width: 640, height: 400, channels: 3, background: '#111111' } }).jpeg().toFile(path.join(uploads, 'second.jpg'));
    const reconstructor = new SceneReconstructor(uploads, { estimator });
    await Promise.all([reconstructor.reconstruct(photo), reconstructor.reconstruct({ ...photo, url: '/uploads/second.jpg' })]);
    assert.equal(calls, 2); assert.equal(maximum, 1);
  } finally { await cleanup(); }
});
