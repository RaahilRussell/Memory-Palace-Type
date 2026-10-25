export type View = "source" | "left" | "right";
export type Mode = "side" | "overlay" | "swipe";
export type Status =
  "ready" | "snapshot" | "pending" | "failed" | "unavailable";
export type ReviewState = {
  photo: number;
  a: string;
  b: string;
  view: View;
  mode: Mode;
  roi: string;
  mix: number;
};
export type Asset = {
  url: string;
  sha256?: string;
  width?: number;
  height?: number;
};
export type Capture = Asset & {
  clean: boolean;
  aligned: boolean;
  camera?: unknown;
  renderMs?: number;
};
export type Metrics = {
  mae?: number;
  rmse?: number;
  psnrDb?: number | null;
  changedPixelFraction?: number;
};
export type Region = { id: string; maskUrl: string };
export type Variant = {
  id: string;
  alias?: string;
  photo: number;
  name: string;
  kind:
    "depth-ablation" | "control" | "combined" | "historical" | "qualitative";
  status: Status;
  message?: string;
  captures: Partial<Record<View, Capture>>;
  qualitativeCapture?: Capture & {
    label: string;
    actualMimeType: string;
    metricsEligible: false;
    uiOverlaysPresent: true;
  };
  reference?: Asset;
  metrics?: { global?: Metrics; regions: Record<string, Metrics> };
  manifestUrl?: string;
  manifestSha256?: string;
  provenance: Record<string, unknown>;
};
export type Photo = {
  index: number;
  filename: string;
  title: string;
  memoryId?: string;
  source?: Asset;
  sourceSha256?: string;
  reference?: Asset;
  regions: Region[];
  baselineStatus: string;
  candidateStatus: string;
};
export type Evidence = {
  photos: Photo[];
  variants: Variant[];
  notices: string[];
  loadedAt: string;
  activeReportUrl: string;
};
export const DEFAULT_CANDIDATE_REPORT =
  "/.local/photo-scene-candidate-results.json";
export function candidateReportUrl(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^\/\.local\/photo-scene-candidate(?:-v\d+)?-results\.json$/.test(value)
    ? value
    : undefined;
}
export function candidateReportKey(value: unknown): string {
  return (candidateReportUrl(value) ?? DEFAULT_CANDIDATE_REPORT).match(
    /photo-scene-(candidate(?:-v\d+)?)-results\.json$/,
  )![1];
}
const validId = (value: string | null, fallback: string) =>
  value && /^[A-Za-z0-9._:/-]{1,220}$/.test(value) ? value : fallback;
export function parseReviewState(search: string): ReviewState {
  const params = new URLSearchParams(search);
  const photo = Number(params.get("photo") || 1);
  const [a, b] = (params.get("variants") || "").split(",");
  const view = ["source", "left", "right"].includes(params.get("view") || "")
    ? (params.get("view") as View)
    : "source";
  const mode =
    view === "source" &&
    ["side", "overlay", "swipe"].includes(params.get("mode") || "")
      ? (params.get("mode") as Mode)
      : "side";
  const mix = Number(params.get("mix") ?? 50);
  return {
    photo: Number.isInteger(photo) && photo >= 1 && photo <= 33 ? photo : 1,
    a: validId(a, "depth-256"),
    b: validId(b, "depth-384"),
    view,
    mode,
    roi: view === "source" ? validId(params.get("roi"), "full") : "full",
    mix: Number.isFinite(mix) ? Math.min(100, Math.max(0, mix)) : 50,
  };
}
export function serializeReviewState(value: ReviewState): string {
  return new URLSearchParams({
    photo: String(value.photo),
    variants: `${value.a},${value.b}`,
    view: value.view,
    mode: value.view === "source" ? value.mode : "side",
    roi: value.view === "source" ? value.roi : "full",
    mix: String(value.mix),
  }).toString();
}
export function selectVariant(
  variants: Variant[],
  id: string,
  photo: number,
): Variant | undefined {
  return (
    variants.find((value) => value.photo === photo && value.id === id) ??
    variants.find((value) => value.photo === photo && value.alias === id)
  );
}
export function pinReadyDefaults(
  state: ReviewState,
  a?: Variant,
  b?: Variant,
): ReviewState {
  return {
    ...state,
    a: a?.status === "ready" && a.alias === state.a ? a.id : state.a,
    b: b?.status === "ready" && b.alias === state.b ? b.id : state.b,
  };
}
export function canBlend(
  capture: Capture | undefined,
  reference: Asset | undefined,
  variantReference: Asset | undefined,
  view: View,
): boolean {
  return (
    view === "source" &&
    !!capture?.clean &&
    !!capture.aligned &&
    !!reference?.sha256 &&
    reference.sha256 === variantReference?.sha256 &&
    capture.width === reference.width &&
    capture.height === reference.height
  );
}
export function freezeRecord<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeRecord);
    Object.freeze(value);
  }
  return value;
}
// Only known local evidence roots are addressable. Do not turn arbitrary manifest paths into network requests.
export function evidenceUrl(
  input: unknown,
  relativeTo = "/.local/photo-scene-variants/",
): string | undefined {
  if (typeof input !== "string" || !input || input.length > 1800) return;
  let value = input.replaceAll("\\", "/");
  try {
    value = decodeURIComponent(value);
  } catch {
    return;
  }
  if (value.split("/").includes("..") || /[\u0000-\u001f?#]/.test(value))
    return;
  const marker = "/.local/";
  if (/^[A-Za-z]:\//.test(value)) {
    const start = value.indexOf(marker);
    if (start < 0) return;
    value = value.slice(start);
  } else if (value.startsWith(".local/")) value = `/${value}`;
  else if (/^photo-\d{2}\//.test(value))
    value = `/.local/photo-scene-variants/${value}`;
  else if (!value.startsWith("/")) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return;
    value = relativeTo.slice(0, relativeTo.lastIndexOf("/") + 1) + value;
  }
  if (
    !/^\/\.local\/(?:depth-fidelity-v1|photo-scene-variants|album-scenes\/screenshots|candidate-album-scenes)\//.test(
      value,
    )
  )
    return;
  return value.split("/").map(encodeURIComponent).join("/");
}
export const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
export const list = (value: unknown): any[] =>
  Array.isArray(value) ? value : [];
export const hash = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
export const viewName = (value: unknown): View | undefined =>
  value === "source-camera" || value === "source"
    ? "source"
    : value === "left-8cm"
      ? "left"
      : value === "right-8cm"
        ? "right"
        : undefined;
