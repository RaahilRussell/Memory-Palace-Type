import test from "node:test";
import assert from "node:assert/strict";
import { selectGroundPatch, selectWallPatch } from "./environment-patch";
import { buildPhotoEnvironment } from "./photo-environment";
import type { VolumePixels } from "./volume";
import * as THREE from "three";

test("floor patch excludes large clothing regions and retains the visible floor color", () => {
  const source: VolumePixels = { width: 100, height: 100, data: new Uint8Array(40000) };
  const mask: VolumePixels = { width: 100, height: 100, data: new Uint8Array(40000) };
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const i = (y * 100 + x) * 4;
    (source.data as Uint8Array).set(x < 85 ? [240, 20, 50, 255] : [112, 96, 84, 255], i);
    (mask.data as Uint8Array).set([x < 85 ? 255 : 0, 0, 0, 255], i);
  }
  const patch = selectGroundPatch(source, mask);
  assert.equal(patch.reliable, true);
  assert.ok(patch.region[0] >= 0.85);
  assert.deepEqual(patch.color, [112, 96, 84]);
});

test("unknown floor never projects filled human pixels across the ground", () => {
  const source: VolumePixels = { width: 32, height: 32, data: new Uint8Array(4096).fill(150) };
  const mask: VolumePixels = { width: 32, height: 32, data: new Uint8Array(4096).fill(255) };
  assert.equal(selectGroundPatch(source, mask).reliable, false);
  const result = buildPhotoEnvironment({ source, excludedMask: mask, textureSource: "source-inpaint" });
  const floor = result.group.getObjectByName("Photographic ground with metre-scale detail") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  assert.equal(floor.material.uniforms.photoWeight.value, 0);
  assert.equal(floor.material.uniforms.detailWeight.value, 0);
  result.dispose();
});

test("wall material selects visible background instead of masked clothing", () => {
  const source: VolumePixels = { width: 100, height: 100, data: new Uint8Array(40000) };
  const mask: VolumePixels = { width: 100, height: 100, data: new Uint8Array(40000) };
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const i = (y * 100 + x) * 4;
    (source.data as Uint8Array).set(x < 85 ? [240, 20, 50, 255] : [112, 96, 84, 255], i);
    (mask.data as Uint8Array).set([x < 85 ? 255 : 0, 0, 0, 255], i);
  }
  const patch = selectWallPatch(source, mask);
  assert.equal(patch.reliable, true);
  assert.ok(patch.region[0] >= 0.85);
  assert.deepEqual(patch.color, [112, 96, 84]);
  const result = buildPhotoEnvironment({ source, excludedMask: mask, environment: "indoor" });
  const wall = result.group.getObjectByName("Photographed rear room wall") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  const texture = wall.material.uniforms.detail.value as THREE.DataTexture;
  const texels = texture.image.data as Uint8Array;
  for (let i = 0; i < texels.length; i += 4) assert.deepEqual(Array.from(texels.slice(i, i + 3)), [112, 96, 84]);
  result.dispose();
});

test("a thin foreground remnant between material sample points cannot become a tile", () => {
  const source: VolumePixels = { width: 100, height: 100, data: new Uint8Array(40000).fill(120) };
  const mask: VolumePixels = { width: 1000, height: 1000, data: new Uint8Array(4000000) };
  for (const select of [selectGroundPatch, selectWallPatch]) {
    (mask.data as Uint8Array).fill(0);
    const original = select(source, mask).region;
    const x = Math.floor((original[0] + 0.032) * mask.width);
    const y = Math.floor((original[1] + 0.023) * mask.height);
    (mask.data as Uint8Array)[(y * mask.width + x) * 4] = 255;
    const patch = select(source, mask);
    assert.equal(patch.reliable, true);
    assert.ok(x / mask.width < patch.region[0] || x / mask.width > patch.region[2]
      || y / mask.height < patch.region[1] || y / mask.height > patch.region[3]);
  }
});

test("fully occluded walls use a plain material instead of tiling a foreground crop", () => {
  const source: VolumePixels = { width: 32, height: 32, data: new Uint8Array(4096).fill(150) };
  const mask: VolumePixels = { width: 32, height: 32, data: new Uint8Array(4096).fill(255) };
  assert.equal(selectWallPatch(source, mask).reliable, false);
  const result = buildPhotoEnvironment({ source, excludedMask: mask, environment: "indoor", textureSource: "source-inpaint" });
  const wall = result.group.getObjectByName("Photographed rear room wall") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  assert.equal(wall.material.uniforms.detailWeight.value, 0);
  assert.equal(wall.material.uniforms.excludeForeground.value, 1);
  result.dispose();
});
