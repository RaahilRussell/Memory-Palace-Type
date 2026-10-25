import type { VolumePixels } from "./volume";

export interface EnvironmentPatch {
  region: [number, number, number, number];
  color: [number, number, number];
  reliable: boolean;
}

/** Reject a whole material crop if any foreground pixel falls in it. Sparse
 * color samples alone miss thin silhouettes that become repeated streaks. */
function overlapsForeground(region: EnvironmentPatch["region"], excluded?: VolumePixels) {
  if (!excluded) return false;
  const [left, top, right, bottom] = region;
  const x0 = Math.max(0, Math.floor(left * excluded.width) - 1);
  const y0 = Math.max(0, Math.floor(top * excluded.height) - 1);
  const x1 = Math.min(excluded.width - 1, Math.ceil(right * excluded.width));
  const y1 = Math.min(excluded.height - 1, Math.ceil(bottom * excluded.height));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (Number(excluded.data[(y * excluded.width + x) * 4]) > 30) return true;
  }
  return false;
}

function samplePixel(source: VolumePixels, u: number, v: number) {
  const x = Math.max(0, Math.min(source.width - 1, Math.floor(u * source.width)));
  const y = Math.max(0, Math.min(source.height - 1, Math.floor(v * source.height)));
  const i = (y * source.width + x) * 4;
  return [0, 1, 2].map(c => Number(source.data[i + c]));
}

/** A wall's material must come from visible background evidence, never a fixed
 * crop that can include someone's face or an uncertain inpainted silhouette. */
export function selectWallPatch(source: VolumePixels, excluded?: VolumePixels): EnvironmentPatch {
  let best: { variance: number; patch: EnvironmentPatch } | undefined;
  const visible: number[][] = [];
  for (let row = 0; row < 5; row++) for (const left of [0.025, 0.105, 0.185, 0.735, 0.815, 0.895]) {
    const top = 0.18 + row * 0.075;
    const region: EnvironmentPatch["region"] = [left, top, left + 0.07, top + 0.06];
    if (overlapsForeground(region, excluded)) continue;
    const samples: number[][] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      samples.push(samplePixel(source, left + (x + 0.5) / 8 * 0.07, top + (y + 0.5) / 8 * 0.06));
    }
    visible.push(...samples);
    const color = [0, 1, 2].map(c => samples.reduce((sum, pixel) => sum + pixel[c], 0) / samples.length) as [number, number, number];
    const variance = samples.reduce((sum, pixel) => sum + pixel.reduce((total, value, c) => total + (value - color[c]) ** 2, 0), 0) / (samples.length * 3);
    if (variance <= 450 && (!best || variance < best.variance)) {
      best = { variance, patch: { region, color, reliable: true } };
    }
  }
  if (best) return best.patch;
  const color = [0, 1, 2].map(c => {
    const values = visible.map(pixel => pixel[c]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 100;
  }) as [number, number, number];
  return { region: [0.025, 0.18, 0.095, 0.24], color, reliable: false };
}

/** Look for a small continuous floor material, excluding people and inpainted holes.
 * A garment, date stamp or propagated silhouette must never tile over the room. */
export function selectGroundPatch(source: VolumePixels, excluded?: VolumePixels): EnvironmentPatch {
  let best: { score: number; patch: EnvironmentPatch } | undefined;
  const maskAt = (u: number, v: number) => {
    if (!excluded) return false;
    const x = Math.min(excluded.width - 1, Math.floor(u * excluded.width));
    const y = Math.min(excluded.height - 1, Math.floor(v * excluded.height));
    return Number(excluded.data[(y * excluded.width + x) * 4]) > 30;
  };
  const pixel = (u: number, v: number) => {
    const x = Math.min(source.width - 1, Math.floor(u * source.width));
    const y = Math.min(source.height - 1, Math.floor(v * source.height));
    const i = (y * source.width + x) * 4;
    return [0, 1, 2].map(c => Number(source.data[i + c]));
  };
  for (let row = 0; row < 5; row++) for (let col = 0; col < 13; col++) {
    const left = 0.02 + col * 0.075, top = 0.73 + row * 0.045;
    if (overlapsForeground([left, top, left + 0.07, top + 0.05], excluded)) continue;
    const samples: number[][] = [];
    let blocked = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const u = left + (x + 0.5) / 8 * 0.07, v = top + (y + 0.5) / 8 * 0.05;
      if (maskAt(u, v)) blocked++;
      samples.push(pixel(u, v));
    }
    if (blocked > 1) continue;
    const color = [0, 1, 2].map(c => samples.reduce((s, p) => s + p[c], 0) / samples.length) as [number, number, number];
    const variance = samples.reduce((s, p) => s + p.reduce((n, v, c) => n + (v - color[c]) ** 2, 0), 0) / (samples.length * 3);
    // Strong contrast is evidence of a scene feature, not repeatable material.
    if (variance > 450) continue;
    const score = variance + blocked * 100 + (1 - top) * 4;
    if (!best || score < best.score) best = { score, patch: { region: [left, top, left + 0.07, top + 0.05], color, reliable: true } };
  }
  if (best) return best.patch;
  // No visible floor evidence: a muted source-derived color is a better
  // completion than stretching body/clothing pixels across a giant plane.
  const samples: number[][] = [];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 20; x++) {
    const u = (x + 0.5) / 20, v = 0.7 + (y + 0.5) / 12 * 0.29;
    if (!maskAt(u, v)) samples.push(pixel(u, v));
  }
  const color = [0, 1, 2].map(c => {
    const values = samples.map(p => p[c]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 100;
  }) as [number, number, number];
  return { region: [0.02, 0.94, 0.09, 0.99], color, reliable: false };
}
