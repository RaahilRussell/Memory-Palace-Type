export type PhotoBounds = { min: [number, number, number]; max: [number, number, number] };
export type Position = { x: number; y: number; z: number };

export function clampPhotoPosition(point: Position, bounds: PhotoBounds) {
  for (const [i, key] of (['x', 'y', 'z'] as const).entries())
    point[key] = Math.max(bounds.min[i], Math.min(bounds.max[i], point[key]));
}

/** Limit artificial locomotion only. If physical headset movement has already
 * left the photographic region, never pull the tracked viewer back abruptly:
 * reject further outward movement and allow their requested inward movement. */
export function limitPhotoLocomotion(current: Position, requested: Position, bounds: PhotoBounds) {
  for (const [i, key] of (['x', 'y', 'z'] as const).entries()) {
    const low = Math.min(current[key], bounds.min[i]);
    const high = Math.max(current[key], bounds.max[i]);
    requested[key] = Math.max(low, Math.min(high, requested[key]));
  }
}
