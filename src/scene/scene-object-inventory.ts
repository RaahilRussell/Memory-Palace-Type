import type { WorldCompletion } from "../types";
import {
  classifyMemoryObject,
  isMemoryObjectClassVerified,
  canReconstructMemoryObject,
  type MemoryObjectCategory,
} from "../memory-objects";
import type { SceneUnderstanding, SourceBox } from "../scene-understanding";
import type { MaskOwnershipDecision, MaskOwnershipReason } from "./mask-ownership";

type InventorySubject = Pick<
  WorldCompletion["subjects"][number],
  "id" | "label" | "kind" | "box" | "object"
>;

export interface SceneInventoryItem {
  id: string;
  label: string;
  category: MemoryObjectCategory | null;
  representation: "3d" | "photographed" | "unclassified";
  movable: boolean;
  source: "detector" | "segmentation" | "scene-understanding";
  /** Verified means detection evidence passes the class gate, not a manual review. */
  verification: "verified" | "unverified";
  confidence?: number;
  /** Class evidence remains intact when a silhouette cannot safely replace pixels. */
  geometryUnsupportedReason?: Exclude<MaskOwnershipReason, "accepted">;
}

function overlap(a: SourceBox, b: SourceBox) {
  const intersection =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union =
    (a[2] - a[0]) * (a[3] - a[1]) +
    (b[2] - b[0]) * (b[3] - b[1]) -
    intersection;
  return union > 0 ? intersection / union : 0;
}

/** Keep the observed inventory visible even when segmentation cannot provide a
 * usable mask. Semantic entries never become geometry or independently verified
 * detections merely by being listed here. */
export function sceneObjectInventory(
  subjects: readonly InventorySubject[],
  scene: SceneUnderstanding | undefined,
  renderedProps: readonly { id: string; movable: boolean }[],
  ownership: readonly MaskOwnershipDecision[] = [],
): SceneInventoryItem[] {
  const detected = subjects.filter((subject) => subject.kind === "object");
  const rendered = new Map(renderedProps.map((prop) => [prop.id, prop]));
  const result: SceneInventoryItem[] = detected.map((subject) => {
    const verified =
      !!subject.object && isMemoryObjectClassVerified(subject.object);
    const prop =
      subject.object && canReconstructMemoryObject(subject.object)
        ? rendered.get(subject.id)
        : undefined;
    const decision = ownership.find(item => item.id === subject.id);
    return {
      id: subject.id,
      label: subject.label,
      category: subject.object?.category ?? null,
      representation: prop
        ? "3d"
        : subject.object
          ? "photographed"
          : "unclassified",
      movable: prop?.movable ?? false,
      source: subject.object ? "detector" : "segmentation",
      verification: verified ? "verified" : "unverified",
      ...(subject.object ? { confidence: subject.object.confidence } : {}),
      ...(decision && !decision.accepted && decision.reason !== "accepted"
        ? { geometryUnsupportedReason: decision.reason } : {}),
    };
  });
  if (!scene || scene.status === "unavailable") return result;
  const cleanLabel = (label: string) =>
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const candidates = scene.objects
    .flatMap((item, inventoryIndex) =>
      detected.flatMap((subject, detectedIndex) => {
        const detectedClass =
          subject.object?.category ?? classifyMemoryObject(subject.label);
        const sameClass =
          item.category && detectedClass
            ? item.category === detectedClass
            : cleanLabel(item.label) === cleanLabel(subject.label);
        const score = sameClass ? overlap(item.box, subject.box) : 0;
        return score >= 0.35 ? [{ inventoryIndex, detectedIndex, score }] : [];
      }),
    )
    .sort((a, b) => b.score - a.score);
  const matchedInventory = new Set<number>(),
    matchedDetections = new Set<number>();
  for (const candidate of candidates) {
    if (
      matchedInventory.has(candidate.inventoryIndex) ||
      matchedDetections.has(candidate.detectedIndex)
    )
      continue;
    matchedInventory.add(candidate.inventoryIndex);
    matchedDetections.add(candidate.detectedIndex);
    const existing = result[candidate.detectedIndex];
    const inferred = scene.objects[candidate.inventoryIndex];
    if (!existing.category && inferred.category) {
      existing.category = inferred.category;
      existing.source = "scene-understanding";
      existing.confidence = inferred.confidence;
      existing.representation = "photographed";
    }
  }
  const ids = new Set(result.map((item) => item.id));
  scene.objects.forEach((item, index) => {
    if (matchedInventory.has(index)) return;
    let id = `scene-inventory-${item.id}`;
    while (ids.has(id)) id += "-inferred";
    ids.add(id);
    result.push({
      id,
      label: item.label,
      category: item.category ?? null,
      representation: "photographed",
      movable: false,
      source: "scene-understanding",
      verification: "unverified",
      confidence: item.confidence,
    });
  });
  return result;
}
