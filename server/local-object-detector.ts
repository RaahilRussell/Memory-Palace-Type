import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  boxOverlap,
  objectDetectionSchema,
  type ObjectDetection,
  type ObjectRecognizer,
  type ObjectRecognitionContext,
  objectHintCategories,
} from "./object-recognition.js";
import {
  MEMORY_OBJECT_CATEGORIES,
  MEMORY_OBJECT_PROFILES,
  MAX_MEMORY_OBJECTS,
  memoryObjectPolicy,
  type MemoryObjectCategory,
  type ObjectRecognitionCoverage,
  isObjectRecognitionCoverage,
  type MemoryObjectEvidence,
} from "../src/memory-objects.js";
import {
  silhouettePrompts,
  selectObjectSilhouette,
  type SilhouetteAudit,
} from "./object-silhouette.js";
import { useLocalModelCache } from './model-cache.js';

// Quality policy revisions re-enrich worlds but replay the same native inference
// audit. Changing this policy must not discard the expensive v7 model evidence.
export const LOCAL_OBJECT_INFERENCE_VERSION = "owlv2-dino-slimsam-v7-taxonomy";
export const LOCAL_OBJECT_MODEL_VERSION = `${LOCAL_OBJECT_INFERENCE_VERSION}-quality-v1`;
export const LOCAL_OBJECT_MODELS = {
  proposal: "Xenova/owlv2-base-patch16-ensemble",
  confirmation: "onnx-community/grounding-dino-tiny-ONNX",
  silhouette: "Xenova/slimsam-77-uniform",
} as const;

export const LOCAL_OBJECT_CATEGORY_QUERIES = Object.fromEntries(
  MEMORY_OBJECT_CATEGORIES.map((category) => {
    const query = MEMORY_OBJECT_PROFILES[category].query;
    const article = /^[aeiou]/i.test(query) ? "an" : "a";
    return [
      category,
      { owl: `a photo of ${article} ${query}`, dino: `${article} ${query}.` },
    ];
  }),
) as Record<MemoryObjectCategory, { owl: string; dino: string }>;
// Preserve the calibrated short can query for confirmation.
LOCAL_OBJECT_CATEGORY_QUERIES["drink-can"].dino = "a can.";
const queries = LOCAL_OBJECT_CATEGORY_QUERIES;
// Reusable drink containers are often called thermoses rather than water bottles.
// Aliases compete with the same negative labels; they do not bypass confirmation.
const queryAliases: [MemoryObjectCategory, string][] = [
  ["water-bottle", "a photo of a thermos"],
  ["water-bottle", "a photo of a reusable bottle"],
  ["water-bottle", "a photo of an insulated bottle"],
  ["drink-can", "a photo of a soda can"],
  ["chip-bag", "a photo of a snack bag"],
];
// Unrelated physical categories and depictions compete without becoming supported props.
const negativeQueries = [
  "a photo of a hand",
  "a photo of a person",
  "a photo of a grave marker",
  "a photo of a wine bottle",
  "a photo of a candle",
  "a photo of a wooden cross",
  "a photo of a printed picture of an object",
];
export const LOCAL_OBJECT_QUERIES = [
  ...new Set([
    ...Object.values(queries).map((q) => q.owl),
    ...queryAliases.map(([, query]) => query),
    ...negativeQueries,
  ]),
];
export const LOCAL_CATEGORY_SEARCH_BUDGET = 24;
export const LOCAL_CATEGORY_CONFIRMATION_BUDGET = 12;
/** Evidence first, then a bounded common-category pass. Unsearched vocabulary remains explicit. */
export function localObjectSearchPlan(context?: ObjectRecognitionContext) {
  const common: MemoryObjectCategory[] = [
    "table",
    "chair",
    "umbrella",
    "round-table",
    "cup",
    "glass",
    "plate",
    "food-container",
    "bag",
    "food",
    "television",
    "speaker",
  ];
  const disambiguators: MemoryObjectCategory[] = [
    "book",
    "cup",
    "glass",
    "speaker",
  ];
  const requested = [
    ...new Set([
      ...disambiguators,
      ...objectHintCategories(context),
      ...MEMORY_OBJECT_CATEGORIES.slice(0, 8),
      ...common,
      ...MEMORY_OBJECT_CATEGORIES,
    ]),
  ];
  const searchedCategories = requested.slice(0, LOCAL_CATEGORY_SEARCH_BUDGET);
  return {
    searchedCategories,
    unsearchedCategories: requested.slice(LOCAL_CATEGORY_SEARCH_BUDGET),
  };
}
/** Hints select vocabulary only. Location and silhouette still require the independent models. */
export function localObjectQueries(
  context?: ObjectRecognitionContext,
  smallOnly = false,
) {
  const selected = localObjectSearchPlan(context).searchedCategories.filter(
    (c) => !smallOnly || memoryObjectPolicy(c).interaction === "movable",
  );
  return [
    ...new Set([
      ...selected.map((c) => queries[c].owl),
      ...queryAliases.filter(([c]) => selected.includes(c)).map(([, q]) => q),
      ...negativeQueries,
    ]),
  ];
}
export function localObjectQueryBatches(
  context?: ObjectRecognitionContext,
  smallOnly = false,
) {
  const positives = localObjectQueries(context, smallOnly).filter(
    (query) => !negativeQueries.includes(query),
  );
  const batches: string[][] = [];
  for (let at = 0; at < positives.length; at += 12)
    batches.push([...positives.slice(at, at + 12), ...negativeQueries]);
  return batches;
}
const categoryByQuery = new Map<string, MemoryObjectCategory>([
  ...Object.entries(queries).map(
    ([category, q]) =>
      [q.owl, category as MemoryObjectCategory] as [
        string,
        MemoryObjectCategory,
      ],
  ),
  ...queryAliases.map(
    ([category, query]) => [query, category] as [string, MemoryObjectCategory],
  ),
]);
export type RawObjectPrediction = {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
};
export type LocalObjectProposal = {
  category: MemoryObjectCategory;
  score: number;
  box: [number, number, number, number];
};

const normalizeConfirmationLabel = (label: string) =>
  label
    .toLowerCase()
    .replace(/[_.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:a|an|the) /, "")
    .trim();
/** DINO returns decoded text, not the requested category. Require a complete
 * canonical phrase or explicit alias; generic/truncated tokens cannot confirm it. */
export function matchesObjectConfirmationLabel(
  category: MemoryObjectCategory,
  label: string,
): boolean {
  if (typeof label !== "string" || label.length > 160) return false;
  const normalized = normalizeConfirmationLabel(label);
  const profile = MEMORY_OBJECT_PROFILES[category];
  return [
    category,
    profile.query,
    queries[category].dino,
    ...profile.aliases,
  ].some((alias) => normalizeConfirmationLabel(alias) === normalized);
}

/** OWL scores and DINO scores have different scales; neither is a probability of correctness. */
export function selectObjectProposals(
  raw: RawObjectPrediction[],
  width: number,
  height: number,
): LocalObjectProposal[] {
  if (!(width > 0 && height > 0)) return [];
  const bounded = raw
    .flatMap((value) => {
      const numbers = [
        value.score,
        value.box?.xmin,
        value.box?.ymin,
        value.box?.xmax,
        value.box?.ymax,
      ];
      if (
        !numbers.every(Number.isFinite) ||
        value.score < 0.2 ||
        value.score > 1
      )
        return [];
      const box: LocalObjectProposal["box"] = [
        Math.max(0, value.box.ymin),
        Math.max(0, value.box.xmin),
        Math.min(height, value.box.ymax),
        Math.min(width, value.box.xmax),
      ];
      const area = (box[2] - box[0]) * (box[3] - box[1]);
      if (
        box[2] - box[0] < 8 ||
        box[3] - box[1] < 8 ||
        area >
          width *
            height *
            (categoryByQuery.has(value.label) &&
            memoryObjectPolicy(categoryByQuery.get(value.label)!)
              .interaction !== "movable"
              ? 0.995
              : 0.65)
      )
        return [];
      return [{ label: value.label, score: value.score, box }];
    })
    .sort((a, b) => b.score - a.score);
  const selected: LocalObjectProposal[] = [];
  for (const candidate of bounded) {
    const category = categoryByQuery.get(candidate.label);
    if (!category) continue;
    if (
      bounded.some(
        (other) =>
          other.label !== candidate.label &&
          other.score > candidate.score &&
          boxOverlap(candidate.box, other.box) > 0.65,
      )
    )
      continue;
    if (selected.some((other) => boxOverlap(candidate.box, other.box) > 0.5))
      continue;
    selected.push({ category, score: candidate.score, box: candidate.box });
    if (selected.length === MAX_MEMORY_OBJECTS) break;
  }
  return selected;
}

/** Require a second independently trained detector to agree on location. */
export function confirmObjectProposal(
  proposal: LocalObjectProposal,
  confirmations: RawObjectPrediction[],
): LocalObjectProposal | undefined {
  // Packaging with printed electronics can weakly resemble a laptop to both
  // detectors. Keep weak proposals only when the independent confirmation is
  // strong; a strong OWL proposal still uses the usual confirmation threshold.
  const minimumConfirmation =
    proposal.category === "laptop" && proposal.score < 0.3 ? 0.6 : 0.4;
  const matches = confirmations
    .filter(
      (value) =>
        matchesObjectConfirmationLabel(proposal.category, value.label) &&
        !!value.box &&
        Number.isFinite(value.score) &&
        value.score >= minimumConfirmation &&
        value.score <= 1,
    )
    .map((value) => ({
      score: value.score,
      box: [
        value.box.ymin,
        value.box.xmin,
        value.box.ymax,
        value.box.xmax,
      ] as LocalObjectProposal["box"],
    }))
    .filter(
      (value) =>
        value.box.every(Number.isFinite) &&
        boxOverlap(proposal.box, value.box) >= 0.35,
    )
    .sort((a, b) => b.score - a.score);
  return matches[0]
    ? { category: proposal.category, ...matches[0] }
    : undefined;
}

/** Deterministic quality replay from the existing native audit. It never infers
 * a replacement class, and it never treats SAM's mask score as class evidence. */
export function localObjectEvidence(
  object: ObjectDetection,
  audit: unknown,
  width: number,
  height: number,
): MemoryObjectEvidence {
  const result: MemoryObjectEvidence = {
    version: 1,
    source: "local-detector",
    proposalConfidence: 0,
    confirmationConfidence: 0,
    confirmation: "unavailable",
    labelMatched: false,
    conflictingCategories: [],
  };
  if (!audit || typeof audit !== "object" || !(width > 0 && height > 0))
    return result;
  const record = audit as Record<string, unknown>;
  const finiteScore = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const canonical = (n: unknown): n is MemoryObjectCategory =>
    MEMORY_OBJECT_CATEGORIES.includes(n as MemoryObjectCategory);
  const boundedBox = (b: unknown): b is LocalObjectProposal["box"] =>
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
    b[0] < b[2] &&
    b[1] < b[3] &&
    b[2] <= height &&
    b[3] <= width;
  const proposals = (value: unknown): LocalObjectProposal[] =>
    !Array.isArray(value)
      ? []
      : value
          .slice(0, MAX_MEMORY_OBJECTS)
          .filter(
            (p): p is LocalObjectProposal =>
              p &&
              canonical(p.category) &&
              finiteScore(p.score) &&
              boundedBox(p.box),
          );
  const maskBox = object.box_2d.map(
    (n, index) => (n / 1000) * (index % 2 ? width : height),
  ) as LocalObjectProposal["box"];
  // Associate the polygon back to its learned box; the mask may omit occluded parts.
  const candidate = proposals(record.confirmed)
    .filter(
      (p) =>
        p.category === object.category && boxOverlap(p.box, maskBox) >= 0.35,
    )
    .sort((a, b) => boxOverlap(b.box, maskBox) - boxOverlap(a.box, maskBox))[0];
  const box = candidate?.box ?? maskBox;
  result.proposalConfidence = Math.max(
    0,
    ...proposals(record.proposals)
      .filter(
        (p) =>
          mayConfirmCategory(p, object.category) &&
          boxOverlap(p.box, box) >= 0.35,
      )
      .map((p) => p.score),
  );
  const matches: {
    category: MemoryObjectCategory;
    score: number;
    crop: boolean;
    labelMatched: boolean;
  }[] = [];
  if (Array.isArray(record.confirmations))
    for (const entry of record.confirmations.slice(0, 64)) {
      if (
        !entry ||
        !canonical(entry.category) ||
        !Array.isArray(entry.detections)
      )
        continue;
      // A malformed crop marker must never be mistaken for whole-image evidence.
      const crop = entry.crop !== undefined;
      for (const detection of entry.detections.slice(0, 128)) {
        if (
          !detection ||
          !finiteScore(detection.score) ||
          detection.score < 0.4 ||
          !detection.box
        )
          continue;
        const bounds = [
          detection.box.ymin,
          detection.box.xmin,
          detection.box.ymax,
          detection.box.xmax,
        ];
        if (!boundedBox(bounds) || boxOverlap(bounds, box) < 0.65) continue;
        matches.push({
          category: entry.category,
          score: detection.score,
          crop,
          labelMatched: matchesObjectConfirmationLabel(
            entry.category,
            detection.label,
          ),
        });
      }
    }
  const own = matches
    .filter((match) => match.category === object.category)
    .sort(
      (a, b) =>
        Number(b.labelMatched) - Number(a.labelMatched) ||
        Number(a.crop) - Number(b.crop) ||
        b.score - a.score,
    )[0];
  if (own) {
    result.confirmation = own.crop ? "crop" : "full-image";
    result.confirmationConfidence = own.score;
    result.labelMatched = own.labelMatched;
  }
  const compatible = (category: MemoryObjectCategory) =>
    category === object.category ||
    (["table", "round-table"].includes(category) &&
      ["table", "round-table"].includes(object.category)) ||
    (["water-bottle", "drink-can"].includes(category) &&
      ["water-bottle", "drink-can"].includes(object.category));
  result.conflictingCategories = [
    ...new Set(
      matches
        .filter(
          (match) =>
            !match.crop && match.labelMatched && !compatible(match.category),
        )
        .map((match) => match.category),
    ),
  ]
    .sort()
    .slice(0, 12);
  return result;
}

/** Only ambiguous container proposals may change class on the second detector.
 * A confidently proposed thermos must not become a can just because DINO gives
 * that cylindrical distractor a higher score in the full crowded image. */
export function mayConfirmCategory(
  proposal: LocalObjectProposal,
  category: MemoryObjectCategory,
) {
  return (
    proposal.category === category ||
    (proposal.score < 0.45 &&
      ["drink-can", "water-bottle"].includes(proposal.category) &&
      ["drink-can", "water-bottle"].includes(category))
  );
}

/** A small contextual crop increases an uncertain object's effective resolution
 * without supplying a manual box: only learned proposals may request one. */
export function confirmationCrop(
  box: LocalObjectProposal["box"],
  width: number,
  height: number,
) {
  const [top, left, bottom, right] = box,
    bw = right - left,
    bh = bottom - top;
  const x = Math.max(0, Math.floor(left - bw * 0.15));
  const y = Math.max(0, Math.floor(top - bh * 0.15));
  return {
    left: x,
    top: y,
    width: Math.min(width - x, Math.ceil(right + bw * 0.15) - x),
    height: Math.min(height - y, Math.ceil(bottom + bh * 0.15) - y),
  };
}

type Point = [number, number];
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  const a = points[0],
    b = points[points.length - 1];
  let maxDistance = 0,
    index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i],
      dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(
        1,
        ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1),
      ),
    );
    const distance = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  return maxDistance > tolerance
    ? [
        ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
        ...simplify(points.slice(index), tolerance),
      ]
    : [a, b];
}

/** Trace the largest connected learned mask, retaining concavities (e.g. fingers occluding a can). */
export function maskToPolygon(
  mask: Uint8Array,
  width: number,
  height: number,
): Point[] {
  if (mask.length !== width * height || width < 2 || height < 2) return [];
  const visited = new Uint8Array(mask.length),
    queue = new Int32Array(mask.length);
  let largest: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || visited[i]) continue;
    let start = 0,
      end = 1;
    queue[0] = i;
    visited[i] = 1;
    while (start < end) {
      const j = queue[start++],
        x = j % width,
        y = Math.floor(j / width);
      for (const n of [
        x > 0 ? j - 1 : -1,
        x + 1 < width ? j + 1 : -1,
        y > 0 ? j - width : -1,
        y + 1 < height ? j + width : -1,
      ])
        if (n >= 0 && mask[n] && !visited[n]) {
          visited[n] = 1;
          queue[end++] = n;
        }
    }
    if (end > largest.length) largest = Array.from(queue.slice(0, end));
  }
  if (largest.length < 8) return [];
  const component = new Uint8Array(mask.length);
  for (const i of largest) component[i] = 1;
  const edges = new Map<number, number[]>(),
    stride = width + 1;
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    const key = ay * stride + ax;
    edges.set(key, [...(edges.get(key) || []), by * stride + bx]);
  };
  for (const i of largest) {
    const x = i % width,
      y = Math.floor(i / width);
    if (!y || !component[i - width]) edge(x, y, x + 1, y);
    if (x === width - 1 || !component[i + 1]) edge(x + 1, y, x + 1, y + 1);
    if (y === height - 1 || !component[i + width]) edge(x + 1, y + 1, x, y + 1);
    if (!x || !component[i - 1]) edge(x, y + 1, x, y);
  }
  let outline: Point[] = [];
  while (edges.size) {
    const first = edges.keys().next().value as number;
    const loop: Point[] = [];
    let current = first;
    do {
      loop.push([current % stride, Math.floor(current / stride)]);
      const next = edges.get(current);
      if (!next?.length) break;
      const target = next.pop()!;
      if (!next.length) edges.delete(current);
      current = target;
    } while (current !== first && loop.length <= mask.length * 4);
    if (loop.length > outline.length) outline = loop;
  }
  outline.push(outline[0]);
  let tolerance = 0.6,
    reduced = simplify(outline, tolerance).slice(0, -1);
  while (reduced.length > 96) {
    tolerance *= 1.4;
    reduced = simplify(outline, tolerance).slice(0, -1);
  }
  return reduced.length >= 3 ? reduced : [];
}

type Runtime = {
  detect(
    image: Buffer,
    context?: ObjectRecognitionContext,
  ): Promise<{
    objects: ObjectDetection[];
    coverage?: ObjectRecognitionCoverage;
    proposals: LocalObjectProposal[];
    confirmed: LocalObjectProposal[];
    silhouettes?: {
      category: MemoryObjectCategory;
      box: LocalObjectProposal["box"];
      channels: SilhouetteAudit[];
    }[];
    confirmations?: {
      category: MemoryObjectCategory;
      crop?: ReturnType<typeof confirmationCrop>;
      detections: RawObjectPrediction[];
    }[];
  }>;
};
let inferenceQueue: Promise<unknown> = Promise.resolve();

function createRuntime(cacheDir: string): Runtime {
  return {
    async detect(image, context) {
      const { pipeline, RawImage, SamModel, AutoProcessor } =
        await import("@huggingface/transformers");
      await useLocalModelCache(cacheDir);
      const imageData = await sharp(image, { limitInputPixels: 40_000_000 })
        .rotate()
        .toColourspace("srgb")
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { width, height } = imageData.info;
      const rawImage = new RawImage(imageData.data, width, height, 3);
      const modelOptions = {
        device: "cpu" as const,
        cache_dir: cacheDir,
        // Do not retain large native workspaces between category queries/models.
        session_options: {
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
          enableCpuMemArena: false,
          enableMemPattern: false,
        },
      };
      let proposals: LocalObjectProposal[];
      const plan = localObjectSearchPlan(context);
      const coverage: ObjectRecognitionCoverage = {
        strategy: "local-evidence-priority",
        ...plan,
        unconfirmedCategories: [],
        candidateLimitReached: false,
        objectLimitReached: false,
      };
      // Release each model before loading the next: this runs alongside depth and
      // people models on a 12 GB Windows machine, not on a dedicated GPU server.
      const owl = await pipeline(
        "zero-shot-object-detection",
        LOCAL_OBJECT_MODELS.proposal,
        { ...modelOptions, dtype: "q8" },
      );
      try {
        const predictions: RawObjectPrediction[] = [];
        for (const batch of localObjectQueryBatches(context))
          predictions.push(...(await owl(rawImage, batch, { threshold: 0.2 })));
        // At most two focused searches for small, semantically observed items. The
        // supplied rectangle selects context only; OWL, DINO and SAM still establish evidence.
        const crops = (context?.inventory ?? [])
          .flatMap((item) => {
            const category =
              item.category ??
              (item.label
                ? objectHintCategories({ inventory: [item] })[0]
                : undefined);
            const b = item.box;
            if (
              !category ||
              memoryObjectPolicy(category).interaction !== "movable" ||
              !b ||
              b.length !== 4 ||
              !b.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
              b[0] >= b[2] ||
              b[1] >= b[3] ||
              (item.confidence ?? 0) < 0.55
            )
              return [];
            const area = (b[2] - b[0]) * (b[3] - b[1]);
            if (
              area > 0.12 ||
              area < 0.0001 ||
              !plan.searchedCategories.includes(category)
            )
              return [];
            return [
              {
                category,
                area,
                box: confirmationCrop(
                  [b[0] * height, b[1] * width, b[2] * height, b[3] * width],
                  width,
                  height,
                ),
              },
            ];
          })
          .sort((a, b) => a.area - b.area)
          .slice(0, 2);
        for (const crop of crops) {
          const pixels = await sharp(image)
            .rotate()
            .extract(crop.box)
            .toColourspace("srgb")
            .removeAlpha()
            .raw()
            .toBuffer();
          const detections = await owl(
            new RawImage(pixels, crop.box.width, crop.box.height, 3),
            [queries[crop.category].owl, ...negativeQueries],
            { threshold: 0.2 },
          );
          for (const detection of detections)
            predictions.push({
              ...detection,
              box: {
                xmin: detection.box.xmin + crop.box.left,
                ymin: detection.box.ymin + crop.box.top,
                xmax: detection.box.xmax + crop.box.left,
                ymax: detection.box.ymax + crop.box.top,
              },
            });
        }
        proposals = selectObjectProposals(predictions, width, height);
        coverage.candidateLimitReached = proposals.length >= MAX_MEMORY_OBJECTS;
      } finally {
        await owl.dispose();
        globalThis.gc?.();
      }
      if (!proposals.length)
        return { objects: [], proposals, confirmed: [], coverage };
      const confirmed: LocalObjectProposal[] = [];
      const confirmations: {
        category: MemoryObjectCategory;
        crop?: ReturnType<typeof confirmationCrop>;
        detections: RawObjectPrediction[];
      }[] = [];
      const dino = await pipeline(
        "zero-shot-object-detection",
        LOCAL_OBJECT_MODELS.confirmation,
        { ...modelOptions, dtype: "fp32" },
      );
      try {
        // This model/runtime misattributed labels in concatenated-query trials.
        // Separate category queries avoid that ambiguity. Keep its native 800×800 input:
        // resizing the exported processor produces incorrectly scaled boxes.
        const categories = new Set(proposals.map((p) => p.category));
        // Cans and bottles share container features, especially behind a hand.
        // Resolve that ambiguity using independent single-category DINO scores,
        // rather than letting the first OWL label determine the final geometry.
        if (categories.has("drink-can") || categories.has("water-bottle")) {
          categories.add("drink-can");
          categories.add("water-bottle");
        }
        const candidates: LocalObjectProposal[] = [];
        const confirmationCategories = [...categories].slice(
          0,
          LOCAL_CATEGORY_CONFIRMATION_BUDGET,
        );
        for (const category of confirmationCategories) {
          const detections = await dino(rawImage, [queries[category].dino], {
            threshold: 0.4,
          });
          confirmations.push({ category, detections });
          for (const proposal of proposals.filter((p) =>
            mayConfirmCategory(p, category),
          )) {
            const match = confirmObjectProposal(
              { ...proposal, category },
              detections,
            );
            if (match) {
              match.box = [
                Math.max(0, match.box[0]),
                Math.max(0, match.box[1]),
                Math.min(height, match.box[2]),
                Math.min(width, match.box[3]),
              ];
              if (
                match.box[2] - match.box[0] >= 8 &&
                match.box[3] - match.box[1] >= 8
              )
                candidates.push(match);
            }
          }
        }
        // Retry only the four strongest missed proposals. Keep independent
        // confirmation/overlap thresholds; never turn an OWL box into a prop by
        // itself. Tight context avoids a distant bottle stealing a thermos query.
        const missed = proposals
          .filter(
            (p) =>
              confirmationCategories.includes(p.category) &&
              p.score >= 0.3 &&
              !candidates.some(
                (c) =>
                  c.category === p.category && boxOverlap(c.box, p.box) >= 0.35,
              ),
          )
          .slice(0, 4);
        for (const proposal of missed) {
          const cropBounds = confirmationCrop(proposal.box, width, height);
          const pixels = await sharp(image)
            .rotate()
            .extract(cropBounds)
            .toColourspace("srgb")
            .removeAlpha()
            .raw()
            .toBuffer();
          const cropImage = new RawImage(
            pixels,
            cropBounds.width,
            cropBounds.height,
            3,
          );
          const cropQueries =
            proposal.category === "water-bottle"
              ? ["a water bottle.", "a thermos."]
              : [queries[proposal.category].dino];
          for (const query of cropQueries) {
            const detections = (
              await dino(cropImage, [query], { threshold: 0.4 })
            ).map((d) => ({
              ...d,
              box: {
                xmin: d.box.xmin + cropBounds.left,
                ymin: d.box.ymin + cropBounds.top,
                xmax: d.box.xmax + cropBounds.left,
                ymax: d.box.ymax + cropBounds.top,
              },
            }));
            confirmations.push({
              category: proposal.category,
              crop: cropBounds,
              detections,
            });
            const match = confirmObjectProposal(proposal, detections);
            if (match) {
              match.box = [
                Math.max(0, match.box[0]),
                Math.max(0, match.box[1]),
                Math.min(height, match.box[2]),
                Math.min(width, match.box[3]),
              ];
              if (
                match.box[2] - match.box[0] >= 8 &&
                match.box[3] - match.box[1] >= 8
              ) {
                candidates.push(match);
                break;
              }
            }
          }
        }
        for (const candidate of candidates.sort((a, b) => b.score - a.score))
          if (
            !confirmed.some(
              (value) => boxOverlap(value.box, candidate.box) > 0.5,
            )
          )
            confirmed.push(candidate);
      } finally {
        await dino.dispose();
        globalThis.gc?.();
      }
      coverage.unconfirmedCategories = [
        ...new Set(
          proposals
            .map((p) => p.category)
            .filter(
              (category) =>
                !confirmed.some((item) => item.category === category),
            ),
        ),
      ];
      if (!confirmed.length)
        return { objects: [], proposals, confirmed, confirmations, coverage };
      const sam = await SamModel.from_pretrained(
        LOCAL_OBJECT_MODELS.silhouette,
        { ...modelOptions, dtype: "q8" },
      );
      const objects: ObjectDetection[] = [];
      const silhouettes: {
        category: MemoryObjectCategory;
        box: LocalObjectProposal["box"];
        channels: SilhouetteAudit[];
      }[] = [];
      try {
        const processor = (await AutoProcessor.from_pretrained(
          LOCAL_OBJECT_MODELS.silhouette,
          { cache_dir: cacheDir },
        )) as import("@huggingface/transformers").SamProcessor;
        for (const candidate of confirmed) {
          const [top, left, bottom, right] = candidate.box;
          const bw = right - left,
            bh = bottom - top;
          const cropLeft = Math.max(0, Math.floor(left - bw * 0.4)),
            cropTop = Math.max(0, Math.floor(top - bh * 0.4));
          const cropWidth = Math.min(
            width - cropLeft,
            Math.ceil(right + bw * 0.4) - cropLeft,
          );
          const cropHeight = Math.min(
            height - cropTop,
            Math.ceil(bottom + bh * 0.4) - cropTop,
          );
          if (!(cropWidth >= 8 && cropHeight >= 8)) continue;
          const crop = await sharp(image)
            .rotate()
            .extract({
              left: cropLeft,
              top: cropTop,
              width: cropWidth,
              height: cropHeight,
            })
            .resize({
              width: 512,
              height: 512,
              fit: "inside",
              withoutEnlargement: true,
            })
            .toColourspace("srgb")
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          const sw = crop.info.width,
            sh = crop.info.height,
            sx = sw / cropWidth,
            sy = sh / cropHeight;
          const cropBounds = {
            left: cropLeft,
            top: cropTop,
            width: cropWidth,
            height: cropHeight,
          };
          const inputs = await processor(
            new RawImage(crop.data, sw, sh, 3),
            silhouettePrompts(
              candidate.box,
              cropBounds,
              { width: sw, height: sh },
              candidate.category,
            ),
          );
          const output = await sam(inputs);
          const masks = await processor.post_process_masks(
            output.pred_masks,
            inputs.original_sizes,
            inputs.reshaped_input_sizes,
          );
          const scores = Array.from(output.iou_scores.data as Float32Array);
          const selected = selectObjectSilhouette({
            channels: scores.map((score, index) => ({
              score,
              data: (masks[0].data as Uint8Array).slice(
                index * sw * sh,
                (index + 1) * sw * sh,
              ),
            })),
            width: sw,
            height: sh,
            box: candidate.box,
            crop: cropBounds,
            category: candidate.category,
          });
          silhouettes.push({
            category: candidate.category,
            box: candidate.box,
            channels: selected.audit,
          });
          if (selected.mask) {
            const mask = selected.mask;
            const polygon = maskToPolygon(mask, sw, sh).map(
              ([x, y]) =>
                [
                  Math.max(
                    0,
                    Math.min(1000, ((x / sx + cropLeft) / width) * 1000),
                  ),
                  Math.max(
                    0,
                    Math.min(1000, ((y / sy + cropTop) / height) * 1000),
                  ),
                ] as Point,
            );
            if (polygon.length < 3) continue;
            const xs = polygon.map((p) => p[0]),
              ys = polygon.map((p) => p[1]);
            objects.push({
              category: candidate.category,
              label: candidate.category.replaceAll("-", " "),
              confidence: candidate.score,
              box_2d: [
                Math.min(...ys),
                Math.min(...xs),
                Math.max(...ys),
                Math.max(...xs),
              ],
              polygon,
            });
          }
        }
      } finally {
        await sam.dispose();
        globalThis.gc?.();
      }
      coverage.unconfirmedCategories = [
        ...new Set(
          proposals
            .map((p) => p.category)
            .filter(
              (category) => !objects.some((item) => item.category === category),
            ),
        ),
      ];
      coverage.objectLimitReached = objects.length >= MAX_MEMORY_OBJECTS;
      return {
        objects: objectDetectionSchema.parse({ objects }).objects,
        coverage,
        proposals,
        confirmed,
        silhouettes,
        confirmations,
      };
    },
  };
}

/** Entire inference is local after the initial public model downloads; no API keys or quota. */
export function localObjectRecognizer(
  cacheDir: string,
  options: { resultDirectory?: string; runtime?: Runtime } = {},
): ObjectRecognizer {
  const resultDirectory =
    options.resultDirectory ?? path.join(cacheDir, "object-detections");
  const runtime = options.runtime ?? createRuntime(cacheDir);
  const withEvidence = async (
    objects: ObjectDetection[],
    audit: unknown,
    image: Buffer,
  ) => {
    if (!objects.length) return objects;
    let width = 0,
      height = 0;
    try {
      const metadata = await sharp(image, {
        limitInputPixels: 40_000_000,
      }).metadata();
      const rotated = (metadata.orientation ?? 1) >= 5;
      width = (rotated ? metadata.height : metadata.width) ?? 0;
      height = (rotated ? metadata.width : metadata.height) ?? 0;
    } catch {
      // Missing dimensions downgrade the evidence rather than rerunning models.
    }
    return objects.map((object) => ({
      ...object,
      evidence: localObjectEvidence(object, audit, width, height),
    }));
  };
  return (image, context) => {
    const task = inferenceQueue
      .catch(() => {})
      .then(async () => {
        const digest = createHash("sha256")
          .update(LOCAL_OBJECT_INFERENCE_VERSION)
          .update(image)
          .update(
            JSON.stringify({
              categories: objectHintCategories(context),
              boxes: (context?.inventory ?? [])
                .slice(0, MAX_MEMORY_OBJECTS)
                .map((item) => ({
                  category: item.category,
                  box: item.box,
                  confidence: item.confidence,
                })),
            }),
          )
          .digest("hex");
        const file = path.join(resultDirectory, `${digest}.json`);
        try {
          const cached = JSON.parse(await readFile(file, "utf8"));
          if (
            cached.version === LOCAL_OBJECT_INFERENCE_VERSION &&
            cached.digest === digest
          )
            return Object.assign(
              await withEvidence(
                objectDetectionSchema.parse(cached).objects,
                cached,
                image,
              ),
              isObjectRecognitionCoverage(cached.coverage)
                ? { coverage: cached.coverage }
                : {},
            );
        } catch {
          /* Missing/invalid cache is recomputed; failures are never cached as empty success. */
        }
        const result = await runtime.detect(image, context);
        const objects = await withEvidence(
          objectDetectionSchema.parse(result).objects,
          result,
          image,
        );
        await mkdir(resultDirectory, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(
          temporary,
          JSON.stringify({
            version: LOCAL_OBJECT_INFERENCE_VERSION,
            qualityVersion: LOCAL_OBJECT_MODEL_VERSION,
            digest,
            models: LOCAL_OBJECT_MODELS,
            hintCategories: objectHintCategories(context),
            ...result,
            objects,
          }),
        );
        await rename(temporary, file);
        return Object.assign(
          objects,
          result.coverage ? { coverage: result.coverage } : {},
        );
      });
    inferenceQueue = task;
    return task;
  };
}
