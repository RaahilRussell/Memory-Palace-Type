import assert from "node:assert/strict";
import test from "node:test";
import { auditObjectMaskOwnership, observedPersonPhotoMask } from "./mask-ownership";
import { photoRemovalMask } from "./photo-depth";
import type { VolumePixels } from "./volume";

const mask = (width: number, height: number, inside: (u: number, v: number) => boolean) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = inside((x + .5) / width, (y + .5) / height) ? 255 : 0;
    data.set([value, value, value, 255], (y * width + x) * 4);
  }
  return { width, height, data };
};
const person = { id: "person", box: [.1, .1, .9, .5] as [number, number, number, number],
  mask: mask(100, 100, (u, v) => u >= .1 && u < .5 && v >= .1 && v < .9) };

test("an object tracing a person's torso is retained before removal, regardless of class score", () => {
  const sofa = { id: "sofa", mask: mask(200, 200, (u, v) => u >= .1 && u < .5 && v >= .2 && v < .8) };
  const [decision] = auditObjectMaskOwnership([sofa], [person]).decisions;
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, "person-overlap");
  assert.equal(decision.conflicts[0].objectFraction, 1);
  assert.equal(decision.conflicts[0].personFraction, .75);
});

test("localized held props and foreground objects survive box overlap and preserve finger holes", () => {
  const can = { id: "can", mask: mask(100, 100, (u, v) =>
    u >= .2 && u < .3 && v >= .4 && v < .5 && !(u >= .23 && u < .27 && v >= .43 && v < .47)) };
  const foreground = { id: "foreground", mask: mask(100, 100, u => u > .7) };
  const audit = auditObjectMaskOwnership([can, foreground], [person]);
  assert.ok(audit.decisions.every(decision => decision.accepted));
  const before = Uint8ClampedArray.from(person.mask.data);
  const valid = observedPersonPhotoMask(person.mask, [can.mask, foreground.mask]);
  for (let i = 0; i < 10000; i++)
    assert.equal(valid.data[i * 4], Number(person.mask.data[i * 4]) &&
      !Number(can.mask.data[i * 4]) && !Number(foreground.mask.data[i * 4]) ? 255 : 0);
  assert.deepEqual(person.mask.data, before);
});

test("the union of accepted small masks cannot erase an unposed or cropped person", () => {
  const objects = [0, 1].map(i => ({ id: `prop-${i}`, mask: mask(100, 100, (u, v) =>
    u >= .2 && u < .3 && v >= .2 + i * .3 && v < .4 + i * .3) }));
  assert.ok(objects.every(object => auditObjectMaskOwnership([object], [person]).decisions[0].accepted));
  const audit = auditObjectMaskOwnership(objects, [person]);
  assert.ok(audit.decisions.every(decision => decision.reason === "combined-person-overlap"));
  assert.deepEqual(auditObjectMaskOwnership([...objects].reverse(), [person]).decisions.reverse(), audit.decisions);
});

test("native mask resolution and subject ordering do not change clear ownership decisions", () => {
  const shape = (u: number, v: number) => u > .1 && u < .5 && v > .2 && v < .8;
  for (const size of [50, 100, 400]) {
    const sofa = { id: "sofa", mask: mask(size, size, shape) };
    const bag = { id: "bag", mask: mask(200, 200, u => u > .8) };
    for (const objects of [[sofa, bag], [bag, sofa]]) {
      const audit = auditObjectMaskOwnership(objects, [person]);
      assert.equal(audit.decisions.find(decision => decision.id === "sofa")!.accepted, false);
      assert.equal(audit.decisions.find(decision => decision.id === "bag")!.accepted, true);
    }
  }
});

test("missing, empty and invalid masks cannot silently authorize source removal", () => {
  const overlap = { id: "prop", mask: mask(100, 100, (u, v) => u > .2 && u < .3 && v > .3 && v < .4) };
  for (const unavailable of [undefined, mask(100, 100, () => false)])
    assert.equal(auditObjectMaskOwnership([overlap], [{ ...person, mask: unavailable }]).decisions[0].reason,
      "person-mask-unavailable");
  assert.equal(auditObjectMaskOwnership([{ id: "bad" }], [person]).decisions[0].reason, "invalid-object-mask");
  assert.equal(auditObjectMaskOwnership([{ id: "empty", mask: mask(10, 10, () => false) }], [person])
    .decisions[0].reason, "empty-object-mask");
});

const removalIntersection = (person: VolumePixels, objects: VolumePixels[]) => {
  const removed = photoRemovalMask(person, objects);
  let personPixels = 0, overlapPixels = 0;
  for (let i = 0; i < person.width * person.height; i++) if (Number(person.data[i * 4]) >= 60) {
    personPixels++;
    if (Number(removed.data[i * 4]) >= 60) overlapPixels++;
  }
  return { overlapPixels, personFraction: overlapPixels / personPixels };
};

test("a five-percent native stripe is rejected when actual expanded removal erases fifteen percent", () => {
  const personMask = mask(100, 100, (u, v) => u >= .1 && u < .3 && v >= .1 && v < .9);
  const stripe = mask(100, 100, (u, v) => u >= .2 && u < .21 && v >= .1 && v < .9);
  const audit = auditObjectMaskOwnership([{ id: "stripe", mask: stripe, removalMask: stripe }],
    [{ id: "person", mask: personMask, removalMask: personMask }], { width: 100, height: 100 });
  const [decision] = audit.decisions;
  const actual = removalIntersection(personMask, [stripe]);
  assert.equal(decision.conflicts[0].personFraction, .05, "native overlap diagnostics remain unchanged");
  assert.equal(actual.overlapPixels, 240);
  assert.equal(actual.personFraction, .15);
  assert.equal(decision.removalConflicts[0].personFraction, actual.personFraction);
  assert.equal(decision.removalConflicts[0].overlapPixels, actual.overlapPixels);
  assert.equal(decision.removalPixels, 246);
  assert.equal(decision.removalMaskSource, "runtime");
  assert.equal(decision.reason, "expanded-person-overlap");
  assert.equal(decision.accepted, false);
  assert.deepEqual(audit.removalGrid, { width: 100, height: 100 });
});

test("legacy 256 depth uses its supplied runtime masks rather than the native diagnostic grid", () => {
  const personShape = (u: number, v: number) => u >= .125 && u < .203125 && v >= .125 && v < .875;
  const stripeShape = (u: number, v: number) => u >= .15625 && u < .16015625 && v >= .125 && v < .875;
  const personNative = mask(512, 512, personShape), personRuntime = mask(256, 256, personShape);
  const objectNative = mask(512, 512, stripeShape), objectRuntime = mask(256, 256, stripeShape);
  const audit = auditObjectMaskOwnership([{ id: "stripe", mask: objectNative, removalMask: objectRuntime }],
    [{ id: "person", mask: personNative, removalMask: personRuntime }], { width: 256, height: 256 });
  const [decision] = audit.decisions;
  assert.equal(audit.width, 384);
  assert.deepEqual(audit.removalGrid, { width: 256, height: 256 });
  assert.ok(decision.conflicts[0].personFraction < .1);
  assert.equal(decision.removalConflicts[0].personFraction, .15);
  assert.equal(decision.removalConflicts[0].overlapPixels,
    removalIntersection(personRuntime, [objectRuntime]).overlapPixels);
  assert.equal(decision.reason, "expanded-person-overlap");

  // Canvas resizing may retain values that nearest native sampling misses.
  // The live footprint, including the exact >=60 threshold, owns admission.
  const widened = mask(256, 256, (u, v) => u >= .15 && u < .17 && v >= .125 && v < .875);
  for (let i = 0; i < widened.data.length; i += 4) if (widened.data[i]) widened.data[i] = 60;
  const widenedAudit = auditObjectMaskOwnership([{ id: "stripe", mask: objectNative, removalMask: widened }],
    [{ id: "person", mask: personNative, removalMask: personRuntime }], { width: 256, height: 256 });
  assert.deepEqual(widenedAudit.decisions[0].conflicts, decision.conflicts);
  assert.equal(widenedAudit.decisions[0].removalConflicts[0].overlapPixels,
    removalIntersection(personRuntime, [widened]).overlapPixels);
  assert.ok(widenedAudit.decisions[0].removalConflicts[0].personFraction > .15);
});

test("expanded unions reject every contributor independently of input order", () => {
  const personMask = mask(100, 100, (u, v) => u >= .1 && u < .5 && v >= .1 && v < .9);
  const objects = [.2, .35].map((left, i) => ({ id: `stripe-${i}`,
    mask: mask(100, 100, (u, v) => u >= left && u < left + .01 && v >= .1 && v < .9) }));
  const people = [{ id: "person", mask: personMask }];
  for (const object of objects)
    assert.equal(auditObjectMaskOwnership([object], people).decisions[0].accepted, true);
  const actual = removalIntersection(personMask, objects.map(object => object.mask));
  assert.equal(actual.personFraction, .15);
  const audit = auditObjectMaskOwnership(objects, people);
  assert.ok(audit.decisions.every(decision => decision.reason === "combined-expanded-person-overlap"));
  assert.ok(audit.decisions.every(decision => decision.conflicts[0].personFraction === .025));
  assert.deepEqual(auditObjectMaskOwnership([...objects].reverse(), people).decisions.reverse(), audit.decisions);
});

test("expansion protects missing-mask boxes and invalid runtime masks cannot fall back silently", () => {
  const outside = mask(100, 100, (u, v) => u >= .09 && u < .1 && v >= .1 && v < .9);
  const audit = auditObjectMaskOwnership([{ id: "stripe", mask: outside }],
    [{ id: "missing", box: [.1, .1, .9, .3] }]);
  assert.equal(audit.decisions[0].conflicts.length, 0);
  assert.equal(audit.decisions[0].removalConflicts[0].evidence, "box");
  assert.equal(audit.decisions[0].reason, "person-mask-unavailable");
  const object = { id: "object", mask: mask(100, 100, u => u > .8) };
  assert.equal(auditObjectMaskOwnership([{ ...object, removalMask: { width: 100, height: 100, data: [] } }], [])
    .decisions[0].reason, "invalid-removal-mask");
  assert.equal(auditObjectMaskOwnership([{ ...object, removalMask: mask(100, 100, () => false) }], [])
    .decisions[0].reason, "empty-removal-mask");
});

test("validity survives downsampling without accepting a thin excluded source pixel", () => {
  const full = mask(4, 4, () => true);
  const thin = mask(16, 16, (u, v) => u > .3 && u < .35 && v > .25 && v < .75);
  const result = observedPersonPhotoMask(full, [thin], { width: 16, height: 16 });
  assert.equal(result.data[(1 * 4 + 1) * 4], 0);
  assert.equal(result.data[(2 * 4 + 1) * 4], 0);
  assert.equal(result.data[(2 * 4 + 3) * 4], 255);
  assert.deepEqual(observedPersonPhotoMask(full, []).data, full.data);
  assert.throws(() => observedPersonPhotoMask(full, [{ width: 2, height: 2, data: [] }]), /complete/);
});

test("a smoothed person mask cannot authorize a pixel mixed with native background", () => {
  const smooth = mask(4, 4, () => true);
  const native = mask(16, 16, (u, v) => !(u > .3 && u < .35 && v > .25 && v < .75));
  const valid = observedPersonPhotoMask(smooth, [], { width: 16, height: 16 }, native);
  assert.equal(valid.data[(1 * 4 + 1) * 4], 0);
  assert.equal(valid.data[(2 * 4 + 1) * 4], 0);
  assert.equal(valid.data[(2 * 4 + 3) * 4], 255);
});
