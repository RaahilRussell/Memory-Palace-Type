import { execFile } from 'node:child_process';
import { access, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isHumanPose } from '../src/human-pose-validation.js';
import type { HumanPose, WorldCompletion } from '../src/types.js';

const runFile = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const POSE_CACHE_VERSION = 'pose-person-crops-v3';
export type PoseModelVariant = 'full' | 'heavy';
export type PoseDetection = { pose: HumanPose; maskUrl: string };
export type PoseEstimator = (request: { sourcePath: string; outputPrefix: string; subjects: WorldCompletion['subjects'] }) => Promise<PoseDetection[]>;

async function pythonExecutable(configured?: string) {
  if (configured) return configured;
  for (const candidate of [
    path.join(ROOT, '.venv-pose', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    path.join(ROOT, '.local/triposr-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  ]) {
    try { await access(candidate); return candidate; } catch { /* Try the next explicitly local runtime. */ }
  }
  throw new Error('Local pose runtime is unavailable. Configure POSE_PYTHON_PATH and run scripts/pose-fitting/fetch_model.py.');
}

/** Single bounded subprocess; no shell interpolation, remote code, or paid model calls. */
export function localPoseEstimator(modelDirectory: string, options: { pythonPath?: string; variant?: PoseModelVariant } = {}): PoseEstimator {
  let queue: Promise<unknown> = Promise.resolve();
  return request => {
    const run = async () => {
      const variant = options.variant || 'heavy';
      const model = `pose-landmarker-${variant}`;
      const output = `${request.outputPrefix}-${POSE_CACHE_VERSION}-${variant}.json`;
      const expectedMask = new RegExp(`^${path.basename(request.outputPrefix)}-${POSE_CACHE_VERSION}-${variant}-mask-\\d{1,2}\\.png$`);
      const validate = async () => {
        if ((await stat(output)).size > 1_024_000) throw new Error('Pose output exceeds its bound.');
        const result = JSON.parse(await readFile(output, 'utf8'));
        if (result.version !== 1 || result.model !== model || !Array.isArray(result.poses) || result.poses.length > 24) throw new Error('Invalid pose output.');
        const detections: PoseDetection[] = [];
        for (const item of result.poses) {
          if (!isHumanPose(item.pose) || item.pose.model !== model || typeof item.maskFile !== 'string' || !expectedMask.test(item.maskFile)) throw new Error('Invalid pose or mask metadata.');
          const maskPath = path.join(path.dirname(output), item.maskFile);
          if ((await stat(maskPath)).size > 2_000_000) throw new Error('Pose mask exceeds its bound.');
          detections.push({ pose: item.pose, maskUrl: `/uploads/reconstructions/${item.maskFile}` });
        }
        return detections;
      };
      try { return await validate(); } catch { /* Missing or invalid cache can be recomputed locally. */ }
      const executable = await pythonExecutable(options.pythonPath || process.env.POSE_PYTHON_PATH);
      const modelPath = path.join(modelDirectory, `pose_landmarker_${variant}.task`);
      await access(modelPath);
      const proposals = `${request.outputPrefix}-pose-proposals.json`;
      await writeFile(proposals, JSON.stringify(request.subjects.filter(subject => subject.kind === 'person').map(subject => subject.box)));
      await runFile(executable, [path.join(ROOT, 'scripts/pose-fitting/extract_poses.py'), '--image', request.sourcePath,
        '--model', modelPath, '--variant', variant, '--output', output, '--subjects', proposals],
      { cwd: ROOT, windowsHide: true, timeout: 90_000, maxBuffer: 256_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      return validate();
    };
    const task = queue.catch(() => {}).then(run); queue = task; return task;
  };
}

type Mask = { data: Uint8Array; width: number; height: number };
export type PoseMatchCandidate = { subject: number; detection: number; score: number };

/** Maximum-cardinality, maximum-score assignment. Greedy matching can give a
 * flexible pose to the only subject that another pose could have matched,
 * leaving a clearly observed person unposed in overlapping groups. */
export function matchPoseCandidates(candidates: PoseMatchCandidate[]): PoseMatchCandidate[] {
  if (!candidates.length) return [];
  const subjects = [...new Set(candidates.map(item => item.subject))].sort((a, b) => a - b);
  const detections = [...new Set(candidates.map(item => item.detection))].sort((a, b) => a - b);
  const source = 0, sink = subjects.length + detections.length + 1;
  type Edge = { to: number; reverse: number; capacity: number; cost: number; candidate?: PoseMatchCandidate };
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const connect = (from: number, to: number, cost: number, candidate?: PoseMatchCandidate) => {
    const forward: Edge = { to, reverse: graph[to].length, capacity: 1, cost, candidate };
    const reverse: Edge = { to: from, reverse: graph[from].length, capacity: 0, cost: -cost };
    graph[from].push(forward); graph[to].push(reverse);
  };
  subjects.forEach((_, i) => connect(source, 1 + i, 0));
  detections.forEach((_, i) => connect(1 + subjects.length + i, sink, 0));
  for (const candidate of candidates) connect(1 + subjects.indexOf(candidate.subject),
    1 + subjects.length + detections.indexOf(candidate.detection), -candidate.score, candidate);
  while (true) {
    const distance = Array(graph.length).fill(Infinity) as number[];
    const predecessor: ([number, number] | undefined)[] = Array(graph.length);
    distance[source] = 0;
    for (let pass = 0; pass < graph.length - 1; pass++) {
      let changed = false;
      graph.forEach((edges, from) => edges.forEach((edge, index) => {
        if (edge.capacity && distance[from] + edge.cost < distance[edge.to] - 1e-9) {
          distance[edge.to] = distance[from] + edge.cost;
          predecessor[edge.to] = [from, index]; changed = true;
        }
      }));
      if (!changed) break;
    }
    if (!predecessor[sink]) break;
    for (let node = sink; node !== source;) {
      const [from, index] = predecessor[node]!;
      const edge = graph[from][index]; edge.capacity = 0;
      graph[node][edge.reverse].capacity = 1; node = from;
    }
  }
  return graph.flatMap(edges => edges.flatMap(edge => edge.candidate && edge.capacity === 0 ? [edge.candidate] : []))
    .sort((a, b) => a.subject - b.subject);
}
/** A joint inside a neighbour's silhouette is not observed evidence for this body.
 * Keep the inferred coordinates, but lower visibility when the owner's mask does
 * not support the image point. Presence remains the model's original confidence.
 */
export function constrainPoseToMask(pose: HumanPose, mask: Mask): HumanPose {
  const radius = Math.max(2, Math.min(7, Math.round((pose.sourceBox[2] - pose.sourceBox[0]) * mask.height * .012)));
  const landmarks = pose.landmarks.map(joint => {
    const px = Math.floor(joint.image[0] * mask.width), py = Math.floor(joint.image[1] * mask.height);
    let supported = false;
    if (px >= 0 && px < mask.width && py >= 0 && py < mask.height) {
      for (let y = Math.max(0, py - radius); y <= Math.min(mask.height - 1, py + radius) && !supported; y++) {
        for (let x = Math.max(0, px - radius); x <= Math.min(mask.width - 1, px + radius); x++) {
          if (mask.data[y * mask.width + x] >= 128) { supported = true; break; }
        }
      }
    }
    return supported ? joint : { ...joint, visibility: Math.min(joint.visibility, .2) };
  });
  return { ...pose, landmarks, observedFraction: landmarks.filter(joint => Math.min(joint.visibility, joint.presence) >= .5).length / 33 };
}

function boxOverlap(a: HumanPose['sourceBox'], b: HumanPose['sourceBox']) {
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (box: HumanPose['sourceBox']) => (box[2] - box[0]) * (box[3] - box[1]);
  return intersection / Math.max(1e-9, area(a) + area(b) - intersection);
}

/** Matching prioritizes observed head/shoulder pixels. A partial silhouette can
 * also match from three reliable torso anchors and a close source box; otherwise
 * a missing head mask turns the same observed person into an extra subject. */
export function associatePoses(subjects: WorldCompletion['subjects'], detections: PoseDetection[], masks: Map<string, Mask> = new Map()) {
  const candidates: PoseMatchCandidate[] = [];
  subjects.forEach((subject, subjectIndex) => {
    if (subject.kind !== 'person') return;
    const [top, left, bottom, right] = subject.box;
    detections.forEach(({ pose }, detectionIndex) => {
      const head = pose.landmarks[0];
      const headObserved = Math.min(head.visibility, head.presence) >= .5 && head.image[0] >= 0 && head.image[0] <= 1 && head.image[1] >= 0 && head.image[1] <= 1;
      const anchors = headObserved ? [head] : [pose.landmarks[11], pose.landmarks[12]].filter(joint => Math.min(joint.visibility, joint.presence) >= .45);
      if (!anchors.length) return;
      const anchorX = anchors.reduce((sum, joint) => sum + joint.image[0], 0) / anchors.length;
      const anchorY = anchors.reduce((sum, joint) => sum + joint.image[1], 0) / anchors.length;
      if (anchorX < left || anchorX > right || anchorY < top || anchorY > bottom) return;
      let score = 0, weight = 0;
      const mask = masks.get(subject.id);
      for (const index of [0, 2, 5, 7, 8, 11, 12]) {
        const joint = pose.landmarks[index], confidence = Math.min(joint.visibility, joint.presence);
        if (confidence < .45) continue;
        const [x, y] = joint.image;
        const inside = x >= left && x <= right && y >= top && y <= bottom;
        const actual = mask && x >= 0 && x < 1 && y >= 0 && y < 1 ? mask.data[Math.floor(y * mask.height) * mask.width + Math.floor(x * mask.width)] / 255 : inside ? 1 : 0;
        const importance = index < 11 ? 2 : 1;
        score += confidence * actual * importance; weight += confidence * importance;
      }
      let support = weight ? score / weight : 0;
      if (support < .42) {
        if (!mask || pose.confidence < .65) return;
        const overlap = boxOverlap(pose.sourceBox, subject.box);
        if (overlap < .55) return;
        const supportedTorso = [11, 12, 23, 24].filter(index => {
          const joint = pose.landmarks[index], [x, y] = joint.image;
          return Math.min(joint.visibility, joint.presence) >= .6 && x >= 0 && x < 1 && y >= 0 && y < 1
            && mask.data[Math.floor(y * mask.height) * mask.width + Math.floor(x * mask.width)] >= 128;
        });
        if (supportedTorso.length < 3) return;
        // Prefer direct head evidence whenever competing candidates support it.
        support = .42 + overlap * .12;
      }
      candidates.push({ subject: subjectIndex, detection: detectionIndex, score: support + pose.confidence * .12 });
    });
  });
  const matches = matchPoseCandidates(candidates);
  const detectionIndices = new Set(matches.map(match => match.detection));
  return { matches, unmatched: detections.map((_, i) => i).filter(i => !detectionIndices.has(i)) };
}
