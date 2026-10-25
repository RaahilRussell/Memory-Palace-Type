import { access, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ffmpegVideoSampler, fixedCameraActorMask } from "../server/video-reconstruction.js";

const [videoFile, reconstructionDir, fingerprint] = process.argv.slice(2);
if (!videoFile || !reconstructionDir || !/^[a-f0-9]{32}$/.test(fingerprint || "")) {
  throw new Error("Usage: tsx scripts/refine-fixed-camera-video-actors.ts <video-file> <reconstruction-dir> <32-character-fingerprint>");
}

const originalPrefix = path.join(reconstructionDir, fingerprint);
const firstSurface = await sharp(`${originalPrefix}-actor-0.png`).raw().toBuffer({ resolveWithObject: true });
if (firstSurface.info.channels !== 2 && firstSurface.info.channels !== 4) throw new Error("Actor surfaces must contain depth and alpha channels.");
const width = firstSurface.info.width;
const height = firstSurface.info.height;
const actorCount = await countActorFrames(originalPrefix);
const masks: Uint8Array[] = [];
let plate: Buffer | undefined;
let staticCamera = true;
let cameraChecks = 0;
let decoded = 0;

const reported = await ffmpegVideoSampler.forEachFrame!(videoFile, async ({ width: frameWidth, height: frameHeight, rgb }) => {
  if (decoded >= actorCount) throw new Error("The video has more frames than the cached actor surfaces.");
  const color = await sharp(rgb, { raw: { width: frameWidth, height: frameHeight, channels: 3 } })
    .resize(width, height, { fit: "fill" }).raw().toBuffer();
  if (!plate) plate = Buffer.from(color);
  if (cameraChecks < 8) {
    let changed = 0;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 3;
      if (Math.max(Math.abs(color[offset] - plate[offset]), Math.abs(color[offset + 1] - plate[offset + 1]), Math.abs(color[offset + 2] - plate[offset + 2])) >= 18) changed++;
    }
    if (changed > width * height * 0.02) staticCamera = false;
    cameraChecks++;
  }
  const difference = fixedCameraActorMask(color, plate, width, height);
  let changed = 0;
  for (const pixel of difference) if (pixel) changed++;
  if (changed > difference.length * 0.015) masks.push(difference);
  else {
    const surface = await sharp(`${originalPrefix}-actor-${decoded}.png`).raw().toBuffer({ resolveWithObject: true });
    if (surface.info.width !== width || surface.info.height !== height || (surface.info.channels !== 2 && surface.info.channels !== 4))
      throw new Error(`Actor surface ${decoded} has inconsistent dimensions or channels.`);
    const originalMask = new Uint8Array(width * height);
    for (let pixel = 0; pixel < originalMask.length; pixel++) originalMask[pixel] = surface.data[pixel * surface.info.channels + surface.info.channels - 1];
    masks.push(originalMask);
  }
  decoded++;
});

if (!staticCamera) throw new Error("The first eight frames show camera or room motion; original segmentation masks were preserved.");
if (reported !== actorCount || decoded !== actorCount) throw new Error(`Decoded ${decoded}/${actorCount} actor frames (sampler reported ${reported}).`);

const metadataFile = await findMetadata(reconstructionDir, fingerprint);
const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
if (!Array.isArray(metadata.reconstruction?.video?.actorFrames) || metadata.reconstruction.video.actorFrames.length !== actorCount)
  throw new Error("Reconstruction metadata does not match the actor surfaces.");
const outputFrames: { time: number; surfaceUrl: string }[] = [];
for (let index = 0; index < actorCount; index++) {
  const current = masks[index];
  const packed = new Uint8Array(width * height * 2);
  const source = await sharp(`${originalPrefix}-actor-${index}.png`).raw().toBuffer({ resolveWithObject: true });
  if (source.info.channels !== 2 && source.info.channels !== 4) throw new Error(`Actor surface ${index} has an unsupported channel layout.`);
  for (let pixel = 0; pixel < width * height; pixel++) {
    packed[pixel * 2] = source.data[pixel * source.info.channels];
    // Keep each frame's own matte: majority voting across moving head edges
    // clips low-contrast hair whenever it shifts between adjacent frames.
    packed[pixel * 2 + 1] = current[pixel] > 0 ? 255 : 0;
  }
  const filename = `${fingerprint}-fixed-actor-${index}.png`;
  await sharp(Buffer.from(packed), { raw: { width, height, channels: 2 } }).png().toFile(path.join(reconstructionDir, filename));
  outputFrames.push({ time: metadata.reconstruction.video.actorFrames[index].time, surfaceUrl: `/uploads/reconstructions/${filename}` });
  if ((index + 1) % 100 === 0 || index + 1 === actorCount) console.log(`Refined ${index + 1}/${actorCount} fixed-camera actor masks.`);
}

metadata.reconstruction.video.actorFrames = outputFrames;
const temporary = `${metadataFile}.tmp`;
await writeFile(temporary, JSON.stringify(metadata));
await rename(temporary, metadataFile);
console.log(`Updated ${metadataFile} with the clean-plate actor masks.`);

async function countActorFrames(prefix: string) {
  let count = 0;
  while (true) {
    try { await access(`${prefix}-actor-${count}.png`); count++; }
    catch { return count; }
  }
}

async function findMetadata(directory: string, wantedFingerprint: string) {
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await readFile(path.join(directory, filename), "utf8"));
      if (value.fingerprint === wantedFingerprint) return path.join(directory, filename);
    } catch { /* Other metadata files are unrelated cache entries. */ }
  }
  throw new Error(`No reconstruction metadata uses fingerprint ${wantedFingerprint}.`);
}
