import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  confirmObjectProposal,
  confirmationCrop,
  localObjectRecognizer,
  mayConfirmCategory,
  maskToPolygon,
  selectObjectProposals,
  localObjectSearchPlan,
  localObjectQueryBatches,
  LOCAL_CATEGORY_SEARCH_BUDGET,
  LOCAL_OBJECT_CATEGORY_QUERIES,
  LOCAL_OBJECT_INFERENCE_VERSION,
  LOCAL_OBJECT_MODEL_VERSION,
  localObjectEvidence,
  matchesObjectConfirmationLabel,
} from "./local-object-detector.js";
import {
  MEMORY_OBJECT_CATEGORIES,
  isObjectRecognitionCoverage,
  MEMORY_OBJECT_PROFILES,
  canReconstructMemoryObject,
  isMemoryObjectClassVerified,
} from "../src/memory-objects.js";
import { objectDetectionSchema, objectSpec } from "./object-recognition.js";

test("DINO decoded labels must exactly match a canonical caption or an explicit taxonomy alias", () => {
  for (const category of MEMORY_OBJECT_CATEGORIES) {
    assert.equal(
      matchesObjectConfirmationLabel(
        category,
        LOCAL_OBJECT_CATEGORY_QUERIES[category].dino,
      ),
      true,
      category,
    );
    for (const alias of MEMORY_OBJECT_PROFILES[category].aliases)
      assert.equal(
        matchesObjectConfirmationLabel(category, `a ${alias}`),
        true,
        `${category}: ${alias}`,
      );
  }
  assert.equal(matchesObjectConfirmationLabel("drink-can", "a can"), true);
  assert.equal(
    matchesObjectConfirmationLabel("water-bottle", "a thermos"),
    true,
  );
  assert.equal(
    matchesObjectConfirmationLabel("umbrella", "a patio umbrella"),
    true,
  );
  for (const label of [
    "patio",
    "object",
    "a backpack",
    "a table with an umbrella",
    "a picture of an umbrella",
  ])
    assert.equal(
      matchesObjectConfirmationLabel("umbrella", label),
      false,
      label,
    );
  assert.equal(
    confirmObjectProposal(
      { category: "umbrella", score: 0.8, box: [150, 100, 300, 200] },
      [prediction("a television", 0.9)],
    ),
    undefined,
  );
});

test("saved cafe crop-only umbrella remains tentative despite a high SAM mask score and conflicting full-image classes", async () => {
  const audit = JSON.parse(
    await readFile(
      new URL("./fixtures/cafe-object-audit-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const detection = objectDetectionSchema.parse(audit).objects[0];
  const evidence = localObjectEvidence(detection, audit, 4032, 3024);
  assert.equal(evidence.confirmation, "crop");
  assert.equal(evidence.labelMatched, true);
  assert.equal(evidence.proposalConfidence, 0.39228886365890503);
  assert.equal(evidence.confirmationConfidence, 0.544187068939209);
  assert.deepEqual(evidence.conflictingCategories, ["backpack", "television"]);
  const object = objectSpec(
    detection.category,
    new Uint8Array([80, 80, 80]),
    new Uint8Array([255]),
    { ...detection, evidence },
  );
  assert.equal(object.category, "umbrella"); // The gate does not invent the table class.
  assert.equal(isMemoryObjectClassVerified(object), false);
  assert.equal(canReconstructMemoryObject(object), false);
  assert.equal(
    isMemoryObjectClassVerified({ ...object, evidence: undefined }),
    true,
  ); // legacy compatibility
  const whole = {
    ...evidence,
    confirmation: "full-image" as const,
    confirmationConfidence: 0.8,
    conflictingCategories: [],
  };
  assert.equal(
    canReconstructMemoryObject({ ...object, evidence: whole }),
    true,
  );
  assert.equal(
    canReconstructMemoryObject({
      ...object,
      evidence: { ...whole, confirmationConfidence: 0.59 },
    }),
    false,
  );
  assert.equal(
    canReconstructMemoryObject({
      ...object,
      evidence: { ...whole, proposalConfidence: 0.29 },
    }),
    false,
  );
  assert.equal(
    canReconstructMemoryObject({
      ...object,
      evidence: { ...whole, conflictingCategories: ["television"] },
    }),
    false,
  );
  assert.equal(
    canReconstructMemoryObject({
      ...object,
      evidence: { ...whole, labelMatched: false },
    }),
    false,
  );
});

test("quality revision replays the immutable v7 audit without changing native cache identity or running inference", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "memoir-object-quality-"),
  );
  try {
    const audit = JSON.parse(
      await readFile(
        new URL("./fixtures/cafe-object-audit-v1.json", import.meta.url),
        "utf8",
      ),
    );
    const image = await sharp({
      create: { width: 4032, height: 3024, channels: 3, background: "#808080" },
    })
      .jpeg()
      .toBuffer();
    const digest = createHash("sha256")
      .update(LOCAL_OBJECT_INFERENCE_VERSION)
      .update(image)
      .update(JSON.stringify({ categories: [], boxes: [] }))
      .digest("hex");
    const file = path.join(directory, `${digest}.json`);
    const original = JSON.stringify({ ...audit, digest });
    await writeFile(file, original);
    let nativeCalls = 0;
    const recognizer = localObjectRecognizer(directory, {
      resultDirectory: directory,
      runtime: {
        async detect() {
          nativeCalls++;
          throw new Error("Quality-only replay must not run a native model");
        },
      },
    });
    assert.notEqual(LOCAL_OBJECT_MODEL_VERSION, LOCAL_OBJECT_INFERENCE_VERSION);
    const first = await recognizer(image),
      reopened = await recognizer(image);
    assert.equal(nativeCalls, 0);
    assert.equal(first.length, 1);
    assert.equal(first[0].evidence?.confirmation, "crop");
    assert.deepEqual(first[0].evidence?.conflictingCategories, [
      "backpack",
      "television",
    ]);
    assert.deepEqual(reopened, first);
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.match(path.basename(directory), /^memoir-object-quality-/);
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing local audit data cannot silently regain legacy verified status", async () => {
  const audit = JSON.parse(
    await readFile(
      new URL("./fixtures/cafe-object-audit-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const detection = objectDetectionSchema.parse(audit).objects[0];
  const evidence = localObjectEvidence(detection, {}, 4032, 3024);
  assert.equal(evidence.confirmation, "unavailable");
  assert.equal(evidence.labelMatched, false);
  const object = objectSpec(
    detection.category,
    new Uint8Array(3),
    new Uint8Array([255]),
    { ...detection, evidence },
  );
  assert.equal(canReconstructMemoryObject(object), false);
});

test("whole-image agreement supports a fixed solid while mismatched decoded labels cannot verify it", () => {
  const detection = objectDetectionSchema.parse({
    objects: [
      {
        category: "chair",
        label: "chair",
        confidence: 0.8,
        box_2d: [150, 100, 300, 200],
        polygon: [
          [100, 150],
          [200, 150],
          [200, 300],
          [100, 300],
        ],
      },
    ],
  }).objects[0];
  const proposal = {
    category: "chair",
    score: 0.45,
    box: [150, 100, 300, 200],
  };
  const audit = {
    proposals: [proposal],
    confirmed: [{ ...proposal, score: 0.8 }],
    confirmations: [
      { category: "chair", detections: [prediction("a patio chair", 0.8)] },
      {
        category: "television",
        detections: [
          prediction("a television", 0.9, {
            xmin: 500,
            ymin: 500,
            xmax: 700,
            ymax: 700,
          }),
        ],
      },
    ],
  };
  const evidence = localObjectEvidence(detection, audit, 1000, 1000);
  assert.equal(evidence.confirmation, "full-image");
  assert.deepEqual(evidence.conflictingCategories, []);
  const object = objectSpec("chair", new Uint8Array(3), new Uint8Array([255]), {
    ...detection,
    evidence,
  });
  assert.equal(canReconstructMemoryObject(object), true);
  audit.confirmations[0].detections[0].label = "an object";
  const mismatched = localObjectEvidence(detection, audit, 1000, 1000);
  assert.equal(mismatched.labelMatched, false);
  assert.equal(
    canReconstructMemoryObject({ ...object, evidence: mismatched }),
    false,
  );
});

test("expanded search prioritizes evidenced classes and reports the unsearched vocabulary", () => {
  const context = {
    inventory: [
      {
        label: "airplane",
        category: "airplane" as const,
        confidence: 0.9,
        box: [0, 0, 0.5, 0.5],
      },
      { label: "sculpture", category: "sculpture" as const },
    ],
  };
  const plan = localObjectSearchPlan(context);
  assert.equal(plan.searchedCategories.length, LOCAL_CATEGORY_SEARCH_BUDGET);
  assert.ok(plan.searchedCategories.includes("airplane"));
  assert.ok(plan.searchedCategories.includes("sculpture"));
  assert.equal(
    new Set([...plan.searchedCategories, ...plan.unsearchedCategories]).size,
    MEMORY_OBJECT_CATEGORIES.length,
  );
  for (const batch of localObjectQueryBatches(context))
    assert.ok(batch.length <= 19);
  assert.ok(
    localObjectQueryBatches(context)
      .flat()
      .includes(LOCAL_OBJECT_CATEGORY_QUERIES.airplane.owl),
  );
  assert.equal(
    isObjectRecognitionCoverage({
      strategy: "local-evidence-priority",
      ...plan,
      unconfirmedCategories: [],
      candidateLimitReached: false,
      objectLimitReached: false,
    }),
    true,
  );
});

test("coverage survives cache reads and semantic query context has its own cache identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memoir-coverage-"));
  let calls = 0;
  const recognizer = localObjectRecognizer(directory, {
    runtime: {
      async detect(_image, context) {
        calls++;
        return {
          objects: [],
          proposals: [],
          confirmed: [],
          coverage: {
            strategy: "local-evidence-priority",
            ...localObjectSearchPlan(context),
            unconfirmedCategories: [],
            candidateLimitReached: false,
            objectLimitReached: false,
          },
        };
      },
    },
  });
  try {
    const image = Buffer.from("same-image");
    const context = {
      inventory: [{ category: "airplane" as const, label: "airplane" }],
    };
    const first = await recognizer(image, context),
      cached = await recognizer(image, context);
    assert.equal(calls, 1);
    assert.ok(first.coverage?.searchedCategories.includes("airplane"));
    assert.deepEqual(cached.coverage, first.coverage);
    await recognizer(image, {
      inventory: [{ category: "scooter", label: "scooter" }],
    });
    assert.equal(calls, 2);
  } finally {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.match(path.basename(target), /^memoir-coverage-/);
    await rm(target, { recursive: true, force: true });
  }
});

const prediction = (
  label: string,
  score: number,
  box = { xmin: 100, ymin: 150, xmax: 200, ymax: 300 },
) => ({ label, score, box });
test("ambiguous laptop proposals require stronger independent evidence", () => {
  const weakLaptop = {
    category: "laptop" as const,
    score: 0.25,
    box: [150, 100, 300, 200] as [number, number, number, number],
  };
  assert.equal(
    confirmObjectProposal(weakLaptop, [prediction("a laptop", 0.45)]),
    undefined,
  );
  assert.equal(
    confirmObjectProposal(weakLaptop, [prediction("a laptop", 0.65)])?.category,
    "laptop",
  );
  assert.equal(
    confirmObjectProposal({ ...weakLaptop, score: 0.55 }, [
      prediction("a laptop", 0.45),
    ])?.category,
    "laptop",
  );
  assert.equal(
    confirmObjectProposal({ ...weakLaptop, category: "drink-can" }, [
      prediction("a can", 0.45),
    ])?.category,
    "drink-can",
  );
});
test("local proposals preserve OWL scores, require finite bounds, and allow negative categories to win", () => {
  const raw = [
    prediction("a photo of an aluminum drink can", 0.25),
    prediction("a photo of a cup", 0.22),
    prediction("a photo of a grave marker", 0.8, {
      xmin: 300,
      ymin: 100,
      xmax: 500,
      ymax: 200,
    }),
    prediction("a photo of a laptop", 0.6, {
      xmin: 300,
      ymin: 100,
      xmax: 500,
      ymax: 200,
    }),
    prediction("a photo of a cell phone", NaN),
  ];
  assert.deepEqual(selectObjectProposals(raw, 1000, 1000), [
    { category: "drink-can", score: 0.25, box: [150, 100, 300, 200] },
  ]);
  assert.equal(
    selectObjectProposals(
      [
        prediction("a photo of a laptop", 0.9, {
          xmin: 0,
          ymin: 0,
          xmax: 1000,
          ymax: 1000,
        }),
      ],
      1000,
      1000,
    ).length,
    0,
  );
});
test("independent DINO confirmation must match both position and threshold", () => {
  const proposal = {
    category: "drink-can" as const,
    score: 0.25,
    box: [150, 100, 300, 200] as [number, number, number, number],
  };
  assert.equal(
    confirmObjectProposal(proposal, [prediction("a can", 0.39)]),
    undefined,
  );
  assert.equal(
    confirmObjectProposal(proposal, [
      prediction("a can", 0.9, { xmin: 700, ymin: 700, xmax: 900, ymax: 900 }),
    ]),
    undefined,
  );
  assert.equal(
    confirmObjectProposal(proposal, [prediction("a can", 0.65)])?.score,
    0.65,
  );
});
test("thermos aliases recover water bottles while competing cup predictions can still win", () => {
  assert.deepEqual(
    selectObjectProposals(
      [
        prediction("a photo of a water bottle", 0.24),
        prediction("a photo of a cup", 0.39),
        prediction("a photo of a thermos", 0.52),
      ],
      1000,
      1000,
    ),
    [{ category: "water-bottle", score: 0.52, box: [150, 100, 300, 200] }],
  );
  assert.deepEqual(
    selectObjectProposals(
      [
        prediction("a photo of a thermos", 0.52),
        prediction("a photo of a reusable bottle", 0.45),
        prediction("a photo of a cup", 0.61),
      ],
      1000,
      1000,
    ),
    [{ category: "cup", score: 0.61, box: [150, 100, 300, 200] }],
  );
});
test("a confident bottle cannot flip to a can while ambiguous containers can change class", () => {
  const bottle = {
    category: "water-bottle" as const,
    score: 0.54,
    box: [20, 40, 100, 80] as [number, number, number, number],
  };
  assert.equal(mayConfirmCategory(bottle, "drink-can"), false);
  assert.equal(mayConfirmCategory(bottle, "water-bottle"), true);
  assert.equal(
    mayConfirmCategory({ ...bottle, score: 0.35 }, "drink-can"),
    true,
  );
  assert.equal(
    mayConfirmCategory(
      { ...bottle, category: "drink-can", score: 0.35 },
      "water-bottle",
    ),
    true,
  );
  assert.equal(
    mayConfirmCategory({ ...bottle, score: 0.45 }, "drink-can"),
    false,
  );
});
test("class changes are limited to ambiguous cans and bottles", () => {
  const proposal = {
    category: "laptop" as const,
    score: 0.35,
    box: [20, 40, 100, 80] as [number, number, number, number],
  };
  assert.equal(mayConfirmCategory(proposal, "computer"), false);
  assert.equal(mayConfirmCategory(proposal, "water-bottle"), false);
  assert.equal(mayConfirmCategory(proposal, "laptop"), true);
  assert.equal(
    mayConfirmCategory({ ...proposal, category: "water-bottle" }, "laptop"),
    false,
  );
});
test("confirmation crops add 15 percent context using x/left and y/top coordinates", () => {
  // An asymmetric object makes accidentally swapping width/height or x/y visible.
  assert.deepEqual(confirmationCrop([80, 120, 200, 180], 500, 400), {
    left: 111,
    top: 62,
    width: 78,
    height: 156,
  });
  assert.deepEqual(confirmationCrop([0, 0, 40, 60], 200, 100), {
    left: 0,
    top: 0,
    width: 69,
    height: 46,
  });
  assert.deepEqual(confirmationCrop([60, 150, 100, 200], 200, 100), {
    left: 142,
    top: 54,
    width: 58,
    height: 46,
  });
});
test("bottle aliases leave a stronger book prediction able to suppress a laptop", () => {
  const bookBox = { xmin: 300, ymin: 100, xmax: 500, ymax: 250 };
  assert.deepEqual(
    selectObjectProposals(
      [
        prediction("a photo of a laptop", 0.78, bookBox),
        prediction("a photo of a book", 0.81, bookBox),
        prediction("a photo of an insulated bottle", 0.49),
      ],
      1000,
      1000,
    ),
    [
      { category: "book", score: 0.81, box: [100, 300, 250, 500] },
      { category: "water-bottle", score: 0.49, box: [150, 100, 300, 200] },
    ],
  );
});
test("equal-scoring overlapping bottle aliases deduplicate without merging separate bottles", () => {
  const nearbyBox = { xmin: 105, ymin: 155, xmax: 205, ymax: 305 };
  const separateBox = { xmin: 400, ymin: 150, xmax: 500, ymax: 300 };
  const selected = selectObjectProposals(
    [
      prediction("a photo of a thermos", 0.55),
      prediction("a photo of a reusable bottle", 0.55, nearbyBox),
      prediction("a photo of an insulated bottle", 0.55),
      prediction("a photo of a water bottle", 0.47, separateBox),
    ],
    1000,
    1000,
  );
  assert.deepEqual(selected, [
    { category: "water-bottle", score: 0.55, box: [150, 100, 300, 200] },
    { category: "water-bottle", score: 0.47, box: [150, 400, 300, 500] },
  ]);
});
test("learned mask contour keeps finger-shaped concavity and excludes disconnected noise", () => {
  const width = 30,
    height = 30,
    mask = new Uint8Array(width * height);
  for (let y = 4; y < 26; y++)
    for (let x = 5; x < 25; x++)
      if (!(x < 12 && y > 10 && y < 18)) mask[y * width + x] = 1;
  mask[0] = mask[1] = 1;
  const polygon = maskToPolygon(mask, width, height);
  assert.ok(polygon.length >= 8 && polygon.length <= 96);
  assert.ok(polygon.some(([x, y]) => x === 12 && y >= 10 && y <= 18));
  assert.ok(polygon.every(([x, y]) => x >= 5 && y >= 4));
  assert.deepEqual(maskToPolygon(new Uint8Array(4), 2, 2), []);
});
test("local results cache by image contents, serialize inference, and retry failures without remote calls", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "memoir-local-object-"),
  );
  let count = 0,
    active = 0,
    peak = 0;
  const runtime = {
    async detect(image: Buffer) {
      count++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (image.toString() === "failure" && count === 4)
        throw new Error("inference failed");
      return { objects: [], proposals: [], confirmed: [] };
    },
  };
  try {
    const detect = localObjectRecognizer(directory, { runtime });
    await Promise.all([
      detect(Buffer.from("one")),
      detect(Buffer.from("two")),
      detect(Buffer.from("one")),
    ]);
    assert.equal(count, 2);
    assert.equal(peak, 1);
    const cacheDir = path.join(directory, "object-detections"),
      cache = await readdir(cacheDir);
    assert.equal(cache.length, 2);
    const cacheFile = path.join(cacheDir, cache[0]);
    const data = JSON.parse(await readFile(cacheFile, "utf8"));
    assert.ok(data.version && data.digest && data.models);
    await writeFile(cacheFile, "{broken");
    await Promise.all([detect(Buffer.from("one")), detect(Buffer.from("two"))]);
    assert.equal(count, 3);
    await assert.rejects(detect(Buffer.from("failure")), /inference failed/);
    await detect(Buffer.from("failure"));
    assert.equal(count, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
