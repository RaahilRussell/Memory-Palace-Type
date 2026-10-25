import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { orthographicPhotoProjection, projectionConfidence, rasterizePhotoVisibility,
  registerTurnaroundSilhouette, turnaroundForeground, overlayPhotographsOnVertexColors,
  sampleValidPhotograph } from "./texture-projection";
import type { VolumePixels } from "./volume";

const camera = orthographicPhotoProjection({ left: -1, right: 1, bottom: -1, top: 1 });

const gridPixels = (width: number, height: number, at: (x: number, y: number) => number[]) => ({
  width, height, data: new Uint8Array(Array.from({ length: width * height }, (_, i) => at(i % width, Math.floor(i / width))).flat()),
});

test("photo sampler fails closed for malformed dimensions and incomplete source or mask buffers", () => {
  const image = gridPixels(2, 2, () => [10, 20, 30, 255]);
  const mask = gridPixels(2, 2, () => [255, 255, 255, 255]);
  for (const dimensions of [
    { width: 0, height: 2 }, { width: -1, height: 2 }, { width: 1.5, height: 2 },
    { width: 2, height: 1.5 }, { width: NaN, height: 2 }, { width: 2, height: Infinity },
    { width: Number.MAX_SAFE_INTEGER, height: 2 },
  ]) {
    assert.equal(sampleValidPhotograph({ ...image, ...dimensions }, mask, 0, 0), undefined);
    assert.equal(sampleValidPhotograph(image, { ...mask, ...dimensions }, 0, 0), undefined);
  }
  assert.equal(sampleValidPhotograph({ ...image, data: Array.from(image.data).slice(0, -1) }, mask, 0, 0), undefined,
    "even an intact requested pixel cannot authorize a truncated source image");
  assert.equal(sampleValidPhotograph(image, { ...mask, data: Array.from(mask.data).slice(0, -1) }, 0, 0), undefined);
  assert.equal(sampleValidPhotograph({ ...image, data: { 0: 10, 1: 20, 2: 30, 3: 255, length: Infinity } }, mask, 0, 0), undefined);
});

test("photo sampler rejects non-finite or out-of-range contributing RGBA without claiming original vertices", () => {
  const image = gridPixels(2, 2, () => [10, 20, 30, 255]);
  const mask = gridPixels(2, 2, () => [255, 255, 255, 255]);
  for (const invalid of [NaN, Infinity, -Infinity, -1, 256]) for (let channel = 0; channel < 4; channel++) {
    const corruptSource = { ...image, data: Array.from(image.data) };
    const corruptMask = { ...mask, data: Array.from(mask.data) };
    corruptSource.data[12 + channel] = invalid;
    corruptMask.data[12 + channel] = invalid;
    assert.equal(sampleValidPhotograph(corruptSource, mask, 0.25, 0.25), undefined);
    assert.equal(sampleValidPhotograph(corruptSource, mask, 1, 1, "nearest"), undefined);
    assert.equal(sampleValidPhotograph(image, corruptMask, 0.25, 0.25), undefined);
    assert.deepEqual(sampleValidPhotograph(corruptSource, mask, 0, 0), [10, 20, 30],
      "unread corrupt neighbours do not invalidate a finite exact sample");
  }
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const group = new THREE.Group(); group.add(new THREE.Mesh(geometry, material));
  const corruptSource = { ...image, data: Array.from(image.data, (value, i) => i % 4 === 0 ? NaN : value) };
  const result = overlayPhotographsOnVertexColors(group, [{ image: corruptSource, mask, camera }]);
  assert.equal(result.updatedVertices, 0);
  assert.equal(result.originalPhotoVertices, 0);
  assert.ok(Array.from(geometry.getAttribute("color").array).every(Number.isFinite));
  geometry.dispose(); material.dispose();
});

test("photo interpolation rejects an invalid diagonal neighbour instead of averaging mask validity", () => {
  const image = gridPixels(8, 8, (x, y) => x === 4 && y === 4 ? [255, 0, 0, 255] : [0, 180, 60, 255]);
  const mask = gridPixels(8, 8, (x, y) => x === 4 && y === 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  const before = image.data.slice();
  assert.equal(sampleValidPhotograph(image, mask, 3.25 / 7, 3.25 / 7), undefined);
  assert.deepEqual(sampleValidPhotograph(image, mask, 3 / 7, 3 / 7), [0, 180, 60],
    "zero-weight invalid neighbours cannot erase an exact valid sample");
  assert.deepEqual(sampleValidPhotograph(image, mask, 3.25 / 7, 3.25 / 7, "nearest"), [0, 180, 60]);
  assert.deepEqual(image.data, before);
});

test("source footprints remain invalid when RGB and ownership mask resolutions differ", () => {
  const image = gridPixels(8, 8, () => [20, 80, 40, 255]);
  const fineMask = gridPixels(32, 32, (x, y) => x === 14 && y === 14 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  assert.equal(sampleValidPhotograph(image, fineMask, 3 / 7, 3 / 7, "nearest"), undefined,
    "one excluded high-resolution mask cell invalidates a larger RGB pixel");
  const coarseMask = gridPixels(4, 4, (x) => x === 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  assert.equal(sampleValidPhotograph(image, coarseMask, 3.2 / 7, 3 / 7), undefined,
    "a valid central mask lookup cannot authorize an invalid RGB interpolation neighbour");
  assert.deepEqual(sampleValidPhotograph(image, coarseMask, 2 / 7, 3 / 7), [20, 80, 40]);
});

test("a valid finger hole stays sampleable while transparent and out-of-frame pixels do not", () => {
  const image = gridPixels(8, 8, () => [180, 110, 70, 255]);
  const mask = gridPixels(8, 8, (x, y) => x === 3 && y === 3 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
  assert.deepEqual(sampleValidPhotograph(image, mask, 3 / 7, 3 / 7), [180, 110, 70]);
  assert.equal(sampleValidPhotograph(image, mask, 3.1 / 7, 3 / 7), undefined);
  assert.equal(sampleValidPhotograph(image, undefined, -0.01, 0.5), undefined);
  assert.equal(sampleValidPhotograph(image, undefined, NaN, 0.5), undefined);
  image.data[(3 * 8 + 3) * 4 + 3] = 0;
  assert.equal(sampleValidPhotograph(image, mask, 3 / 7, 3 / 7), undefined);
});

test("an arm in front of a chest prevents the chest from receiving arm pixels", () => {
  const torso = new THREE.BoxGeometry(1.2, 1.5, 0.3);
  const arm = new THREE.CylinderGeometry(0.12, 0.12, 1.2, 20);
  const armMatrix = new THREE.Matrix4().makeTranslation(0.2, 0, 0.32);
  const visibility = rasterizePhotoVisibility([
    { geometry: torso }, { geometry: arm, matrix: armMatrix },
  ], camera);
  const normal = new THREE.Vector3(0, 0, 1);
  assert.equal(projectionConfidence(new THREE.Vector3(0.2, 0, 0.15), normal, camera, visibility), 0,
    "front-facing but occluded shirt must reject this photograph");
  assert.ok(projectionConfidence(new THREE.Vector3(-0.3, 0, 0.15), normal, camera, visibility) > 0.99);
  assert.ok(projectionConfidence(new THREE.Vector3(0.2, 0, 0.44), normal, camera, visibility) > 0.99);
  assert.equal(projectionConfidence(new THREE.Vector3(-0.3, 0, -0.15), normal, camera, visibility), 0);
  torso.dispose(); arm.dispose();
});

test("opposing cameras expose separate surfaces without mirroring a front photograph", () => {
  const front = camera.project(new THREE.Vector3(0.4, 0.3, 0.2));
  const rearCamera = orthographicPhotoProjection({ left: -1, right: 1, bottom: -1, top: 1 }, Math.PI);
  const rear = rearCamera.project(new THREE.Vector3(0.4, 0.3, -0.2));
  assert.ok(front.u > 0.5 && rear.u < 0.5);
  assert.equal(front.v, rear.v);
  assert.equal(projectionConfidence(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), camera), 0);
  assert.equal(projectionConfidence(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), rearCamera), 1);
});

const turnaround = (): VolumePixels => {
  const width = 100, height = 120;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const background = Math.round(110 + y * 0.15);
    const torso = x > 25 && x < 75 && y > 8 && y < 65;
    const legs = y >= 65 && y < 110 && (x > 25 && x < 44 || x > 56 && x < 75);
    const value = torso ? 190 : legs ? 35 : background;
    const offset = (y * width + x) * 4;
    data.set([value, value, value, 255], offset);
  }
  return { width, height, data };
};

test("turnaround masking removes studio background and leg gaps without recoloring monochrome clothes", () => {
  const image = turnaround();
  const before = Array.from(image.data);
  const field = turnaroundForeground(image, [0, 0.2, 1, 0.8]);
  assert.equal(field.contains(0.5, 0.4), true);
  assert.equal(field.contains(0.05, 0.4), false);
  assert.equal(field.contains(0.5, 0.8), false);
  assert.equal(field.contains(0.25, 0.8), true);
  assert.deepEqual(Array.from(image.data), before, "a matte must never alter source RGB");
});

test("silhouette registration keeps each inferred trouser leg on its corresponding mesh leg", () => {
  const geometry = new THREE.BoxGeometry(0.25, 1.6, 0.25);
  const visibility = rasterizePhotoVisibility([
    { geometry, matrix: new THREE.Matrix4().makeTranslation(-0.3, 0, 0) },
    { geometry, matrix: new THREE.Matrix4().makeTranslation(0.3, 0, 0) },
  ], camera);
  const field = turnaroundForeground(turnaround(), [0, 0.2, 1, 0.8]);
  const register = registerTurnaroundSilhouette(visibility, field);
  const left = register(0.35, 0.8), right = register(0.65, 0.8);
  assert.ok(left && right);
  assert.ok(left.u < 0.4 && right.u > 0.6);
  assert.equal(field.contains(left.u, left.v), true);
  assert.equal(field.contains(right.u, right.v), true);
  geometry.dispose();
});

test("an imported mesh receives exact source color on visible vertices and keeps unseen learned colors", () => {
  const geometry = new THREE.BoxGeometry(1, 1, 0.4, 2, 2, 2);
  const position = geometry.getAttribute("position");
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(position.count * 3).fill(0.04), 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));
  const image: VolumePixels = { width: 4, height: 4,
    data: new Uint8Array(Array.from({ length: 16 }, () => [128, 64, 32, 255]).flat()) };
  const result = overlayPhotographsOnVertexColors(group, [{ image, camera, sampleProvenance: "original" }]);
  assert.ok(result.updatedVertices > 0);
  assert.equal(result.originalPhotoVertices, result.updatedVertices);
  assert.equal(result.inferredPhotoVertices, 0);
  const expected = new THREE.Color().setRGB(128 / 255, 64 / 255, 32 / 255, THREE.SRGBColorSpace);
  const colors = geometry.getAttribute("color"), normals = geometry.getAttribute("normal");
  for (let i = 0; i < position.count; i++) {
    if (normals.getZ(i) > 0.99) {
      assert.ok(Math.abs(colors.getX(i) - expected.r) < 1e-6);
      assert.ok(Math.abs(colors.getY(i) - expected.g) < 1e-6);
      assert.ok(Math.abs(colors.getZ(i) - expected.b) < 1e-6);
    } else if (normals.getZ(i) < -0.99) {
      assert.ok(Math.abs(colors.getX(i) - 0.04) < 1e-6);
    }
  }
  geometry.dispose(); material.dispose();
});

test("vertex projection preserves excluded colour and counts only the final accepted view", () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 2, 2);
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(0.04), 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const group = new THREE.Group(); group.add(new THREE.Mesh(geometry, material));
  const image = gridPixels(8, 8, () => [20, 180, 60, 255]);
  const mask = gridPixels(8, 8, (x, y) => x === 4 && y === 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  const original = overlayPhotographsOnVertexColors(group, [{ image, mask, camera }]);
  assert.equal(original.originalPhotoVertices, count - 1);
  assert.ok(Math.abs(geometry.getAttribute("color").getX(4) - 0.04) < 1e-6);
  const layered = overlayPhotographsOnVertexColors(group, [
    { image, mask, camera }, { image, camera, sampleProvenance: "inferred" },
  ]);
  assert.equal(layered.updatedVertices, count);
  assert.equal(layered.originalPhotoVertices, 0);
  assert.equal(layered.inferredPhotoVertices, count);
  geometry.dispose(); material.dispose();
});
