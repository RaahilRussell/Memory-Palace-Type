import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MEMORY_OBJECT_CATEGORIES,
  MEMORY_OBJECT_PROFILES,
  classifyMemoryObject,
  memoryObjectPolicy,
  isMemoryObjectSpec,
  isObjectRecognitionCoverage,
} from "../memory-objects";
import {
  evaluateObjectCoverage,
  type ExpectedPhotoObjects,
} from "../memory-object-coverage";

test("all 33 photo expectations map to canonical classes, with ambiguous items kept separate", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../scripts/object-detection/fixtures/album-expected-objects.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(fixture.items.length, 33);
  assert.equal(
    new Set(fixture.items.map((item: ExpectedPhotoObjects) => item.filename))
      .size,
    33,
  );
  for (const item of fixture.items) {
    assert.ok(item.expectedCategories.length > 0);
    for (const category of item.expectedCategories)
      assert.ok(
        MEMORY_OBJECT_CATEGORIES.includes(category),
        `${item.index}: ${category}`,
      );
    assert.ok(Array.isArray(item.ambiguousOrUnreadable));
  }
  for (const category of MEMORY_OBJECT_CATEGORIES) {
    assert.equal(classifyMemoryObject(category), category);
    assert.ok(
      isMemoryObjectSpec({
        category,
        confidence: 0.8,
        color: "#567890",
        dimensions: MEMORY_OBJECT_PROFILES[category].dimensions,
      }),
    );
  }
});

test("furniture and vehicles stay fixed; architectural surfaces and wearables retain observed pixels", () => {
  for (const category of [
    "table",
    "round-table",
    "chair",
    "umbrella",
    "airplane",
    "car",
  ] as const) {
    assert.equal(memoryObjectPolicy(category).interaction, "fixed");
    assert.equal(memoryObjectPolicy(category).reconstruction, "solid");
  }
  for (const category of ["glasses", "clothing", "watch", "lanyard"] as const) {
    assert.equal(memoryObjectPolicy(category).interaction, "attached");
    assert.equal(memoryObjectPolicy(category).reconstruction, "source-surface");
  }
  for (const category of [
    "building",
    "window",
    "bridge",
    "sculpture",
    "moving-walkway",
  ] as const)
    assert.equal(memoryObjectPolicy(category).reconstruction, "source-surface");
  for (const label of [
    "unidentified object",
    "Depth-isolated foreground",
    "a photo of a laptop",
    "phone printed on a box",
  ])
    assert.equal(classifyMemoryObject(label), undefined);
  assert.equal(classifyMemoryObject("red soda can"), "drink-can");
  assert.equal(classifyMemoryObject("blue sunglasses"), "sunglasses");
  assert.equal(classifyMemoryObject("round patio table"), "round-table");
});

test("category presence does not imply valid object geometry or complete visual acceptance", () => {
  const result = evaluateObjectCoverage(
    {
      index: 1,
      filename: "example.jpg",
      expectedCategories: ["chair", "phone", "umbrella"],
      ambiguousOrUnreadable: ["tiny tabletop item"],
    },
    [
      { kind: "object", label: "chair" },
      {
        kind: "object",
        label: "phone",
        object: {
          category: "phone",
          confidence: 0.9,
          color: "#202020",
          dimensions: [0.075, 0.15, 0.009],
        },
      },
      { kind: "object", label: "unidentified object" },
    ],
  );
  assert.deepEqual(result.missingCategories, ["umbrella"]);
  assert.deepEqual(result.missingSolidDescriptors, ["chair", "umbrella"]);
  assert.deepEqual(result.solidGeometryEligibleCategories, ["phone"]);
  assert.deepEqual(result.unknownLabels, ["unidentified object"]);
  assert.deepEqual(result.ambiguousOrUnreadable, ["tiny tabletop item"]);
});

test("tentative category mappings cannot count as verified solid coverage", () => {
  const result = evaluateObjectCoverage({ index: 1, filename: "cafe.jpg", expectedCategories: ["umbrella"], ambiguousOrUnreadable: [] },
    [{ kind: "object", label: "umbrella", object: { category: "umbrella", confidence: .544, color: "#333333", dimensions: [2, 2.5, 2],
      evidence: { version: 1, source: "local-detector", proposalConfidence: .415, confirmationConfidence: .544,
        confirmation: "crop", labelMatched: true, conflictingCategories: ["television"] } } }]);
  assert.deepEqual(result.tentativeDescriptorCategories, ["umbrella"]);
  assert.deepEqual(result.verifiedDescriptorCategories, []);
  assert.deepEqual(result.solidGeometryEligibleCategories, []);
  assert.deepEqual(result.missingSolidDescriptors, ["umbrella"]);
  assert.equal(result.expectedSolidDescriptors.matched, 0);
});

test("coverage data rejects unknown fields, inconsistent sets and unbounded classes", () => {
  const valid = {
    strategy: "local-evidence-priority",
    searchedCategories: ["phone"],
    unsearchedCategories: ["chair"],
    unconfirmedCategories: ["phone"],
    candidateLimitReached: false,
    objectLimitReached: false,
  };
  assert.equal(isObjectRecognitionCoverage(valid), true);
  for (const change of [
    { unsearchedCategories: ["phone"] },
    { unconfirmedCategories: ["chair"] },
    { searchedCategories: ["not-a-class"] },
    { script: "bad" },
    { objectLimitReached: 1 },
  ])
    assert.equal(isObjectRecognitionCoverage({ ...valid, ...change }), false);
});
