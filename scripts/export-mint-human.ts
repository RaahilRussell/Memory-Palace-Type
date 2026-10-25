import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { BVHLoader } from "three/addons/loaders/BVHLoader.js";
import { deformHumanTemplate, parseHumanPoseTemplate } from "../src/scene/posed-template.js";
import type { HumanPoseRig } from "../src/scene/human-pose.js";

const [bvhPath, metadataPath, assetDirectory, outputPath] = process.argv.slice(2);
if (!bvhPath || !metadataPath || !assetDirectory || !outputPath)
  throw new Error("Usage: tsx scripts/export-mint-human.ts <motion.bvh> <reconstruction.json> <quest-assets> <human.mesh>");

const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const video = metadata.reconstruction.video;
const frameSpecs = video.actorFrames as { time: number; surfaceUrl?: string }[];
const scene = new DataView(await readFile(path.join(assetDirectory, "mint.scene")).then((b) =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
const actorWidth = scene.getUint32(12, true);
const actorHeight = scene.getUint32(16, true);
const verticalFov = scene.getFloat32(36, true) * Math.PI / 180;
const aspect = actorWidth / actorHeight;
const halfHeight = Math.tan(verticalFov / 2);
if (!actorWidth || !actorHeight || frameSpecs.length < 300)
  throw new Error("The reconstruction is missing its dense actor timeline.");

const actorStart = 10.0;
const actorEnd = 22.2;
const actorFrames = frameSpecs.filter((frame) => frame.time >= actorStart && frame.time <= actorEnd);
if (actorFrames.length < 350) throw new Error(`Expected the full 12-second actor segment; got ${actorFrames.length} frames.`);
const interval = actorFrames[1].time - actorFrames[0].time;
if (actorFrames.some((frame, i) => i > 0 && Math.abs((frame.time - actorFrames[i - 1].time) - interval) > 0.002))
  throw new Error("Actor frame timing must be uniform for the H3D2 Quest animation stream.");

const bvhText = await readFile(bvhPath, "utf8");
const { skeleton, clip } = new BVHLoader().parse(bvhText);
const animationRoot = new THREE.Group();
animationRoot.add(skeleton.bones[0]);
const mixer = new THREE.AnimationMixer(animationRoot);
mixer.clipAction(clip).play();
const boneByName = new Map(skeleton.bones.map((bone) => [bone.name, bone]));
const required = ["hips_JNT", "spine2_JNT", "head_JNT", "l_shoulder_JNT", "r_shoulder_JNT", "l_arm_JNT", "r_arm_JNT", "l_forearm_JNT", "r_forearm_JNT", "l_hand_JNT", "r_hand_JNT", "l_upleg_JNT", "r_upleg_JNT", "l_leg_JNT", "r_leg_JNT", "l_foot_JNT", "r_foot_JNT", "l_toebase_JNT", "r_toebase_JNT"];
for (const name of required) if (!boneByName.has(name)) throw new Error(`BVH is missing ${name}.`);
const boneWorld = new THREE.Vector3();
function bonePosition(name: string) {
  const bone = boneByName.get(name)!;
  bone.getWorldPosition(boneWorld);
  return boneWorld.clone().multiplyScalar(0.01);
}

const modelBytes = await readFile(path.resolve("public/models/human/average.glb"));
const modelBuffer = modelBytes.buffer.slice(modelBytes.byteOffset, modelBytes.byteOffset + modelBytes.byteLength);
const template = await parseHumanPoseTemplate(modelBuffer, "average");
const group = template.group;
const meshes: THREE.Mesh[] = [];
group.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh); });
const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.geometry.getAttribute("position").count, 0);
const indexCount = meshes.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count), 0);
const verticesPerFrame = vertexCount * 3;
const frameCount = actorFrames.length;
const colors = new Uint8Array(vertexCount * 3);
const indices = new Uint32Array(indexCount);
const framePositions = new Int16Array(frameCount * verticesPerFrame);
const frameNormals = new Int8Array(frameCount * verticesPerFrame);
const vertexIndexStart = new Map<THREE.Mesh, number>();
let vertexOffset = 0;
let indexOffset = 0;
const srgb = (linear: number) => linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
for (const mesh of meshes) {
  vertexIndexStart.set(mesh, vertexOffset);
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const color = geometry.getAttribute("color");
  if (!geometry.index || !color || !geometry.getAttribute("_pose_joints") || !geometry.getAttribute("_pose_weights"))
    throw new Error(`Human mesh ${mesh.name} does not have complete authored geometry and pose weights.`);
  for (let i = 0; i < position.count; i++) {
    const c = i * 3;
    colors[c] = Math.round(THREE.MathUtils.clamp(srgb(color.getX(i)), 0, 1) * 255);
    colors[c + 1] = Math.round(THREE.MathUtils.clamp(srgb(color.getY(i)), 0, 1) * 255);
    colors[c + 2] = Math.round(THREE.MathUtils.clamp(srgb(color.getZ(i)), 0, 1) * 255);
  }
  for (let i = 0; i < geometry.index.count; i++) indices[indexOffset++] = vertexOffset + geometry.index.getX(i);
  vertexOffset += position.count;
}
group.updateMatrixWorld(true);
const rigJoints = {} as HumanPoseRig["joints"];
const confidenceByJoint: Record<string, number> = {};
for (const name of ["hips", "shoulders", "head", "leftShoulder", "leftElbow", "leftWrist", "leftHip", "leftKnee", "leftAnkle", "leftHeel", "leftToe", "rightShoulder", "rightElbow", "rightWrist", "rightHip", "rightKnee", "rightAnkle", "rightHeel", "rightToe"] as const)
  confidenceByJoint[name] = 1;

const rgbPath = (index: number) => path.join(assetDirectory, "actor", "alpha", `${String(index).padStart(4, "0")}.png`);
const sourceAt = (name: string, fallback: string) => bonePosition(boneByName.has(name) ? name : fallback);
const defaultPose = {} as HumanPoseRig;
let poseCacheIndex = -1;
let cachedAlpha: { data: Uint8Array; width: number; height: number } | undefined;
for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
  const spec = actorFrames[frameIndex];
  const bvhTime = THREE.MathUtils.clamp(spec.time - actorStart, 0, clip.duration);
  mixer.setTime(bvhTime);
  animationRoot.updateMatrixWorld(true);
  group.updateMatrixWorld(true);

  const sourceIndex = frameSpecs.findIndex((candidate) => Math.abs(candidate.time - spec.time) < interval * 0.4);
  if (sourceIndex < 0) throw new Error(`No actor matte matches video time ${spec.time.toFixed(3)}s.`);
  if (sourceIndex !== poseCacheIndex) {
    const sharpModule = await import("sharp");
    const { data, info } = await sharpModule.default(await readFile(rgbPath(sourceIndex))).greyscale().raw().toBuffer({ resolveWithObject: true });
    cachedAlpha = { data, width: info.width, height: info.height };
    poseCacheIndex = sourceIndex;
  }
  const alpha = cachedAlpha!;
  let minX = alpha.width, maxX = -1, minY = alpha.height, maxY = -1, area = 0;
  for (let y = 0; y < alpha.height; y++) for (let x = 0; x < alpha.width; x++) {
    if (alpha.data[y * alpha.width + x] < 128) continue;
    area++;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (area < 18000 || maxX <= minX || maxY <= minY) {
    const offset = frameIndex * verticesPerFrame;
    for (let i = 0; i < verticesPerFrame; i += 3) {
      framePositions[offset + i] = 0;
      framePositions[offset + i + 1] = 0;
      framePositions[offset + i + 2] = 1000;
      frameNormals[offset + i] = 0;
      frameNormals[offset + i + 1] = 0;
      frameNormals[offset + i + 2] = 127;
    }
    continue;
  }
  const uCenter = (minX + maxX) / (2 * (alpha.width - 1));
  const bottomV = maxY / (alpha.height - 1);
  const heightFraction = (maxY - minY) / (alpha.height - 1);
  const depth = THREE.MathUtils.clamp(1.76 / (2 * halfHeight * heightFraction), 1.8, 5.5);
  const hipRatio = 0.9337 / 1.76;
  const hipX = (uCenter * 2 - 1) * halfHeight * aspect * depth;
  const floorY = (1 - bottomV * 2) * halfHeight * depth;
  const hipY = floorY + 1.76 * hipRatio;

  const hipBase = bonePosition("hips_JNT");
  const leftShoulder = sourceAt("r_arm_JNT", "r_shoulder_JNT");
  const rightShoulder = sourceAt("l_arm_JNT", "l_shoulder_JNT");
  const leftElbow = bonePosition("r_forearm_JNT"), rightElbow = bonePosition("l_forearm_JNT");
  const leftWrist = bonePosition("r_hand_JNT"), rightWrist = bonePosition("l_hand_JNT");
  const leftHip = bonePosition("r_upleg_JNT"), rightHip = bonePosition("l_upleg_JNT");
  const leftKnee = bonePosition("r_leg_JNT"), rightKnee = bonePosition("l_leg_JNT");
  const leftAnkle = bonePosition("r_foot_JNT"), rightAnkle = bonePosition("l_foot_JNT");
  const leftToe = bonePosition("r_toebase_JNT"), rightToe = bonePosition("l_toebase_JNT");
  const head = bonePosition("head_JNT");
  const shoulderCenter = bonePosition("spine2_JNT");

  // Normalize the BVH actor's body height against the photo silhouette at this
  // frame. Retain independent joint depth so arms and feet have real parallax.
  const bvhTop = bonePosition("head_JNT").y;
  const bvhBottom = Math.min(bonePosition("l_toebase_JNT").y, bonePosition("r_toebase_JNT").y);
  const bvhHeight = Math.max(1.2, Math.min(2.1, bvhTop - bvhBottom));
  const poseScale = 1.76 / bvhHeight;
  const anchor = new THREE.Vector3(hipX, hipY, -depth);
  const place = (point: THREE.Vector3) => anchor.clone().addScaledVector(point.sub(hipBase), poseScale);
  const position = (name: string) => place(bonePosition(name));
  rigJoints.hips = anchor;
  rigJoints.shoulders = place(shoulderCenter);
  rigJoints.head = position("head_JNT");
  rigJoints.leftShoulder = place(leftShoulder); rigJoints.leftElbow = place(leftElbow); rigJoints.leftWrist = place(leftWrist);
  rigJoints.leftHip = place(leftHip); rigJoints.leftKnee = place(leftKnee); rigJoints.leftAnkle = place(leftAnkle); rigJoints.leftToe = place(leftToe); rigJoints.leftHeel = rigJoints.leftAnkle.clone().add(new THREE.Vector3(0, -0.02, -0.10));
  rigJoints.rightShoulder = place(rightShoulder); rigJoints.rightElbow = place(rightElbow); rigJoints.rightWrist = place(rightWrist);
  rigJoints.rightHip = place(rightHip); rigJoints.rightKnee = place(rightKnee); rigJoints.rightAnkle = place(rightAnkle); rigJoints.rightToe = place(rightToe); rigJoints.rightHeel = rigJoints.rightAnkle.clone().add(new THREE.Vector3(0, -0.02, -0.10));
  Object.assign(rigJoints, {
    leftHandTip: rigJoints.leftWrist.clone().addScaledVector(rigJoints.leftWrist.clone().sub(rigJoints.leftElbow).normalize(), 0.11),
    rightHandTip: rigJoints.rightWrist.clone().addScaledVector(rigJoints.rightWrist.clone().sub(rigJoints.rightElbow).normalize(), 0.11),
  });
  for (const name of Object.keys(confidenceByJoint)) confidenceByJoint[name] = 1;
  const torsoQuaternion = boneByName.get("spine2_JNT")!.getWorldQuaternion(new THREE.Quaternion());
  defaultPose.joints = rigJoints;
  defaultPose.confidenceByJoint = confidenceByJoint;
  defaultPose.sourceLandmarkIndex = {};
  defaultPose.torsoQuaternion = torsoQuaternion;
  defaultPose.shoulderWidth = rigJoints.leftShoulder.distanceTo(rigJoints.rightShoulder);
  defaultPose.hipWidth = rigJoints.leftHip.distanceTo(rigJoints.rightHip);
  defaultPose.torsoLength = THREE.MathUtils.clamp(rigJoints.shoulders.distanceTo(rigJoints.hips), 0.36, 0.62);
  defaultPose.sourceAnchor = [uCenter, (minY + maxY) / (2 * (alpha.height - 1))];
  defaultPose.pixelsPerMeter = alpha.height / 1.76;
  defaultPose.sourceSize = { width: alpha.width, height: alpha.height };
  defaultPose.headRoll = 0;
  defaultPose.pose = { confidence: 1, landmarks: [] } as never;
  const { report } = deformHumanTemplate(group, defaultPose);
  if (report.vertices !== vertexCount) throw new Error(`Frame ${frameIndex}: human template deformation omitted vertices.`);
  const posedWorld = new Float32Array(verticesPerFrame);
  let outputVertex = 0;
  const frameOffset = frameIndex * verticesPerFrame;
  for (const mesh of meshes) {
    const positionAttribute = mesh.geometry.getAttribute("position");
    const normalAttribute = mesh.geometry.getAttribute("normal");
    const matrixWorld = mesh.matrixWorld;
    const point = new THREE.Vector3();
    for (let v = 0; v < positionAttribute.count; v++) {
      point.fromBufferAttribute(positionAttribute, v).applyMatrix4(matrixWorld);
      const component = outputVertex * 3;
      posedWorld[component] = point.x;
      posedWorld[component + 1] = point.y;
      posedWorld[component + 2] = point.z;
      outputVertex++;
    }
  }
  // Fit the posed human's camera projection to the observed alpha silhouette.
  // The motion capture supplies articulated joints; this final image-space
  // correction keeps the actual recorded outline and projected RGB aligned.
  let bodyMinU = Infinity, bodyMaxU = -Infinity, bodyMinV = Infinity, bodyMaxV = -Infinity;
  for (let i = 0; i < posedWorld.length; i += 3) {
    const depth = Math.max(-posedWorld[i + 2], 0.05);
    const u = 0.5 + posedWorld[i] / (2 * depth * halfHeight * aspect);
    const v = 0.5 - posedWorld[i + 1] / (2 * depth * halfHeight);
    bodyMinU = Math.min(bodyMinU, u); bodyMaxU = Math.max(bodyMaxU, u);
    bodyMinV = Math.min(bodyMinV, v); bodyMaxV = Math.max(bodyMaxV, v);
  }
  const targetMinU = minX / (alpha.width - 1), targetMaxU = maxX / (alpha.width - 1);
  const targetMinV = minY / (alpha.height - 1), targetMaxV = maxY / (alpha.height - 1);
  const bodyMidU = (bodyMinU + bodyMaxU) / 2, bodyMidV = (bodyMinV + bodyMaxV) / 2;
  const targetMidU = (targetMinU + targetMaxU) / 2, targetMidV = (targetMinV + targetMaxV) / 2;
  const fitU = (targetMaxU - targetMinU) / Math.max(bodyMaxU - bodyMinU, 1e-4);
  const fitV = (targetMaxV - targetMinV) / Math.max(bodyMaxV - bodyMinV, 1e-4);
  for (const mesh of meshes) {
    const positionAttribute = mesh.geometry.getAttribute("position");
    const normalAttribute = mesh.geometry.getAttribute("normal");
    const matrixWorld = mesh.matrixWorld;
    const point = new THREE.Vector3();
    for (let v = 0; v < positionAttribute.count; v++) {
      const component = (vertexIndexStart.get(mesh)! + v) * 3;
      let x = posedWorld[component], y = posedWorld[component + 1], z = posedWorld[component + 2];
      const depth = Math.max(-z, 0.05);
      const u = 0.5 + x / (2 * depth * halfHeight * aspect);
      const imageV = 0.5 - y / (2 * depth * halfHeight);
      const fittedU = targetMidU + (u - bodyMidU) * fitU;
      const fittedV = targetMidV + (imageV - bodyMidV) * fitV;
      x = (fittedU - 0.5) * (2 * depth * halfHeight * aspect);
      y = (0.5 - fittedV) * (2 * depth * halfHeight);
      const frameComponent = frameOffset + component;
      framePositions[frameComponent] = Math.round(THREE.MathUtils.clamp(x, -32.7, 32.7) * 1000);
      framePositions[frameComponent + 1] = Math.round(THREE.MathUtils.clamp(y, -32.7, 32.7) * 1000);
      framePositions[frameComponent + 2] = Math.round(THREE.MathUtils.clamp(z, -32.7, 32.7) * 1000);
      point.fromBufferAttribute(normalAttribute, v).transformDirection(matrixWorld);
      frameNormals[frameComponent] = Math.round(THREE.MathUtils.clamp(point.x, -1, 1) * 127);
      frameNormals[frameComponent + 1] = Math.round(THREE.MathUtils.clamp(point.y, -1, 1) * 127);
      frameNormals[frameComponent + 2] = Math.round(THREE.MathUtils.clamp(point.z, -1, 1) * 127);
    }
  }
  if ((frameIndex + 1) % 30 === 0 || frameIndex + 1 === frameCount)
    console.log(`Baked articulated body ${frameIndex + 1}/${frameCount} at video ${spec.time.toFixed(2)}s.`);
}

const header = Buffer.alloc(36);
  header.write("H3D2", 0, "ascii");
header.writeUInt32LE(vertexCount, 4);
header.writeUInt32LE(indexCount, 8);
header.writeUInt32LE(frameCount, 12);
header.writeUInt32LE(30, 16);
header.writeFloatLE(interval, 20);
header.writeFloatLE(actorFrames[0].time, 24);
header.writeUInt32LE(1000, 28);
  header.writeUInt32LE(127, 32);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, Buffer.concat([header, colors, Buffer.from(indices.buffer), Buffer.from(framePositions.buffer), Buffer.from(frameNormals.buffer)]));
console.log(`H3D2: ${vertexCount} vertices, ${indexCount / 3} triangles, ${frameCount} smooth-normal poses (${clip.duration.toFixed(2)}s BVH), ${outputPath}`);
