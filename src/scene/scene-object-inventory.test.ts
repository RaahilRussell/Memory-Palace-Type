import assert from "node:assert/strict";
import test from "node:test";
import { sceneObjectInventory } from "./scene-object-inventory";
import type { SceneUnderstanding, SourceBox } from "../scene-understanding";
import type {
  MemoryObjectCategory,
  MemoryObjectEvidence,
} from "../memory-objects";

const item = (id: string, category: MemoryObjectCategory, box: SourceBox) => ({
  id,
  label: category,
  category,
  box,
  confidence: 0.9,
  visibility: "clear" as const,
});
const scene = (objects: SceneUnderstanding["objects"]): SceneUnderstanding => ({
  version: 1,
  source: "gemini",
  status: "complete",
  environment: "unknown",
  confidence: 0.8,
  structures: [],
  objects,
  people: [],
  relations: [],
  limitations: [],
});
const detected = (
  id: string,
  category: MemoryObjectCategory,
  box: SourceBox,
) => ({
  id,
  kind: "object" as const,
  label: category,
  box,
  object: {
    category,
    confidence: 0.85,
    color: "#808080",
    dimensions: [0.1, 0.1, 0.1] as [number, number, number],
  },
});

test("unmasked semantic objects remain visible and unverified without geometry or grab permission", () => {
  const result = sceneObjectInventory(
    [],
    scene([item("phone", "phone", [0.1, 0.2, 0.3, 0.4])]),
    [],
  );
  assert.deepEqual(result, [
    {
      id: "scene-inventory-phone",
      label: "phone",
      category: "phone",
      confidence: 0.9,
      representation: "photographed",
      movable: false,
      source: "scene-understanding",
      verification: "unverified",
    },
  ]);
});

test("category and source overlap deduplicate inventory while preserving separate objects", () => {
  const first: SourceBox = [0.1, 0.1, 0.3, 0.3],
    second: SourceBox = [0.1, 0.6, 0.3, 0.8];
  const result = sceneObjectInventory(
    [detected("detected-phone", "phone", first)],
    scene([
      item("same-phone", "phone", [0.11, 0.11, 0.31, 0.31]),
      item("other-phone", "phone", second),
      item("different-class", "book", first),
    ]),
    [{ id: "detected-phone", movable: true }],
  );
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((value) => value.id),
    [
      "detected-phone",
      "scene-inventory-other-phone",
      "scene-inventory-different-class",
    ],
  );
  assert.equal(result[0].verification, "verified");
  assert.equal(result[0].representation, "3d");
  assert.equal(result[0].movable, true);
  assert.ok(
    result
      .slice(1)
      .every((value) => value.verification === "unverified" && !value.movable),
  );
});

test("semantic matching is one to one and cannot promote a label-only segment into a verified detection", () => {
  const box: SourceBox = [0.2, 0.2, 0.6, 0.6];
  const result = sceneObjectInventory(
    [{ id: "segment", kind: "object", label: "cell phone", box }],
    scene([
      item("first", "phone", box),
      item("second", "phone", [0.25, 0.25, 0.65, 0.65]),
    ]),
    [],
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "segment");
  assert.equal(result[0].category, "phone");
  assert.equal(result[0].verification, "unverified");
  assert.equal(result[0].source, "scene-understanding");
  assert.equal(result[0].representation, "photographed");
});

test("missing mask assets preserve detector inventory without claiming a rendered prop", () => {
  const result = sceneObjectInventory(
    [detected("missing-mask", "chair", [0.1, 0.2, 0.8, 0.7])],
    undefined,
    [],
  );
  assert.equal(result[0].source, "detector");
  assert.equal(result[0].verification, "verified");
  assert.equal(result[0].representation, "photographed");
  assert.equal(result[0].movable, false);
});

test("tentative local fixed-solid descriptors remain photographed and unverified even if a stale prop is listed", () => {
  const subject = detected(
    "tentative-umbrella",
    "umbrella",
    [0.69, 0.49, 0.99, 0.99],
  );
  const evidence: MemoryObjectEvidence = {
    version: 1,
    source: "local-detector",
    proposalConfidence: 0.392,
    confirmationConfidence: 0.544,
    confirmation: "crop",
    labelMatched: true,
    conflictingCategories: ["backpack", "television"],
  };
  const result = sceneObjectInventory(
    [{ ...subject, object: { ...subject.object, evidence } }],
    scene([item("semantic-umbrella", "umbrella", subject.box)]),
    [{ id: subject.id, movable: true }],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].category, "umbrella");
  assert.equal(result[0].source, "detector");
  assert.equal(result[0].verification, "unverified");
  assert.equal(result[0].representation, "photographed");
  assert.equal(result[0].movable, false);
});

test("inventory ids remain unique when semantic ids collide with detector ids", () => {
  const result = sceneObjectInventory(
    [detected("scene-inventory-phone", "book", [0.1, 0.2, 0.3, 0.4])],
    scene([item("phone", "phone", [0.6, 0.6, 0.8, 0.8])]),
    [],
  );
  assert.equal(new Set(result.map((value) => value.id)).size, 2);
});

test("mask ownership rejection retains class provenance and explains unsupported geometry", () => {
  const result = sceneObjectInventory([detected("sofa", "sofa", [.1, .1, .9, .5])], undefined, [], [
    { id: "sofa", accepted: false, reason: "person-overlap", objectPixels: 100, conflicts: [],
      removalPixels: 0, removalConflicts: [], removalMaskSource: "native-nearest" },
  ]);
  assert.equal(result[0].category, "sofa");
  assert.equal(result[0].verification, "verified", "class evidence is distinct from mask ownership");
  assert.equal(result[0].representation, "photographed");
  assert.equal(result[0].movable, false);
  assert.equal(result[0].geometryUnsupportedReason, "person-overlap");
});
