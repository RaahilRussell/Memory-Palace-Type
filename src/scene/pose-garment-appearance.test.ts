import test from "node:test";
import assert from "node:assert/strict";
import { refinePoseGarmentAppearance, type HumanAppearance } from "./human-appearance";
import { HUMAN_POSE_LANDMARK_NAMES, type HumanPose } from "../types";
import type { VolumePixels } from "./volume";

const pixels = (sample: (u: number, v: number) => number[]): VolumePixels => ({
  width: 200, height: 200,
  data: Uint8Array.from(Array.from({ length: 40000 }, (_, i) => [...sample((i % 200) / 200, Math.floor(i / 200) / 200), 255]).flat()),
});
const fullMask = pixels(() => [255, 255, 255]);
const previous: HumanAppearance = { shirtColor: "#020202", pantsColor: "#020204", skinColor: "#a17b63", hairColor: "#121212", shoeColor: "#202020" };
const seatedPose = (): HumanPose => ({
  version: 1, source: "mediapipe-pose", model: "pose-landmarker-heavy", confidence: .97, observedFraction: 1,
  sourceBox: [.1, .1, .95, .9],
  landmarks: HUMAN_POSE_LANDMARK_NAMES.map((name, index) => ({
    name, image: (index === 11 ? [.28, .2, 0] : index === 12 ? [.72, .2, 0] :
      index === 23 ? [.35, .62, 0] : index === 24 ? [.65, .62, 0] : [.5, .9, 0]) as [number, number, number],
    world: [0, 0, 0], visibility: [11, 12, 23, 24].includes(index) ? .99 : .1, presence: .99,
  })),
});

test("a seated tan coat is sampled above crossed black trousers without altering pose or mask", () => {
  const pose = seatedPose(), original = structuredClone(pose), maskBefore = Array.from(fullMask.data);
  const source = pixels((_u, v) => v < .62 ? [143, 106, 61] : [2, 2, 4]);
  const result = refinePoseGarmentAppearance(previous, pose, source, fullMask);
  assert.equal(result.shirtColor, "#8f6a3d");
  assert.equal(result.pantsColor, previous.pantsColor);
  assert.ok(result.chestBox![2] < .62);
  assert.equal(result.garmentSampling?.status, "measured");
  assert.ok(result.garmentSampling!.sampleCount > 500);
  assert.deepEqual(pose, original);
  assert.deepEqual(Array.from(fullMask.data), maskBefore);
  assert.equal(previous.shirtColor, "#020202");
});

test("a classified held object cannot become the coat's fallback palette", () => {
  const held = (u: number, v: number) => u > .385 && u < .615 && v > .28 && v < .51;
  const source = pixels((u, v) => held(u, v) ? [240, 20, 30] : [143, 106, 61]);
  const objectMask = pixels((u, v) => held(u, v) ? [255, 255, 255] : [0, 0, 0]);
  const untreated = refinePoseGarmentAppearance(previous, seatedPose(), source, fullMask);
  const excluded = refinePoseGarmentAppearance(previous, seatedPose(), source, fullMask, [objectMask]);
  assert.equal(untreated.shirtColor, "#f0141e", "fixture object occupies most unfiltered garment samples");
  assert.equal(excluded.shirtColor, "#8f6a3d");
  assert.ok(excluded.garmentSampling!.excludedSamples > 500);
});

test("observed hands and forearms are excluded independently of object detection", () => {
  const pose = seatedPose();
  for (const [index, point] of [[13, [.32, .36, 0]], [15, [.55, .4, 0]]] as const) {
    pose.landmarks[index].image = [...point]; pose.landmarks[index].visibility = .98;
  }
  const result = refinePoseGarmentAppearance(previous, pose, pixels(() => [143, 106, 61]), fullMask);
  assert.equal(result.shirtColor, "#8f6a3d");
  assert.ok(result.garmentSampling!.excludedSamples > 60);
  assert.ok(result.garmentSampling!.sampleCount < result.garmentSampling!.maskSamples);
});

test("dark clothing remains dark instead of being brightened to repair a missing mask", () => {
  const result = refinePoseGarmentAppearance(previous, seatedPose(), pixels((_u, v) => v < .62 ? [12, 14, 15] : [190, 190, 190]), fullMask);
  assert.equal(result.shirtColor, "#0c0e0f");
});

test("monochrome appearance retains grayscale after pose-anchored sampling", () => {
  const mono = { ...previous, skinColor: "#999999", hairColor: "#111111", pantsColor: "#222222" };
  const result = refinePoseGarmentAppearance(mono, seatedPose(), pixels(() => [123, 120, 122]), fullMask);
  assert.equal(result.shirtColor.slice(1, 3), result.shirtColor.slice(3, 5));
  assert.equal(result.shirtColor.slice(3, 5), result.shirtColor.slice(5, 7));
});

test("occluded hips do not define a garment polygon or claim measured sampling", () => {
  const pose = seatedPose(); pose.landmarks[23].visibility = .2;
  const result = refinePoseGarmentAppearance(previous, pose, pixels(() => [143, 106, 61]), fullMask);
  assert.equal(result.shirtColor, previous.shirtColor);
  assert.equal(result.garmentSampling?.status, "insufficient-support");
  assert.equal(result.garmentSampling?.sampleCount, 0);
});

test("sparse mask support retains fallback appearance with an explicit sampling failure", () => {
  const mask = pixels((u, v) => u > .49 && u < .51 && v > .35 && v < .37 ? [255, 255, 255] : [0, 0, 0]);
  const result = refinePoseGarmentAppearance(previous, seatedPose(), pixels(() => [143, 106, 61]), mask);
  assert.equal(result.shirtColor, previous.shirtColor);
  assert.equal(result.garmentSampling?.status, "insufficient-support");
  assert.ok(result.garmentSampling!.sampleCount < 32);
});
