import assert from "node:assert/strict";
import test from "node:test";
import { createDepthGeometry } from "./reconstruction.js";

function pixels(width: number, values: number[]) {
  return {
    width,
    height: values.length / width,
    data: values.flatMap((v) => [v, v, v, 255]),
  };
}

test("estimated foreground and background occupy different depths", () => {
  const geometry = createDepthGeometry(pixels(2, [255, 0, 255, 0]), {
    near: 2,
    far: 12,
  });
  assert.deepEqual(Array.from(geometry.distances), [2, 12, 2, 12]);
  assert.equal(geometry.positions[2], -2);
  assert.equal(geometry.positions[5], -12);
});

test("dense actor depth accepts a packed one-channel frame", () => {
  const geometry = createDepthGeometry(
    { width: 2, height: 2, data: new Uint8Array([255, 0, 255, 0]) },
    { near: 2, far: 12 },
  );
  assert.deepEqual(Array.from(geometry.distances), [2, 12, 2, 12]);
});

test("depth projection preserves the source photograph from its original viewpoint", () => {
  const geometry = createDepthGeometry(pixels(3, [255, 128, 0, 200, 80, 20]), {
    near: 2,
    far: 12,
    fov: 60,
    aspect: 1.5,
  });
  const tangent = Math.tan(Math.PI / 6);
  for (let i = 0; i < 6; i++) {
    const distance = -geometry.positions[i * 3 + 2];
    const u = geometry.positions[i * 3] / (distance * tangent * 1.5) / 2 + 0.5;
    const v =
      (geometry.positions[i * 3 + 1] - 1.6) / (distance * tangent) / 2 + 0.5;
    assert.ok(Math.abs(u - geometry.uvs[i * 2]) < 1e-6);
    assert.ok(Math.abs(v - geometry.uvs[i * 2 + 1]) < 1e-6);
  }
});

test("silhouette discontinuities become fragments rather than stretched face triangles", () => {
  const flat = createDepthGeometry(pixels(2, [255, 255, 255, 255]));
  assert.equal(flat.indices.length, 6);
  const silhouette = createDepthGeometry(pixels(2, [255, 0, 255, 0]));
  assert.equal(silhouette.indices.length, 0);
  assert.equal(silhouette.edgeVertexIndices.length, 4);
});

test("depth strength expands the world behind a stable foreground plane", () => {
  const depth = pixels(2, [255, 0, 255, 0]);
  const shallow = createDepthGeometry(depth, {
    near: 2,
    far: 12,
    strength: 0.5,
  });
  const deep = createDepthGeometry(depth, { near: 2, far: 12, strength: 2 });
  assert.equal(shallow.distances[0], deep.distances[0]);
  assert.equal(shallow.distances[1], 7);
  assert.equal(deep.distances[1], 22);
  assert.ok(
    Math.abs(
      shallow.positions[3] / shallow.distances[1] -
        deep.positions[3] / deep.distances[1],
    ) < 1e-6,
  );
});

test("incomplete depth inputs fail before building geometry", () => {
  assert.throws(
    () => createDepthGeometry({ width: 2, height: 2, data: [255] }),
    /complete depth/,
  );
  assert.throws(
    () => createDepthGeometry(pixels(2, [0, 0, 0, 0]), { near: 5, far: 2 }),
    /Invalid depth/,
  );
  assert.throws(
    () => createDepthGeometry(pixels(2, [0, 0, 0, 0]), { far: Infinity }),
    /Invalid depth/,
  );
  assert.throws(() => createDepthGeometry(pixels(2, [0, NaN, 0, 0])), /finite/);
});

test("an occluded corner retains the other three supported pixels with either diagonal", () => {
  for (let corner = 0; corner < 4; corner++) {
    const values = [200, 200, 200, 200];
    values[corner] = 0;
    const geometry = createDepthGeometry(pixels(2, values));
    assert.equal(geometry.indices.length, 3);
    assert.ok(!Array.from(geometry.indices).includes(corner));
  }
});

test("capture height changes preserve source rays instead of shifting the photo vertically", () => {
  const depth = pixels(2, [200, 200, 200, 200]);
  const original = createDepthGeometry(depth);
  const calibrated = createDepthGeometry(depth, { cameraHeight: 1.1 });
  for (let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(
        original.positions[i * 3 + 1] - calibrated.positions[i * 3 + 1] - 0.5,
      ) < 1e-6,
    );
    assert.equal(original.positions[i * 3], calibrated.positions[i * 3]);
  }
});
