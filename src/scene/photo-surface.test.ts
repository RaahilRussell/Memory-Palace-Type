import assert from "node:assert/strict";
import test from "node:test";
import { createDepthGeometry } from "./reconstruction";
import { createDepthEdgeCoverage, createPhotoSurface } from "./photo-surface";

function pixels(width: number, values: number[]) {
  return {
    width,
    height: values.length / width,
    data: values.flatMap((value) => [value, value, value, 255]),
  };
}

test("photographic surface and backing reproduce source rays over the full image", () => {
  const depth = pixels(3, [255, 160, 0, 200, 80, 20]);
  const options = { fov: 48, aspect: 1.8, cameraHeight: 1.2 };
  const result = createPhotoSurface(depth, options);
  const tangent = Math.tan((options.fov * Math.PI) / 360);
  for (const geometry of [result.foreground, result.background]) {
    for (let i = 0; i < geometry.distances.length; i++) {
      const distance = -geometry.positions[i * 3 + 2];
      const u =
        0.5 +
        geometry.positions[i * 3] / (2 * distance * tangent * options.aspect);
      const v =
        0.5 +
        (geometry.positions[i * 3 + 1] - options.cameraHeight) /
          (2 * distance * tangent);
      assert.ok(Math.abs(u - geometry.uvs[i * 2]) < 1e-6);
      assert.ok(Math.abs(v - geometry.uvs[i * 2 + 1]) < 1e-6);
    }
    assert.equal(Math.min(...geometry.uvs), 0);
    assert.equal(Math.max(...geometry.uvs), 1);
    for (const values of [geometry.positions, geometry.uvs, geometry.distances])
      assert.ok(Array.from(values).every(Number.isFinite));
  }
  assert.equal(result.background.indices.length, 6);
});

test("default photographic depth is compact around the original inverse-depth midpoint", () => {
  const depth = pixels(2, [255, 0, 255, 0]);
  const { foreground } = createPhotoSurface(depth, { near: 2, far: 12 });
  const near = Math.min(...foreground.distances);
  const far = Math.max(...foreground.distances);
  assert.ok(far / near <= 1.75 + 1e-6);
  assert.ok(Math.abs(2 / (1 / near + 1 / far) - 2 / (1 / 2 + 1 / 12)) < 1e-6);
  const alreadyCompact = createPhotoSurface(depth, { near: 3, far: 4 });
  assert.deepEqual(
    Array.from(alreadyCompact.foreground.distances),
    [3, 4, 3, 4],
  );
});

test("compressed surface retains observed silhouette cuts and supported triangles", () => {
  // Compression makes this moderate original discontinuity small enough for
  // the compact mesh to bridge it; reuse the observed cut instead.
  const depth = pixels(2, [230, 180, 230, 180]);
  const observed = createDepthGeometry(depth);
  assert.equal(observed.indices.length, 0);
  const { foreground } = createPhotoSurface(depth);
  assert.deepEqual(foreground.indices, observed.indices);
  assert.deepEqual(foreground.edgeVertexIndices, observed.edgeVertexIndices);

  const corner = pixels(2, [200, 200, 200, 0]);
  const retained = createPhotoSurface(corner).foreground;
  assert.equal(retained.indices.length, 3);
  assert.ok(!Array.from(retained.indices).includes(3));
});

test("strength changes parallax while backing remains strictly behind the complete foreground", () => {
  const depth = pixels(3, [255, 128, 0, 220, 60, 0]);
  let previousSpread = 0;
  for (const strength of [0.4, 1, 1.5, 2.5]) {
    const { foreground, background } = createPhotoSurface(depth, { strength });
    const nearest = Math.min(...foreground.distances);
    const farthest = Math.max(...foreground.distances);
    assert.ok(farthest - nearest > previousSpread);
    previousSpread = farthest - nearest;
    for (const distance of background.distances) {
      assert.ok(distance > farthest);
      assert.ok(Math.abs(distance - farthest - 0.05) < 1e-6);
    }
    assert.equal(background.positions.length, 12);
  }
});

test("photo surfaces reject incomplete, non-finite and invalid projection inputs", () => {
  assert.throws(
    () => createPhotoSurface({ width: 2, height: 2, data: [255] }),
    /complete depth/,
  );
  assert.throws(
    () => createPhotoSurface(pixels(2, [255, NaN, 255, 255])),
    /finite/,
  );
  assert.throws(
    () =>
      createPhotoSurface(pixels(2, [255, 255, 255, 255]), { near: 5, far: 2 }),
    /Invalid depth/,
  );
});

test("disconnected edge patches preserve all source-view pixels without bridging depth cuts", () => {
  const result = createPhotoSurface(pixels(3, [255, 128, 0, 255, 255, 0, 0, 128, 255]), { aspect: 1.3, fov: 50 });
  let area = 0;
  for (const geometry of [result.foreground, result.edgeCoverage]) {
    for (let t = 0; t < geometry.indices.length; t += 3) {
      const [a, b, c] = Array.from(geometry.indices.slice(t, t + 3));
      const uv = geometry.uvs;
      area += Math.abs((uv[b*2]-uv[a*2])*(uv[c*2+1]-uv[a*2+1]) -
        (uv[c*2]-uv[a*2])*(uv[b*2+1]-uv[a*2+1])) / 2;
    }
  }
  assert.ok(Math.abs(area - 1) < 1e-6, 'observed triangles and patches tile the source exactly');
  const edges = result.edgeCoverage;
  assert.ok(edges.indices.length > 0);
  for (let t = 0; t < edges.indices.length; t += 3) {
    const a = edges.indices[t], b = edges.indices[t+1], c = edges.indices[t+2];
    assert.equal(edges.positions[a*3+2], edges.positions[b*3+2]);
    assert.equal(edges.positions[a*3+2], edges.positions[c*3+2]);
    for (const i of [a,b,c]) {
      const d = -edges.positions[i*3+2], tangent = Math.tan(50*Math.PI/360);
      assert.ok(Math.abs(.5 + edges.positions[i*3]/(2*d*tangent*1.3) - edges.uvs[i*2]) < 1e-6);
      assert.ok(Math.abs(.5 + (edges.positions[i*3+1]-1.6)/(2*d*tangent) - edges.uvs[i*2+1]) < 1e-6);
    }
  }
});

test("completed-context edge patches use its full-depth capture rays", () => {
  const geometry = createDepthGeometry(pixels(2, [255, 0, 255, 0]), {
    aspect: .75, fov: 70, cameraHeight: .68, strength: 2,
  });
  const coverage = createDepthEdgeCoverage(geometry);
  assert.equal(coverage.indices.length, 6);
  const tangent = Math.tan(70 * Math.PI / 360);
  for (let i = 0; i < coverage.indices.length; i++) {
    const depth = -coverage.positions[i * 3 + 2];
    assert.ok(Math.abs(.5 + coverage.positions[i * 3] / (2 * depth * tangent * .75) - coverage.uvs[i * 2]) < 1e-6);
    assert.ok(Math.abs(.5 + (coverage.positions[i * 3 + 1] - .68) / (2 * depth * tangent) - coverage.uvs[i * 2 + 1]) < 1e-6);
  }
});
