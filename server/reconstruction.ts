import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import sharp from "sharp";
import type { Memory, ReconstructionSpec } from "../src/types.js";
import { isReconstructionSpec } from "../src/reconstruction-validation.js";
import type { LocalSegmenter } from "./world-completion.js";
import { HttpError, isMediaBytes } from "./http.js";
import { publicAddress } from "./media.js";
import {
  DenseVideoFrameLimitError,
  ffmpegVideoSampler,
  fixedCameraActorMask,
  VIDEO_CACHE_VERSION,
  videoSampleTimes,
  type VideoSampler,
} from "./video-reconstruction.js";
import {
  sharedDepthEstimator,
  type DepthEstimator,
  type DepthPixels,
} from "./depth-model.js";

const MAX_BYTES = 15 * 1024 * 1024;
const CACHE_VERSION = "depth-anything-v2-small-fp32-518-v1";
const LEGACY_TRACK_CACHE_VERSION = "video-depth-sequence-v1";
export type { DepthEstimator, DepthPixels } from "./depth-model.js";
const PHOTO_CACHE_VERSION = `${CACHE_VERSION}-preserved-depth-v2`;
/** Keep inference fixed while comparing preserved depth against the old 256px artifact. */
export const PHOTO_DEPTH_CONFIG = Object.freeze({
  modelInputMax: 518,
  artifactMax: 518,
  cacheVersion: PHOTO_CACHE_VERSION,
});

async function writeArtifact(file: string, data: Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function allowedReconstructionUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "images.unsplash.com" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
    );
  } catch {
    return false;
  }
}

/** Only the bundled sample-photo CDN is fetched. DNS is validated and pinned per redirect. */
export async function downloadReconstructionSource(
  value: string,
  redirects = 0,
): Promise<Buffer> {
  if (!allowedReconstructionUrl(value))
    throw new HttpError(
      400,
      "Archive or upload this photo before turning it into 3D. Remote reconstruction supports only the sample-photo CDN.",
    );
  if (redirects > 3)
    throw new HttpError(
      502,
      "The sample photo redirected too many times. Upload the original photo instead.",
    );
  const url = new URL(value);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((address) => !publicAddress(address.address))
  )
    throw new HttpError(
      400,
      "The photo host did not resolve to a public address.",
    );
  const address = addresses.find((item) => item.family === 4) || addresses[0];
  const result = await new Promise<Buffer | URL>((resolve, reject) => {
    const req = request(
      {
        protocol: "https:",
        hostname: address.address,
        family: address.family,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        headers: {
          Host: url.hostname,
          Accept: "image/jpeg,image/png,image/webp",
          "User-Agent": "Again/0.1",
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.destroy();
          resolve(new URL(response.headers.location, url));
          return;
        }
        const mimeType = (response.headers["content-type"] || "")
          .split(";")[0]
          .toLowerCase()
          .trim();
        if (
          response.statusCode !== 200 ||
          !["image/jpeg", "image/png", "image/webp"].includes(mimeType)
        ) {
          response.destroy();
          reject(
            new HttpError(
              502,
              "The sample photo could not be downloaded. Upload the original photo instead.",
            ),
          );
          return;
        }
        if (Number(response.headers["content-length"] || 0) > MAX_BYTES) {
          response.destroy();
          reject(
            new HttpError(
              413,
              "Use a photo smaller than 15 MB for 3D reconstruction.",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy();
            reject(
              new HttpError(
                413,
                "Use a photo smaller than 15 MB for 3D reconstruction.",
              ),
            );
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          if (!isMediaBytes(bytes, mimeType)) {
            reject(
              new HttpError(
                400,
                "The photo contents do not match their image format.",
              ),
            );
            return;
          }
          resolve(bytes);
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("Photo download timed out.")),
      30000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
  return result instanceof URL
    ? downloadReconstructionSource(result.href, redirects + 1)
    : result;
}

/** Single-view reconstruction: learned relative depth, not brightness or a recovered scan. */
export class SceneReconstructor {
  private readonly pending = new Map<string, Promise<ReconstructionSpec>>();
  private readonly estimator: DepthEstimator;
  private readonly videoSampler: VideoSampler;
  private readonly actorSegmenter?: LocalSegmenter;
  private inferenceQueue: Promise<unknown> = Promise.resolve();
  readonly artifactDir: string;
  constructor(
    readonly uploadsDir: string,
    options: {
      estimator?: DepthEstimator;
      modelCacheDir?: string;
      videoSampler?: VideoSampler;
      actorSegmenter?: LocalSegmenter;
    } = {},
  ) {
    this.artifactDir = path.join(uploadsDir, "reconstructions");
    this.estimator =
      options.estimator ||
      sharedDepthEstimator(
        options.modelCacheDir || path.join(path.dirname(uploadsDir), "models"),
      );
    this.videoSampler = options.videoSampler || ffmpegVideoSampler;
    this.actorSegmenter = options.actorSegmenter;
  }

  async reconstruct(memory: Memory): Promise<ReconstructionSpec> {
    // This lookup is source-specific, so metadata edits reuse the same geometry.
    const cacheVersion =
      memory.mediaType === "video"
        ? `${CACHE_VERSION}:${VIDEO_CACHE_VERSION}`
        : PHOTO_CACHE_VERSION;
    const sourceKey = createHash("sha256")
      .update(`${cacheVersion}:${memory.mediaType}:${memory.url}`)
      .digest("hex")
      .slice(0, 32);
    const existing = this.pending.get(sourceKey);
    if (existing) return existing;
    const operation = this.build(memory, sourceKey).finally(() =>
      this.pending.delete(sourceKey),
    );
    this.pending.set(sourceKey, operation);
    return operation;
  }

  private async sourceBytes(memory: Memory): Promise<Buffer> {
    if (memory.url.startsWith("/uploads/")) {
      // Catalog URLs are data, not trusted filesystem paths. Only flat, literal upload filenames are accepted.
      const filename = memory.url.slice("/uploads/".length);
      if (!/^[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(filename))
        throw new HttpError(
          400,
          "This image path cannot be used for 3D reconstruction. Upload the original photo again.",
        );
      const file = path.join(this.uploadsDir, filename);
      try {
        if ((await stat(file)).size > MAX_BYTES)
          throw new HttpError(
            413,
            "Use a photo smaller than 15 MB for 3D reconstruction.",
          );
        return await readFile(file);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          404,
          "The original photo is missing. Upload it again to turn it into 3D.",
        );
      }
    }
    return downloadReconstructionSource(memory.url);
  }

  private async cached(
    sourceKey: string,
    fingerprint?: string,
    depthCacheVersion?: string,
  ): Promise<ReconstructionSpec | undefined> {
    try {
      const saved = JSON.parse(
        await readFile(
          path.join(this.artifactDir, `${sourceKey}.json`),
          "utf8",
        ),
      ) as {
        fingerprint: string;
        depthCacheVersion?: string;
        reconstruction: ReconstructionSpec;
      };
      if (!/^[a-f0-9]{32}$/.test(saved.fingerprint)) return;
      if (fingerprint && saved.fingerprint !== fingerprint) return;
      if (depthCacheVersion && saved.depthCacheVersion !== depthCacheVersion)
        return;
      const reconstruction = saved.reconstruction;
      const artifactPrefix = `/uploads/reconstructions/${saved.fingerprint}`;
      if (
        !isReconstructionSpec(reconstruction) ||
        reconstruction.sourceUrl !== `${artifactPrefix}-source.jpg` ||
        reconstruction.depthUrl !== `${artifactPrefix}-depth.png`
      )
        return;
      await Promise.all([
        stat(path.join(this.artifactDir, `${saved.fingerprint}-source.jpg`)),
        stat(path.join(this.artifactDir, `${saved.fingerprint}-depth.png`)),
      ]);
      if (reconstruction.video) {
        for (const [index, frame] of reconstruction.video.frames.entries()) {
          const key =
            index === 0
              ? saved.fingerprint
              : this.frameKey(saved.fingerprint, frame.time);
          if (
            frame.sourceUrl !== `/uploads/reconstructions/${key}-source.jpg` ||
            frame.depthUrl !== `/uploads/reconstructions/${key}-depth.png`
          )
            return;
          await Promise.all([
            stat(path.join(this.artifactDir, `${key}-source.jpg`)),
            stat(path.join(this.artifactDir, `${key}-depth.png`)),
          ]);
        }
        for (const frame of reconstruction.video.actorFrames ?? [])
          await stat(path.join(this.artifactDir, path.basename(frame.surfaceUrl)));
      }
      return reconstruction;
    } catch {
      return undefined;
    }
  }

  private async build(
    memory: Memory,
    sourceKey: string,
  ): Promise<ReconstructionSpec> {
    await mkdir(this.artifactDir, { recursive: true });
    if (memory.mediaType === "video") return this.buildVideo(memory, sourceKey);
    // Immutable sample CDN URLs can be reused offline; local files are content-hashed to detect replacement.
    if (!memory.url.startsWith("/uploads/")) {
      const cached = await this.cached(sourceKey, undefined, PHOTO_CACHE_VERSION);
      if (cached) return cached;
    }
    let source: Buffer;
    try {
      source = await this.sourceBytes(memory);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        "The photo could not be loaded for 3D. Check the connection or upload the original photo.",
      );
    }
    const fingerprint = createHash("sha256")
      // Completion, reviewed bodies and atlases use this original source identity.
      // Version the depth cache separately so a resolution upgrade preserves them.
      .update(CACHE_VERSION)
      .update(source)
      .digest("hex")
      .slice(0, 32);
    const cached = await this.cached(sourceKey, fingerprint, PHOTO_CACHE_VERSION);
    if (cached) return cached;
    let width: number;
    let height: number;
    let texture: Buffer;
    let modelInput: { data: Buffer; width: number; height: number };
    try {
      const prepared = await sharp(source, {
        limitInputPixels: 40_000_000,
        animated: false,
      })
        .rotate()
        .flatten({ background: "#101722" })
        .resize({
          width: 1600,
          height: 1600,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 92 })
        .toBuffer({ resolveWithObject: true });
      texture = prepared.data;
      width = prepared.info.width;
      height = prepared.info.height;
      if (width < 16 || height < 16) throw new Error("The photo is too small.");
      const rgb = await sharp(texture)
        .resize({
          width: PHOTO_DEPTH_CONFIG.modelInputMax,
          height: PHOTO_DEPTH_CONFIG.modelInputMax,
          fit: "inside",
          withoutEnlargement: true,
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      modelInput = {
        data: rgb.data,
        width: rgb.info.width,
        height: rgb.info.height,
      };
    } catch {
      throw new HttpError(
        400,
        "Use a valid photo at least 16 pixels wide and high after resizing, with no more than 40 megapixels.",
      );
    }
    const infer = async () => {
      try {
        return await this.estimator(modelInput);
      } catch {
        throw new HttpError(
          503,
          "The depth model could not run. On first use the server downloads Depth Anything V2 from Hugging Face. Check the server internet connection and available memory, then retry.",
        );
      }
    };
    // Avoid simultaneous CPU inference/model allocations when several people select photos.
    const inference = this.inferenceQueue.catch(() => {}).then(infer);
    this.inferenceQueue = inference;
    const depth = await inference;
    if (
      !depth.width ||
      !depth.height ||
      depth.data.length !== depth.width * depth.height * depth.channels
    )
      throw new HttpError(
        503,
        "The depth model returned an invalid image. Retry the reconstruction.",
      );
    const depthPng = await sharp(Buffer.from(depth.data), {
      raw: {
        width: depth.width,
        height: depth.height,
        channels: depth.channels,
      },
    })
      .resize({
        width: PHOTO_DEPTH_CONFIG.artifactMax,
        height: PHOTO_DEPTH_CONFIG.artifactMax,
        fit: "inside",
        withoutEnlargement: true,
        kernel: "nearest",
      })
      .grayscale()
      .png()
      .toBuffer();
    const prefix = `${fingerprint}`;
    const reconstruction: ReconstructionSpec = {
      version: 1,
      kind: "depth-mesh",
      sourceUrl: `/uploads/reconstructions/${prefix}-source.jpg`,
      depthUrl: `/uploads/reconstructions/${prefix}-depth.png`,
      width,
      height,
      depthSource: "depth-anything-v2",
      near: 2,
      far: 12,
      fov: 60,
      mediaBasis: "image",
    };
    if (!isReconstructionSpec(reconstruction))
      throw new HttpError(
        503,
        "The reconstruction metadata is invalid. Retry this photo.",
      );
    // Stable URLs preserve completion identity. Atomically replace upgraded depth,
    // leaving the previous usable artifact intact until the new PNG is complete.
    await Promise.all([
      writeArtifact(path.join(this.artifactDir, `${prefix}-source.jpg`), texture),
      writeArtifact(path.join(this.artifactDir, `${prefix}-depth.png`), depthPng),
    ]);
    const metadataPath = path.join(this.artifactDir, `${sourceKey}.json`);
    await writeFile(
      `${metadataPath}.tmp`,
      JSON.stringify({
        fingerprint,
        depthCacheVersion: PHOTO_CACHE_VERSION,
        reconstruction,
      }),
    );
    await rename(`${metadataPath}.tmp`, metadataPath);
    return reconstruction;
  }

  private frameKey(fingerprint: string, time: number) {
    return createHash("sha256")
      .update(`${fingerprint}:${time}`)
      .digest("hex")
      .slice(0, 32);
  }

  private async buildVideo(
    memory: Memory,
    sourceKey: string,
  ): Promise<ReconstructionSpec> {
    const filename = memory.url.slice("/uploads/".length);
    if (
      !memory.url.startsWith("/uploads/") ||
      !/^[A-Za-z0-9_-]+\.(?:mp4|webm|mov)$/i.test(filename)
    )
      throw new HttpError(
        422,
        "Upload or archive this video locally to immerse in it.",
      );
    const file = path.join(this.uploadsDir, filename);
    let bytes: Buffer;
    try {
      if ((await stat(file)).size > 50 * 1024 * 1024)
        throw new HttpError(
          413,
          "Use a video smaller than 50 MB for 3D reconstruction.",
        );
      bytes = await readFile(file);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        404,
        "The original video is missing. Upload it again to immerse in it.",
      );
    }
    // Hash the whole video: clips with identical opening frames can have different motion.
    const fingerprint = createHash("sha256")
      .update(CACHE_VERSION)
      .update(VIDEO_CACHE_VERSION)
      .update(bytes)
      .digest("hex")
      .slice(0, 32);
    const legacySourceKey = createHash("sha256")
      .update(`${CACHE_VERSION}:${LEGACY_TRACK_CACHE_VERSION}:${memory.mediaType}:${memory.url}`)
      .digest("hex")
      .slice(0, 32);
    const legacyFingerprint = createHash("sha256")
      .update(CACHE_VERSION)
      .update(LEGACY_TRACK_CACHE_VERSION)
      .update(bytes)
      .digest("hex")
      .slice(0, 32);
    const legacyTracks = (await this.cached(legacySourceKey, legacyFingerprint))?.video?.trackedObjects;
    const cached = await this.cached(sourceKey, fingerprint);
    if (cached?.video) {
      if (cached.video.trackedObjects?.length || !legacyTracks?.length) return cached;
      const migrated = { ...cached, video: { ...cached.video, trackedObjects: legacyTracks } };
      const metadataPath = path.join(this.artifactDir, `${sourceKey}.json`);
      await writeFile(`${metadataPath}.tmp`, JSON.stringify({ fingerprint, reconstruction: migrated }));
      await rename(`${metadataPath}.tmp`, metadataPath);
      return migrated;
    }
    const duration = await this.videoSampler.duration(file);
    const times = videoSampleTimes(duration);
    const frames = [];
    let width = 0,
      height = 0;
    for (const [index, time] of times.entries()) {
      const frame = await this.videoSampler.frame(file, time);
      const prepared = await sharp(frame, { limitInputPixels: 40_000_000 })
        .rotate()
        .flatten({ background: "#101722" })
        .resize({
          width: 512,
          height: 512,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 90 })
        .toBuffer({ resolveWithObject: true });
      if (prepared.info.width < 16 || prepared.info.height < 16)
        throw new HttpError(
          422,
          "Video frames must be at least 16 pixels wide and high.",
        );
      if (!index) {
        width = prepared.info.width;
        height = prepared.info.height;
      }
      if (prepared.info.width !== width || prepared.info.height !== height)
        throw new HttpError(
          422,
          "Video frame dimensions changed during playback. Export this video at a fixed resolution.",
        );
      const rgb = await sharp(prepared.data).removeAlpha().raw().toBuffer();
      const inference = this.inferenceQueue
        .catch(() => {})
        .then(() => this.estimator({ data: rgb, width, height }));
      this.inferenceQueue = inference;
      let depth: DepthPixels;
      try {
        depth = await inference;
      } catch {
        throw new HttpError(
          503,
          "The video depth model could not run. Check the server connection to Hugging Face and available memory, then retry.",
        );
      }
      if (
        !depth.width ||
        !depth.height ||
        depth.data.length !== depth.width * depth.height * depth.channels
      )
        throw new HttpError(
          503,
          "The depth model returned an invalid video frame. Retry the reconstruction.",
        );
      const depthPng = await sharp(Buffer.from(depth.data), {
        raw: {
          width: depth.width,
          height: depth.height,
          channels: depth.channels,
        },
      })
        .resize({
          width: 128,
          height: 128,
          fit: "inside",
          withoutEnlargement: true,
        })
        .grayscale()
        .png()
        .toBuffer();
      const key = index === 0 ? fingerprint : this.frameKey(fingerprint, time);
      await Promise.all([
        writeFile(
          path.join(this.artifactDir, `${key}-source.jpg`),
          prepared.data,
        ),
        writeFile(path.join(this.artifactDir, `${key}-depth.png`), depthPng),
      ]);
      frames.push({
        time,
        sourceUrl: `/uploads/reconstructions/${key}-source.jpg`,
        depthUrl: `/uploads/reconstructions/${key}-depth.png`,
      });
    }
    let actorFrames: { time: number; surfaceUrl: string }[] | undefined;
    if (this.actorSegmenter && this.videoSampler.forEachFrame) {
      type RawActorFrame = { time: number; depth: Uint8Array; mask: Uint8Array };
      let actorWidth = 0;
      let actorHeight = 0;
      let decodedFrames = 0;
      let previous: RawActorFrame | undefined;
      let current: RawActorFrame | undefined;
      let cleanPlate: Buffer | undefined;
      let cameraCheckFrames = 0;
      let lockedCamera = true;
      let resumeStart = 0;
      while (true) {
        try { await stat(path.join(this.artifactDir, `${fingerprint}-actor-${resumeStart}.png`)); resumeStart++; }
        catch { break; }
      }
      if (resumeStart) {
        const cachedActor = await sharp(path.join(this.artifactDir, `${fingerprint}-actor-0.png`))
          .raw().toBuffer({ resolveWithObject: true });
        if (cachedActor.info.channels !== 2 && cachedActor.info.channels !== 4)
          throw new Error("The cached actor surface has an invalid channel layout.");
        actorWidth = cachedActor.info.width;
        actorHeight = cachedActor.info.height;
        cleanPlate = await sharp(path.join(this.artifactDir, `${fingerprint}-source.jpg`))
          .resize(actorWidth, actorHeight, { fit: "fill" }).removeAlpha().raw().toBuffer();
      }
      actorFrames = [];
      const loadSavedActorFrame = async (index: number, time: number): Promise<RawActorFrame> => {
        const loaded = await sharp(path.join(this.artifactDir, `${fingerprint}-actor-${index}.png`))
          .raw().toBuffer({ resolveWithObject: true });
        if ((loaded.info.channels !== 2 && loaded.info.channels !== 4) || loaded.info.width < 1 || loaded.info.height < 1 ||
          loaded.info.width !== actorWidth || loaded.info.height !== actorHeight)
          throw new Error(`Cached actor surface ${index} is invalid.`);
        const depth = new Uint8Array(loaded.info.width * loaded.info.height);
        const mask = new Uint8Array(depth.length);
        const channels = loaded.info.channels;
        for (let pixel = 0; pixel < depth.length; pixel++) {
          depth[pixel] = loaded.data[pixel * channels];
          mask[pixel] = loaded.data[pixel * channels + channels - 1] ? 255 : 0;
        }
        return { time, depth, mask };
      };
      const saveSmoothed = async (index: number, before: RawActorFrame, frame: RawActorFrame, after: RawActorFrame) => {
        const packed = new Uint8Array(actorWidth * actorHeight * 2);
        for (let pixel = 0; pixel < actorWidth * actorHeight; pixel++) {
          const beforeMask = before.mask[pixel] > 0 ? 1 : 0;
          const currentMask = frame.mask[pixel] > 0 ? 1 : 0;
          const afterMask = after.mask[pixel] > 0 ? 1 : 0;
          const near = Math.min(before.depth[pixel], frame.depth[pixel], after.depth[pixel]);
          const far = Math.max(before.depth[pixel], frame.depth[pixel], after.depth[pixel]);
          packed[pixel * 2] = before.depth[pixel] + frame.depth[pixel] + after.depth[pixel] - near - far;
          packed[pixel * 2 + 1] = beforeMask + currentMask + afterMask >= 2 ? 255 : 0;
        }
        const key = `${fingerprint}-actor-${index}`;
        const surface = await sharp(Buffer.from(packed), {
          raw: { width: actorWidth, height: actorHeight, channels: 2 },
        }).png().toBuffer();
        await writeFile(path.join(this.artifactDir, `${key}.png`), surface);
        actorFrames!.push({ time: frame.time, surfaceUrl: `/uploads/reconstructions/${key}.png` });
      };
      try {
        const reportedFrameCount = await this.videoSampler.forEachFrame(file, async ({ time, width: frameWidth, height: frameHeight, rgb }) => {
          const frameIndex = decodedFrames;
          if (resumeStart && cameraCheckFrames < 8 && cleanPlate) {
            const colorImage = await sharp(rgb, {
              raw: { width: frameWidth, height: frameHeight, channels: 3 },
            }).resize(actorWidth, actorHeight, { fit: "fill" }).raw().toBuffer();
            let changed = 0;
            for (let pixel = 0; pixel < actorWidth * actorHeight; pixel++) {
              const offset = pixel * 3;
              if (Math.max(
                Math.abs(colorImage[offset] - cleanPlate[offset]),
                Math.abs(colorImage[offset + 1] - cleanPlate[offset + 1]),
                Math.abs(colorImage[offset + 2] - cleanPlate[offset + 2]),
              ) >= 18) changed++;
            }
            if (changed > actorWidth * actorHeight * 0.02) lockedCamera = false;
            cameraCheckFrames++;
          }
          if (frameIndex < resumeStart) {
            if (frameIndex >= resumeStart - 2) {
              const saved = await loadSavedActorFrame(frameIndex, time);
              if (frameIndex === resumeStart - 2) previous = saved;
              else current = saved;
            }
            actorFrames!.push({ time, surfaceUrl: `/uploads/reconstructions/${fingerprint}-actor-${frameIndex}.png` });
            decodedFrames++;
            return;
          }
          const encoded = await sharp(rgb, {
            raw: { width: frameWidth, height: frameHeight, channels: 3 },
          }).jpeg({ quality: 92 }).toBuffer();
          const inference = this.inferenceQueue.catch(() => {}).then(() =>
            this.estimator({ data: rgb, width: frameWidth, height: frameHeight }),
          );
          this.inferenceQueue = inference;
          const [segments, inferred] = await Promise.all([
            this.actorSegmenter!(encoded, frameWidth, frameHeight),
            inference,
          ]);
          const depthImage = await sharp(Buffer.from(inferred.data), {
            raw: { width: inferred.width, height: inferred.height, channels: inferred.channels },
          }).resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
            .grayscale().raw().toBuffer({ resolveWithObject: true });
          const colorImage = await sharp(rgb, {
            raw: { width: frameWidth, height: frameHeight, channels: 3 },
          }).resize(depthImage.info.width, depthImage.info.height, { fit: "fill" })
            .raw().toBuffer();
          if (!cleanPlate) cleanPlate = Buffer.from(colorImage);
          if (cameraCheckFrames < 8) {
            let changed = 0;
            for (let pixel = 0; pixel < depthImage.info.width * depthImage.info.height; pixel++) {
              const offset = pixel * 3;
              if (Math.max(
                Math.abs(colorImage[offset] - cleanPlate[offset]),
                Math.abs(colorImage[offset + 1] - cleanPlate[offset + 1]),
                Math.abs(colorImage[offset + 2] - cleanPlate[offset + 2]),
              ) >= 18) changed++;
            }
            if (changed > depthImage.info.width * depthImage.info.height * 0.02)
              lockedCamera = false;
            cameraCheckFrames++;
          }
          const actorMask = new Uint8Array(frameWidth * frameHeight);
          for (const segment of segments) {
            if (segment.subject.kind !== "person") continue;
            for (let pixel = 0; pixel < actorMask.length; pixel++)
              if (segment.mask[pixel]) actorMask[pixel] = 255;
          }
          let maskImage: Uint8Array = new Uint8Array(await sharp(Buffer.from(actorMask), {
            raw: { width: frameWidth, height: frameHeight, channels: 1 },
          }).resize({ width: depthImage.info.width, height: depthImage.info.height, fit: "fill", kernel: "lanczos3" })
            .threshold(96).raw().toBuffer());
          if (lockedCamera && cleanPlate) {
            const differenceMask = fixedCameraActorMask(
              colorImage,
              cleanPlate,
              depthImage.info.width,
              depthImage.info.height,
            );
            let changed = 0;
            for (const pixel of differenceMask) if (pixel) changed++;
            // Registered motion is a stronger cue than per-frame semantic
            // labels when the camera and background remain fixed.
            if (changed > differenceMask.length * 0.015) maskImage = differenceMask;
          }
          if (!actorWidth) {
            actorWidth = depthImage.info.width;
            actorHeight = depthImage.info.height;
          }
          if (depthImage.info.width !== actorWidth || depthImage.info.height !== actorHeight)
            throw new Error("Video dimensions changed during dense actor analysis.");
          const frame: RawActorFrame = {
            time,
            depth: new Uint8Array(depthImage.data),
            mask: new Uint8Array(maskImage),
          };
          if (frameIndex === resumeStart && resumeStart > 0) {
            // The cached last surface already contains its temporal lookahead.
            // Use it as a boundary sample, then resume exact frame indices.
            previous = current;
            current = frame;
            decodedFrames++;
            return;
          }
          if (decodedFrames === 0) {
            current = frame;
          } else if (decodedFrames === 1) {
            await saveSmoothed(0, current!, current!, frame);
            previous = current;
            current = frame;
          } else {
            await saveSmoothed(decodedFrames - 1, previous!, current!, frame);
            previous = current;
            current = frame;
          }
          decodedFrames++;
        });
        if (reportedFrameCount !== decodedFrames)
          throw new Error(`Decoded ${decodedFrames} actor frames, but the video sampler reported ${reportedFrameCount}.`);
        if (decodedFrames < 2 || !previous || !current)
          throw new Error("Dense actor analysis needs at least two decoded frames.");
        if (resumeStart < decodedFrames)
          await saveSmoothed(decodedFrames - 1, previous, current, current);
        if (actorFrames.length !== decodedFrames)
          throw new Error(`Saved ${actorFrames.length}/${decodedFrames} dense actor frames.`);
      } catch (error) {
        // Long recordings still support the bounded depth sequence. Only skip
        // dense actors for this explicit limit, before any frame processing.
        if (error instanceof DenseVideoFrameLimitError && decodedFrames === 0) {
          actorFrames = undefined;
        } else {
          if (error instanceof HttpError && error.status < 500) throw error;
          throw new HttpError(503, `Dense per-frame person and depth analysis stopped after saving ${actorFrames.length} of ${decodedFrames} actor frames. Completed frame surfaces remain in the local cache; retry the reconstruction after checking model memory and ffmpeg.`);
        }
      }
    }
    const reconstruction: ReconstructionSpec = {
      version: 1,
      kind: "depth-mesh",
      sourceUrl: frames[0].sourceUrl,
      depthUrl: frames[0].depthUrl,
      width,
      height,
      depthSource: "depth-anything-v2",
      near: 2,
      far: 12,
      fov: 60,
      mediaBasis: "video-sequence",
      video: {
        version: 1,
        duration,
        frames,
        ...(actorFrames ? { actorFrames } : {}),
        ...(legacyTracks?.length ? { trackedObjects: legacyTracks } : {}),
      },
    };
    if (!isReconstructionSpec(reconstruction))
      throw new HttpError(
        503,
        "The video reconstruction metadata is invalid. Retry this video.",
      );
    const metadataPath = path.join(this.artifactDir, `${sourceKey}.json`);
    await writeFile(
      `${metadataPath}.tmp`,
      JSON.stringify({ fingerprint, reconstruction }),
    );
    await rename(`${metadataPath}.tmp`, metadataPath);
    return reconstruction;
  }
}
