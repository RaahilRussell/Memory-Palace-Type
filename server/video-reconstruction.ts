import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ReconstructionSpec } from "../src/types.js";
import { HttpError } from "./http.js";

const runFile = promisify(execFile);
export const VIDEO_CACHE_VERSION = "video-depth-sequence-v2-dense-actors";
/** Dense actors are optional for recordings beyond the per-frame work budget. */
export class DenseVideoFrameLimitError extends HttpError {
  constructor() { super(422, "Dense actor reconstruction supports up to 2,000 decoded frames."); }
}
export type VideoSampler = {
  duration(file: string): Promise<number>;
  frame(file: string, time: number): Promise<Buffer>;
  forEachFrame?(file: string, visit: (frame: { time: number; width: number; height: number; rgb: Buffer }) => Promise<void>, maxDimension?: number): Promise<number>;
};

/** Foreground cue for a locked camera. The source plate is an observed empty
 * room frame, so changed pixels reveal moving actors without semantic-label
 * drift onto floors or furniture. */
export function fixedCameraDifferenceMask(
  current: Uint8Array,
  plate: Uint8Array,
  width: number,
  height: number,
  threshold = 18,
) {
  if (
    !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    current.length !== width * height * 3 || plate.length !== current.length ||
    !Number.isFinite(threshold) || threshold < 0 || threshold > 255
  ) throw new Error("Fixed-camera RGB frames must match and use a valid threshold.");
  const rowOffsets = new Int16Array(height * 3);
  const edgeBand = Math.max(1, Math.floor(width * 0.15));
  for (let y = 0; y < height; y++) {
    const deltas: [number[], number[], number[]] = [[], [], []];
    for (let x = 0; x < width; x++) {
      if (x >= edgeBand && x < width - edgeBand) continue;
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++)
        deltas[channel].push(current[offset + channel] - plate[offset + channel]);
    }
    for (let channel = 0; channel < 3; channel++) {
      deltas[channel].sort((a, b) => a - b);
      const middle = Math.floor(deltas[channel].length / 2);
      rowOffsets[y * 3 + channel] = deltas[channel][middle] ?? 0;
    }
  }
  const mask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const offset = pixel * 3;
    const rowOffset = Math.floor(pixel / width) * 3;
    if (
      Math.max(
        Math.abs(current[offset] - plate[offset] - rowOffsets[rowOffset]),
        Math.abs(current[offset + 1] - plate[offset + 1] - rowOffsets[rowOffset + 1]),
        Math.abs(current[offset + 2] - plate[offset + 2] - rowOffsets[rowOffset + 2]),
      ) >= threshold
    ) mask[pixel] = 255;
  }
  // A 3x3 closing removes tiny compression holes along dark clothing while
  // preserving a tight silhouette at the 144x256 actor-surface resolution.
  const dilated = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    for (let dy = -1; dy <= 1 && !dilated[i]; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < width && yy >= 0 && yy < height && mask[yy * width + xx]) {
        dilated[i] = 255;
        break;
      }
    }
  }
  const closed = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let keep = true;
    for (let dy = -1; dy <= 1 && keep; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= width || yy < 0 || yy >= height || !dilated[yy * width + xx]) {
        keep = false;
        break;
      }
    }
    if (keep) closed[y * width + x] = 255;
  }
  const exterior = new Uint8Array(closed.length);
  const queue = new Int32Array(closed.length);
  let head = 0, tail = 0;
  const enqueue = (pixel: number) => {
    if (!closed[pixel] && !exterior[pixel]) {
      exterior[pixel] = 1;
      queue[tail++] = pixel;
    }
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
    if (x) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (y) enqueue(pixel - width);
    if (y + 1 < height) enqueue(pixel + width);
  }
  for (let pixel = 0; pixel < closed.length; pixel++)
    if (!closed[pixel] && !exterior[pixel]) closed[pixel] = 255;
  return closed;
}

/** Use the high-contrast core of a person to trim exposure and floor noise
 * from the softer full silhouette. The box expands down to include dark legs. */
export function fixedCameraActorMask(current: Uint8Array, plate: Uint8Array, width: number, height: number) {
  const full = fixedCameraDifferenceMask(current, plate, width, height, 12);
  let fullArea = 0;
  for (const pixel of full) if (pixel) fullArea++;
  if (fullArea <= full.length * 0.015) return full;
  const strong = fixedCameraDifferenceMask(current, plate, width, height, 45);
  const seen = new Uint8Array(strong.length);
  let best: { area: number; left: number; right: number; top: number; bottom: number } | undefined;
  for (let start = 0; start < strong.length; start++) {
    if (!strong[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    let left = width, right = -1, top = height, bottom = -1;
    for (let head = 0; head < queue.length; head++) {
      const pixel = queue[head], x = pixel % width, y = Math.floor(pixel / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const neighbor of [x ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1, y ? pixel - width : -1, y + 1 < height ? pixel + width : -1])
        if (neighbor >= 0 && strong[neighbor] && !seen[neighbor]) { seen[neighbor] = 1; queue.push(neighbor); }
    }
    const touchesFrame = left === 0 || right === width - 1 || top === 0 || bottom === height - 1;
    const area = queue.length;
    if (touchesFrame || area < Math.max(12, strong.length * 0.002) || area > strong.length * 0.2) continue;
    if (!best || area > best.area) best = { area, left, right, top, bottom };
  }
  if (!best) return full;
  const boxWidth = best.right - best.left + 1;
  const boxHeight = best.bottom - best.top + 1;
  const left = Math.max(0, best.left - Math.max(8, Math.ceil(boxWidth * 0.1)));
  const right = Math.min(width - 1, best.right + Math.max(8, Math.ceil(boxWidth * 0.1)));
  // Preserve low-contrast hair and head pixels above the high-contrast torso.
  // A very tight expansion made stationary-camera actors look decapitated
  // when dark hair blended into a dark clean plate.
  const top = Math.max(0, best.top - Math.ceil(boxHeight * 0.12));
  const bottom = Math.min(height - 1, best.bottom + Math.ceil(boxHeight));
  const silhouette = fullArea > full.length * 0.3
    ? fixedCameraDifferenceMask(current, plate, width, height, 30)
    : full;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    if (x < left || x > right || y < top || y > bottom) silhouette[y * width + x] = 0;
  const lowerCenter = (best.left + best.right) / 2 + width * 0.05;
  const lowerHalfWidth = Math.max(8, Math.floor(width * 0.18));
  for (let y = Math.floor(height * 0.64); y < height; y++)
    for (let x = 0; x < width; x++)
      if (x < lowerCenter - lowerHalfWidth || x > lowerCenter + lowerHalfWidth)
        silhouette[y * width + x] = 0;
  return silhouette;
}

/** Uniform samples include the end of the clip, not only its first few seconds. */
export function videoSampleTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600)
    throw new HttpError(
      422,
      "Use a video between a fraction of a second and one hour long.",
    );
  const count = Math.min(8, Math.max(2, Math.ceil(duration / 2) + 1));
  const end = Math.max(duration * 0.9, duration - 0.2);
  return Array.from({ length: count }, (_, i) => (end * i) / (count - 1));
}

/** Audio tails must not schedule depth extraction after the last video frame. */
export function videoStreamDuration(probe: {
  streams?: { duration?: unknown }[];
  format?: { duration?: unknown };
}) {
  const stream = Number(probe.streams?.[0]?.duration);
  const duration =
    Number.isFinite(stream) && stream > 0
      ? stream
      : Number(probe.format?.duration);
  videoSampleTimes(duration);
  return duration;
}

/** Local files only; execFile never invokes a shell and FFmpeg cannot fetch remote streams. */
export const ffmpegVideoSampler: VideoSampler = {
  async duration(file) {
    try {
      const { stdout } = await runFile(
        process.env.FFPROBE_PATH || "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=duration:format=duration",
          "-of",
          "json",
          file,
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 },
      );
      return videoStreamDuration(JSON.parse(stdout));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        422,
        "Video immersion needs ffmpeg and ffprobe on the server. Install them (or set FFMPEG_PATH and FFPROBE_PATH), then retry this video.",
      );
    }
  },
  async frame(file, time) {
    try {
      const { stdout } = await runFile(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-ss",
          time.toFixed(6),
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          "scale=512:512:force_original_aspect_ratio=decrease",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ],
        {
          encoding: "buffer",
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 3 * 1024 * 1024,
        },
      );
      if (!stdout.length) throw new Error("No decoded frame");
      return stdout;
    } catch {
      throw new HttpError(
        422,
        "A video frame could not be decoded. Install ffmpeg on the server and use a playable MP4, WebM, or MOV video.",
      );
    }
  },
  async forEachFrame(file, visit, maxDimension = 512) {
    let probe: { streams?: { width?: number; height?: number }[]; frames?: { best_effort_timestamp_time?: string }[] };
    try {
      const { stdout } = await runFile(process.env.FFPROBE_PATH || "ffprobe", [
        "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:frame=best_effort_timestamp_time", "-show_frames", "-of", "json", file,
      ], { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      probe = JSON.parse(stdout);
    } catch {
      throw new HttpError(422, "The video frame timeline could not be read. Re-export it as a playable MP4, WebM, or MOV.");
    }
    const inputWidth = Number(probe.streams?.[0]?.width);
    const inputHeight = Number(probe.streams?.[0]?.height);
    const times = (probe.frames ?? []).map((frame) => Number(frame.best_effort_timestamp_time));
    if (!Number.isInteger(inputWidth) || !Number.isInteger(inputHeight) || inputWidth < 16 || inputHeight < 16 || times.length < 2 || times.some((time, index) => !Number.isFinite(time) || time < 0 || (index > 0 && time <= times[index - 1])))
      throw new HttpError(422, "Dense actor reconstruction requires a valid timeline with at least two decoded frames.");
    if (times.length > 2000) throw new DenseVideoFrameLimitError();
    if (!Number.isInteger(maxDimension) || maxDimension < 16 || maxDimension > 2048)
      throw new HttpError(400, "The decoded video frame limit must be between 16 and 2,048 pixels.");
    const scale = Math.min(1, maxDimension / Math.max(inputWidth, inputHeight));
    const width = Math.max(16, Math.floor(inputWidth * scale / 2) * 2);
    const height = Math.max(16, Math.floor(inputHeight * scale / 2) * 2);
    const frameBytes = width * height * 3;
    const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
      "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", file,
      "-map", "0:v:0", "-vsync", "0", "-vf", `scale=${width}:${height}:flags=lanczos`,
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    let count = 0;
    try {
      let parts: Buffer[] = [];
      let pending = 0;
      for await (const chunk of child.stdout) {
        let offset = 0;
        while (offset < chunk.length) {
          const take = Math.min(frameBytes - pending, chunk.length - offset);
          parts.push(chunk.subarray(offset, offset + take));
          pending += take;
          offset += take;
          if (pending === frameBytes) {
            if (count >= times.length) throw new Error("FFmpeg decoded more frames than ffprobe reported.");
            await visit({ time: times[count], width, height, rgb: Buffer.concat(parts, frameBytes) });
            count++;
            parts = [];
            pending = 0;
          }
        }
      }
      const exitCode = await finished;
      if (exitCode !== 0 || pending !== 0 || count !== times.length)
        throw new Error(`Decoded ${count}/${times.length} video frames. ${stderr}`);
      return count;
    } catch (error) {
      child.kill();
      await finished.catch(() => null);
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, "Every source frame could not be decoded for actor reconstruction. Check that ffmpeg can read this video, then retry.");
    }
  },
};

/** Each bounded keyframe gets semantic recognition. Video objects remain fixed during playback. */
export async function completeVideoReconstruction(
  reconstruction: ReconstructionSpec,
  complete: (frame: ReconstructionSpec) => Promise<ReconstructionSpec>,
): Promise<ReconstructionSpec> {
  if (!reconstruction.video) return complete(reconstruction);
  const { video, ...base } = reconstruction;
  const frames = [];
  for (const frame of video.frames) {
    const completed = await complete({
      ...base,
      sourceUrl: frame.sourceUrl,
      depthUrl: frame.depthUrl,
      completionUrl: frame.completionUrl,
      mediaBasis: "video-frame",
    });
    frames.push({
      ...frame,
      ...(completed.completionUrl
        ? { completionUrl: completed.completionUrl }
        : {}),
    });
  }
  return {
    ...reconstruction,
    completionUrl: frames[0].completionUrl,
    video: { ...video, frames },
  };
}
