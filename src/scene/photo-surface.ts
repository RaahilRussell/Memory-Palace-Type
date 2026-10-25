import {
  createDepthGeometry,
  type DepthPixels,
  type ProjectionOptions,
} from "./reconstruction";

/** Cover omitted source pixels with independent, constant-depth triangles.
 * This preserves capture rays without reconnecting discontinuous surfaces. */
export function createDepthEdgeCoverage(projected: ReturnType<typeof createDepthGeometry>) {
  const positions = new Float32Array(projected.cutIndices.length * 3);
  const uvs = new Float32Array(projected.cutIndices.length * 2);
  const indices = new Uint32Array(projected.cutIndices.length);
  for (let t = 0; t < projected.cutIndices.length; t += 3) {
    const depths = Array.from(projected.cutIndices.slice(t, t + 3),
      i => projected.distances[i]).sort((a, b) => a - b);
    const distance = depths[1];
    for (let j = 0; j < 3; j++) {
      const i = projected.cutIndices[t + j];
      const n = t + j;
      const scale = distance / projected.distances[i];
      positions.set([
        projected.positions[i * 3] * scale,
        (projected.positions[i * 3 + 1] - projected.cameraHeight) * scale + projected.cameraHeight,
        -distance,
      ], n * 3);
      uvs.set(projected.uvs.subarray(i * 2, i * 2 + 2), n * 2);
      indices[n] = n;
    }
  }
  return { positions, uvs, indices };
}

/** A conservative photographic surface: monocular relative depth supplies
 * parallax without asserting the large metric gaps of a recovered scan. */
export function createPhotoSurface(
  depth: DepthPixels,
  options: ProjectionOptions = {},
) {
  // Validate through the common projector, and keep its original discontinuity
  // decisions. Testing compressed depths would otherwise reconnect silhouettes
  // that were correctly separated in the learned depth image.
  const observed = createDepthGeometry(depth, options);
  const near = options.near ?? 2;
  const far = options.far ?? 12;
  const ratio = Math.min(1.75, far / near);
  const center = 2 / (1 / near + 1 / far);
  // Preserve the midpoint in inverse depth (the model's native convention),
  // narrowing only its uncertain range. These endpoints have far/near=ratio
  // and harmonic mean=center. Strength retains the common foreground anchor.
  const compactNear = (center * (1 + ratio)) / (2 * ratio);
  const compactFar = (center * (1 + ratio)) / 2;
  const foreground = createDepthGeometry(depth, {
    ...options,
    near: compactNear,
    far: compactFar,
  });
  foreground.indices = observed.indices;
  foreground.cutIndices = observed.cutIndices;
  foreground.edgeVertexIndices = observed.edgeVertexIndices;

  // A cut removes a triangle's photographed pixels, not only its unsupported
  // depth connection. Retain those pixels on independent tiny planar patches.
  // Each patch uses one bounded local depth, so no triangle stretches between
  // foreground and background. UV coverage is exact at the capture viewpoint.
  // Keep these separate from the observed mesh and diagnostic point cloud.
  const edgeCoverage = createDepthEdgeCoverage(foreground);

  let backingDistance = 0;
  for (const distance of foreground.distances)
    backingDistance = Math.max(backingDistance, distance);
  backingDistance += 0.05;
  // A two-triangle backing covers exactly the source camera frustum. It uses
  // the subject-free texture to fill silhouette cuts and small revealed gaps,
  // and stays behind every photographed vertex at every depth strength.
  const background = createDepthGeometry(
    { width: 2, height: 2, data: new Uint8Array(16).fill(255) },
    {
      ...options,
      aspect: options.aspect ?? depth.width / depth.height,
      near: backingDistance,
      far: backingDistance + 1,
      strength: 1,
    },
  );
  return { foreground, background, edgeCoverage };
}
