import inventory from "../../scripts/object-detection/fixtures/album-expected-objects.json";
import {
  object,
  list,
  hash,
  evidenceUrl,
  viewName,
  freezeRecord,
  candidateReportUrl,
  DEFAULT_CANDIDATE_REPORT,
  type Asset,
  type Capture,
  type Evidence,
  type Photo,
  type Variant,
  type Status,
} from "./model";

type Document = { value: any; sha256: string; url: string };
const QUALITATIVE_MANIFESTS = [
  {
    url: "/.local/candidate-album-scenes/capture-manifests/v1-photo01.json",
    sha256: "08ac5e7a95456c9695fa051a6b66467d3ca8c855529b012170f7fe1eab47cba0",
  },
];
export const CAPTURE_MANIFEST_LIMIT = 165;
export function reviewRegistryConfig(value: unknown): {
  activeReportUrl: string;
  captureManifests: { url: string; sha256: string }[];
  notices: string[];
} {
  const row = object(value),
    notices: string[] = [];
  const active = candidateReportUrl(row.activeReportUrl);
  if (row.activeReportUrl !== undefined && !active)
    notices.push(
      "Registry activeReportUrl is invalid; using the original candidate report.",
    );
  const entries = list(row.captureManifests);
  if (
    row.captureManifests !== undefined &&
    !Array.isArray(row.captureManifests)
  )
    notices.push("Registry captureManifests is not an array.");
  if (entries.length > CAPTURE_MANIFEST_LIMIT)
    notices.push(
      `Capture manifest input exceeds the ${CAPTURE_MANIFEST_LIMIT}-entry limit; excess entries were skipped.`,
    );
  const manifests = new Map(
    QUALITATIVE_MANIFESTS.map((entry) => [entry.url, { ...entry }]),
  );
  for (const entry of entries.slice(0, CAPTURE_MANIFEST_LIMIT)) {
    const url = evidenceUrl(entry?.url),
      sha256 = hash(entry?.sha256);
    if (!url || !sha256) {
      notices.push("Invalid capture manifest URL or SHA-256 was skipped.");
      continue;
    }
    const previous = manifests.get(url);
    if (previous) {
      if (previous.sha256 !== sha256)
        notices.push(`Conflicting capture manifest hash ignored: ${url}`);
      continue;
    }
    if (manifests.size >= CAPTURE_MANIFEST_LIMIT) {
      notices.push(
        `Capture manifest limit reached (${CAPTURE_MANIFEST_LIMIT}, including pinned entries).`,
      );
      break;
    }
    manifests.set(url, { url, sha256 });
  }
  return {
    activeReportUrl: active ?? DEFAULT_CANDIDATE_REPORT,
    captureManifests: [...manifests.values()],
    notices,
  };
}
export async function readDocument(
  url: string,
  expectedHash?: string,
): Promise<Document> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} (${response.status})`);
  const bytes = await response.arrayBuffer();
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  if (expectedHash && digest !== expectedHash)
    throw new Error(`Manifest hash mismatch: ${url}`);
  return {
    value: JSON.parse(new TextDecoder().decode(bytes)),
    sha256: digest,
    url,
  };
}
function asset(
  value: unknown,
  base: string,
  dimensions?: { width: number; height: number },
): Asset | undefined {
  const row = object(value);
  const url = evidenceUrl(row.path ?? row.archivePath, base);
  return url ? { url, sha256: hash(row.sha256), ...dimensions } : undefined;
}
export function depthVariants(
  caseRow: unknown,
  captureDoc: Document,
  evaluation: unknown,
  modelManifest: unknown,
): Variant[] {
  const item = object(caseRow),
    report = object(captureDoc.value),
    scores = object(evaluation),
    model = object(modelManifest);
  if (
    !Number.isInteger(item.index) ||
    item.index < 1 ||
    item.index > 33 ||
    report.schemaVersion !== 1
  )
    throw new Error("Unsupported depth capture report.");
  const dimensions = {
    width: Number(report.configuration?.width),
    height: Number(report.configuration?.height),
  };
  if (!(
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width <= 8192 &&
    dimensions.height <= 8192
  ))
    throw new Error("Invalid depth capture dimensions.");
  const reference = asset(
    report.artifacts?.reference,
    captureDoc.url,
    dimensions,
  );
  return ["baseline", "candidate", "plane"].map((name) => {
    const captures: Variant["captures"] = {};
    for (const row of list(report.captures).filter(
      (row) => row.variant === name && row.coverage === false,
    )) {
      const view = viewName(row.view),
        image = asset(row, captureDoc.url, dimensions);
      if (!view || !image || !image.sha256) continue;
      const scoreInput = scores.inputs?.[name];
      const aligned =
        scores.alignmentVerified === true &&
        scores.view === "source-camera" &&
        hash(scores.inputs?.reference?.sha256) === reference?.sha256 &&
        hash(scoreInput?.sha256) === image.sha256;
      captures[view] = {
        ...image,
        clean: true,
        aligned,
        camera: {
          position: row.cameraPosition,
          worldMatrix: row.cameraWorldMatrix,
          viewMatrix: row.cameraViewMatrix,
          projectionMatrix: row.cameraProjectionMatrix,
        },
        renderMs: row.renderMs,
      };
    }
    const sourceScore = captures.source?.aligned
      ? {
          global: scores.global?.[name],
          regions: Object.fromEntries(
            list(scores.regions)
              .map((row) => [row.name, row[name]])
              .filter(([, metrics]) => metrics),
          ),
        }
      : undefined;
    return freezeRecord({
      id: `depth-${item.index}-${name}-${captureDoc.sha256.slice(0, 16)}`,
      alias:
        name === "baseline"
          ? "depth-256"
          : name === "candidate"
            ? "depth-384"
            : "plane",
      photo: item.index,
      name:
        name === "baseline"
          ? "Frozen surface · depth 256"
          : name === "candidate"
            ? "Frozen surface · retained depth 384"
            : "Flat photograph · control",
      kind: name === "plane" ? "control" : "depth-ablation",
      status: captures.source ? "ready" : "unavailable",
      captures,
      reference,
      metrics: sourceScore,
      manifestUrl: captureDoc.url,
      manifestSha256: captureDoc.sha256,
      provenance: {
        sourceSha256: hash(item.originalSha256),
        servedSourceSha256: hash(item.servedSourceSha256),
        sourcePreparationMatches: item.originalPreparationMatches,
        code: {
          commit: report.provenance?.commit ?? null,
          dirtyFingerprint: report.provenance?.dirtyFingerprint ?? null,
          frozenFiles: report.frozenImplementation,
          browserBundleSha256: report.browserBundleSha256,
        },
        experiment: report.experiment,
        generatedAt: report.generatedAt,
        model: {
          id: model.modelId,
          sha256: model.modelSha256,
          preprocessing: model.preprocessing,
        },
        settings: report.configuration,
        geometry: report.metadata?.variants?.[name],
        sharedModelPassMs: item.elapsedMs,
        peakRssBytes: item.rssBytes,
        limitations: report.limitations,
        unknowns: [
          "Repository commit and dirty-tree fingerprint are unknown unless explicitly recorded; frozen source-file and browser-bundle hashes are retained.",
        ],
      },
    } as Variant);
  });
}
export function snapshotVariant(
  document: Document,
  attemptDocument?: Document,
): Variant {
  const row = object(document.value),
    identity = object(row.inputIdentity),
    provenance = object(row.provenance),
    attempt = object(attemptDocument?.value ?? row.raw?.attempt);
  const photo = Number(identity.photoIndex);
  if (
    !row.variantId ||
    typeof row.variantId !== "string" ||
    !Number.isInteger(photo) ||
    photo < 1 ||
    photo > 33 ||
    !Array.isArray(row.files)
  )
    throw new Error("Unsupported immutable attempt manifest.");
  const captures: Variant["captures"] = {};
  // A scene/GLB/texture is not a clean camera capture. Only explicitly calibrated capture metadata enables comparison.
  for (const file of list(row.files)) {
    const capture = object(file.capture),
      view = viewName(capture.view),
      image = asset(file, document.url, {
        width: Number(capture.width),
        height: Number(capture.height),
      });
    if (!view || !image || capture.canvasOnly !== true || !hash(file.sha256))
      continue;
    captures[view] = {
      ...image,
      clean: true,
      aligned: capture.alignmentVerified === true,
      camera: capture.camera,
      renderMs: capture.renderMs,
    } as Capture;
  }
  const referenceFile = list(row.files).find(
    (file) =>
      file.role === "source-reference" && file.capture?.canvasOnly === true,
  );
  const reference = referenceFile
    ? asset(referenceFile, document.url, {
        width: Number(referenceFile.capture.width),
        height: Number(referenceFile.capture.height),
      })
    : undefined;
  const failed = /failed|error/i.test(
    String(attempt.status ?? attempt.sceneStatus ?? ""),
  );
  const status: Status = failed
    ? "failed"
    : Object.keys(captures).length
      ? "ready"
      : "snapshot";
  return freezeRecord({
    id: row.variantId,
    photo,
    name: `Combined · ${row.variantName ?? "candidate"} · attempt ${identity.attemptNumber ?? identity.attemptId ?? "?"} · ${String(identity.startedAt ?? "").slice(11, 19) || "time unknown"}`,
    kind: "combined",
    status,
    message: failed
      ? "This archived attempt failed; inspect the recorded error below."
      : status === "snapshot"
        ? "Immutable scene/assets archived. Clean camera renders have not been captured."
        : undefined,
    captures,
    reference,
    manifestUrl: document.url,
    manifestSha256: document.sha256,
    provenance: {
      ...provenance,
      inputIdentity: identity,
      timing: row.timing,
      counts: row.counts,
      attempt,
      attemptDocument: attemptDocument
        ? { url: attemptDocument.url, sha256: attemptDocument.sha256 }
        : null,
      rawReferences: row.raw,
      archivedSource: asset(
        list(row.files).find((file) => file.role === "source"),
        document.url,
      ),
      files: row.files,
      urlMap: row.urlMap,
      archiveStatus: row.archiveStatus ?? null,
    },
  });
}
export async function readSnapshotVariant(
  document: Document,
): Promise<Variant> {
  const row = object(document.value);
  let attempt: Document | undefined;
  if (typeof row.raw?.attempt === "string") {
    const pointer = row.raw.attempt;
    const file = list(row.files).find(
      (file) => file.role === "attempt" && file.archivePath === pointer,
    );
    const url = evidenceUrl(pointer);
    const expected = hash(file?.sha256);
    if (!url || !expected)
      throw new Error("Archived attempt pointer lacks its integrity record.");
    attempt = await readDocument(url, expected);
  }
  return snapshotVariant(document, attempt);
}
export function qualitativeVariants(
  document: Document,
  implementation: Variant,
): Variant[] {
  const row = object(document.value);
  if (
    row.schemaVersion !== 1 ||
    row.kind !== "qualitative-screenshot-captures" ||
    row.uiOverlaysPresent !== true ||
    row.metricsEligible !== false ||
    row.actualExtrinsics !== "unmeasured"
  )
    throw new Error("Unsupported qualitative capture manifest.");
  if (
    row.variantId !== implementation.id ||
    row.photoIndex !== implementation.photo ||
    hash(row.variantManifest?.sha256) !== implementation.manifestSha256 ||
    hash(row.source?.sha256) !== implementation.provenance.sourceSha256
  )
    throw new Error(
      "Qualitative capture provenance does not match the frozen implementation.",
    );
  return list(row.captures)
    .slice(0, 100)
    .map((entry) => {
      const url = evidenceUrl(
        entry.servedRelativeUrl ?? entry.relativePath ?? entry.filePath,
        document.url,
      );
      const width = entry.dimensions?.width,
        height = entry.dimensions?.height;
      if (
        !url ||
        !hash(entry.sha256) ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(entry.id ?? "") ||
        typeof entry.label !== "string" ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 8192 ||
        height > 8192 ||
        entry.uiOverlaysPresent !== true ||
        entry.metricsEligible !== false ||
        entry.camera?.actualExtrinsics !== "unmeasured" ||
        !["image/jpeg", "image/png"].includes(entry.actualMimeType)
      )
        throw new Error("Invalid qualitative screenshot record.");
      const version =
        typeof row.variantName === "string"
          ? (row.variantName.match(/\bv\d+\b/)?.[0] ?? "")
          : "";
      return freezeRecord({
        id: `${implementation.id}:qual:${entry.id}:${document.sha256.slice(0, 12)}`,
        photo: implementation.photo,
        name: `Combined ${version} · ${entry.label}`.replace(
          "Combined  ·",
          "Combined ·",
        ),
        kind: "qualitative",
        status: "ready",
        captures: {},
        qualitativeCapture: {
          url,
          sha256: hash(entry.sha256),
          width,
          height,
          clean: false,
          aligned: false,
          camera: entry.camera,
          label: entry.label,
          actualMimeType: entry.actualMimeType,
          metricsEligible: false,
          uiOverlaysPresent: true,
        },
        message:
          "Recorded screenshot with application overlays and unmeasured camera extrinsics. Shared calibrated presets and source ROI crops do not reposition this screenshot.",
        manifestUrl: document.url,
        manifestSha256: document.sha256,
        provenance: {
          ...implementation.provenance,
          implementationVariantId: implementation.id,
          implementationName: row.variantName,
          implementationManifest: {
            url: implementation.manifestUrl,
            sha256: implementation.manifestSha256,
          },
          qualitativeCapture: entry,
          captureCreatedAt: row.createdAt,
          captureMethod: row.captureMethod,
          encodingNote: row.encodingNote,
          metricsEligible: false,
          uiOverlaysPresent: true,
          actualExtrinsics: "unmeasured",
          notes: row.notes,
        },
      } as Variant);
    });
}
export function registryEntries(
  value: unknown,
): { url: string; sha256?: string }[] {
  const row = object(value);
  const entries = list(row.variants ?? row.entries);
  if (
    !entries.length &&
    !Array.isArray(row.variants) &&
    !Array.isArray(row.entries)
  )
    throw new Error("Attempt registry schema is not available yet.");
  return entries.slice(0, 1000).flatMap((entry) => {
    const url = evidenceUrl(
      entry.manifestPath ?? entry.manifestUrl ?? entry.path,
    );
    return url
      ? [{ url, sha256: hash(entry.manifestSha256 ?? entry.sha256) }]
      : [];
  });
}
const pending = (
  photo: number,
  name: string,
  alias: string,
  status: Status,
  message: string,
  kind: Variant["kind"],
): Variant =>
  freezeRecord({
    id: `${alias}-${photo}`,
    alias,
    photo,
    name,
    kind,
    status,
    message,
    captures: {},
    provenance: { unknowns: ["No immutable capture record is available."] },
  });
export async function loadEvidence(): Promise<Evidence> {
  const notices: string[] = [];
  const optional = async (url: string, label: string) => {
    try {
      return await readDocument(url);
    } catch (error) {
      notices.push(
        `${label}: ${error instanceof Error ? error.message : "unavailable"}`,
      );
      return undefined;
    }
  };
  const [baseline, depth, registry, visual, catalog] = await Promise.all([
    optional(
      "/.local/photo-scene-baseline/results-at-stop.json",
      "Frozen baseline inventory",
    ),
    optional("/.local/depth-fidelity-v1/manifest.json", "Depth ablation"),
    optional(
      "/.local/photo-scene-variants/registry.json",
      "Immutable attempt registry",
    ),
    optional(
      "/.local/photo-scene-baseline/visual-review-at-stop.json",
      "Historical screenshots",
    ),
    optional("/api/memories", "Source catalog"),
  ]);
  const registryConfig = reviewRegistryConfig(registry?.value);
  notices.push(...registryConfig.notices);
  const candidate = await optional(
    registryConfig.activeReportUrl,
    "Active combined candidate results",
  );
  const photos: Photo[] = inventory.items.map((item) => {
    const baselineItem =
      list(baseline?.value?.items).find((row) => row.index === item.index) ??
      {};
    const candidateItem =
      list(candidate?.value?.items).find((row) => row.index === item.index) ??
      {};
    const memory =
      list(catalog?.value?.memories).find(
        (row) => row.id === (baselineItem.memoryId ?? candidateItem.memoryId),
      ) ?? baselineItem.memory;
    const url = /^\/uploads\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(
      memory?.url ?? "",
    )
      ? memory.url
      : undefined;
    return {
      index: item.index,
      filename: item.filename,
      title: baselineItem.title ?? memory?.title ?? item.filename,
      memoryId: baselineItem.memoryId ?? candidateItem.memoryId,
      source: url ? { url } : undefined,
      sourceSha256: hash(baselineItem.originalSha256),
      regions: [],
      baselineStatus: baselineItem.sceneStatus ?? "unknown",
      candidateStatus:
        candidateItem.sceneStatus ?? candidateItem.status ?? "pending",
    };
  });
  const variants: Variant[] = [];
  await Promise.all(
    list(depth?.value?.cases)
      .slice(0, 33)
      .map(async (item) => {
        const directory = evidenceUrl(item.sourcePath)?.replace(
          /\/[^/]+$/,
          "/captures/",
        );
        if (!directory) return;
        const [capture, evaluation] = await Promise.all([
          optional(
            `${directory}capture-report.json`,
            `Photo ${item.index} captures`,
          ),
          optional(
            `${directory}evaluation-regions.json`,
            `Photo ${item.index} source metrics`,
          ),
        ]);
        if (!capture) return;
        try {
          const records = depthVariants(
            item,
            capture,
            evaluation?.value,
            depth?.value,
          );
          variants.push(...records);
          const photo = photos.find((row) => row.index === item.index);
          if (photo) {
            photo.reference = records[0].reference;
            photo.regions = list(evaluation?.value?.inputs?.masks).flatMap(
              (mask) => {
                const url = evidenceUrl(mask.path);
                return url && typeof mask.name === "string"
                  ? [{ id: mask.name, maskUrl: url }]
                  : [];
              },
            );
          }
        } catch (error) {
          notices.push(`Photo ${item.index}: ${String(error)}`);
        }
      }),
  );
  if (registry) {
    try {
      const entries = registryEntries(registry.value);
      // Bound metadata requests; this reads JSON only and never starts a reconstruction.
      for (let offset = 0; offset < entries.length; offset += 6)
        await Promise.all(
          entries.slice(offset, offset + 6).map(async (entry) => {
            try {
              variants.push(
                await readSnapshotVariant(
                  await readDocument(entry.url, entry.sha256),
                ),
              );
            } catch (error) {
              notices.push(`Archived attempt unavailable: ${String(error)}`);
            }
          }),
        );
    } catch (error) {
      notices.push(String(error));
    }
  }
  for (const entry of registryConfig.captureManifests) {
    try {
      const document = await readDocument(entry.url, entry.sha256);
      const row = object(document.value);
      let implementation = variants.find(
        (variant) =>
          variant.id === row.variantId &&
          variant.manifestSha256 === hash(row.variantManifest?.sha256),
      );
      if (!implementation) {
        const url = evidenceUrl(
          row.variantManifest?.servedRelativeUrl ??
            row.variantManifest?.relativePath,
        );
        const expected = hash(row.variantManifest?.sha256);
        if (!url || !expected)
          throw new Error(
            "Qualitative record has no pinned implementation manifest.",
          );
        implementation = await readSnapshotVariant(
          await readDocument(url, expected),
        );
      }
      variants.push(...qualitativeVariants(document, implementation));
    } catch (error) {
      notices.push(`Qualitative capture unavailable: ${String(error)}`);
    }
  }
  for (const photo of photos) {
    const archived = variants.find(
      (value) =>
        value.photo === photo.index &&
        value.kind === "combined" &&
        value.provenance.sourceSha256 === photo.sourceSha256,
    )?.provenance.archivedSource as Asset | undefined;
    if (archived?.url) photo.source = archived;
    for (const [alias, name] of [
      ["depth-256", "Frozen surface · depth 256"],
      ["depth-384", "Frozen surface · retained depth 384"],
    ])
      if (
        !variants.some(
          (value) => value.photo === photo.index && value.alias === alias,
        )
      )
        variants.push(
          pending(
            photo.index,
            name,
            alias,
            "unavailable",
            "No clean depth-only captures for this photo. The experiment currently covers photos 1–3.",
            "depth-ablation",
          ),
        );
    if (
      !variants.some(
        (value) => value.photo === photo.index && value.kind === "combined",
      )
    ) {
      const failed = /failed|error/i.test(photo.candidateStatus);
      variants.push(
        pending(
          photo.index,
          "Combined candidate · awaiting archive",
          "combined",
          failed ? "failed" : "pending",
          failed
            ? "Latest candidate status is failed. An immutable attempt record has not arrived."
            : "No immutable candidate attempt or clean render is available yet.",
          "combined",
        ),
      );
    }
    const historical = list(visual?.value?.items).find(
      (row) => row.index === photo.index,
    );
    const front = list(historical?.screenshots)
      .map((item) => (typeof item === "string" ? item : item.path))
      .find(
        (value) =>
          typeof value === "string" &&
          /completed-front\.(png|jpg)$/.test(value),
      );
    const url = evidenceUrl(front);
    variants.push(
      freezeRecord({
        id: `historical-${photo.index}`,
        alias: "historical",
        photo: photo.index,
        name: "Historical full world · qualitative",
        kind: "historical",
        status: url
          ? "ready"
          : /failed/i.test(photo.baselineStatus)
            ? "failed"
            : "unavailable",
        message: url
          ? "Screenshot includes application UI; framing and camera movement were not calibrated."
          : `No historical front screenshot. Baseline status: ${photo.baselineStatus}.`,
        captures: url ? { source: { url, clean: false, aligned: false } } : {},
        manifestUrl: visual?.url,
        manifestSha256: visual?.sha256,
        provenance: {
          sourceSha256: photo.sourceSha256 ?? null,
          code: { commit: null, dirtyFingerprint: null },
          screenshots: historical?.screenshots ?? [],
          notes: historical?.observedVisualIssues ?? [],
          reportSnapshot: "frozen-at-stop",
          baselineReport: {
            url: baseline?.url ?? null,
            sha256: baseline?.sha256 ?? null,
          },
          imageIntegrity: "Image hash not recorded in historical review.",
          unknowns: [
            "Historical screenshots are qualitative only; exact camera matrices and capture code fingerprint were not recorded.",
          ],
        },
      }),
    );
  }
  return {
    photos,
    variants: variants.sort(
      (a, b) => a.photo - b.photo || a.name.localeCompare(b.name),
    ),
    notices,
    loadedAt: new Date().toISOString(),
    activeReportUrl: registryConfig.activeReportUrl,
  };
}
