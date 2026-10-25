import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ReconstructionSpec, WorldCompletion } from "../src/types.js";
import {
  OBJECT_CATEGORIES,
  categoryFromLabel,
  objectDetectionSchema,
  sampledObjectColor,
  fittedObjectDimensions,
  fitPlanarObjectOrientation,
  objectSpec,
  type ObjectDetection,
} from "./object-recognition.js";
import {
  canReconstructMemoryObject,
  isMemoryObjectSpec,
  type MemoryObjectEvidence,
} from "../src/memory-objects.js";
import {
  LOCAL_OBJECT_MODEL_VERSION,
  LOCAL_OBJECT_INFERENCE_VERSION,
  localObjectRecognizer,
} from "./local-object-detector.js";
import { createHash } from "node:crypto";

test("bounded local provenance survives detection parsing and object material fitting", () => {
  const evidence: MemoryObjectEvidence = {
    version: 1,
    source: "local-detector",
    proposalConfidence: 0.392,
    confirmationConfidence: 0.544,
    confirmation: "crop",
    labelMatched: true,
    conflictingCategories: ["backpack", "television"],
  };
  const parsed = objectDetectionSchema.parse({
    objects: [{ ...detection("umbrella"), evidence }],
  }).objects[0];
  const spec = objectSpec(
    parsed.category,
    new Uint8Array([32, 64, 128]),
    new Uint8Array([255]),
    parsed,
  );
  assert.deepEqual(spec.evidence, evidence);
  assert.equal(isMemoryObjectSpec(spec), true);
  assert.equal(canReconstructMemoryObject(spec), false);
  for (const invalid of [
    { ...evidence, confirmationConfidence: NaN },
    { ...evidence, proposalConfidence: 1.1 },
    { ...evidence, conflictingCategories: ["person"] },
    { ...evidence, conflictingCategories: ["chair", "chair"] },
    { ...evidence, conflictingCategories: OBJECT_CATEGORIES.slice(0, 13) },
    { ...evidence, labelMatched: "yes" },
    { ...evidence, confirmation: "mask" },
    { ...evidence, samScore: 0.99 },
  ]) {
    assert.equal(isMemoryObjectSpec({ ...spec, evidence: invalid }), false);
    assert.throws(() =>
      objectDetectionSchema.parse({
        objects: [{ ...parsed, evidence: invalid }],
      }),
    );
  }
  assert.equal(isMemoryObjectSpec({ ...spec, evidence: undefined }), true);
});

test("diagonally held phone orientation follows its visible mask instead of its enclosing rectangle", () => {
  const width = 160,
    height = 160,
    mask = new Uint8Array(width * height),
    angle = Math.PI / 4;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const along = (x - 80) * Math.cos(angle) + (y - 80) * Math.sin(angle);
      const across = -(x - 80) * Math.sin(angle) + (y - 80) * Math.cos(angle);
      if (Math.abs(along) < 50 && Math.abs(across) < 22)
        mask[y * width + x] = 255;
    }
  mask[0] = 255;
  const fitted = fitPlanarObjectOrientation(mask, width, height)!;
  assert.ok(fitted);
  assert.ok(Math.abs(fitted.rotation[2] - Math.PI / 4) < 0.03);
  assert.ok(fitted.dimensions[0] / fitted.dimensions[1] < 0.5);
  assert.equal(fitted.dimensions[2], 0.009);
  assert.equal(
    fitPlanarObjectOrientation(
      new Uint8Array(width * height).fill(255),
      width,
      height,
    ),
    undefined,
  );
});
import {
  WorldCompleter,
  polygonMask,
  type CompletionProvider,
} from "./world-completion.js";

function detection(
  category: ObjectDetection["category"],
  x = 400,
): ObjectDetection {
  return {
    category,
    label: category,
    confidence: 0.9,
    box_2d: [400, x, 450, x + 50],
    polygon: [
      [x, 400],
      [x + 50, 400],
      [x + 50, 450],
      [x, 450],
    ],
  };
}

async function fixture(crowd = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memoir-objects-"));
  const uploads = path.join(directory, "uploads"),
    artifacts = path.join(uploads, "reconstructions");
  await mkdir(artifacts, { recursive: true });
  const key = "b".repeat(32),
    prefix = `/uploads/reconstructions/${key}`;
  await sharp({
    create: { width: 128, height: 96, channels: 3, background: "#3060a0" },
  })
    .jpeg()
    .toFile(path.join(artifacts, `${key}-source.jpg`));
  await sharp({
    create: { width: 128, height: 96, channels: 3, background: "#555555" },
  })
    .grayscale()
    .png()
    .toFile(path.join(artifacts, `${key}-depth.png`));
  const reconstruction: ReconstructionSpec = {
    version: 1,
    kind: "depth-mesh",
    sourceUrl: `${prefix}-source.jpg`,
    depthUrl: `${prefix}-depth.png`,
    width: 128,
    height: 96,
    depthSource: "depth-anything-v2",
    near: 2,
    far: 12,
    fov: 60,
  };
  const world: WorldCompletion = {
    version: 1,
    generatedBy: "local-segmentation",
    backgroundUrl: `${prefix}-source.jpg`,
    subjects: [],
  };
  if (crowd) {
    const maskUrl = `${prefix}-mask-person.png`;
    await sharp({
      create: { width: 128, height: 96, channels: 3, background: "#ffffff" },
    })
      .grayscale()
      .png()
      .toFile(path.join(artifacts, `${key}-mask-person.png`));
    world.subjects = Array.from({ length: 12 }, (_, i) => ({
      id: `person-${i}`,
      label: "Reviewed person",
      kind: "person",
      box: [0, 0, 1, 1],
      maskUrl,
      neuralAsset: {
        url: `${prefix}-reviewed.glb`,
        model: "makehuman",
        upAxis: "y",
        frontYaw: 0,
        appearance: "pbr",
        inputKind: "anatomical-template",
      },
    }));
    await writeFile(
      path.join(artifacts, `${key}-world.json`),
      JSON.stringify(world),
    );
  }
  return {
    directory,
    uploads,
    artifacts,
    key,
    reconstruction,
    world,
    readWorld: async () =>
      JSON.parse(
        await readFile(path.join(artifacts, `${key}-world.json`), "utf8"),
      ) as WorldCompletion,
    cleanup: async () => {
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.match(path.basename(target), /^memoir-objects-/);
      await rm(target, { recursive: true, force: true });
    },
  };
}

test("semantic category mapping covers supported local labels without inventing labels for depth blobs", () => {
  assert.equal(categoryFromLabel("cell phone"), "phone");
  assert.equal(categoryFromLabel("laptop"), "laptop");
  assert.equal(categoryFromLabel("backpack"), "backpack");
  assert.equal(categoryFromLabel("bottle"), "water-bottle");
  assert.equal(categoryFromLabel("Depth-isolated foreground"), undefined);
  assert.equal(categoryFromLabel("person wearing blue"), undefined);
  assert.throws(() =>
    objectDetectionSchema.parse({
      objects: [{ ...detection("phone"), category: "person" }],
    }),
  );
});

test("tiny source objects retain their real color instead of falling between sampling strides", () => {
  const rgb = new Uint8Array(512 * 512 * 3),
    mask = new Uint8Array(512 * 512);
  for (const pixel of [513, 514, 1025, 1026]) {
    mask[pixel] = 255;
    rgb.set([201, 34, 87], pixel * 3);
  }
  assert.equal(sampledObjectColor(rgb, mask), "#c92257");
});

test("observed squat cans and landscape phones keep their proportions instead of standard category proportions", () => {
  const mask = new Uint8Array(200 * 200);
  for (let y = 50; y < 150; y++)
    for (let x = 60; x < 140; x++) mask[y * 200 + x] = 255;
  // A thin straw must not determine the complete can body's height.
  for (let y = 10; y < 50; y++) mask[y * 200 + 100] = 255;
  const can = fittedObjectDimensions("drink-can", mask, 200, 200);
  assert.ok(Math.abs(can[0] / can[1] - 0.8) < 0.04);
  assert.equal(can[0], can[2]);
  const phone = new Uint8Array(200 * 100);
  for (let y = 25; y < 75; y++)
    for (let x = 50; x < 150; x++) phone[y * 200 + x] = 255;
  const fitted = fittedObjectDimensions("phone", phone, 200, 100);
  assert.ok(Math.abs(fitted[0] / fitted[1] - 2) < 0.05);
  assert.equal(fitted[2], 0.009);
});

test("cached twelve-person worlds acquire all eight small object types without replacing people or retrying paid calls", async () => {
  const f = await fixture(true);
  let calls = 0;
  const provider: CompletionProvider = {
    segment: async () => {
      throw new Error("Do not regenerate reviewed segmentation");
    },
    textures: async () => {
      throw new Error("Do not regenerate reviewed textures");
    },
    objects: async () => {
      calls++;
      return OBJECT_CATEGORIES.slice(0, 8).map((category, i) =>
        detection(category, 60 + i * 110),
      );
    },
  };
  try {
    const completer = new WorldCompleter(f.uploads, {
      provider,
      localSegmenter: false,
      poseEstimator: false,
    });
    await Promise.all([
      completer.complete(f.reconstruction),
      completer.complete(f.reconstruction),
    ]);
    const enriched = await f.readWorld();
    assert.deepEqual(
      enriched.subjects.filter((subject) => subject.kind === "person"),
      f.world.subjects,
    );
    assert.equal(enriched.subjects.length, 20);
    assert.deepEqual(
      enriched.subjects
        .filter((subject) => subject.object)
        .map((subject) => subject.object!.category),
      [...OBJECT_CATEGORIES.slice(0, 8)],
    );
    assert.deepEqual(enriched.objectRecognition, {
      version: 1,
      source: "gemini",
      status: "complete",
      detected: 8,
    });
    assert.ok(
      enriched.subjects
        .filter((subject) => subject.object)
        .every((subject) =>
          /^#30[56][0-9a-f]a[0-9a-f]$/.test(subject.object!.color),
        ),
    );
    assert.ok(
      enriched.subjects.find((subject) => subject.object?.category === "phone")!
        .object!.dimensions[2] < 0.01,
    );
    const mask = await sharp(
      path.join(
        f.uploads,
        enriched.subjects[12].maskUrl.slice("/uploads/".length),
      ),
    )
      .raw()
      .toBuffer();
    assert.ok(
      mask.some(Boolean),
      "A held object is not erased by the overlapping person mask.",
    );
    await new WorldCompleter(f.uploads, {
      provider,
      localSegmenter: false,
      poseEstimator: false,
    }).complete(f.reconstruction);
    assert.equal(calls, 1);
  } finally {
    await f.cleanup();
  }
});

test("Gemini outage uses small local object detections and the durable attempt marker prevents repeat charges", async () => {
  const f = await fixture(true);
  let calls = 0,
    localCalls = 0;
  const provider: CompletionProvider = {
    segment: async () => [],
    textures: async () => {
      throw new Error("unused");
    },
    objects: async () => {
      calls++;
      throw Object.assign(new Error("unavailable"), { status: 429 });
    },
  };
  const localSegmenter = async (
    _image: Buffer,
    width: number,
    height: number,
  ) => {
    localCalls++;
    const phone = detection("phone");
    return [
      {
        subject: {
          label: "cell phone",
          kind: "object" as const,
          confidence: 0.98,
          box_2d: phone.box_2d,
          polygon: phone.polygon,
        },
        mask: polygonMask(width, height, phone.polygon),
      },
    ];
  };
  try {
    await new WorldCompleter(f.uploads, {
      provider,
      localSegmenter,
      poseEstimator: false,
    }).complete(f.reconstruction);
    const enriched = await f.readWorld();
    assert.equal(enriched.objectRecognition?.source, "local-segmentation");
    assert.equal(enriched.objectRecognition?.detected, 1);
    assert.equal(enriched.subjects.at(-1)?.object?.category, "phone");
    assert.equal(enriched.subjects.at(-1)?.object?.confidence, 0.98);
    const attempt = JSON.parse(
      await readFile(
        path.join(f.artifacts, `${f.key}-object-recognition-v1.json`),
        "utf8",
      ),
    );
    assert.equal(attempt.status, "unavailable");
    assert.equal(attempt.httpStatus, 429);
    await new WorldCompleter(f.uploads, {
      provider,
      localSegmenter,
      poseEstimator: false,
    }).complete(f.reconstruction);
    assert.equal(calls, 1);
    assert.equal(localCalls, 1);
    // Simulate a crash after the paid attempt persisted but before final world metadata was saved.
    await writeFile(
      path.join(f.artifacts, `${f.key}-world.json`),
      JSON.stringify(f.world),
    );
    await new WorldCompleter(f.uploads, {
      provider,
      localSegmenter: false,
      poseEstimator: false,
    }).complete(f.reconstruction);
    assert.equal(calls, 1);
    const unavailable = await f.readWorld();
    assert.equal(unavailable.objectRecognition?.status, "unavailable");
    assert.equal(unavailable.objectRecognition?.detected, 0);
    assert.deepEqual(unavailable.subjects, f.world.subjects);
  } finally {
    await f.cleanup();
  }
});

test("local confidence audit rejects weak and unscored replacements, preserves actual strong scores, and never recalls Gemini", async () => {
  const f = await fixture(true);
  let localCalls = 0,
    cloudCalls = 0;
  const weak = detection("water-bottle", 100),
    strong = detection("phone", 400),
    unscored = detection("laptop", 700);
  const oldObject: WorldCompletion["subjects"][number] = {
    id: "legacy-bottle",
    label: "bottle",
    kind: "object",
    box: weak.box_2d.map((value) => value / 1000) as [
      number,
      number,
      number,
      number,
    ],
    maskUrl: f.world.subjects[0].maskUrl,
    object: {
      category: "water-bottle",
      confidence: 0.7,
      color: "#3060a0",
      dimensions: [0.075, 0.24, 0.075],
    },
  };
  const legacy: WorldCompletion = {
    ...f.world,
    subjects: [...f.world.subjects, oldObject],
    objectRecognition: {
      version: 1,
      source: "local-segmentation",
      status: "complete",
      detected: 1,
    },
  };
  const localSegmenter = async (
    _image: Buffer,
    width: number,
    height: number,
  ) => {
    localCalls++;
    return [
      { detected: weak, label: "bottle", confidence: 0.9257550239562988 },
      { detected: strong, label: "cell phone", confidence: 0.98 },
      { detected: unscored, label: "laptop", confidence: undefined },
    ].map(({ detected, label, confidence }) => ({
      subject: {
        label,
        kind: "object" as const,
        box_2d: detected.box_2d,
        polygon: detected.polygon,
        ...(confidence === undefined ? {} : { confidence }),
      },
      mask: polygonMask(width, height, detected.polygon),
    }));
  };
  const provider: CompletionProvider = {
    segment: async () => {
      cloudCalls++;
      return [];
    },
    textures: async () => {
      cloudCalls++;
      throw new Error("unused");
    },
    objects: async () => {
      cloudCalls++;
      return [];
    },
  };
  try {
    await writeFile(
      path.join(f.artifacts, `${f.key}-world.json`),
      JSON.stringify(legacy),
    );
    const completer = new WorldCompleter(f.uploads, {
      provider,
      localSegmenter,
      poseEstimator: false,
    });
    await completer.complete(f.reconstruction);
    const audited = await f.readWorld();
    assert.equal(
      audited.subjects.find((subject) => subject.id === "legacy-bottle")
        ?.object,
      undefined,
    );
    assert.deepEqual(
      audited.subjects.filter((subject) => subject.kind === "person"),
      f.world.subjects,
    );
    const recognized = audited.subjects.filter((subject) => subject.object);
    assert.equal(recognized.length, 1);
    assert.equal(recognized[0].object?.category, "phone");
    assert.equal(recognized[0].object?.confidence, 0.98);
    assert.equal(audited.objectRecognition?.detected, 1);
    await completer.complete(f.reconstruction);
    assert.equal(localCalls, 1);
    assert.equal(
      cloudCalls,
      0,
      "Auditing old local results must never issue a paid cloud request, even without a cloud marker.",
    );
  } finally {
    await f.cleanup();
  }
});

test("an old label without a confidence-bearing detector result cannot invent an object", async () => {
  const f = await fixture(true);
  try {
    const labelOnly: WorldCompletion = {
      ...f.world,
      subjects: [
        ...f.world.subjects,
        {
          id: "unscored-phone",
          label: "cell phone",
          kind: "object",
          box: [0.4, 0.4, 0.45, 0.45],
          maskUrl: f.world.subjects[0].maskUrl,
        },
      ],
    };
    await writeFile(
      path.join(f.artifacts, `${f.key}-world.json`),
      JSON.stringify(labelOnly),
    );
    await new WorldCompleter(f.uploads, {
      localSegmenter: false,
      poseEstimator: false,
    }).complete(f.reconstruction);
    const result = await f.readWorld();
    assert.equal(result.subjects.at(-1)?.object, undefined);
    assert.equal(result.objectRecognition?.detected, 0);
    assert.equal(result.objectRecognition?.status, "unavailable");
  } finally {
    await f.cleanup();
  }
});

test("video-frame completion detects objects without requesting a generated image atlas or fitting static people", async () => {
  const f = await fixture();
  let imageCalls = 0,
    objectCalls = 0,
    poseCalls = 0;
  const provider: CompletionProvider = {
    segment: async () => [],
    objects: async () => {
      objectCalls++;
      return [detection("drink-can")];
    },
    textures: async () => {
      imageCalls++;
      throw new Error("Video must not charge image generation");
    },
  };
  try {
    await new WorldCompleter(f.uploads, {
      provider,
      localSegmenter: false,
      poseEstimator: async () => {
        poseCalls++;
        return [];
      },
    }).complete({ ...f.reconstruction, mediaBasis: "video-frame" });
    assert.equal(imageCalls, 0);
    assert.equal(objectCalls, 1);
    assert.equal(poseCalls, 0);
    assert.equal(
      (await f.readWorld()).subjects[0].object?.category,
      "drink-can",
    );
  } finally {
    await f.cleanup();
  }
});

test("local object recognition upgrades a quota-failed cached crowd without cloud calls and survives reopen", async () => {
  const f = await fixture(true);
  let localCalls = 0;
  const provider: CompletionProvider = {
    segment: async () => {
      throw new Error("Cached people must not be regenerated");
    },
    objects: async () => {
      throw new Error("Local mode must not call Gemini");
    },
    textures: async () => {
      throw new Error("Cached textures must not be regenerated");
    },
  };
  try {
    f.world.objectRecognition = {
      version: 1,
      status: "unavailable",
      source: "local-segmentation",
      detected: 0,
    };
    await writeFile(
      path.join(f.artifacts, `${f.key}-world.json`),
      JSON.stringify(f.world),
    );
    await writeFile(
      path.join(f.artifacts, `${f.key}-object-recognition-v1.json`),
      JSON.stringify({ status: "unavailable", httpStatus: 429 }),
    );
    const options = {
      provider,
      localSegmenter: false as const,
      poseEstimator: false as const,
      localObjectModelVersion: "grounding-test-v1",
      localObjectRecognizer: async () => {
        localCalls++;
        // Detector scores use their own scale, not the old DETR threshold.
        return [{ ...detection("drink-can"), confidence: 0.43 }];
      },
    };
    await new WorldCompleter(f.uploads, options).complete(f.reconstruction);
    await new WorldCompleter(f.uploads, options).complete(f.reconstruction);
    const result = await f.readWorld();
    assert.equal(localCalls, 1);
    assert.equal(result.subjects.filter((s) => s.kind === "person").length, 12);
    assert.deepEqual(result.subjects.slice(0, 12), f.world.subjects);
    assert.equal(result.subjects.at(-1)?.object?.confidence, 0.43);
    assert.equal(result.objectRecognition?.source, "local-grounding-dino");
    assert.equal(result.objectRecognition?.modelVersion, "grounding-test-v1");
    assert.equal(result.objectRecognition?.status, "complete");
  } finally {
    await f.cleanup();
  }
});

test("local model revision removes obsolete automatic objects and restores their photographic pixels", async () => {
  const f = await fixture(true);
  try {
    const options = {
      localSegmenter: false as const,
      poseEstimator: false as const,
    };
    await new WorldCompleter(f.uploads, {
      ...options,
      localObjectModelVersion: "test-v1",
      localObjectRecognizer: async () => [detection("phone")],
    }).complete(f.reconstruction);
    const old = await f.readWorld();
    assert.equal(old.subjects.filter((s) => s.object).length, 1);
    await new WorldCompleter(f.uploads, {
      ...options,
      localObjectModelVersion: "test-v2",
      localObjectRecognizer: async () => [],
    }).complete(f.reconstruction);
    const corrected = await f.readWorld();
    assert.equal(corrected.subjects.filter((s) => s.object).length, 0);
    assert.equal(
      corrected.subjects.filter((s) => s.kind === "person").length,
      12,
    );
    assert.equal(corrected.objectRecognition?.detected, 0);
    const pixels = await sharp(
      path.join(f.uploads, corrected.backgroundUrl.slice("/uploads/".length)),
    )
      .raw()
      .toBuffer();
    // The removed region returns to the original photo, not a transparent hole.
    const pixel = (40 * 128 + 53) * 3;
    assert.ok(Math.abs(pixels[pixel] - 48) < 5);
    assert.ok(Math.abs(pixels[pixel + 2] - 160) < 5);
  } finally {
    await f.cleanup();
  }
});

test("quality metadata revision revalidates an existing world from its v7 audit without inference or source/depth identity changes", async () => {
  const f = await fixture();
  try {
    const audit = JSON.parse(
      await readFile(
        new URL("./fixtures/cafe-object-audit-v1.json", import.meta.url),
        "utf8",
      ),
    );
    const candidate = objectDetectionSchema.parse(audit).objects[0];
    const mask = polygonMask(128, 96, candidate.polygon);
    const pixels = new Uint8Array(128 * 96 * 3);
    for (let i = 0; i < mask.length; i++)
      pixels.set(mask[i] ? [220, 35, 25] : [25, 65, 180], i * 3);
    const sourcePath = path.join(f.artifacts, `${f.key}-source.jpg`);
    const source = await sharp(pixels, {
      raw: { width: 128, height: 96, channels: 3 },
    })
      .jpeg({ quality: 98 })
      .toBuffer();
    await writeFile(sourcePath, source);
    const originalImage = await sharp(source)
      .resize(4032, 3024)
      .jpeg({ quality: 98 })
      .toBuffer();
    const depthPath = path.join(f.artifacts, `${f.key}-depth.png`),
      depthBefore = await readFile(depthPath);
    await writeFile(
      path.join(f.artifacts, `${f.key}-world.json`),
      JSON.stringify(f.world),
    );
    const options = {
      localSegmenter: false as const,
      poseEstimator: false as const,
    };
    await new WorldCompleter(f.uploads, {
      ...options,
      localObjectModelVersion: LOCAL_OBJECT_INFERENCE_VERSION,
      localObjectRecognizer: async () => [candidate],
    }).complete(f.reconstruction, { originalImage });
    const old = await f.readWorld();
    assert.equal(
      old.objectRecognition?.modelVersion,
      `${LOCAL_OBJECT_INFERENCE_VERSION}-original-v2`,
    );
    assert.equal(
      old.subjects.find((s) => s.object)?.object?.evidence,
      undefined,
    );

    const resultDirectory = path.join(f.directory, "saved-object-audit");
    await mkdir(resultDirectory);
    const digest = createHash("sha256")
      .update(LOCAL_OBJECT_INFERENCE_VERSION)
      .update(originalImage)
      .update(JSON.stringify({ categories: [], boxes: [] }))
      .digest("hex");
    const auditPath = path.join(resultDirectory, `${digest}.json`),
      auditText = JSON.stringify({ ...audit, digest });
    await writeFile(auditPath, auditText);
    let nativeCalls = 0,
      recognizerCalls = 0;
    const replay = localObjectRecognizer(f.directory, {
      resultDirectory,
      runtime: {
        async detect() {
          nativeCalls++;
          throw new Error("Existing v7 inference must be reused");
        },
      },
    });
    const completer = new WorldCompleter(f.uploads, {
      ...options,
      localObjectModelVersion: LOCAL_OBJECT_MODEL_VERSION,
      localObjectRecognizer: async (image, context) => {
        recognizerCalls++;
        return replay(image, context);
      },
    });
    const geometry = await completer.complete(f.reconstruction, {
      originalImage,
    });
    await completer.complete(geometry, { originalImage });
    const corrected = await f.readWorld(),
      object = corrected.subjects.find((s) => s.object)?.object;
    assert.equal(nativeCalls, 0);
    assert.equal(recognizerCalls, 1);
    assert.equal(
      corrected.objectRecognition?.modelVersion,
      `${LOCAL_OBJECT_MODEL_VERSION}-original-v2`,
    );
    assert.equal(object?.category, "umbrella");
    assert.equal(object?.evidence?.confirmation, "crop");
    assert.deepEqual(object?.evidence?.conflictingCategories, [
      "backpack",
      "television",
    ]);
    assert.equal(canReconstructMemoryObject(object!), false);
    assert.equal(geometry.sourceUrl, f.reconstruction.sourceUrl);
    assert.equal(geometry.depthUrl, f.reconstruction.depthUrl);
    assert.deepEqual(await readFile(sourcePath), source);
    assert.deepEqual(await readFile(depthPath), depthBefore);
    assert.equal(await readFile(auditPath, "utf8"), auditText);
    const restored = await sharp(
      path.join(f.uploads, corrected.backgroundUrl.slice("/uploads/".length)),
    )
      .raw()
      .toBuffer();
    const sourceRgb = await sharp(source).raw().toBuffer();
    const center = (83 * 128 + 102) * 3;
    assert.ok(mask[center / 3] >= 128);
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(restored[center + c] - sourceRgb[center + c]) < 16,
        "Tentative umbrella must restore the source table pixels, not inpaint its mask again",
      );
  } finally {
    await f.cleanup();
  }
});

test("a fresh completion restores a generic segment when the new local fixed-object evidence is tentative", async () => {
  const f = await fixture();
  try {
    const candidate: ObjectDetection = {
      category: "umbrella",
      label: "umbrella",
      confidence: 0.544,
      box_2d: [300, 300, 800, 900],
      polygon: [
        [300, 300],
        [900, 300],
        [900, 800],
        [300, 800],
      ],
      evidence: {
        version: 1,
        source: "local-detector",
        proposalConfidence: 0.392,
        confirmationConfidence: 0.544,
        confirmation: "crop",
        labelMatched: true,
        conflictingCategories: ["backpack", "television"],
      },
    };
    const sourcePath = path.join(f.artifacts, `${f.key}-source.jpg`);
    const pixels = new Uint8Array(128 * 96 * 3),
      mask = polygonMask(128, 96, candidate.polygon);
    for (let i = 0; i < mask.length; i++)
      pixels.set(mask[i] ? [220, 35, 25] : [25, 65, 180], i * 3);
    const source = await sharp(pixels, {
      raw: { width: 128, height: 96, channels: 3 },
    })
      .jpeg({ quality: 98 })
      .toBuffer();
    await writeFile(sourcePath, source);
    let segmentationCalls = 0;
    await new WorldCompleter(f.uploads, {
      poseEstimator: false,
      localObjectModelVersion: LOCAL_OBJECT_MODEL_VERSION,
      localSegmenter: async (_image, width, height) => {
        segmentationCalls++;
        return [
          {
            subject: {
              ...candidate,
              label: "Generic foreground object",
              kind: "object",
            },
            mask: polygonMask(width, height, candidate.polygon),
          },
        ];
      },
      localObjectRecognizer: async () => [candidate],
    }).complete(f.reconstruction);
    const result = await f.readWorld(),
      subject = result.subjects.find((s) => s.object);
    assert.equal(segmentationCalls, 1);
    assert.equal(subject?.object?.evidence?.confirmation, "crop");
    assert.equal(canReconstructMemoryObject(subject!.object!), false);
    const restored = await sharp(
      path.join(f.uploads, result.backgroundUrl.slice("/uploads/".length)),
    )
      .raw()
      .toBuffer();
    const sourceRgb = await sharp(source).raw().toBuffer(),
      center = (50 * 128 + 70) * 3;
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(restored[center + c] - sourceRgb[center + c]) < 16,
        "Fresh generic segmentation must not leave a hole beneath tentative inventory",
      );
  } finally {
    await f.cleanup();
  }
});
