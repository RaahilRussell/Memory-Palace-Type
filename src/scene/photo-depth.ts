import type { DepthPixels } from "./reconstruction";

/** Remove isolated model speckles only when all eight neighbours agree. Unlike
 * a blur this keeps real silhouette edges and narrow foreground features sharp. */
export function cleanPhotoDepth(depth: DepthPixels): DepthPixels {
  const { width, height } = depth;
  const data = new Uint8ClampedArray(Array.from(depth.data));
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const values: number[] = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (dx || dy)
            values.push(Number(depth.data[((y + dy) * width + x + dx) * 4]));
      values.sort((a, b) => a - b);
      const median = (values[3] + values[4]) / 2;
      const i = (y * width + x) * 4;
      if (
        values[7] - values[0] <= 8 &&
        Math.abs(Number(depth.data[i]) - median) > 24
      )
        data[i] = data[i + 1] = data[i + 2] = median;
    }
  }
  return { width, height, data };
}

/** Extend observed background depth behind separately reconstructed subjects.
 * The subject's original near-depth surface must not survive as a second shell
 * painted with the inpainted background. This is a conservative fill, not a scan
 * of hidden geometry. Visible depth outside a one-pixel mask fringe is unchanged. */
function foregroundPixels(
  depth: Pick<DepthPixels, "width" | "height">,
  masks: DepthPixels[],
) {
  const { width, height } = depth;
  const count = width * height;
  const hidden = new Uint8Array(count);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (
        !masks.some((mask) => {
          const mx = Math.min(
            mask.width - 1,
            Math.floor(((x + 0.5) * mask.width) / width),
          );
          const my = Math.min(
            mask.height - 1,
            Math.floor(((y + 0.5) * mask.height) / height),
          );
          return Number(mask.data[(my * mask.width + mx) * 4]) >= 60;
        })
      )
        continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height)
            hidden[(y + dy) * width + x + dx] = 1;
    }
  return hidden;
}

/** The same expanded footprint is used for RGB and depth removal to avoid a
 * foreground-coloured halo on the newly filled background. */
export function photoRemovalMask(
  depth: Pick<DepthPixels, "width" | "height">,
  masks: DepthPixels[],
): DepthPixels {
  const hidden = foregroundPixels(depth, masks);
  const data = new Uint8ClampedArray(hidden.length * 4);
  for (let i = 0; i < hidden.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = hidden[i] * 255;
    data[i * 4 + 3] = 255;
  }
  return { width: depth.width, height: depth.height, data };
}

export function backgroundPhotoDepth(
  depth: DepthPixels,
  masks: DepthPixels[],
): DepthPixels {
  if (!masks.length) return depth;
  const { width, height } = depth;
  const count = width * height;
  const hidden = foregroundPixels(depth, masks);
  const data = Uint8ClampedArray.from(depth.data);
  const known = new Uint8Array(count);
  const queue = new Int32Array(count);
  const values = new Float32Array(count);
  let end = 0;
  for (let i = 0; i < count; i++) {
    values[i] = Number(depth.data[i * 4]);
    if (!hidden[i]) {
      known[i] = 1;
      queue[end++] = i;
    }
  }
  // No visible background evidence: use the far plane, not the removed subject.
  if (!end) values.fill(0);
  const neighbours = (i: number) => [
    i % width ? i - 1 : -1,
    i % width < width - 1 ? i + 1 : -1,
    i >= width ? i - width : -1,
    i < count - width ? i + width : -1,
  ];
  for (let cursor = 0; cursor < end; cursor++) {
    const i = queue[cursor];
    for (const n of neighbours(i)) {
      if (n < 0 || known[n]) continue;
      known[n] = 1;
      values[n] = values[i];
      queue[end++] = n;
    }
  }
  // Smooth nearest-boundary seams only inside the filled region. Keep the
  // original background boundary fixed so nearby walls/floors remain anchored.
  const filled = Array.from(hidden.keys()).filter((i) => hidden[i]);
  for (let pass = 0; pass < 24; pass++)
    for (const i of pass % 2 ? filled : filled.slice().reverse()) {
      let total = 0,
        samples = 0;
      for (const n of neighbours(i))
        if (n >= 0) {
          total += values[n];
          samples++;
        }
      if (samples) values[i] = total / samples;
    }
  for (const i of filled)
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = values[i];
  return { width, height, data };
}
