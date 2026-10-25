import type { VolumePixels } from "./volume";
import { photoRemovalMask } from "./photo-depth";

type Box = [number, number, number, number];
export interface OwnershipSubject {
  id: string;
  /** All masks cover the complete source image, never a cropped object box. */
  mask?: VolumePixels;
  /** The already-resized mask used by live RGB/depth removal. Native mask
   * diagnostics above remain independent of the runtime sampling footprint. */
  removalMask?: VolumePixels;
  box?: Box;
}
export type MaskOwnershipReason = "accepted" | "invalid-object-mask" |
  "empty-object-mask" | "person-mask-unavailable" | "person-overlap" |
  "combined-person-overlap" | "invalid-removal-mask" | "empty-removal-mask" |
  "expanded-person-overlap" | "combined-expanded-person-overlap";
type OwnershipConflict = { personId: string; overlapPixels: number;
  objectFraction: number; personFraction: number; evidence: "mask" | "box" };
export interface MaskOwnershipDecision {
  id: string;
  accepted: boolean;
  reason: MaskOwnershipReason;
  objectPixels: number;
  conflicts: OwnershipConflict[];
  removalPixels: number;
  removalConflicts: OwnershipConflict[];
  removalMaskSource: "runtime" | "native-nearest";
}

/** A conservative removal budget, not an estimate of semantic correctness.
 * Small held objects can overlap a coarse person mask. Erasing >=10% of any
 * person requires stronger ownership evidence than these masks supply. */
export const MASK_OWNERSHIP_POLICY = {
  version: "person-removal-budget-v2-expanded",
  threshold: 60,
  maxPersonFraction: 0.1,
  maxGridEdge: 384,
} as const;

const complete = (mask: VolumePixels | undefined): mask is VolumePixels =>
  !!mask && Number.isInteger(mask.width) && Number.isInteger(mask.height) &&
  mask.width >= 2 && mask.height >= 2 && mask.data.length >= mask.width * mask.height * 4;

function active(mask: VolumePixels, u: number, v: number) {
  const x = Math.min(mask.width - 1, Math.floor(u * mask.width));
  const y = Math.min(mask.height - 1, Math.floor(v * mask.height));
  const i = (y * mask.width + x) * 4;
  return Number(mask.data[i]) >= MASK_OWNERSHIP_POLICY.threshold &&
    Number(mask.data[i + 3]) >= MASK_OWNERSHIP_POLICY.threshold;
}

/** Resolve ownership once, before body evidence, scene removal, props and
 * collisions. The decision depends on pixel masks, not box overlap or a SAM
 * confidence score. Boxes are used only to retain evidence when a mask failed. */
export function auditObjectMaskOwnership(
  objects: readonly OwnershipSubject[],
  people: readonly OwnershipSubject[],
  removalGrid?: { width: number; height: number },
) {
  const reference = [...objects, ...people].map(subject => subject.mask)
    .filter(complete).sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height) ||
      b.width - a.width || b.height - a.height)[0];
  const scale = reference ? Math.min(1, MASK_OWNERSHIP_POLICY.maxGridEdge /
    Math.max(reference.width, reference.height)) : 1;
  const width = reference ? Math.max(2, Math.round(reference.width * scale)) : 2;
  const height = reference ? Math.max(2, Math.round(reference.height * scale)) : 2;
  const grid = removalGrid ?? { width, height };
  if (![grid.width, grid.height].every(size => Number.isInteger(size) && size >= 2 &&
      size <= MASK_OWNERSHIP_POLICY.maxGridEdge))
    throw new Error("Mask removal grid must match the bounded 2–384 pixel depth grid.");
  const bitmap = (subject: OwnershipSubject, protectMissing = false,
    dimensions = { width, height }, removal = false) => {
    const { width, height } = dimensions;
    const data = new Uint8Array(width * height);
    let pixels = 0;
    let valid = complete(subject.mask);
    const box = subject.box;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width, v = (y + 0.5) / height;
      const mx = valid ? Math.min(subject.mask!.width - 1, Math.floor(u * subject.mask!.width)) : 0;
      const my = valid ? Math.min(subject.mask!.height - 1, Math.floor(v * subject.mask!.height)) : 0;
      // Removal's threshold intentionally matches photo-depth, including its
      // red-channel-only handling of already-decoded masks.
      const inside = valid ? (removal
        ? Number(subject.mask!.data[(my * subject.mask!.width + mx) * 4]) >= MASK_OWNERSHIP_POLICY.threshold
        : active(subject.mask!, u, v)) : !!box &&
        box.every(Number.isFinite) && v >= box[0] && v < box[2] && u >= box[1] && u < box[3];
      if (inside) { data[y * width + x] = 1; pixels++; }
    }
    if (protectMissing && !pixels && box && box.every(Number.isFinite)) {
      valid = false;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width, v = (y + 0.5) / height;
        if (v >= box[0] && v < box[2] && u >= box[1] && u < box[3]) {
          data[y * width + x] = 1; pixels++;
        }
      }
    }
    return { id: subject.id, data, pixels, valid };
  };
  const personMaps = people.map(subject => bitmap(subject, true));
  const objectMaps = objects.map(subject => bitmap(subject));
  const removalPeople = people.map(subject => bitmap({ ...subject,
    mask: subject.removalMask ?? subject.mask }, true, grid, true));
  const removalObjects = objects.map(subject => {
    const mask = subject.removalMask ?? subject.mask;
    const valid = complete(mask);
    const expanded = valid ? photoRemovalMask(grid, [mask]) : undefined;
    return { ...bitmap({ ...subject, mask: expanded }, false, grid, true), valid };
  });
  type Bitmap = ReturnType<typeof bitmap>;
  const conflictsFor = (object: Bitmap, people: Bitmap[]): OwnershipConflict[] =>
    people.flatMap(person => {
      let overlapPixels = 0;
      for (let i = 0; i < object.data.length; i++) overlapPixels += object.data[i] & person.data[i];
      return overlapPixels ? [{ personId: person.id, overlapPixels,
        objectFraction: overlapPixels / Math.max(1, object.pixels),
        personFraction: overlapPixels / Math.max(1, person.pixels),
        evidence: person.valid ? "mask" as const : "box" as const }] : [];
    });
  const decisions: MaskOwnershipDecision[] = objectMaps.map((object, index) => {
    const conflicts = conflictsFor(object, personMaps);
    const removal = removalObjects[index];
    const removalConflicts = conflictsFor(removal, removalPeople);
    const reason: MaskOwnershipReason = !object.valid ? "invalid-object-mask" :
      !object.pixels ? "empty-object-mask" :
      conflicts.some(conflict => conflict.evidence === "box") ? "person-mask-unavailable" :
      conflicts.some(conflict => conflict.personFraction >= MASK_OWNERSHIP_POLICY.maxPersonFraction)
        ? "person-overlap" :
      !removal.valid ? "invalid-removal-mask" : !removal.pixels ? "empty-removal-mask" :
      removalConflicts.some(conflict => conflict.evidence === "box") ? "person-mask-unavailable" :
      removalConflicts.some(conflict => conflict.personFraction >= MASK_OWNERSHIP_POLICY.maxPersonFraction)
        ? "expanded-person-overlap" : "accepted";
    const removalMaskSource: MaskOwnershipDecision["removalMaskSource"] =
      objects[index].removalMask === undefined ? "native-nearest" : "runtime";
    return { id: object.id, accepted: reason === "accepted", reason, objectPixels: object.pixels, conflicts,
      removalPixels: removal.pixels, removalConflicts,
      removalMaskSource };
  });
  // Individually small masks must not collectively erase a large body region.
  // Reject all contributors to an over-budget union, independent of subject order.
  const rejected = new Map<string, MaskOwnershipReason>();
  const auditUnion = (objectMaps: Bitmap[], personMaps: Bitmap[],
    key: "conflicts" | "removalConflicts", reason: MaskOwnershipReason) => {
    for (const person of personMaps) {
      if (!person.valid || !person.pixels) continue;
      const contributors = objectMaps.filter((object, i) => decisions[i].accepted &&
        decisions[i][key].some(conflict => conflict.personId === person.id));
      let unionPixels = 0;
      for (let i = 0; i < person.data.length; i++)
        if (person.data[i] && contributors.some(object => object.data[i])) unionPixels++;
      if (unionPixels / person.pixels >= MASK_OWNERSHIP_POLICY.maxPersonFraction)
        contributors.forEach(object => { if (!rejected.has(object.id)) rejected.set(object.id, reason); });
    }
  };
  auditUnion(objectMaps, personMaps, "conflicts", "combined-person-overlap");
  auditUnion(removalObjects, removalPeople, "removalConflicts", "combined-expanded-person-overlap");
  for (const decision of decisions) if (rejected.has(decision.id)) {
    decision.accepted = false;
    decision.reason = rejected.get(decision.id)!;
  }
  return { policy: MASK_OWNERSHIP_POLICY.version, width, height,
    removalGrid: { ...grid }, decisions };
}

/** Retain a separate original-photo validity mask. RGB is never filled or
 * rewritten. Any removal pixel contributing to a resized source sample makes
 * that sample unavailable; finger-hole interiors and unrelated pixels survive. */
export function observedPersonPhotoMask(
  person: VolumePixels,
  exclusions: readonly VolumePixels[],
  originalSourceSize?: { width: number; height: number },
  nativePersonMask: VolumePixels = person,
): VolumePixels {
  if (!complete(person) || !complete(nativePersonMask) || exclusions.some(mask => !complete(mask)))
    throw new Error("Photo validity requires complete full-image RGBA masks.");
  const data = Uint8ClampedArray.from(person.data);
  const source = originalSourceSize ?? person;
  if (!(source.width > 0 && source.height > 0)) throw new Error("Invalid source dimensions.");
  const padU = person.width === source.width ? 0 : 0.5 / source.width;
  const padV = person.height === source.height ? 0 : 0.5 / source.height;
  const footprint = (mask: VolumePixels, x: number, y: number) => [
    Math.max(0, Math.floor((x / person.width - padU) * mask.width)),
    Math.min(mask.width - 1, Math.ceil(((x + 1) / person.width + padU) * mask.width) - 1),
    Math.max(0, Math.floor((y / person.height - padV) * mask.height)),
    Math.min(mask.height - 1, Math.ceil(((y + 1) / person.height + padV) * mask.height) - 1),
  ];
  for (let y = 0; y < person.height; y++) for (let x = 0; x < person.width; x++) {
    const i = (y * person.width + x) * 4;
    if (Number(person.data[i]) < MASK_OWNERSHIP_POLICY.threshold) continue;
    let excluded = false;
    // A smoothed/upscaled person-mask value cannot authorize background RGB
    // already mixed into this pixel. Every native person cell must support it.
    const [personLeft, personRight, personTop, personBottom] = footprint(nativePersonMask, x, y);
    for (let my = personTop; my <= personBottom && !excluded; my++)
      for (let mx = personLeft; mx <= personRight; mx++) {
        const offset = (my * nativePersonMask.width + mx) * 4;
        if (!(Number(nativePersonMask.data[offset]) >= 100) ||
            Number(nativePersonMask.data[offset + 3]) !== 255) { excluded = true; break; }
      }
    for (const mask of exclusions) {
      if (excluded) break;
      const [left, right, top, bottom] = footprint(mask, x, y);
      for (let my = top; my <= bottom && !excluded; my++)
        for (let mx = left; mx <= right; mx++) {
          const offset = (my * mask.width + mx) * 4;
          if (Number(mask.data[offset]) >= MASK_OWNERSHIP_POLICY.threshold &&
              Number(mask.data[offset + 3]) >= MASK_OWNERSHIP_POLICY.threshold) { excluded = true; break; }
        }
      if (excluded) break;
    }
    if (excluded) data[i] = data[i + 1] = data[i + 2] = 0;
  }
  return { width: person.width, height: person.height, data };
}
