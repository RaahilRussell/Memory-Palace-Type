import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ffmpegVideoSampler } from "../server/video-reconstruction.js";

const [videoFile, metadataFile, outputDirectory] = process.argv.slice(2);
if (!videoFile || !metadataFile || !outputDirectory)
  throw new Error("Usage: tsx scripts/export-mint-quest-assets.ts <source-video> <reconstruction.json> <output-directory>");

const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
const spec = metadata.reconstruction;
const actorFrames = spec?.video?.actorFrames;
const track = spec?.video?.trackedObjects?.find((item: { id: string }) => item.id === "mint-tin");
if (!Array.isArray(actorFrames) || !actorFrames.length || !track?.keyframes?.length)
  throw new Error("The reconstruction must include dense actor frames and the tracked mint tin.");
const sourceRoot = path.dirname(metadataFile);
const unpack = (url: string) => path.join(sourceRoot, path.basename(url));
const actorSurface = await sharp(unpack(actorFrames[0].surfaceUrl)).metadata();
const actorWidth = actorSurface.width;
const actorHeight = actorSurface.height;
const actorMaskChannel = actorSurface.channels === 4 ? 3 : actorSurface.channels === 2 ? 1 : -1;
if (actorMaskChannel < 0)
  throw new Error(`Actor surfaces must provide depth plus alpha mask channels; received ${actorSurface.channels ?? "unknown"}.`);
if (!actorWidth || !actorHeight || actorFrames.some((frame: { time: number }, index: number) =>
  !Number.isFinite(frame.time) || (index > 0 && frame.time <= actorFrames[index - 1].time)))
  throw new Error("The actor frame dimensions or timeline are invalid.");

const colorScale = 4;
const colorWidth = actorWidth * colorScale;
const colorHeight = actorHeight * colorScale;
const colorDirectory = path.join(outputDirectory, "actor", "color");
const alphaDirectory = path.join(outputDirectory, "actor", "alpha");
const depthDirectory = path.join(outputDirectory, "actor", "depth");
await mkdir(colorDirectory, { recursive: true });
await mkdir(alphaDirectory, { recursive: true });
await mkdir(depthDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });

let nextFrameIndex = 0;
const frameCount = await ffmpegVideoSampler.forEachFrame!(videoFile, async ({ time, width, height, rgb }) => {
  const index = nextFrameIndex++;
  const target = actorFrames[index];
  if (!target || Math.abs(target.time - time) > 0.025)
    throw new Error(`Source frame ${index} at ${time.toFixed(3)}s does not match the baked actor timeline.`);
  const stem = String(index).padStart(4, "0");
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(colorWidth, colorHeight, { fit: "fill", kernel: "lanczos3" })
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toFile(path.join(colorDirectory, `${stem}.jpg`));
  await sharp(unpack(target.surfaceUrl))
    .extractChannel(actorMaskChannel)
    .resize(colorWidth, colorHeight, { fit: "fill", kernel: "lanczos3" })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(path.join(alphaDirectory, `${stem}.png`));
  await copyFile(unpack(target.surfaceUrl), path.join(depthDirectory, `${stem}.png`));
  if ((index + 1) % 100 === 0 || index + 1 === actorFrames.length)
    console.log(`Packaged ${index + 1}/${actorFrames.length} actor frames.`);
}, 1024);
if (frameCount !== actorFrames.length)
  throw new Error(`Packed ${frameCount}/${actorFrames.length} video frames.`);

const firstDepthUrl = spec.video.frames[0]?.depthUrl ?? spec.depthUrl;
const roomDepthPath = unpack(firstDepthUrl);
const roomDepth = await sharp(roomDepthPath).metadata();
if (!roomDepth.width || !roomDepth.height) throw new Error("The clean-plate depth map is missing.");
await copyFile(unpack(spec.sourceUrl), path.join(outputDirectory, "room.jpg"));
await copyFile(roomDepthPath, path.join(outputDirectory, "room-depth.png"));

const header = Buffer.alloc(56);
header.write("M3D1", 0, "ascii");
[
  roomDepth.width, roomDepth.height, actorWidth, actorHeight,
  actorFrames.length, track.keyframes.length,
].forEach((value: number, index: number) => header.writeUInt32LE(value, 4 + index * 4));
[
  spec.near, spec.far, spec.fov, 1.25,
  actorFrames.at(-1).time, track.radius, track.thickness,
].forEach((value: number, index: number) => header.writeFloatLE(value, 28 + index * 4));
const timeline = Buffer.alloc(actorFrames.length * 4);
actorFrames.forEach((frame: { time: number }, index: number) => timeline.writeFloatLE(frame.time, index * 4));
const keyframes = Buffer.alloc(track.keyframes.length * 36);
track.keyframes.forEach((frame: any, index: number) => {
  const offset = index * 36;
  [frame.time, frame.u, frame.v, frame.depth, ...(frame.rotation ?? [0, 0, 0])]
    .forEach((value: number, component: number) => keyframes.writeFloatLE(value, offset + component * 4));
  keyframes.writeUInt32LE(frame.visible === false ? 0 : 1, offset + 28);
  keyframes.writeUInt32LE(0, offset + 32);
});
await writeFile(path.join(outputDirectory, "mint.scene"), Buffer.concat([header, timeline, keyframes]));

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><radialGradient id="lid" cx="36%" cy="26%" r="80%"><stop stop-color="#8cf4e9"/><stop offset=".38" stop-color="#24bcae"/><stop offset=".76" stop-color="#087c7b"/><stop offset="1" stop-color="#063f49"/></radialGradient>
<linearGradient id="metal"><stop stop-color="#38494b"/><stop offset=".14" stop-color="#d7dfdb"/><stop offset=".3" stop-color="#748584"/><stop offset=".5" stop-color="#f4f7ef"/><stop offset=".73" stop-color="#687678"/><stop offset=".9" stop-color="#d4dedc"/><stop offset="1" stop-color="#3b4d50"/></linearGradient>
<linearGradient id="side" x2="0" y2="1"><stop stop-color="#dbe5e0"/><stop offset=".2" stop-color="#4b6363"/><stop offset=".45" stop-color="#a6b3ae"/><stop offset=".62" stop-color="#34494c"/><stop offset=".82" stop-color="#aeb9b3"/><stop offset="1" stop-color="#4c5e5f"/></linearGradient>
<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".72" numOctaves="2" seed="4"/><feColorMatrix values=".55 0 0 0 .25 .55 0 0 0 .25 .55 0 0 0 .25 0 0 0 .12 0"/></filter></defs>
<rect width="512" height="512" fill="#142325"/>
<rect x="257" width="255" height="512" fill="url(#side)"/><rect x="257" width="255" height="512" filter="url(#grain)" opacity=".12"/>
<circle cx="128" cy="256" r="119" fill="url(#metal)"/><circle cx="128" cy="256" r="104" fill="url(#lid)" stroke="#dce8df" stroke-width="3"/>
<circle cx="128" cy="256" r="92" fill="none" stroke="#d9f7ea" stroke-opacity=".55" stroke-width="2"/>
<path d="M56 220 Q126 172 198 213" fill="none" stroke="#ffffff" stroke-opacity=".32" stroke-width="9" stroke-linecap="round"/>
<text x="128" y="253" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" font-weight="700" letter-spacing="2" fill="#f3ffec">MINTS</text>
<text x="128" y="279" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" letter-spacing="1.3" fill="#d1f6e9">PEPPERMINT · 40 PCS</text>
<path d="M93 299 Q128 312 163 299" fill="none" stroke="#d4ffef" stroke-opacity=".52" stroke-width="2"/>
</svg>`);
await sharp(svg).png().toFile(path.join(outputDirectory, "mint-tin.png"));
await writeFile(path.join(outputDirectory, "report.json"), JSON.stringify({
  frames: frameCount, duration: actorFrames.at(-1).time,
  room: { width: roomDepth.width, height: roomDepth.height },
  actor: { width: actorWidth, height: actorHeight, colorWidth, colorHeight, colorEncoding: "jpeg-94-444", alpha: "separate-lossless-png" },
  objectKeyframes: track.keyframes.length,
}, null, 2) + "\n");
console.log(`Standalone scene assets ready: ${frameCount} actor frames, ${track.keyframes.length} mint poses.`);
