import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPhotoPosition, limitPhotoLocomotion } from './photo-navigation';

const bounds = { min: [-0.18, 1.48, -0.25], max: [0.18, 1.72, 0.35] } as const;
const region = { min: [...bounds.min], max: [...bounds.max] } as { min: [number,number,number]; max: [number,number,number] };
test('photo movement stays near the source without crossing the photographed surface', () => {
  const point = { x: 6, y: 8, z: -9 };
  clampPhotoPosition(point, region);
  assert.deepEqual(point, { x: .18, y: 1.72, z: -.25 });
  const inside = { x: .05, y: 1.6, z: 0 };
  clampPhotoPosition(inside, region);
  assert.deepEqual(inside, { x: .05, y: 1.6, z: 0 });
});
test('photo locomotion does not snap a physically displaced headset back into bounds', () => {
  const head = { x: 1, y: 1.8, z: -.5 };
  const outward = { x: 1.05, y: 1.8, z: -.55 };
  limitPhotoLocomotion(head, outward, region);
  assert.deepEqual(outward, head);
  const inward = { x: .95, y: 1.8, z: -.45 };
  limitPhotoLocomotion(head, inward, region);
  assert.deepEqual(inward, { x: .95, y: 1.8, z: -.45 });
});
