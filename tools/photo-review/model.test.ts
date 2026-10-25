import test from "node:test";
import assert from "node:assert/strict";
import {
  canBlend,
  candidateReportKey,
  candidateReportUrl,
  evidenceUrl,
  parseReviewState,
  pinReadyDefaults,
  serializeReviewState,
} from "./model";
import {
  depthVariants,
  registryEntries,
  snapshotVariant,
  qualitativeVariants,
  reviewRegistryConfig,
  CAPTURE_MANIFEST_LIMIT,
} from "./adapters";

const a = "a".repeat(64),
  b = "b".repeat(64),
  c = "c".repeat(64);
const base = "/.local/depth-fidelity-v1/case-01/captures/";
test("registry active report accepts only versioned local candidate reports and derives the live viewer key", () => {
  const v2 = "/.local/photo-scene-candidate-v2-results.json";
  assert.equal(
    reviewRegistryConfig({ activeReportUrl: v2 }).activeReportUrl,
    v2,
  );
  assert.equal(candidateReportKey(v2), "candidate-v2");
  assert.equal(candidateReportKey(undefined), "candidate");
  for (const value of [
    "https://example.com/results.json",
    "/.local/photo-scene-candidate-vx-results.json",
    `${v2}?x=1`,
    "/.local/../photo-scene-candidate-results.json",
  ]) {
    assert.equal(candidateReportUrl(value), undefined);
    assert.equal(
      reviewRegistryConfig({ activeReportUrl: value }).activeReportUrl,
      "/.local/photo-scene-candidate-results.json",
    );
    assert.ok(reviewRegistryConfig({ activeReportUrl: value }).notices.length);
  }
});
test("capture registry deduplicates the pinned v1 record and preserves its hash against conflicts", () => {
  const pinned = reviewRegistryConfig({}).captureManifests[0];
  const v2 = {
    url: "/.local/candidate-album-scenes/capture-manifests/v2-photo01.json",
    sha256: b,
  };
  const result = reviewRegistryConfig({
    captureManifests: [
      pinned,
      pinned,
      v2,
      v2,
      { ...pinned, sha256: a },
      { url: "https://example.com/x.json", sha256: a },
      { url: v2.url, sha256: "bad" },
    ],
  });
  assert.deepEqual(result.captureManifests, [pinned, v2]);
  assert.ok(result.notices.some((value) => value.includes("Conflicting")));
  assert.ok(result.notices.some((value) => value.includes("Invalid")));
});
test("capture registry bounds requests including the pinned v1 manifest", () => {
  const result = reviewRegistryConfig({
    captureManifests: Array.from({ length: 200 }, (_, index) => ({
      url: `/.local/candidate-album-scenes/capture-manifests/v2-${index}.json`,
      sha256: b,
    })),
  });
  assert.equal(result.captureManifests.length, CAPTURE_MANIFEST_LIMIT);
  assert.equal(result.captureManifests.length, 165);
  assert.ok(result.notices.some((value) => value.includes("limit")));
  assert.equal(
    reviewRegistryConfig({ captureManifests: {} }).captureManifests.length,
    1,
  );
});
function qualitativeFixture() {
  return {
    sha256: c,
    url: "/.local/candidate-album-scenes/capture-manifests/v1-photo01.json",
    value: {
      schemaVersion: 1,
      kind: "qualitative-screenshot-captures",
      photoIndex: 1,
      variantId: "frozen-v1",
      variantName: "Photo evidence, poses and objects v1",
      source: { sha256: a },
      variantManifest: { sha256: b },
      uiOverlaysPresent: true,
      metricsEligible: false,
      actualExtrinsics: "unmeasured",
      captures: [
        {
          id: "v1-photo01-photo-right",
          label: "Photo fidelity · right movement 450 ms",
          camera: {
            preset: "Front plus right movement",
            actualExtrinsics: "unmeasured",
            movement: { requestedDurationMs: 450, measuredDisplacement: null },
          },
          servedRelativeUrl:
            "/.local/candidate-album-scenes/screenshots/v1/01-photo-right.png",
          sha256: c,
          dimensions: { width: 1264, height: 993 },
          actualMimeType: "image/jpeg",
          actualFormat: "jpeg",
          extensionMismatch: true,
          uiOverlaysPresent: true,
          metricsEligible: false,
        },
      ],
    },
  };
}
const qualitativeImplementation = () =>
  ({
    id: "frozen-v1",
    photo: 1,
    manifestSha256: b,
    manifestUrl: "/.local/photo-scene-variants/photo-01/run/manifest.json",
    captures: {},
    provenance: {
      sourceSha256: a,
      code: { commit: "frozen-commit", dirtyFingerprint: c },
    },
  }) as any;
test("qualitative screenshots preserve JPEG bytes/names and never become calibrated source or 8 cm views", () => {
  const [variant] = qualitativeVariants(
    qualitativeFixture(),
    qualitativeImplementation(),
  );
  assert.equal(variant.kind, "qualitative");
  assert.deepEqual(variant.captures, {});
  assert.equal(variant.qualitativeCapture?.actualMimeType, "image/jpeg");
  assert.match(variant.qualitativeCapture!.url, /01-photo-right\.png$/);
  assert.equal(variant.qualitativeCapture?.aligned, false);
  assert.equal(variant.qualitativeCapture?.clean, false);
  assert.equal(variant.qualitativeCapture?.metricsEligible, false);
  assert.equal(variant.metrics, undefined);
  assert.equal(
    (variant.qualitativeCapture?.camera as any).movement.requestedDurationMs,
    450,
  );
  assert.equal((variant.provenance.code as any).commit, "frozen-commit");
  assert.equal((variant.provenance.implementationManifest as any).sha256, b);
  assert.ok(Object.isFrozen(variant.qualitativeCapture));
  const reference = {
    url: "/reference.png",
    sha256: a,
    width: 1264,
    height: 993,
  };
  assert.equal(
    canBlend(variant.qualitativeCapture, reference, reference, "source"),
    false,
  );
});
test("qualitative captures reject mismatched implementation provenance or a metrics eligibility upgrade", () => {
  assert.throws(
    () =>
      qualitativeVariants(qualitativeFixture(), {
        ...qualitativeImplementation(),
        manifestSha256: a,
      }),
    /provenance/,
  );
  const document = qualitativeFixture();
  document.value.captures[0].metricsEligible = true;
  assert.throws(
    () => qualitativeVariants(document, qualitativeImplementation()),
    /Invalid qualitative/,
  );
});
test("initial unavailable placeholders are never pinned into comparison URLs", () => {
  const state = parseReviewState("");
  const placeholder = {
    id: "depth-256-1",
    alias: "depth-256",
    status: "unavailable",
  } as any;
  assert.equal(pinReadyDefaults(state, placeholder).a, "depth-256");
  assert.equal(
    pinReadyDefaults(state, {
      ...placeholder,
      id: "depth-1-baseline-hash",
      status: "ready",
    }).a,
    "depth-1-baseline-hash",
  );
  assert.equal(
    pinReadyDefaults({ ...state, a: "explicit-missing-id" }, placeholder).a,
    "explicit-missing-id",
  );
});
test("comparison URLs retain immutable choices and region state", () => {
  const value = {
    photo: 3,
    a: "depth-3-baseline-abc",
    b: "attempt-2026-10-24:def",
    view: "source" as const,
    mode: "swipe" as const,
    roi: "seated-face",
    mix: 63,
  };
  assert.deepEqual(parseReviewState(serializeReviewState(value)), value);
});
test("invalid and off-axis URL state cannot enable source metrics or overlay", () => {
  assert.equal(parseReviewState("?photo=34").photo, 1);
  assert.equal(parseReviewState("?photo=2.3").photo, 1);
  assert.equal(parseReviewState("?mix=NaN").mix, 50);
  assert.equal(parseReviewState("?mix=999").mix, 100);
  assert.equal(
    parseReviewState("?variants=javascript:alert(1),ok").a,
    "depth-256",
  );
  const value = parseReviewState("?view=left&mode=overlay&roi=face");
  assert.equal(value.mode, "side");
  assert.equal(value.roi, "full");
});
test("asset paths stay within served evidence roots", () => {
  assert.equal(
    evidenceUrl(
      "C:\\repo\\.local\\depth-fidelity-v1\\case-01\\captures\\x.png",
    ),
    `${base}x.png`,
  );
  assert.equal(
    evidenceUrl(
      "photo-01/run/source/working.jpg",
      "/.local/photo-scene-variants/photo-01/run/manifest.json",
    ),
    "/.local/photo-scene-variants/photo-01/run/source/working.jpg",
  );
  assert.equal(
    evidenceUrl(
      "assets/a.png",
      "/.local/photo-scene-variants/photo-01/run/manifest.json",
    ),
    "/.local/photo-scene-variants/photo-01/run/assets/a.png",
  );
  for (const value of [
    "https://example.com/image.png",
    "javascript:alert(1)",
    "/.env",
    "../secret",
    "%2e%2e/secret",
    "/.local/depth-fidelity-v1/../secret",
  ])
    assert.equal(evidenceUrl(value), undefined);
});
function depthDocument() {
  return {
    sha256: c,
    url: `${base}capture-report.json`,
    value: {
      schemaVersion: 1,
      experiment: "depth-resolution-only",
      configuration: { width: 960, height: 720 },
      artifacts: {
        reference: { path: `${base}source-reference.png`, sha256: a },
      },
      captures: [
        {
          variant: "baseline",
          view: "source-camera",
          coverage: false,
          path: `${base}baseline-source-camera.png`,
          sha256: b,
          cameraWorldMatrix: [1],
          renderMs: 2,
        },
        {
          variant: "baseline",
          view: "left-8cm",
          coverage: false,
          path: `${base}baseline-left-8cm.png`,
          sha256: c,
        },
        {
          variant: "baseline",
          view: "source-camera",
          coverage: true,
          path: `${base}coverage.png`,
          sha256: c,
        },
      ],
      frozenImplementation: { surface: { sha256: c } },
      browserBundleSha256: b,
    },
  };
}
test("depth records preserve provenance, exclude coverage images and pin immutable identity", () => {
  const document = depthDocument();
  const variants = depthVariants(
    { index: 1, originalSha256: a },
    document,
    {
      view: "source-camera",
      alignmentVerified: true,
      inputs: { reference: { sha256: a }, baseline: { sha256: b } },
      global: { baseline: { mae: 0.01 } },
    },
    {},
  );
  const variant = variants[0];
  assert.equal(variant.name, "Frozen surface · depth 256");
  assert.equal(variant.kind, "depth-ablation");
  assert.equal(variant.captures.source?.sha256, b);
  assert.equal(variant.metrics?.global?.mae, 0.01);
  assert.equal(variant.captures.left?.aligned, false);
  assert.equal((variant.provenance.code as any).commit, null);
  assert.ok(Object.isFrozen(variant));
  assert.ok(Object.isFrozen(variant.provenance));
  assert.match(variant.id, new RegExp(c.slice(0, 16)));
});
test("overlay requires the exact aligned reference and source view", () => {
  const reference = {
    url: "/reference.png",
    sha256: a,
    width: 960,
    height: 720,
  };
  const capture = {
    url: "/capture.png",
    sha256: b,
    width: 960,
    height: 720,
    clean: true,
    aligned: true,
  };
  assert.equal(canBlend(capture, reference, reference, "source"), true);
  assert.equal(
    canBlend(capture, reference, { ...reference, sha256: b }, "source"),
    false,
  );
  assert.equal(canBlend(capture, reference, reference, "left"), false);
  assert.equal(
    canBlend({ ...capture, clean: false }, reference, reference, "source"),
    false,
  );
  assert.equal(
    canBlend({ ...capture, width: 1200 }, reference, reference, "source"),
    false,
  );
});
test("source metrics are withheld when input hashes do not match captures", () => {
  const records = depthVariants(
    { index: 1 },
    depthDocument(),
    {
      view: "source-camera",
      alignmentVerified: true,
      inputs: { reference: { sha256: c }, baseline: { sha256: b } },
      global: { baseline: { mae: 0 } },
    },
    {},
  );
  assert.equal(records[0].metrics, undefined);
});
test("a successful archived scene is not silently presented as a clean render", () => {
  const snapshot = {
    variantId: "immutable-attempt-1",
    inputIdentity: {
      photoIndex: 2,
      attemptId: 1,
      startedAt: "2026-10-24T21:00:00Z",
    },
    provenance: {
      sourceSha256: a,
      code: { commit: "abc", dirtyFingerprint: b },
    },
    files: [
      { role: "source", archivePath: "assets/source.png", sha256: a },
      { role: "completion", archivePath: "assets/world.json", sha256: b },
    ],
    raw: { attempt: { status: "completed" }, scene: {} },
  };
  const variant = snapshotVariant({
    value: snapshot,
    sha256: c,
    url: "/.local/photo-scene-variants/photo-02/run/manifest.json",
  });
  assert.equal(variant.status, "snapshot");
  assert.deepEqual(variant.captures, {});
  assert.equal((variant.provenance.code as any).dirtyFingerprint, b);
  assert.ok(Object.isFrozen(snapshot.files));
});
test("failed attempts remain failed and registry hashes survive normalization", () => {
  const variant = snapshotVariant({
    value: {
      variantId: "failed-run",
      inputIdentity: { photoIndex: 1 },
      files: [],
      raw: { attempt: { status: "failed" } },
    },
    sha256: a,
    url: "/.local/photo-scene-variants/photo-01/run/manifest.json",
  });
  assert.equal(variant.status, "failed");
  assert.deepEqual(
    registryEntries({
      version: 1,
      entries: [
        { manifestPath: "photo-01/run/manifest.json", manifestSha256: a },
      ],
    }),
    [
      {
        url: "/.local/photo-scene-variants/photo-01/run/manifest.json",
        sha256: a,
      },
    ],
  );
  assert.throws(() => registryEntries({ unrelated: [] }), /schema/);
});
test("registry v1 preserves variant names, root-relative assets and separately archived failure status", () => {
  const document = {
    sha256: c,
    url: "/.local/photo-scene-variants/photo-01/run/manifest.json",
    value: {
      schemaVersion: 1,
      variantId: "run",
      variantName: "Photo evidence, poses and objects v1",
      inputIdentity: {
        photoIndex: 1,
        attemptNumber: 2,
        startedAt: "2026-10-24T21:30:00Z",
      },
      provenance: {
        sourceSha256: a,
        code: { commit: "abc", dirtyFingerprint: b },
      },
      timing: { processingMs: 358485 },
      counts: { people: 4, posedPeople: 2, props: 1 },
      files: [
        {
          role: "source",
          archivePath: "photo-01/run/source/working.jpg",
          sha256: a,
        },
      ],
      raw: { attempt: "photo-01/run/raw/attempt.json" },
    },
  };
  const variant = snapshotVariant(document, {
    sha256: b,
    url: "/.local/photo-scene-variants/photo-01/run/raw/attempt.json",
    value: { status: "failed", error: "Model stage unavailable" },
  });
  assert.equal(variant.status, "failed");
  assert.match(
    variant.name,
    /Photo evidence, poses and objects v1 · attempt 2/,
  );
  assert.equal(
    (variant.provenance.archivedSource as any).url,
    "/.local/photo-scene-variants/photo-01/run/source/working.jpg",
  );
  assert.equal((variant.provenance.counts as any).posedPeople, 2);
  assert.equal((variant.provenance.attemptDocument as any).sha256, b);
});
