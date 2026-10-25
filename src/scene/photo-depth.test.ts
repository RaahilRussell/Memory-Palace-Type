import assert from "node:assert/strict";
import test from "node:test";
import { backgroundPhotoDepth, cleanPhotoDepth } from "./photo-depth";

function pixels(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
) {
  return {
    width,
    height,
    data: Array.from({ length: width * height }, (_, i) => [
      value(i % width, Math.floor(i / width)),
      0,
      0,
      255,
    ]).flat(),
  };
}

test("isolated depth speckles are removed without blurring silhouettes or thin objects", () => {
  const depth = pixels(9, 9, (x, y) =>
    x === 2 && y === 4 ? 255 : x >= 6 ? 220 : 40,
  );
  const cleaned = cleanPhotoDepth(depth);
  assert.equal(cleaned.data[(4 * 9 + 2) * 4], 40);
  for (let y = 0; y < 9; y++) {
    assert.equal(cleaned.data[(y * 9 + 5) * 4], 40);
    assert.equal(cleaned.data[(y * 9 + 6) * 4], 220);
  }
  const thin = pixels(9, 9, (x) => (x === 4 ? 220 : 40));
  assert.deepEqual(
    cleanPhotoDepth(thin).data,
    new Uint8ClampedArray(thin.data),
  );
  assert.equal(depth.data[(4 * 9 + 2) * 4], 255);
});

test("removed foreground and its depth fringe are replaced using visible background", () => {
  const depth = pixels(9, 9, (x, y) =>
    x >= 2 && x <= 6 && y >= 2 && y <= 6 ? 230 : 45,
  );
  const mask = pixels(9, 9, (x, y) =>
    x >= 3 && x <= 5 && y >= 3 && y <= 5 ? 255 : 0,
  );
  const background = backgroundPhotoDepth(depth, [mask]);
  for (let i = 0; i < 81; i++) assert.equal(background.data[i * 4], 45);
  assert.equal(depth.data[40 * 4], 230);
});

test("background depth respects unequal mask resolution and preserves visible slopes", () => {
  const depth = pixels(12, 12, (x, y) =>
    x >= 4 && x < 8 && y >= 4 && y < 8 ? 230 : 20 + x * 3,
  );
  const mask = pixels(3, 3, (x, y) => (x === 1 && y === 1 ? 255 : 0));
  const result = backgroundPhotoDepth(depth, [mask]);
  assert.ok(Number(result.data[(6 * 12 + 6) * 4]) < 60);
  for (let y = 0; y < 12; y++) {
    assert.equal(result.data[y * 12 * 4], 20);
    assert.equal(result.data[(y * 12 + 11) * 4], 53);
  }
});

test("no background evidence falls back to far depth without inventing a foreground shell", () => {
  const depth = pixels(3, 3, () => 200);
  assert.equal(backgroundPhotoDepth(depth, []), depth);
  const result = backgroundPhotoDepth(depth, [pixels(3, 3, () => 255)]);
  for (let i = 0; i < 9; i++) assert.equal(result.data[i * 4], 0);
});
