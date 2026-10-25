import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  evaluateObjectCoverage,
  type ExpectedPhotoObjects,
} from "../../src/memory-object-coverage.js";
import {
  MEMORY_OBJECT_CATEGORIES,
  isObjectRecognitionCoverage,
} from "../../src/memory-objects.js";

const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const resultsFile = argument("--results");
if (!resultsFile)
  throw new Error(
    "Usage: npx tsx scripts/object-detection/report-album-coverage.ts --results <photo-scene-test-results.json> [--output <coverage.json>] [--data-root <repository>] [--data-directory <isolated data directory>]",
  );
const resultsPath = path.resolve(resultsFile);
const root = path.resolve(
  argument("--data-root") ?? path.dirname(path.dirname(resultsPath)),
);
const fixturePath = fileURLToPath(
  new URL("./fixtures/album-expected-objects.json", import.meta.url),
);
const dataDirectory = path.resolve(argument("--data-directory") ?? path.join(root, "data"));
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  scope: string;
  items: ExpectedPhotoObjects[];
};
const results = JSON.parse(await readFile(resultsPath, "utf8"));
const items = [];
for (const expected of fixture.items) {
  const item = results.items?.find(
    (value: { filename?: string }) => value.filename === expected.filename,
  );
  const completionUrl = item?.reconstruction?.completionUrl;
  if (!item || !completionUrl) {
    items.push({
      ...expected,
      status: "pending",
      reason: item?.error ?? "No completed reconstruction descriptor",
    });
    continue;
  }
  if (
    !/^\/uploads\/reconstructions\/[A-Za-z0-9_-]+-world\.json$/.test(
      completionUrl,
    )
  ) {
    items.push({
      ...expected,
      status: "unavailable",
      reason: "Invalid local completion path",
    });
    continue;
  }
  try {
    const completionPath = path.join(dataDirectory, completionUrl.slice(1));
    const bytes = await readFile(completionPath);
    const recorded = item.artifacts?.find((artifact: { url?: string }) => artifact.url === completionUrl)?.sha256;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (recorded && recorded !== sha256) throw new Error("Completion changed since this attempt; use its immutable archived evidence instead of scoring the current world as this version.");
    const world = JSON.parse(bytes.toString("utf8"));
    const coverage = isObjectRecognitionCoverage(
      world.objectRecognition?.coverage,
    )
      ? world.objectRecognition.coverage
      : undefined;
    items.push({
      status: "audited",
      memoryId: item.memoryId,
      visualReviewStatus: item.visualReviewStatus ?? "pending",
      evidence: { completionPath, sha256, matchesRecordedAttempt: recorded ? true : null },
      ...evaluateObjectCoverage(
        expected,
        world.subjects ?? [],
        world.sceneUnderstanding?.objects ?? [],
        coverage,
      ),
    });
  } catch (error) {
    items.push({
      ...expected,
      status: "unavailable",
      reason: (error as Error).message,
    });
  }
}
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  scope: fixture.scope,
  warning:
    "Category presence and geometry eligibility are not mask accuracy, complete instance recall or visual acceptance. Pending items are not scored as failures.",
  supportedCategories: [...MEMORY_OBJECT_CATEGORIES],
  summary: {
    total: items.length,
    audited: items.filter((item) => item.status === "audited").length,
    pending: items.filter((item) => item.status === "pending").length,
    unavailable: items.filter((item) => item.status === "unavailable").length,
  },
  items,
};
const output = argument("--output");
if (output) {
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output: destination, ...report.summary }));
} else console.log(JSON.stringify(report, null, 2));
