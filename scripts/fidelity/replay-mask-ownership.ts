/** Replay archived photo 06 without servers, model inference, or cache writes.
 * node --import tsx scripts/fidelity/replay-mask-ownership.ts <manifest.json> <report.json>
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { auditObjectMaskOwnership, observedPersonPhotoMask } from "../../src/scene/mask-ownership";
import { canReconstructMemoryObject } from "../../src/memory-objects";
import { isWorldCompletion } from "../../src/world-completion-validation";
import { analyzeHumanAppearance } from "../../src/scene/human-appearance";
import type { VolumePixels } from "../../src/scene/volume";

const [manifestArg, reportArg] = process.argv.slice(2);
if (!manifestArg || !reportArg) throw new Error("Pass archived photo06 manifest.json and a separate output report path.");
const manifestPath = path.resolve(manifestArg), reportPath = path.resolve(reportArg);
const root = path.dirname(manifestPath);
const relativeReport = path.relative(root, reportPath);
if (!relativeReport || (!path.isAbsolute(relativeReport) && relativeReport !== ".." &&
    !relativeReport.startsWith(".." + path.sep))) throw new Error("Report must be outside the immutable archive.");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const implementationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const git = async (args: string[]) => (await execFileAsync("git", args, {
  cwd: implementationRoot, encoding: "utf8", windowsHide: true, shell: false,
  // Read-only provenance must not refresh/write the checkout's index.
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 4 * 1024 * 1024,
})).stdout.trimEnd();
const implementationFiles = [
  { path: "scripts/fidelity/replay-mask-ownership.ts", role: "replay-entrypoint" },
  ...["src/scene/mask-ownership.ts", "src/scene/photo-depth.ts", "src/scene/human-appearance.ts",
    "src/memory-objects.ts", "src/memory-object-taxonomy.ts", "src/world-completion-validation.ts",
    "src/neural-asset-validation.ts", "src/human-pose-validation.ts", "src/scene-understanding.ts",
    "src/pose-intent.ts", "src/types.ts"].map(file => ({ path: file, role: "replay-dependency" })),
  ...["src/scene/volume-world.ts", "src/scene/texture-projection.ts", "src/scene/neural-photo-fitting.ts",
    "src/scene/posed-human-photographs.ts", "src/scene/human-body.ts"]
    .map(file => ({ path: file, role: "runtime-context-not-executed" })),
  ...["package.json", "package-lock.json"].map(file => ({ path: file, role: "dependency-declaration" })),
].sort((a, b) => a.path.localeCompare(b.path));
const captureImplementation = async () => {
  const [gitHead, workingTreeStatus, sourceFiles] = await Promise.all([
    git(["rev-parse", "--verify", "HEAD"]),
    git(["status", "--porcelain=v1", "--untracked-files=normal"]),
    Promise.all(implementationFiles.map(async file => {
      const bytes = await readFile(path.join(implementationRoot, file.path));
      return { ...file, sha256: hash(bytes), bytes: bytes.length };
    })),
  ]);
  assert.match(gitHead, /^[0-9a-f]{40,64}$/, "Expected a complete implementation commit id.");
  return { gitHead, workingTreeDirty: workingTreeStatus.length > 0, workingTreeStatus,
    sourceFiles, sourceSetSha256: hash(Buffer.from(JSON.stringify(sourceFiles))) };
};
const implementation = await captureImplementation();
const evaluationStartedAt = new Date().toISOString();
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("Network/model services forbidden during saved-mask replay."); };
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString()) as {
  photoIndex: number; variantId: string;
  files: { relativePath: string; archivePath: string; sha256: string }[];
  urlMap: Record<string, string>;
};
assert.equal(manifest.photoIndex, 6, "This fixture's verified person probes belong to photo06.");
const readVerified = async (entry: typeof manifest.files[number]) => {
  const file = path.resolve(root, entry.relativePath);
  if (!file.startsWith(root + path.sep)) throw new Error("Archive entry escaped its directory.");
  const bytes = await readFile(file);
  assert.equal(hash(bytes), entry.sha256, `Archived bytes changed: ${entry.relativePath}`);
  return bytes;
};
const loadUrl = async (url: string) => {
  const entry = manifest.files.find(file => file.archivePath === manifest.urlMap[url]);
  assert.ok(entry, `Missing archived asset ${url}`);
  return readVerified(entry);
};
const worldEntry = manifest.files.find(file => /assets\/.*-world\.json$/.test(file.relativePath));
const sourceEntry = manifest.files.find(file => /assets\/.*-source\.jpg$/.test(file.relativePath));
assert.ok(worldEntry && sourceEntry);
const worldBytes = await readVerified(worldEntry), sourceBytes = await readVerified(sourceEntry);
const world: unknown = JSON.parse(worldBytes.toString());
assert.ok(isWorldCompletion(world));
const decode = async (bytes: Uint8Array): Promise<VolumePixels> => {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
};
const subjects = [];
for (const subject of world.subjects) subjects.push({ ...subject, mask: await decode(await loadUrl(subject.maskUrl)) });
const people = subjects.filter(subject => subject.kind === "person");
const objects = subjects.filter(subject => subject.object && canReconstructMemoryObject(subject.object));
const removalGrid = { width: 384, height: 288 };
const audit = auditObjectMaskOwnership(objects, people, removalGrid);
assert.equal(audit.decisions.find(item => item.id === "subject-5")?.reason, "person-overlap");
assert.equal(audit.decisions.find(item => item.id === "recognized-object-1")?.accepted, true, "The real foreground bag survives.");
const accepted = new Set(audit.decisions.filter(item => item.accepted).map(item => item.id));
const exclusions = objects.filter(item => accepted.has(item.id)).map(item => item.mask);
const sourceMeta = await sharp(sourceBytes).metadata();
assert.ok(sourceMeta.width && sourceMeta.height);
const detail = await sharp(sourceBytes).resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const source: VolumePixels = { width: detail.info.width, height: detail.info.height, data: detail.data };
const originalHash = hash(detail.data);
const left = people.find(item => item.id === "subject-0")!;
const resized = await sharp(await loadUrl(left.maskUrl)).resize(source.width, source.height).ensureAlpha().raw().toBuffer();
const personMask: VolumePixels = { width: source.width, height: source.height, data: resized };
const photoMask = observedPersonPhotoMask(personMask, exclusions,
  { width: sourceMeta.width, height: sourceMeta.height }, left.mask);
const probes = [["hair", .18, .36], ["face", .184, .43], ["jacket-left", .115, .47],
  ["jacket-right", .25, .49], ["cuff", .21, .59]] as const;
const preserved = probes.map(([name, u, v]) => {
  const i = (Math.floor(v * source.height) * source.width + Math.floor(u * source.width)) * 4;
  assert.ok(Number(photoMask.data[i]) >= 60, `${name} must remain valid original evidence`);
  return { name, u, v, originalRgb: Array.from(detail.data.subarray(i, i + 3)), validity: Number(photoMask.data[i]) };
});
const photoExclusion = { width: source.width, height: source.height,
  data: Uint8ClampedArray.from(photoMask.data, (value, i) => i % 4 === 3 ? 255 : value >= 100 ? 0 : 255) };
const appearance = analyzeHumanAppearance({ source, mask: personMask, box: left.box, label: left.label,
  pose: left.humanPose, excludedMasks: [photoExclusion] });
assert.equal(hash(detail.data), originalHash, "Original RGB must not be inpainted or mutated.");
const sorted = (value: typeof audit) => [...value.decisions].sort((a, b) => a.id.localeCompare(b.id));
assert.deepEqual(sorted(auditObjectMaskOwnership([...objects].reverse(), [...people].reverse(), removalGrid)), sorted(audit));
assert.deepEqual(auditObjectMaskOwnership(objects, people, removalGrid), audit, "Repeating the pure saved-mask policy is deterministic.");
assert.equal(hash(await readVerified(sourceEntry)), hash(sourceBytes));
assert.equal(hash(await readVerified(worldEntry)), hash(worldBytes));
assert.equal(hash(await readFile(manifestPath)), hash(manifestBytes));
assert.equal(networkCalls, 0);
const implementationAtEnd = await captureImplementation();
assert.equal(implementationAtEnd.gitHead, implementation.gitHead, "Implementation HEAD changed during replay; rerun it.");
assert.deepEqual(implementationAtEnd.sourceFiles, implementation.sourceFiles, "Implementation source bytes changed during replay; rerun it.");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify({ schemaVersion: 2, variantId: manifest.variantId,
  evaluation: { kind: "saved-asset-pure-function-replay", startedAt: evaluationStartedAt, completedAt: new Date().toISOString(),
    browserRenderingExercised: false, apiIntegrationExercised: false,
    repeatabilityCheck: "Same decoded saved inputs evaluated twice in one Node process; not a browser/API cold reopen or cache reload." },
  implementation: { ...implementation,
    workingTreeDirtyAtEnd: implementationAtEnd.workingTreeDirty, workingTreeStatusAtEnd: implementationAtEnd.workingTreeStatus,
    sourceBytesStableDuringReplay: true,
    identityPolicy: "Source SHA-256 fingerprints identify the evaluated working files. Git HEAD identifies the checkout base; dirty files are not claimed to be contained in that commit. Runtime-context files are fingerprinted but not executed by this replay." },
  runtime: { node: process.versions.node, platform: process.platform, architecture: process.arch, sharpVersions: sharp.versions },
  manifestSha256: hash(manifestBytes), sourceSha256: hash(sourceBytes), worldSha256: hash(worldBytes),
  inference: "none; saved-output policy replay", networkCalls, audit,
  maskSampling: "Native full-image mask pixel centers on the bounded diagnostic grid; expanded removal replay uses nearest native-mask alignment at 384x288. Live rendering supplies its actual resized depth-grid masks.",
  preservedPersonProbes: preserved, originalRgbUnchanged: true,
  appearance: { shirtColor: appearance.shirtColor, garmentSampling: appearance.garmentSampling,
    appearanceSampling: appearance.appearanceSampling },
  limitations: ["Removal budget is a conservative ownership check, not semantic segmentation ground truth.",
    "This saved-asset replay exercises ownership and appearance functions, not a rendered depth/photo plane, UV baking, full-body geometry, or side-view fidelity.",
    "The 384x288 removal grid uses nearest native-mask alignment; it is not a capture of the live renderer's resized depth masks or plane.",
    "Sharp decodes and resizes the source to at most 1200 pixels per edge and resizes the person mask. Live canvas interpolation may differ at source and mask boundaries.",
    "In-process repeatability is not evidence of a browser/API cold reopen, storage reload, or service integration."] }, null, 2) + "\n");
console.log(JSON.stringify({ reportPath, rejected: audit.decisions.filter(item => !item.accepted).map(item => item.id),
  retainedObjects: [...accepted], preservedProbes: preserved.length, networkCalls,
  implementationGitHead: implementation.gitHead, implementationWorkingTreeDirty: implementation.workingTreeDirty,
  implementationSourceSetSha256: implementation.sourceSetSha256 }));
