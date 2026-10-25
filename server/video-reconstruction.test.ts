import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Memory, ReconstructionSpec } from "../src/types.js";
import { isReconstructionSpec } from "../src/reconstruction-validation.js";
import { SceneReconstructor } from "./reconstruction.js";
import {
  DenseVideoFrameLimitError,
  completeVideoReconstruction,
  fixedCameraActorMask,
  fixedCameraDifferenceMask,
  VIDEO_CACHE_VERSION,
  videoSampleTimes,
  videoStreamDuration,
  type VideoSampler,
} from "./video-reconstruction.js";

test("fixed-camera differences produce a clean, closed actor silhouette", () => {
  const width = 9, height = 9;
  const plate = new Uint8Array(width * height * 3);
  const current = Uint8Array.from(plate);
  for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) {
    if (x === 4 && y === 4) continue;
    const offset = (y * width + x) * 3;
    current[offset] = current[offset + 1] = current[offset + 2] = 90;
  }
  const mask = fixedCameraDifferenceMask(current, plate, width, height, 18);
  assert.equal(mask[4 * width + 4], 255, "closing fills a tiny compression hole");
  assert.equal(mask[0], 0, "the unchanged room stays background");
  const exposureShift = Uint8Array.from(plate);
  for (let pixel = 0; pixel < width * height; pixel++) exposureShift.fill(40, pixel * 3, pixel * 3 + 3);
  for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) {
    const offset = (y * width + x) * 3;
    exposureShift.fill(110, offset, offset + 3);
  }
  const compensated = fixedCameraDifferenceMask(exposureShift, plate, width, height, 18);
  assert.equal(compensated[0], 0, "row-wise exposure changes are removed");
  assert.equal(compensated[4 * width + 4], 255, "the person remains visible after exposure compensation");
  assert.throws(() => fixedCameraDifferenceMask(current, plate.slice(1), width, height), /must match/);
});

test("fixed-camera actor masks keep the high-contrast body and reject room drift", () => {
  const width = 64, height = 96;
  const plate = new Uint8Array(width * height * 3).fill(100);
  const current = Uint8Array.from(plate);
  for (let y = 0; y < 12; y++) for (let x = 0; x < width; x++) current.fill(120, (y * width + x) * 3, (y * width + x) * 3 + 3);
  for (let y = 16; y <= 19; y++) for (let x = 26; x <= 34; x++) current.fill(125, (y * width + x) * 3, (y * width + x) * 3 + 3);
  for (let y = 20; y <= 45; y++) for (let x = 20; x <= 40; x++) current.fill(190, (y * width + x) * 3, (y * width + x) * 3 + 3);
  for (let x = 0; x < width; x++) current.fill(130, (80 * width + x) * 3, (80 * width + x) * 3 + 3);
  const mask = fixedCameraActorMask(current, plate, width, height);
  assert.equal(mask[30 * width + 30], 255, "the person core and body are retained");
  assert.equal(mask[17 * width + 30], 255, "low-contrast hair above the body is retained");
  assert.equal(mask[5 * width + 5], 0, "bright wall drift is rejected");
  assert.equal(mask[80 * width + 5], 0, "floor drift is rejected");
});

const video: Memory = {
  id: "video-test",
  title: "A moving memory",
  description: "",
  date: "",
  location: "",
  tags: [],
  source: "upload",
  mediaType: "video",
  url: "/uploads/clip.mp4",
  thumbnailUrl: "",
};
const still: ReconstructionSpec = {
  version: 1,
  kind: "depth-mesh",
  sourceUrl: "/uploads/reconstructions/abc-source.jpg",
  depthUrl: "/uploads/reconstructions/abc-depth.png",
  width: 512,
  height: 384,
  depthSource: "depth-anything-v2",
  near: 2,
  far: 12,
  fov: 60,
};

test("video samples span the entire clip and bound work even for long recordings", () => {
  assert.equal(
    videoStreamDuration({
      streams: [{ duration: "21.86" }],
      format: { duration: "21.96" },
    }),
    21.86,
  );
  assert.equal(
    videoStreamDuration({
      streams: [{ duration: "N/A" }],
      format: { duration: "8" },
    }),
    8,
  );
  for (const duration of [0.05, 1, 20, 3600]) {
    const times = videoSampleTimes(duration);
    assert.ok(times.length >= 2 && times.length <= 8);
    assert.equal(times[0], 0);
    assert.ok(times.at(-1)! >= duration * 0.9 && times.at(-1)! < duration);
    assert.ok(times.every((time, i) => !i || time > times[i - 1]));
  }
  for (const duration of [0, -1, Infinity, NaN, 3601])
    assert.throws(() => videoSampleTimes(duration));
});

test("video reconstruction caches all frame artifacts and hashes the video beyond its opening frame", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memoir-video-"));
  const uploads = path.join(directory, "uploads");
  await mkdir(uploads);
  let inferenceCalls = 0,
    samples = 0;
  const sampler: VideoSampler = {
    duration: async () => 5,
    frame: async (_file, time) => {
      samples++;
      return sharp({
        create: {
          width: 640,
          height: 400,
          channels: 3,
          background: time ? "#225588" : "#dd8833",
        },
      })
        .jpeg()
        .toBuffer();
    },
  };
  const reconstructor = new SceneReconstructor(uploads, {
    videoSampler: sampler,
    estimator: async (input) => {
      inferenceCalls++;
      assert.equal(input.width, 512);
      assert.equal(input.height, 320);
      return {
        data: Uint8Array.of(0, 64, 128, 255),
        width: 2,
        height: 2,
        channels: 1,
      };
    },
  });
  try {
    await writeFile(
      path.join(uploads, "clip.mp4"),
      "same first frame; motion A",
    );
    const first = await reconstructor.reconstruct(video);
    assert.equal(first.mediaBasis, "video-sequence");
    assert.equal(first.video?.frames.length, 4);
    assert.equal(inferenceCalls, 4);
    assert.ok(isReconstructionSpec(first));
    assert.deepEqual(await reconstructor.reconstruct(video), first);
    assert.equal(inferenceCalls, 4);
    assert.equal(samples, 4);
    for (const frame of first.video!.frames) {
      assert.ok(
        (
          await readFile(
            path.join(uploads, frame.sourceUrl.slice("/uploads/".length)),
          )
        ).length,
      );
      assert.ok(
        (
          await readFile(
            path.join(uploads, frame.depthUrl.slice("/uploads/".length)),
          )
        ).length,
      );
    }
    await writeFile(
      path.join(uploads, "clip.mp4"),
      "same first frame; motion B",
    );
    const changed = await reconstructor.reconstruct(video);
    assert.notEqual(changed.sourceUrl, first.sourceUrl);
    assert.equal(inferenceCalls, 8);
    // Missing later geometry invalidates a manifest, rather than silently freezing playback.
    await rm(
      path.join(
        uploads,
        changed.video!.frames[2].depthUrl.slice("/uploads/".length),
      ),
    );
    await reconstructor.reconstruct(video);
    assert.equal(inferenceCalls, 12);
    const metadata = (await readdir(reconstructor.artifactDir)).find((name) =>
      name.endsWith(".json"),
    )!;
    const saved = JSON.parse(
      await readFile(path.join(reconstructor.artifactDir, metadata), "utf8"),
    );
    saved.reconstruction.video.frames[1].time = -1;
    await writeFile(
      path.join(reconstructor.artifactDir, metadata),
      JSON.stringify(saved),
    );
    await reconstructor.reconstruct(video);
    assert.equal(inferenceCalls, 16);
    for (const url of [
      "/uploads/../clip.mp4",
      "/uploads/nested/clip.mp4",
      "https://example.com/clip.mp4",
    ])
      await assert.rejects(
        reconstructor.reconstruct({ ...video, url }),
        /Upload or archive/,
      );
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^memoir-video-/);
    await rm(resolved, { recursive: true, force: true });
  }
});

test("dense actor analysis saves a temporally smoothed surface for every decoded source frame", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memoir-dense-video-"));
  const uploads = path.join(directory, "uploads");
  await mkdir(uploads);
  const sourceTimes = [0, 1 / 30, 2 / 30];
  let segmentCalls = 0;
  const mintTrack = {
    id: "mint-tin",
    label: "Mints",
    kind: "circular-tin" as const,
    radius: 0.034,
    thickness: 0.012,
    color: "#25c8c2",
    keyframes: [
      { time: 0.5, u: 0.44, v: 0.52, depth: 4 },
      { time: 0.9, u: 0.51, v: 0.58, depth: 2.5, rotation: [1, 0.2, 0.5] as [number, number, number] },
    ],
  };
  const sampler: VideoSampler = {
    duration: async () => 1,
    frame: async (_file, time) => sharp({ create: {
      width: 64, height: 96, channels: 3, background: time ? "#777777" : "#555555",
    } }).jpeg().toBuffer(),
    async forEachFrame(_file, visit) {
      for (let index = 0; index < sourceTimes.length; index++) {
        const rgb = Buffer.alloc(64 * 96 * 3, index ? 180 : 80);
        await visit({ time: sourceTimes[index], width: 64, height: 96, rgb });
      }
      return sourceTimes.length;
    },
  };
  const reconstructor = new SceneReconstructor(uploads, {
    videoSampler: sampler,
    estimator: async ({ width, height }) => ({
      data: new Uint8Array(width * height).fill(128), width, height, channels: 1,
    }),
    actorSegmenter: async (_image, width, height) => {
      segmentCalls++;
      const mask = new Uint8Array(width * height);
      for (let y = 15; y < 80; y++) for (let x = 16; x < 48; x++) mask[y * width + x] = 255;
      return [{ subject: {
        label: "person", kind: "person", confidence: 0.95,
        box_2d: [150, 250, 830, 750],
        polygon: [[250, 150], [750, 150], [750, 830], [250, 830]],
      }, mask }];
    },
  });
  try {
    await writeFile(path.join(uploads, "clip.mp4"), "dense actor test input");
    const legacyVersion = "video-depth-sequence-v1";
    const legacySourceKey = createHash("sha256")
      .update(`depth-anything-v2-small-fp32-518-v1:${legacyVersion}:${video.mediaType}:${video.url}`)
      .digest("hex").slice(0, 32);
    const legacyFingerprint = createHash("sha256")
      .update("depth-anything-v2-small-fp32-518-v1")
      .update(legacyVersion)
      .update("dense actor test input")
      .digest("hex").slice(0, 32);
    const legacyFrames = [0, 0.9].map((time, index) => {
      const key = index === 0 ? legacyFingerprint : createHash("sha256")
        .update(`${legacyFingerprint}:${time}`).digest("hex").slice(0, 32);
      return {
        time,
        sourceUrl: `/uploads/reconstructions/${key}-source.jpg`,
        depthUrl: `/uploads/reconstructions/${key}-depth.png`,
      };
    });
    await mkdir(reconstructor.artifactDir, { recursive: true });
    for (const frame of legacyFrames) {
      await writeFile(path.join(uploads, frame.sourceUrl.slice("/uploads/".length)), "source");
      await writeFile(path.join(uploads, frame.depthUrl.slice("/uploads/".length)), "depth");
    }
    const legacyReconstruction: ReconstructionSpec = {
      ...still,
      sourceUrl: legacyFrames[0].sourceUrl,
      depthUrl: legacyFrames[0].depthUrl,
      mediaBasis: "video-sequence",
      video: { version: 1, duration: 1, frames: legacyFrames, trackedObjects: [mintTrack] },
    };
    await writeFile(path.join(reconstructor.artifactDir, `${legacySourceKey}.json`), JSON.stringify({
      fingerprint: legacyFingerprint,
      reconstruction: legacyReconstruction,
    }));
    const result = await reconstructor.reconstruct(video);
    assert.equal(segmentCalls, sourceTimes.length);
    assert.deepEqual(result.video?.actorFrames?.map((frame) => frame.time), sourceTimes);
    assert.deepEqual(result.video?.trackedObjects, [mintTrack]);
    assert.ok(isReconstructionSpec(result));
    for (const actorFrame of result.video!.actorFrames!) {
      const asset = await readFile(path.join(uploads, actorFrame.surfaceUrl.slice("/uploads/".length)));
      const metadata = await sharp(asset).metadata();
      assert.ok(metadata.channels === 2 || metadata.channels === 4);
      assert.ok(metadata.width! >= 16 && metadata.height! >= 16);
      const decoded = await sharp(asset).raw().toBuffer({ resolveWithObject: true });
      assert.ok(decoded.data.some((value, index) => index % decoded.info.channels === decoded.info.channels - 1 && value > 0));
      assert.equal(decoded.data[decoded.info.channels - 1], 0);
    }
    assert.deepEqual(await reconstructor.reconstruct(video), result);
    assert.equal(segmentCalls, sourceTimes.length);
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("dense actor retries resume from saved frame surfaces without repeating inference", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memoir-resume-video-"));
  const uploads = path.join(directory, "uploads");
  await mkdir(uploads);
  const sourceTimes = [0, 1 / 30, 2 / 30];
  let segmentCalls = 0, estimatorCalls = 0;
  const sampler: VideoSampler = {
    duration: async () => 1,
    frame: async () => sharp({ create: { width: 64, height: 96, channels: 3, background: "#777777" } }).jpeg().toBuffer(),
    async forEachFrame(_file, visit) {
      for (let index = 0; index < sourceTimes.length; index++)
        await visit({ time: sourceTimes[index], width: 64, height: 96, rgb: Buffer.alloc(64 * 96 * 3, index ? 180 : 80) });
      return sourceTimes.length;
    },
  };
  const reconstructor = new SceneReconstructor(uploads, {
    videoSampler: sampler,
    estimator: async ({ width, height }) => {
      estimatorCalls++;
      return { data: new Uint8Array(width * height).fill(128), width, height, channels: 1 };
    },
    actorSegmenter: async (_image, width, height) => {
      segmentCalls++;
      return [{ subject: { label: "person", kind: "person", confidence: 0.95, box_2d: [0, 0, 1000, 1000], polygon: [] }, mask: new Uint8Array(width * height).fill(255) }];
    },
  });
  try {
    const sourceBytes = "resume dense actor test input";
    await writeFile(path.join(uploads, "clip.mp4"), sourceBytes);
    const fingerprint = createHash("sha256")
      .update("depth-anything-v2-small-fp32-518-v1")
      .update(VIDEO_CACHE_VERSION)
      .update(sourceBytes)
      .digest("hex").slice(0, 32);
    await mkdir(reconstructor.artifactDir, { recursive: true });
    const savedSurface = Buffer.alloc(64 * 96 * 2);
    for (let pixel = 0; pixel < 64 * 96; pixel++) savedSurface[pixel * 2] = 128;
    const savedPng = await sharp(savedSurface, { raw: { width: 64, height: 96, channels: 2 } }).png().toBuffer();
    for (const index of [0, 1]) await writeFile(path.join(reconstructor.artifactDir, `${fingerprint}-actor-${index}.png`), savedPng);
    const result = await reconstructor.reconstruct(video);
    assert.equal(segmentCalls, 1, "only the missing actor frame should be segmented");
    assert.equal(estimatorCalls, 3, "two sparse samples and one missing dense frame are processed");
    assert.deepEqual(result.video?.actorFrames?.map((frame) => frame.time), sourceTimes);
    assert.deepEqual(await readFile(path.join(reconstructor.artifactDir, `${fingerprint}-actor-0.png`)), savedPng);
    assert.deepEqual(await readFile(path.join(reconstructor.artifactDir, `${fingerprint}-actor-1.png`)), savedPng);
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("dense actor analysis persists completed smoothed frames before a later decode failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memoir-partial-video-"));
  const uploads = path.join(directory, "uploads");
  await mkdir(uploads);
  const sampler: VideoSampler = {
    duration: async () => 1,
    frame: async () => sharp({ create: {
      width: 64, height: 96, channels: 3, background: "#777777",
    } }).jpeg().toBuffer(),
    async forEachFrame(_file, visit) {
      for (let index = 0; index < 2; index++) {
        await visit({ time: index / 30, width: 64, height: 96, rgb: Buffer.alloc(64 * 96 * 3, 180) });
      }
      throw new Error("Simulated late decode failure");
    },
  };
  const reconstructor = new SceneReconstructor(uploads, {
    videoSampler: sampler,
    estimator: async ({ width, height }) => ({
      data: new Uint8Array(width * height).fill(128), width, height, channels: 1,
    }),
    actorSegmenter: async (_image, width, height) => [{
      subject: { label: "person", kind: "person", confidence: 0.95, box_2d: [0, 0, 1000, 1000], polygon: [] },
      mask: new Uint8Array(width * height).fill(255),
    }],
  });
  try {
    await writeFile(path.join(uploads, "clip.mp4"), "partial dense actor test input");
    await assert.rejects(reconstructor.reconstruct(video), /Dense per-frame person and depth analysis stopped after saving 1 of 2 actor frames/);
    const savedActors = (await readdir(reconstructor.artifactDir)).filter((name) => name.endsWith("-actor-0.png"));
    assert.equal(savedActors.length, 1);
    assert.equal((await readdir(reconstructor.artifactDir)).filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).length, 0);
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("video manifests reject unsafe paths, inconsistent origins, timestamps and unbounded frames", () => {
  const manifest: ReconstructionSpec = {
    ...still,
    mediaBasis: "video-sequence",
    video: {
      version: 1,
      duration: 5,
      frames: [
        { time: 0, sourceUrl: still.sourceUrl, depthUrl: still.depthUrl },
        {
          time: 4.9,
          sourceUrl: "/uploads/second.jpg",
          depthUrl: "/uploads/second.png",
        },
      ],
    },
  };
  assert.ok(isReconstructionSpec(manifest));
  const denseManifest = structuredClone(manifest);
  denseManifest.video!.actorFrames = [
    { time: 0, surfaceUrl: "/uploads/reconstructions/actor-0.png" },
    { time: 1 / 30, surfaceUrl: "/uploads/reconstructions/actor-1.png" },
  ];
  assert.ok(isReconstructionSpec(denseManifest));
  const unsafeDense = structuredClone(denseManifest);
  unsafeDense.video!.actorFrames![1].surfaceUrl = "/uploads/../secret.png";
  assert.equal(isReconstructionSpec(unsafeDense), false);
  const oversizedDense = structuredClone(denseManifest);
  oversizedDense.video!.actorFrames = Array(2001).fill(denseManifest.video!.actorFrames![0]);
  assert.equal(isReconstructionSpec(oversizedDense), false);
  const tracked = structuredClone(manifest);
  tracked.video!.trackedObjects = [{
    id: "mint-tin",
    label: "Mints",
    kind: "circular-tin",
    radius: 0.03,
    thickness: 0.012,
    color: "#25c8c2",
    keyframes: [
      { time: 1, u: 0.5, v: 0.5, depth: 5 },
      { time: 4, u: 0.8, v: 0.2, depth: 1.5, rotation: [0, 1, 0] },
    ],
  }];
  assert.ok(isReconstructionSpec(tracked));
  const invalidTrack = structuredClone(tracked);
  invalidTrack.video!.trackedObjects![0].keyframes[1].u = 1.5;
  assert.equal(isReconstructionSpec(invalidTrack), false);
  for (const mutate of [
    (x: typeof manifest) => {
      x.video!.frames[1].sourceUrl = "https://evil.test/frame.jpg";
    },
    (x: typeof manifest) => {
      x.video!.frames[1].depthUrl = "/uploads/../secret.png";
    },
    (x: typeof manifest) => {
      x.video!.frames[1].time = 0;
    },
    (x: typeof manifest) => {
      x.video!.frames[1].time = 6;
    },
    (x: typeof manifest) => {
      x.video!.frames[0].sourceUrl = "/uploads/wrong.jpg";
    },
    (x: typeof manifest) => {
      x.video!.frames = Array(9).fill(x.video!.frames[0]);
    },
    (x: typeof manifest) => {
      x.mediaBasis = "image";
    },
  ]) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.equal(isReconstructionSpec(copy), false);
  }
  assert.equal(
    isReconstructionSpec({ ...still, mediaBasis: "video-sequence" }),
    false,
  );
});

test("completion recognizes every video keyframe serially while preserving timing and source assets", async () => {
  const input: ReconstructionSpec = {
    ...still,
    mediaBasis: "video-sequence",
    video: {
      version: 1,
      duration: 3,
      frames: [
        { time: 0, sourceUrl: still.sourceUrl, depthUrl: still.depthUrl },
        {
          time: 2.9,
          sourceUrl: "/uploads/reconstructions/def-source.jpg",
          depthUrl: "/uploads/reconstructions/def-depth.png",
        },
      ],
    },
  };
  let active = 0,
    calls = 0;
  const output = await completeVideoReconstruction(input, async (frame) => {
    assert.equal(++active, 1);
    assert.equal(frame.mediaBasis, "video-frame");
    assert.equal(frame.video, undefined);
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return {
      ...frame,
      completionUrl: frame.sourceUrl.replace("-source.jpg", "-world.json"),
    };
  });
  assert.equal(calls, 2);
  assert.equal(output.completionUrl, "/uploads/reconstructions/abc-world.json");
  assert.deepEqual(
    output.video?.frames.map((frame) => frame.time),
    [0, 2.9],
  );
  assert.equal(
    output.video?.frames[1].completionUrl,
    "/uploads/reconstructions/def-world.json",
  );
});


test("long videos fall back to a cached sampled sequence without dense actor inference", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memoir-long-video-"));
  const uploads = path.join(directory, "uploads");
  await mkdir(uploads);
  let denseAttempts = 0, inferenceCalls = 0, segmentCalls = 0;
  const reconstructor = new SceneReconstructor(uploads, {
    videoSampler: {
      duration: async () => 120,
      frame: async () => sharp({ create: { width: 64, height: 96, channels: 3, background: "#777777" } }).jpeg().toBuffer(),
      async forEachFrame() { denseAttempts++; throw new DenseVideoFrameLimitError(); },
    },
    estimator: async ({ width, height }) => {
      inferenceCalls++;
      return { data: new Uint8Array(width * height).fill(128), width, height, channels: 1 };
    },
    actorSegmenter: async () => { segmentCalls++; return []; },
  });
  try {
    await writeFile(path.join(uploads, "clip.mp4"), "long video test input");
    const result = await reconstructor.reconstruct(video);
    assert.equal(result.video?.duration, 120);
    assert.equal(result.video?.frames.length, 8);
    assert.equal(result.video?.actorFrames, undefined);
    assert.equal(isReconstructionSpec(result), true);
    assert.deepEqual(await reconstructor.reconstruct(video), result);
    assert.equal(inferenceCalls, 8, "the cached sampled sequence does not repeat depth inference");
    assert.equal(denseAttempts, 1, "the cached fallback does not repeat dense decoding");
    assert.equal(segmentCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
