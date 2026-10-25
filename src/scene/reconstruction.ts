import * as THREE from "three";

export interface DepthPixels {
  width: number;
  height: number;
  data: ArrayLike<number>;
}
export interface ProjectionOptions {
  near?: number;
  far?: number;
  fov?: number;
  aspect?: number;
  strength?: number;
  cameraHeight?: number;
}

/** Deproject the estimated inverse-depth image. White is close; black is distant.
 * Moving each pixel along its camera ray preserves the photograph at its source viewpoint.
 * Triangles across occlusion boundaries are deliberately omitted instead of stretching faces.
 */
export function createDepthGeometry(
  depth: DepthPixels,
  options: ProjectionOptions = {},
) {
  const { width, height, data } = depth;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    data.length < width * height
  )
    throw new Error(
      "A complete depth image of at least 2 × 2 pixels is required.",
    );
  const near = options.near ?? 2;
  const far = options.far ?? 12;
  const fov = options.fov ?? 60;
  const strength = options.strength ?? 1;
  const aspect = options.aspect ?? width / height;
  const cameraHeight = options.cameraHeight ?? 1.6;
  if (
    ![near, far, fov, aspect, strength, cameraHeight].every(Number.isFinite) ||
    !(
      near > 0 &&
      far > near &&
      fov > 0 &&
      fov < 150 &&
      aspect > 0 &&
      strength > 0
    )
  )
    throw new Error("Invalid depth projection.");
  const positions = new Float32Array(width * height * 3);
  const uvs = new Float32Array(width * height * 2);
  const distances = new Float32Array(width * height);
  const indices: number[] = [];
  const cutIndices: number[] = [];
  const edges = new Set<number>();
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const depthStride = data.length >= width * height * 4 ? 4 : 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const u = x / (width - 1);
      const v = y / (height - 1);
      const sample = Number(data[i * depthStride]);
      if (!Number.isFinite(sample))
        throw new Error("Depth samples must be finite.");
      const inverseDepth = Math.min(1, Math.max(0, sample / 255));
      const distance =
        near +
        (1 / (inverseDepth / near + (1 - inverseDepth) / far) - near) *
          strength;
      distances[i] = distance;
      positions[i * 3] = (u * 2 - 1) * halfHeight * aspect * distance;
      positions[i * 3 + 1] = (1 - v * 2) * halfHeight * distance + cameraHeight;
      positions[i * 3 + 2] = -distance;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = 1 - v;
    }
  }
  const continuous = (a: number, b: number, c: number) => {
    const closest = Math.min(distances[a], distances[b], distances[c]);
    const spread = Math.max(distances[a], distances[b], distances[c]) - closest;
    // Relative threshold tolerates distant sloping surfaces while cutting foreground silhouettes.
    return spread <= Math.max(0.24 * strength, closest * 0.12);
  };
  const triangle = (a: number, b: number, c: number) => {
    if (continuous(a, b, c)) indices.push(a, b, c);
    else {
      cutIndices.push(a, b, c);
      edges.add(a);
      edges.add(b);
      edges.add(c);
    }
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = y * width + x;
      const b = a + 1,
        c = a + width,
        d = c + 1;
      // Pick the split that retains the most supported surface. A fixed diagonal
      // discards both triangles when just one corner crosses an occlusion edge.
      const first = Number(continuous(a, c, b)) + Number(continuous(b, c, d));
      const second = Number(continuous(a, c, d)) + Number(continuous(a, d, b));
      if (
        second > first ||
        (second === first &&
          Math.abs(distances[a] - distances[d]) <
            Math.abs(distances[b] - distances[c]))
      ) {
        triangle(a, c, d);
        triangle(a, d, b);
      } else {
        triangle(a, c, b);
        triangle(b, c, d);
      }
    }
  }
  return {
    positions,
    uvs,
    indices: new Uint32Array(indices),
    cutIndices: new Uint32Array(cutIndices),
    distances,
    edgeVertexIndices: new Uint32Array(edges),
    cameraHeight,
  };
}

export { buildReconstruction } from "./volume-world";
export type { Reconstruction, ReconstructionInput } from "./volume-world";
