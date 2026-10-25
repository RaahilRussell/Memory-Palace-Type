import {
  MEMORY_OBJECT_CATEGORIES,
  MEMORY_OBJECT_PROFILES,
  memoryObjectDimensionLimit,
  memoryObjectPolicy,
  type MemoryObjectCategory,
} from "./memory-object-taxonomy";
export {
  MEMORY_OBJECT_CATEGORIES,
  MEMORY_OBJECT_PROFILES,
  MAX_MEMORY_OBJECTS,
  memoryObjectPolicy,
  memoryObjectDimensionLimit,
  isObjectRecognitionCoverage,
} from "./memory-object-taxonomy";
export type {
  MemoryObjectCategory,
  MemoryObjectProfile,
  MemoryObjectGeometry,
  ObjectRecognitionCoverage,
} from "./memory-object-taxonomy";

/** Inferred dimensions in metres, not measurements of the original object. */
export interface MemoryObjectSpec {
  category: MemoryObjectCategory;
  confidence: number;
  color: string;
  dimensions: [number, number, number];
  rotation?: [number, number, number];
  evidence?: MemoryObjectEvidence;
}

/** Bounded detector provenance. Scores are model scores, not calibrated probabilities;
 * a SAM silhouette score supplies no evidence about the object's class. */
export interface MemoryObjectEvidence {
  version: 1;
  source: "local-detector";
  proposalConfidence: number;
  confirmationConfidence: number;
  confirmation: "full-image" | "crop" | "unavailable";
  labelMatched: boolean;
  conflictingCategories: MemoryObjectCategory[];
}

export function isMemoryObjectEvidence(
  value: unknown,
): value is MemoryObjectEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const score = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  return (
    Object.keys(item).every((key) =>
      [
        "version",
        "source",
        "proposalConfidence",
        "confirmationConfidence",
        "confirmation",
        "labelMatched",
        "conflictingCategories",
      ].includes(key),
    ) &&
    item.version === 1 &&
    item.source === "local-detector" &&
    score(item.proposalConfidence) &&
    score(item.confirmationConfidence) &&
    ["full-image", "crop", "unavailable"].includes(
      item.confirmation as string,
    ) &&
    typeof item.labelMatched === "boolean" &&
    Array.isArray(item.conflictingCategories) &&
    item.conflictingCategories.length <= 12 &&
    new Set(item.conflictingCategories).size ===
      item.conflictingCategories.length &&
    item.conflictingCategories.every((category) =>
      MEMORY_OBJECT_CATEGORIES.includes(category),
    )
  );
}

/** A compatibility boundary: previously reviewed/cloud/legacy objects have no
 * local provenance. Every result emitted by the current local recognizer does. */
export function isMemoryObjectClassVerified(object: MemoryObjectSpec): boolean {
  const evidence = object.evidence;
  if (evidence === undefined) return true;
  if (
    !isMemoryObjectEvidence(evidence) ||
    !evidence.labelMatched ||
    evidence.confirmation === "unavailable" ||
    evidence.proposalConfidence < 0.2 ||
    evidence.confirmationConfidence < 0.4
  )
    return false;
  const policy = memoryObjectPolicy(object.category);
  // Fixed solids can erase a large part of the original scene. Crop-only rescue
  // does not establish their class, even when SAM traces a coherent silhouette.
  return (
    policy.interaction !== "fixed" ||
    policy.reconstruction !== "solid" ||
    (evidence.confirmation === "full-image" &&
      evidence.proposalConfidence >= 0.3 &&
      evidence.confirmationConfidence >= 0.6 &&
      evidence.conflictingCategories.length === 0)
  );
}

export function canReconstructMemoryObject(object: MemoryObjectSpec): boolean {
  return (
    memoryObjectPolicy(object.category).reconstruction === "solid" &&
    isMemoryObjectClassVerified(object)
  );
}

const normalizeLabel = (text: string) =>
  text.toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
const labelRules = MEMORY_OBJECT_CATEGORIES.flatMap((category) =>
  [
    category,
    MEMORY_OBJECT_PROFILES[category].query,
    ...MEMORY_OBJECT_PROFILES[category].aliases,
  ].map((label) => ({ category, label: normalizeLabel(label) })),
).sort((a, b) => b.label.length - a.label.length);

/** Longest visible class phrase wins; unknown blobs and printed depictions remain unknown. */
export function classifyMemoryObject(
  label: string,
): MemoryObjectCategory | undefined {
  const text = normalizeLabel(label);
  if (
    /\b(depth isolated|inferred object|unknown object|picture of|photo of|image of|printed on|on (?:a )?screen)\b/.test(
      text,
    )
  )
    return undefined;
  return labelRules.find((rule) => {
    let start = text.indexOf(rule.label);
    while (start >= 0) {
      const end = start + rule.label.length;
      if (
        (start === 0 || !/[a-z0-9]/.test(text[start - 1])) &&
        (end === text.length || !/[a-z0-9]/.test(text[end]))
      )
        return true;
      start = text.indexOf(rule.label, start + 1);
    }
    return false;
  })?.category;
}

export function isMemoryObjectSpec(value: unknown): value is MemoryObjectSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!MEMORY_OBJECT_CATEGORIES.includes(item.category as MemoryObjectCategory))
    return false;
  const limit = memoryObjectDimensionLimit(
    item.category as MemoryObjectCategory,
  );
  return (
    Object.keys(item).every((key) =>
      [
        "category",
        "confidence",
        "color",
        "dimensions",
        "rotation",
        "evidence",
      ].includes(key),
    ) &&
    MEMORY_OBJECT_CATEGORIES.includes(item.category as MemoryObjectCategory) &&
    typeof item.confidence === "number" &&
    Number.isFinite(item.confidence) &&
    item.confidence >= 0 &&
    item.confidence <= 1 &&
    typeof item.color === "string" &&
    /^#[a-f\d]{6}$/i.test(item.color) &&
    Array.isArray(item.dimensions) &&
    item.dimensions.length === 3 &&
    item.dimensions.every(
      (n) =>
        typeof n === "number" && Number.isFinite(n) && n >= 0.004 && n <= limit,
    ) &&
    (item.evidence === undefined || isMemoryObjectEvidence(item.evidence)) &&
    (item.rotation === undefined ||
      (Array.isArray(item.rotation) &&
        item.rotation.length === 3 &&
        item.rotation.every(
          (n) =>
            typeof n === "number" &&
            Number.isFinite(n) &&
            Math.abs(n) <= Math.PI * 2,
        )))
  );
}
