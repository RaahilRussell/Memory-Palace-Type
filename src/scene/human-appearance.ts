import type { VolumePixels } from "./volume";
import type { HumanPose } from "../types";

export type PhotoBox = [
  top: number,
  left: number,
  bottom: number,
  right: number,
];

/** Source colors stay in sRGB. Unseen clothes are an explicit, neutral inference. */
export interface HumanAppearance {
  shirtColor: string;
  pantsColor: string;
  skinColor: string;
  hairColor: string;
  shoeColor: string;
  height?: number;
  yaw?: number;
  headYaw?: number;
  sourceView?: "front" | "back";
  sleeves?: "short" | "long";
  hairLength?: "short" | "long";
  hairVolume?: number;
  /** Crown to chin, excluding neck and neighboring people's shoulders. */
  faceBox?: PhotoBox;
  /** Central fabric only: avoids projecting somebody's arms onto a torso. */
  chestBox?: PhotoBox;
  /** Photographic shoulders through the observed shirt hem. Unlike chestBox,
   * this retains the scale and position of collars, graphics and necklaces. */
  torsoBox?: PhotoBox;
  neckBox?: PhotoBox;
  /** Bounded anatomical fit, measured in source pixels rather than mask UVs. */
  headWidthScale?: number;
  headHeightScale?: number;
  torsoWidthScale?: number;
  /** Fraction of a normal shirt seen in the photo; the remainder is inferred. */
  torsoSourceBottom?: number;
  /** Valid photographic evidence only; crop/shape bounds still use the original
   * person silhouette and may contain holes that texture-validity masks exclude. */
  appearanceSampling?: Record<"head" | "skin" | "hair" | "shirt" | "pants" | "shoes", AppearanceSampleEvidence>;
  /** Sampling evidence, separate from whether the final mesh fits the photo. */
  garmentSampling?: {
    source: "measured-torso";
    status: "measured" | "insufficient-support";
    candidateSamples: number;
    maskSamples: number;
    excludedSamples: number;
    sampleCount: number;
  };
}

type RGB = [number, number, number];
type AppearanceSampleEvidence = {
  status: "measured" | "inferred";
  sampleCount: number;
};
type Span = { left: number; right: number; count: number; y: number };
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * clamp(q))];
};
const hex = (rgb: RGB) =>
  `#${rgb
    .map((n) =>
      Math.round(clamp(n, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const brightness = (rgb: RGB) =>
  rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
const colorDistance = (a: RGB, b: RGB) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const warmSkin = (p: RGB) =>
  p[0] > 32 &&
  p[0] > p[1] * 1.08 &&
  p[0] - p[2] > 15 &&
  p[1] > p[2] * 0.95 &&
  p[0] - p[1] < 115;

const sampleEvidence = (sampleCount: number): AppearanceSampleEvidence => ({
  status: sampleCount > 0 ? "measured" : "inferred",
  sampleCount,
});

/** Appearance validity is independent of the fitting silhouette. Original RGB
 * must be fully opaque, matching the vertex and UV photographic samplers. */
function observedSourceColor(source: VolumePixels, x: number, y: number): RGB | undefined {
  const offset = (y * source.width + x) * 4;
  const rgba = [0, 1, 2, 3].map((channel) => Number(source.data[offset + channel]));
  if (!rgba.every((value) => Number.isFinite(value) && value >= 0 && value <= 255) || rgba[3] !== 255) return undefined;
  return [rgba[0], rgba[1], rgba[2]];
}

function coveredSourcePixel(mask: VolumePixels, source: VolumePixels, x: number, y: number) {
  const mx = Math.min(mask.width - 1, Math.floor((x + 0.5) / source.width * mask.width));
  const my = Math.min(mask.height - 1, Math.floor((y + 0.5) / source.height * mask.height));
  return Number(mask.data[(my * mask.width + mx) * 4]) >= 128;
}

/** Pick the strongest color family, then average its local neighborhood. Large
 * white shirt graphics therefore do not turn a black shirt gray. */
function dominantColor(pixels: RGB[], fallback: RGB): RGB {
  if (!pixels.length) return fallback;
  const bins = new Map<string, RGB[]>();
  for (const p of pixels) {
    const key = p.map((v) => Math.floor(v / 24)).join(":");
    const bin = bins.get(key) ?? [];
    bin.push(p);
    bins.set(key, bin);
  }
  let strongest: RGB[] = [];
  for (const bin of bins.values())
    if (bin.length > strongest.length) strongest = bin;
  const seed = [0, 1, 2].map((i) =>
    quantile(
      strongest.map((p) => p[i]),
      0.5,
    ),
  ) as RGB;
  const neighbors = pixels.filter((p) => colorDistance(p, seed) < 38);
  return [0, 1, 2].map((i) =>
    quantile(
      neighbors.map((p) => p[i]),
      0.5,
    ),
  ) as RGB;
}

export function analyzeHumanAppearance({
  source,
  mask,
  box,
  label,
  pose,
  excludedMasks = [],
}: {
  source: VolumePixels;
  mask: VolumePixels;
  box: PhotoBox;
  label: string;
  pose?: HumanPose;
  excludedMasks?: VolumePixels[];
}): HumanAppearance {
  for (const pixels of [source, mask]) {
    if (
      pixels.width < 2 ||
      pixels.height < 2 ||
      pixels.data.length < pixels.width * pixels.height * 4
    )
      throw new Error(
        "Human appearance requires complete RGBA source and mask pixels.",
      );
  }
  for (const pixels of excludedMasks) {
    if (!Number.isInteger(pixels.width) || !Number.isInteger(pixels.height) ||
      pixels.width < 1 || pixels.height < 1 || pixels.data.length < pixels.width * pixels.height * 4)
      throw new Error("Human appearance requires complete RGBA exclusion masks.");
  }
  if (!box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1])
    throw new Error(
      "Human appearance requires a nonempty normalized subject box.",
    );

  const w = mask.width,
    h = mask.height;
  const top = Math.floor(clamp(box[0]) * (h - 1));
  const bottom = Math.ceil(clamp(box[2]) * (h - 1));
  const left = Math.floor(clamp(box[1]) * (w - 1));
  const right = Math.ceil(clamp(box[3]) * (w - 1));
  const active = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < w &&
    y < h &&
    Number(mask.data[(y * w + x) * 4]) >= 110;
  const sample = (x: number, y: number): RGB | undefined => {
    const sx = Math.round((x / (w - 1)) * (source.width - 1));
    const sy = Math.round((y / (h - 1)) * (source.height - 1));
    const alpha = Number(mask.data[(y * w + x) * 4 + 3]);
    if (alpha !== 255 ||
      excludedMasks.some((exclusion) => coveredSourcePixel(exclusion, source, sx, sy))) return undefined;
    return observedSourceColor(source, sx, sy);
  };
  const rows: Span[] = [];
  for (let y = top; y <= bottom; y++) {
    let first = w,
      last = -1,
      count = 0;
    for (let x = left; x <= right; x++)
      if (active(x, y)) {
        first = Math.min(first, x);
        last = x;
        count++;
      }
    if (count >= 2) rows.push({ left: first, right: last, count, y });
  }
  if (!rows.length)
    return {
      shirtColor: "#777777",
      pantsColor: "#303238",
      skinColor: "#ae8970",
      hairColor: "#272421",
      shoeColor: "#252525",
      height: 1.76,
      yaw: 0,
      headYaw: 0,
      sourceView: "front",
      sleeves: "short",
      hairLength: "short",
      faceBox: box,
      appearanceSampling: {
        head: sampleEvidence(0), skin: sampleEvidence(0), hair: sampleEvidence(0),
        shirt: sampleEvidence(0), pants: sampleEvidence(0), shoes: sampleEvidence(0),
      },
    };

  const crown = rows[0].y,
    visibleBottom = rows[rows.length - 1].y;
  const visibleHeight = Math.max(2, visibleBottom - crown);
  // Arms can span most of the photograph. Find the head above them, rather than
  // assuming that the center or width of the whole person is a head landmark.
  const crownRows = rows.filter(
    (r) =>
      r.y > crown + visibleHeight * 0.035 && r.y < crown + visibleHeight * 0.15,
  );
  const headRows = crownRows.length
    ? crownRows
    : rows.slice(0, Math.max(1, Math.ceil(rows.length * 0.15)));
  const headWidth = Math.max(
    4,
    quantile(
      headRows.map((r) => r.right - r.left + 1),
      0.65,
    ),
  );
  const headCenter = quantile(
    headRows.map((r) => (r.left + r.right) / 2),
    0.5,
  );
  let chin = Math.min(visibleBottom, crown + headWidth * 1.38);
  const shoulderExpansion = (row: Span) => {
    const width = row.right - row.left + 1;
    if (width <= headWidth * 1.3) return false;
    // A hand laid over a friend's shoulder often joins the head/neck mask on
    // just one side. That jump is an arm, not the person's chin or collar.
    if (width > headWidth * 1.8 &&
      (row.left > headCenter - headWidth * 0.62 ||
       row.right < headCenter + headWidth * 0.62)) return false;
    return true;
  };
  for (let i = 0; i < rows.length - 2; i++) {
    const r = rows[i];
    if (r.y < crown + headWidth * 1.05 || r.y > crown + headWidth * 1.8)
      continue;
    if (
      rows.slice(i, i + 3).every(shoulderExpansion)
    ) {
      chin = Math.min(r.y, crown + headWidth * 1.55);
      break;
    }
  }
  const headHeight = Math.max(4, chin - crown);
  const headOutline = rows.filter(
    (r) => r.y > crown + headHeight * 0.06 && r.y < crown + headHeight * 0.85,
  );
  const headLeft = clamp(
    Math.min(
      headCenter - headWidth * 0.48,
      quantile(
        headOutline.map((r) => r.left),
        0.15,
      ),
    ),
    Math.max(left, headCenter - headWidth * 0.64),
    right,
  );
  const headRight = clamp(
    Math.max(
      headCenter + headWidth * 0.48,
      quantile(
        headOutline.map((r) => r.right),
        0.85,
      ),
    ),
    left + 1,
    Math.min(right, headCenter + headWidth * 0.64),
  );

  const normalized = (t: number, l: number, b: number, r: number): PhotoBox => [
    clamp(t / (h - 1)),
    clamp(l / (w - 1)),
    clamp(b / (h - 1)),
    clamp(r / (w - 1)),
  ];
  const faceBox = normalized(crown, headLeft, chin, headRight);
  const shirtTop = Math.min(visibleBottom - 2, chin + headHeight * 0.17);
  const shirtBottom = Math.min(visibleBottom, chin + headHeight * 2.35);
  const torsoRows = rows.filter(
    (r) =>
      r.y >= shirtTop + (shirtBottom - shirtTop) * 0.45 && r.y <= shirtBottom,
  );
  const torsoLeft = quantile(
    torsoRows.map((r) => r.left),
    0.5,
  );
  const torsoRight = quantile(
    torsoRows.map((r) => r.right),
    0.5,
  );
  const torsoCenter = torsoRows.length
    ? (torsoLeft + torsoRight) / 2
    : headCenter;
  const chestHalfWidth = Math.max(
    3,
    Math.min((torsoRight - torsoLeft) * 0.35, headWidth * 0.78),
  );
  const chestBox = normalized(
    shirtTop,
    torsoCenter - chestHalfWidth,
    shirtBottom,
    torsoCenter + chestHalfWidth,
  );

  // A shirt crop must retain its photographic width. The old palette crop is
  // intentionally narrow and made a small printed logo fill the entire chest.
  // Follow the contiguous component under the head, rejecting a second person
  // or an arm that travels across the image. Shoulder widths are bounded by
  // anatomy; occlusion by a neighboring person cannot shrink a torso in half.
  const componentNear = (y: number, anchor: number): Span | undefined => {
    const runs: Span[] = [];
    let start = -1;
    for (let x = left; x <= right + 1; x++) {
      if (x <= right && active(x, y)) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        runs.push({ left: start, right: x - 1, count: x - start, y });
        start = -1;
      }
    }
    const distance = (r: Span) => Math.max(r.left - anchor, anchor - r.right, 0);
    return runs.filter((r) => r.count > 2)
      .sort((a, b) => distance(a) - distance(b) || b.count - a.count)[0];
  };
  const garmentTop = Math.min(visibleBottom - 2, chin + headHeight * 0.04);
  const expectedHem = garmentTop + headHeight * 2.35;
  const garmentBottom = Math.min(visibleBottom, expectedHem);
  const garmentRows = rows
    .filter((r) => r.y > garmentTop + headHeight * 0.3 && r.y < garmentBottom)
    .map((r) => componentNear(r.y, headCenter))
    .filter((r): r is Span => Boolean(r));
  const usefulWidths = garmentRows
    .map((r) => r.right - r.left + 1)
    .filter((width) => width < headWidth * 3.2);
  const garmentWidth = clamp(
    quantile(usefulWidths, 0.82),
    headWidth * 1.85,
    headWidth * 2.75,
  );
  const garmentCenter = headCenter + clamp(
    quantile(garmentRows.map((r) => (r.left + r.right) / 2), 0.5) - headCenter,
    -headWidth * 0.25,
    headWidth * 0.25,
  );
  const torsoBox = normalized(
    garmentTop,
    garmentCenter - garmentWidth / 2,
    garmentBottom,
    garmentCenter + garmentWidth / 2,
  );
  const neckBox = normalized(
    Math.max(crown, chin - headHeight * 0.1),
    headCenter - headWidth * 0.3,
    Math.min(visibleBottom, chin + headHeight * 0.24),
    headCenter + headWidth * 0.3,
  );
  const photographedHeadAspect =
    ((faceBox[3] - faceBox[1]) * source.width) /
    Math.max(1, (faceBox[2] - faceBox[0]) * source.height);
  const fitAspect = photographedHeadAspect / (0.19 / 0.272);

  const collect = (area: PhotoBox, erode = false) => {
    const result: { color: RGB; x: number; y: number }[] = [];
    for (
      let y = Math.max(top, Math.floor(area[0] * (h - 1)));
      y <= Math.min(bottom, Math.ceil(area[2] * (h - 1)));
      y++
    )
      for (
        let x = Math.max(left, Math.floor(area[1] * (w - 1)));
        x <= Math.min(right, Math.ceil(area[3] * (w - 1)));
        x++
      ) {
        if (!active(x, y)) continue;
        if (
          erode &&
          (!active(x - 1, y) ||
            !active(x + 1, y) ||
            !active(x, y - 1) ||
            !active(x, y + 1))
        )
          continue;
        const color = sample(x, y);
        if (color) result.push({ color, x, y });
      }
    return result;
  };
  const head = collect(faceBox, true);
  const allColors = collect(chestBox, true).map((p) => p.color);
  const chroma = [...head.map((p) => p.color), ...allColors];
  const grayscale =
    chroma.length > 0 &&
    quantile(
      chroma.map((p) => Math.max(...p) - Math.min(...p)),
      0.94,
    ) < 9;
  const skinArea = head.filter(
    (p) => p.y > crown + headHeight * 0.25 && p.y < crown + headHeight * 0.9,
  );
  const warm = skinArea.filter((p) => warmSkin(p.color));
  const skinBrightness = quantile(
    skinArea.map((p) => brightness(p.color)),
    0.48,
  );
  const skinCandidates = grayscale
    ? skinArea
        .map((p) => p.color)
        .filter((p) => brightness(p) >= skinBrightness)
    : warm.map((p) => p.color);
  const skin = dominantColor(
    skinCandidates,
    grayscale ? [145, 145, 145] : [151, 107, 78],
  );
  const crownColors = head
    .filter((p) => p.y < crown + headHeight * 0.36)
    .map((p) => p.color);
  const hair = dominantColor(crownColors, [30, 27, 24]);
  const shirtCandidates = grayscale
    ? allColors
    : allColors.filter((p) => !(warmSkin(p) && colorDistance(p, skin) < 80));
  const shirtColors = shirtCandidates.length ? shirtCandidates : allColors;
  const shirt = dominantColor(
    shirtColors,
    [105, 105, 105],
  );
  const fullBodyVisible = visibleHeight > headHeight * 5.1;
  const pantsArea = normalized(
    chin + headHeight * 2.6,
    torsoCenter - chestHalfWidth * 0.85,
    Math.min(visibleBottom, chin + headHeight * 4.4),
    torsoCenter + chestHalfWidth * 0.85,
  );
  const pantsColors = fullBodyVisible ? collect(pantsArea, true).map((p) => p.color) : [];
  const pants = fullBodyVisible
    ? dominantColor(
        pantsColors,
        grayscale ? [43, 43, 43] : [38, 43, 49],
      )
    : grayscale
      ? ([43, 43, 43] as RGB)
      : ([38, 43, 49] as RGB);

  let yaw = 0,
    headYaw = 0;
  let sourceView: "front" | "back" = "front";
  if (!grayscale && skinArea.length > 16) {
    const centralBand = skinArea.filter(
      (p) =>
        p.y < crown + headHeight * 0.68 &&
        Math.abs(p.x - headCenter) < headWidth * 0.3,
    );
    const centralSkin = centralBand.filter((p) => warmSkin(p.color));
    const skinFraction = centralSkin.length / Math.max(1, centralBand.length);
    const darkFraction =
      centralBand.filter((p) => brightness(p.color) < 70).length /
      Math.max(1, centralBand.length);
    // A back-of-head has mostly hair across its center; a neck or ear alone must
    // not cause us to paint a new face onto the side seen in the photograph.
    if (
      (skinFraction < 0.28 && darkFraction > 0.72) ||
      /\b(back of|facing away|turned away|from behind)\b/i.test(label)
    ) {
      yaw = Math.PI;
      sourceView = "back";
    } else if (warm.length > 12) {
      const skinCenter =
        warm.reduce((total, p) => total + p.x, 0) / warm.length;
      const offset = (skinCenter - headCenter) / headWidth;
      headYaw = Math.abs(offset) > 0.065 ? clamp(offset * 3, -0.8, 0.8) : 0;
    }
  }
  const monochrome = (p: RGB): RGB => {
    const gray = Math.round(brightness(p));
    return [gray, gray, gray];
  };
  const preserve = (p: RGB) => hex(grayscale ? monochrome(p) : p);
  // Hair mass is read from the crown color's coverage of the observed head.
  // Matching the crown, rather than testing "dark", avoids treating dark skin
  // as hair. A rear view naturally shows more hair and needs a separate cap.
  const hairCoverage =
    head.filter((p) => colorDistance(p.color, hair) < 39).length /
    Math.max(1, head.length);
  const hairVolume =
    sourceView === "back" ? 0.4 : clamp((hairCoverage - 0.2) * 2.3, 0.25, 0.95);
  const appearance: HumanAppearance = {
    shirtColor: preserve(shirt),
    pantsColor: preserve(pants),
    skinColor: preserve(skin),
    hairColor: preserve(hair),
    shoeColor: grayscale ? "#252525" : "#252629",
    height: 1.76,
    yaw,
    headYaw,
    sourceView,
    sleeves: /\b(jacket|coat|sweater|long.sleeve|hoodie)\b/i.test(label)
      ? "long"
      : "short",
    hairLength: /\blong hair\b/i.test(label) ? "long" : "short",
    hairVolume: /\b(curly|afro|voluminous)\b/i.test(label)
      ? Math.max(0.85, hairVolume)
      : hairVolume,
    faceBox,
    chestBox,
    torsoBox,
    neckBox,
    headWidthScale: clamp(Math.sqrt(fitAspect), 0.86, 1.18),
    headHeightScale: clamp(1 / Math.sqrt(fitAspect), 0.9, 1.12),
    torsoWidthScale: clamp((garmentWidth / headWidth) / 2.2, 0.88, 1.22),
    torsoSourceBottom: clamp(
      (garmentBottom - garmentTop) / (expectedHem - garmentTop),
      0.25,
      1,
    ),
    appearanceSampling: {
      head: sampleEvidence(head.length), skin: sampleEvidence(skinCandidates.length),
      hair: sampleEvidence(crownColors.length), shirt: sampleEvidence(shirtColors.length),
      pants: sampleEvidence(pantsColors.length), shoes: sampleEvidence(0),
    },
  };
  return pose ? refinePoseGarmentAppearance(appearance, pose, source, mask, excludedMasks) : appearance;
}

/** Sample clothing inside the measured shoulder/hip quadrilateral. A mask-top
 * chest crop assumes a standing body and can pick seated trousers as a coat.
 * This changes only garment appearance; it never repairs masks or landmark scores. */
export function refinePoseGarmentAppearance(
  appearance: HumanAppearance,
  pose: HumanPose,
  source: VolumePixels,
  mask: VolumePixels,
  excludedMasks: VolumePixels[] = [],
): HumanAppearance {
  const evidence: NonNullable<HumanAppearance["garmentSampling"]> = {
    source: "measured-torso", status: "insufficient-support", candidateSamples: 0,
    maskSamples: 0, excludedSamples: 0, sampleCount: 0,
  };
  const fallback = () => ({ ...appearance, garmentSampling: evidence });
  const reliable = (index: number) => {
    const point = pose.landmarks[index];
    return point && Math.min(point.visibility, point.presence) >= .6 &&
      point.image.slice(0, 2).every(value => Number.isFinite(value) && value >= 0 && value <= 1);
  };
  if (!(pose.confidence >= .4) || ![11, 12, 23, 24].every(reliable) ||
    source.width < 2 || source.height < 2 || mask.width < 2 || mask.height < 2) return fallback();
  type Point = [number, number];
  const xy = (index: number): Point => [pose.landmarks[index].image[0] * source.width,
    pose.landmarks[index].image[1] * source.height];
  const [a, b, c, d] = [11, 12, 23, 24].map(xy);
  const lerp = (p: Point, q: Point, t: number): Point => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const torsoPoint = (u: number, v: number) => lerp(lerp(a, c, v), lerp(b, d, v), u);
  const shoulderWidth = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const torsoHeight = Math.hypot((a[0] + b[0] - c[0] - d[0]) / 2, (a[1] + b[1] - c[1] - d[1]) / 2);
  if (shoulderWidth < 8 || torsoHeight < 10) return fallback();
  const distanceToSegment = (p: Point, start: Point, end: Point) => {
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const t = clamp(((p[0] - start[0]) * dx + (p[1] - start[1]) * dy) / Math.max(1, dx * dx + dy * dy));
    return Math.hypot(p[0] - start[0] - dx * t, p[1] - start[1] - dy * t);
  };
  const hands = [15, 16].filter(reliable).map(xy);
  const forearms = [[13, 15], [14, 16]].filter(pair => pair.every(reliable)).map(pair => pair.map(xy));
  const maskAt = (pixels: VolumePixels, p: Point) => {
    const x = Math.floor(p[0] / source.width * pixels.width), y = Math.floor(p[1] / source.height * pixels.height);
    const offset = (y * pixels.width + x) * 4;
    return x >= 0 && x < pixels.width && y >= 0 && y < pixels.height &&
      pixels.data[offset] >= 128 && Number(pixels.data[offset + 3]) === 255;
  };
  const colors: RGB[] = [];
  for (let row = 0; row < 30; row++) for (let column = 0; column < 36; column++) {
    // Stop above the pelvis, where crossed knees and held objects commonly cover a seated coat.
    const point = torsoPoint(.08 + (column + .5) / 36 * .84, .14 + (row + .5) / 30 * .64);
    evidence.candidateSamples++;
    if (!maskAt(mask, point)) continue;
    evidence.maskSamples++;
    const x = Math.min(source.width - 1, Math.max(0, Math.floor(point[0])));
    const y = Math.min(source.height - 1, Math.max(0, Math.floor(point[1])));
    const handCovered = hands.some(hand => Math.hypot(point[0] - hand[0], point[1] - hand[1]) < shoulderWidth * .13);
    const armCovered = forearms.some(([elbow, wrist]) => distanceToSegment(point, elbow, wrist) < shoulderWidth * .075);
    if (handCovered || armCovered || excludedMasks.some(exclusion => coveredSourcePixel(exclusion, source, x, y))) {
      evidence.excludedSamples++; continue;
    }
    const color = observedSourceColor(source, x, y);
    if (!color) continue;
    colors.push(color);
  }
  evidence.sampleCount = colors.length;
  if (colors.length < 32 || evidence.maskSamples / evidence.candidateSamples < .3 || colors.length / evidence.candidateSamples < .12) return fallback();
  const bounds = (u0: number, u1: number, v0: number, v1: number): PhotoBox => {
    const points = [torsoPoint(u0, v0), torsoPoint(u1, v0), torsoPoint(u0, v1), torsoPoint(u1, v1)];
    return [clamp(Math.min(...points.map(p => p[1])) / source.height), clamp(Math.min(...points.map(p => p[0])) / source.width),
      clamp(Math.max(...points.map(p => p[1])) / source.height), clamp(Math.max(...points.map(p => p[0])) / source.width)];
  };
  evidence.status = "measured";
  const selected = dominantColor(colors, [105, 105, 105]);
  const monochrome = [appearance.skinColor, appearance.hairColor, appearance.pantsColor]
    .every(color => color.slice(1, 3) === color.slice(3, 5) && color.slice(3, 5) === color.slice(5, 7));
  const gray = Math.round(brightness(selected));
  return { ...appearance, shirtColor: hex(monochrome ? [gray, gray, gray] : selected),
    chestBox: bounds(.08, .92, .14, .78), torsoBox: bounds(0, 1, 0, 1), garmentSampling: evidence,
    ...(appearance.appearanceSampling ? { appearanceSampling: { ...appearance.appearanceSampling, shirt: sampleEvidence(colors.length) } } : {}) };
}
