import React, { useEffect, useId, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadEvidence } from "./adapters";
import {
  canBlend,
  candidateReportKey,
  parseReviewState,
  pinReadyDefaults,
  selectVariant,
  serializeReviewState,
  type Asset,
  type Capture,
  type Evidence,
  type Metrics,
  type Mode,
  type ReviewState,
  type Variant,
  type View,
} from "./model";
import "./style.css";

type Box = [number, number, number, number];
const FULL: Box = [0, 0, 1, 1];
const short = (value: unknown) =>
  typeof value === "string" && value
    ? `${value.slice(0, 12)}…`
    : "Not recorded";
const human = (value: string) => value.replaceAll("-", " ");
const kindNames = {
  "depth-ablation": "Depth-only ablation",
  control: "Flat-plane control",
  combined: "Combined implementation",
  historical: "Historical screenshot",
  qualitative: "Archived candidate · qualitative screenshot",
};
const viewNames = {
  source: "Source camera",
  left: "Left 8 cm",
  right: "Right 8 cm",
};

async function maskBounds(url: string): Promise<Box> {
  const img = new Image();
  img.src = url;
  await img.decode();
  if (img.width > 4096 || img.height > 4096)
    throw new Error("Region mask exceeds its display bound.");
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Region preview is unavailable.");
  context.drawImage(img, 0, 0);
  const pixels = context.getImageData(0, 0, img.width, img.height).data;
  let l = img.width,
    t = img.height,
    r = 0,
    b = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const offset = (y * img.width + x) * 4;
      if (pixels[offset] >= 128 && pixels[offset + 3] >= 128) {
        l = Math.min(l, x);
        t = Math.min(t, y);
        r = Math.max(r, x + 1);
        b = Math.max(b, y + 1);
      }
    }
  if (r <= l || b <= t) throw new Error("The selected region mask is empty.");
  return [l / img.width, t / img.height, r / img.width, b / img.height];
}

function Picture({
  image,
  reference,
  mode = "side",
  mix = 50,
  box = FULL,
  title,
  onReady,
  onUnavailable,
}: {
  image?: Asset;
  reference?: Asset;
  mode?: Mode;
  mix?: number;
  box?: Box;
  title: string;
  onReady?: () => void;
  onUnavailable?: () => void;
}) {
  const clipId = useId().replaceAll(":", "");
  const [error, setError] = useState(false);
  const fail = () => {
    setError(true);
    onUnavailable?.();
  };
  useEffect(() => setError(false), [image?.url, reference?.url]);
  if (!image || error)
    return (
      <div className="empty-media">
        <span>{error ? "Image could not be loaded" : "Image unavailable"}</span>
        <p>
          {error
            ? "The manifest remains visible below. The capture is not treated as a successful comparison."
            : "No image is substituted for a missing result."}
        </p>
      </div>
    );
  if (!image.width || !image.height)
    return (
      <div className="photo-frame">
        <img src={image.url} alt={title} onError={fail} onLoad={onReady} />
      </div>
    );
  const width = image.width,
    height = image.height;
  const [x, y, right, bottom] = [
    box[0] * width,
    box[1] * height,
    box[2] * width,
    box[3] * height,
  ];
  const cropWidth = right - x,
    cropHeight = bottom - y;
  const split = x + (cropWidth * mix) / 100;
  return (
    <div className="photo-frame">
      <svg
        role="img"
        aria-label={title}
        viewBox={`${x} ${y} ${cropWidth} ${cropHeight}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title>{title}</title>
        {mode !== "side" && reference && (
          <image
            href={reference.url}
            width={width}
            height={height}
            onError={fail}
          />
        )}
        <defs>
          <clipPath id={clipId}>
            <rect
              x={x}
              y={y}
              width={(cropWidth * mix) / 100}
              height={cropHeight}
            />
          </clipPath>
        </defs>
        <image
          href={image.url}
          width={width}
          height={height}
          opacity={mode === "overlay" ? mix / 100 : 1}
          clipPath={mode === "swipe" ? `url(#${clipId})` : undefined}
          onError={fail}
          onLoad={onReady}
        />
        {mode === "swipe" && (
          <line
            x1={split}
            x2={split}
            y1={y}
            y2={bottom}
            stroke="#b8ffdc"
            strokeWidth={Math.max(1, cropWidth / 400)}
          />
        )}
      </svg>
    </div>
  );
}

function MetricRow({ value }: { value?: Metrics }) {
  if (!value)
    return (
      <p className="muted metric-note">
        No matched source-view metrics for this capture.
      </p>
    );
  const formatted = (v: unknown, digits: number, suffix = "") =>
    typeof v === "number" && Number.isFinite(v)
      ? `${v.toFixed(digits)}${suffix}`
      : "Not recorded";
  return (
    <dl className="metrics">
      <div>
        <dt>MAE ↓</dt>
        <dd>{formatted(value.mae, 4)}</dd>
      </div>
      <div>
        <dt>PSNR ↑</dt>
        <dd>{formatted(value.psnrDb, 2, " dB")}</dd>
      </div>
      <div>
        <dt>Changed pixels</dt>
        <dd>
          {typeof value.changedPixelFraction === "number"
            ? `${(value.changedPixelFraction * 100).toFixed(1)}%`
            : "Not recorded"}
        </dd>
      </div>
    </dl>
  );
}

function Provenance({
  variant,
  capture,
}: {
  variant?: Variant;
  capture?: Capture;
}) {
  if (!variant) return null;
  const provenance = variant.provenance,
    code = provenance.code as Record<string, unknown> | undefined;
  return (
    <details className="provenance">
      <summary>Provenance & capture details</summary>
      <dl>
        <dt>Variant ID</dt>
        <dd>
          <code>{variant.id}</code>
        </dd>
        <dt>Original source SHA-256</dt>
        <dd>
          <code title={String(provenance.sourceSha256 ?? "")}>
            {short(provenance.sourceSha256)}
          </code>
        </dd>
        <dt>Code commit</dt>
        <dd>
          <code>{String(code?.commit ?? "Not recorded")}</code>
        </dd>
        <dt>Dirty fingerprint</dt>
        <dd>
          <code title={String(code?.dirtyFingerprint ?? "")}>
            {short(code?.dirtyFingerprint)}
          </code>
        </dd>
        <dt>Capture SHA-256</dt>
        <dd>
          <code title={capture?.sha256}>{short(capture?.sha256)}</code>
        </dd>
        <dt>Manifest SHA-256</dt>
        <dd>
          <code title={variant.manifestSha256}>
            {short(variant.manifestSha256)}
          </code>
        </dd>
      </dl>
      {variant.manifestUrl && (
        <a href={variant.manifestUrl} target="_blank" rel="noreferrer">
          Open recorded manifest ↗
        </a>
      )}
      <details>
        <summary>Full recorded metadata</summary>
        <pre>
          {JSON.stringify(
            { ...provenance, selectedCapture: capture ?? null },
            null,
            2,
          )}
        </pre>
      </details>
    </details>
  );
}

function VariantPanel({
  label,
  variant,
  state,
  reference,
  box,
}: {
  label: string;
  variant?: Variant;
  state: ReviewState;
  reference?: Asset;
  box: Box;
}) {
  const qualitative = variant?.qualitativeCapture;
  const capture = qualitative ?? variant?.captures[state.view];
  const [loadedImage, setLoadedImage] = useState<{
    url: string;
    status: "ready" | "unavailable";
  }>();
  const imageState =
    loadedImage?.url === capture?.url
      ? (loadedImage?.status ?? "loading")
      : "loading";
  const displayStatus = capture
    ? imageState
    : variant?.status === "ready"
      ? "unavailable"
      : (variant?.status ?? "unavailable");
  const blend = canBlend(capture, reference, variant?.reference, state.view);
  const metrics =
    state.view === "source" && capture?.aligned && imageState === "ready"
      ? state.roi === "full"
        ? variant?.metrics?.global
        : variant?.metrics?.regions[state.roi]
      : undefined;
  return (
    <article className="panel">
      <header className="panel-title">
        <span className="slot">{label}</span>
        <div>
          <h2>{variant?.name ?? "Selected variant unavailable"}</h2>
          <span className="eyebrow">
            {variant ? kindNames[variant.kind] : "Manifest not listed"}
          </span>
        </div>
        <span className={`status ${displayStatus}`}>
          {displayStatus === "snapshot" ? "Render pending" : displayStatus}
        </span>
      </header>
      {capture ? (
        <Picture
          key={capture.url}
          image={capture}
          reference={reference}
          mode={blend ? state.mode : "side"}
          mix={state.mix}
          box={capture.clean && state.view === "source" ? box : FULL}
          title={
            qualitative
              ? qualitative.label
              : `${variant?.name}, ${viewNames[state.view]}`
          }
          onReady={() => setLoadedImage({ url: capture.url, status: "ready" })}
          onUnavailable={() =>
            setLoadedImage({ url: capture.url, status: "unavailable" })
          }
        />
      ) : (
        <div className="empty-media">
          <span>
            {variant?.status === "failed"
              ? "Attempt failed"
              : variant?.status === "snapshot"
                ? "Clean render pending"
                : "No capture at this view"}
          </span>
          <p>
            {variant?.message ??
              "This selected record is not present in the loaded manifests. Choose an available variant; it has not been silently replaced."}
          </p>
        </div>
      )}
      <div className="panel-body">
        {capture && (
          <p className="caption">
            {qualitative
              ? `Recorded view: ${qualitative.label}. Actual camera extrinsics are unmeasured.`
              : capture.clean
                ? viewNames[state.view]
                : "Uncalibrated front screenshot, with application UI"}
            {!qualitative &&
              state.view !== "source" &&
              " · qualitative view only"}
          </p>
        )}
        {variant?.message && capture && (
          <p className="muted">{variant.message}</p>
        )}
        {state.mode !== "side" && !blend && capture && (
          <p className="notice-inline">
            Overlay is unavailable: this capture has no verified reference
            alignment.
          </p>
        )}
        {qualitative ? (
          <p className="muted metric-note">
            Image metrics, source overlay and source swipe are disabled for this
            screenshot. Encoding: {qualitative.actualMimeType}; original
            filename and bytes preserved.
          </p>
        ) : state.view === "source" ? (
          <MetricRow value={metrics} />
        ) : (
          <p className="muted metric-note">
            No real held-out photo at this camera position. Source-photo error
            metrics are disabled.
          </p>
        )}
        <Provenance variant={variant} capture={capture} />
      </div>
    </article>
  );
}

function Review() {
  const [state, setState] = useState(() => parseReviewState(location.search));
  const [evidence, setEvidence] = useState<Evidence>();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [box, setBox] = useState<Box>(FULL);
  const [roiError, setRoiError] = useState("");
  const [copied, setCopied] = useState(false);
  const change = (next: Partial<ReviewState>, replace = false) => {
    const merged = parseReviewState(
      serializeReviewState({ ...state, ...next }),
    );
    history[replace ? "replaceState" : "pushState"](
      null,
      "",
      `?${serializeReviewState(merged)}`,
    );
    setState(merged);
  };
  useEffect(() => {
    const listener = () => setState(parseReviewState(location.search));
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  useEffect(() => {
    let stopped = false,
      inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      if (!stopped) setRefreshing(true);
      try {
        const result = await loadEvidence();
        if (!stopped) {
          setEvidence(result);
          setError("");
        }
      } catch (failure) {
        if (!stopped) setError(String(failure));
      } finally {
        inFlight = false;
        if (!stopped) setRefreshing(false);
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 30000);
    window.addEventListener("photo-review-refresh", refresh);
    return () => {
      stopped = true;
      clearInterval(interval);
      window.removeEventListener("photo-review-refresh", refresh);
    };
  }, []);
  const photo = evidence?.photos.find((value) => value.index === state.photo);
  const available =
    evidence?.variants.filter((value) => value.photo === state.photo) ?? [];
  const a = selectVariant(available, state.a, state.photo),
    b = selectVariant(available, state.b, state.photo);
  useEffect(() => {
    // Replace default aliases once with immutable record identities; later refreshes never swap the chosen attempt.
    const next = pinReadyDefaults(state, a, b);
    if (next.a !== state.a || next.b !== state.b) {
      history.replaceState(null, "", `?${serializeReviewState(next)}`);
      setState(next);
    }
  }, [a?.id, b?.id, state.a, state.b]);
  const region = photo?.regions.find((value) => value.id === state.roi);
  useEffect(() => {
    let active = true;
    setBox(FULL);
    setRoiError("");
    if (state.roi !== "full" && !region) {
      setRoiError(
        "This region is not available for the selected source. Showing the full image.",
      );
      return;
    }
    if (region && state.view === "source")
      maskBounds(region.maskUrl)
        .then((result) => {
          if (active) setBox(result);
        })
        .catch((failure) => {
          if (active) setRoiError(String(failure));
        });
    return () => {
      active = false;
    };
  }, [region?.maskUrl, state.roi, state.view]);
  const selectPhoto = (index: number) =>
    change({ photo: index, a: "depth-256", b: "depth-384", roi: "full" });
  const source = photo?.reference ?? photo?.source;
  const live = (port: number, candidate = false) =>
    `http://127.0.0.1:${port}/.local/photo-scene-review.html?index=${state.photo}${candidate ? `&report=${candidateReportKey(evidence?.activeReportUrl)}` : ""}`;
  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow accent">AGAIN / PHOTO COMPARISON</p>
          <h1>Compare photo reconstructions</h1>
          <p className="intro">
            The original photograph beside two saved implementations. Explore
            the evidence, one photo at a time.
          </p>
        </div>
        <div className="header-actions">
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(location.href)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                })
                .catch(() =>
                  setError(
                    "Copy the address from your browser to share this comparison.",
                  ),
                );
            }}
          >
            {copied ? "Link copied" : "Copy comparison link"}
          </button>
          <button
            className="quiet"
            disabled={refreshing}
            onClick={() =>
              window.dispatchEvent(new Event("photo-review-refresh"))
            }
          >
            {refreshing ? "Reading manifests…" : "Refresh evidence"}
          </button>
        </div>
      </header>
      <section className="controls" aria-label="Comparison controls">
        <div className="photo-control">
          <label htmlFor="photo">Photo · all 33 sources</label>
          <div className="input-row">
            <button
              aria-label="Previous photo"
              disabled={state.photo <= 1}
              onClick={() => selectPhoto(state.photo - 1)}
            >
              ←
            </button>
            <select
              id="photo"
              value={state.photo}
              onChange={(event) => selectPhoto(Number(event.target.value))}
            >
              {(
                evidence?.photos ??
                Array.from({ length: 33 }, (_, i) => ({
                  index: i + 1,
                  title: `Photo ${i + 1}`,
                }))
              ).map((item) => (
                <option key={item.index} value={item.index}>
                  {String(item.index).padStart(2, "0")} ·{" "}
                  {item.title.replace(/^\d+\s*·\s*/, "")}
                </option>
              ))}
            </select>
            <button
              aria-label="Next photo"
              disabled={state.photo >= 33}
              onClick={() => selectPhoto(state.photo + 1)}
            >
              →
            </button>
          </div>
        </div>
        {(["a", "b"] as const).map((key, index) => (
          <div key={key}>
            <label htmlFor={`variant-${key}`}>
              Variant {index === 0 ? "A" : "B"}
            </label>
            <select
              id={`variant-${key}`}
              value={key === "a" ? (a?.id ?? state.a) : (b?.id ?? state.b)}
              onChange={(event) => change({ [key]: event.target.value })}
            >
              {!selectVariant(available, state[key], state.photo) && (
                <option value={state[key]}>Selected record unavailable</option>
              )}
              {available.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name} ·{" "}
                  {value.status === "snapshot"
                    ? "render pending"
                    : value.status === "ready"
                      ? "capture recorded"
                      : value.status}
                </option>
              ))}
            </select>
          </div>
        ))}
      </section>
      <section
        className="view-controls"
        aria-label="Shared view and source comparison"
      >
        <div className="segmented" aria-label="Shared camera preset">
          {(["source", "left", "right"] as View[]).map((view) => (
            <button
              aria-pressed={state.view === view}
              key={view}
              onClick={() =>
                change({
                  view,
                  ...(view !== "source" ? { mode: "side", roi: "full" } : {}),
                })
              }
            >
              {viewNames[view]}
            </button>
          ))}
          <button
            className="reset"
            onClick={() =>
              change({ view: "source", mode: "side", roi: "full", mix: 50 })
            }
          >
            Reset
          </button>
        </div>
        <div className="compact">
          <label htmlFor="mode">Compare</label>
          <select
            id="mode"
            value={state.mode}
            disabled={state.view !== "source"}
            onChange={(event) => change({ mode: event.target.value as Mode })}
          >
            <option value="side">Side by side</option>
            <option value="overlay">Source overlay</option>
            <option value="swipe">Source swipe</option>
          </select>
        </div>
        <div className="compact region">
          <label htmlFor="roi">Source region</label>
          <select
            id="roi"
            value={region?.id ?? "full"}
            disabled={state.view !== "source" || !photo?.regions.length}
            onChange={(event) => change({ roi: event.target.value })}
          >
            <option value="full">Full image</option>
            {photo?.regions.map((value) => (
              <option key={value.id} value={value.id}>
                {human(value.id)}
              </option>
            ))}
          </select>
        </div>
      </section>
      <p className="muted">
        Offsets use estimated scene scale; physical camera distances are
        uncalibrated.
      </p>
      {(a?.qualitativeCapture || b?.qualitativeCapture) && (
        <p className="notice-inline">
          Shared camera presets affect the calibrated depth captures. Candidate
          screenshots retain the recorded view named in their variant selector.
        </p>
      )}
      {state.mode !== "side" && (
        <div className="blend-control">
          <label htmlFor="mix">
            {state.mode === "swipe"
              ? "Variant visible to divider"
              : "Variant opacity"}{" "}
            · {state.mix.toFixed(0)}%
          </label>
          <input
            id="mix"
            type="range"
            min="0"
            max="100"
            value={state.mix}
            onChange={(event) =>
              change({ mix: Number(event.target.value) }, true)
            }
          />
          <span>
            {canBlend(
              a?.captures[state.view],
              photo?.reference,
              a?.reference,
              state.view,
            ) ||
            canBlend(
              b?.captures[state.view],
              photo?.reference,
              b?.reference,
              state.view,
            )
              ? "Aligned captures are compared with the same source reference."
              : "Overlay requires a capture with verified source alignment."}
          </span>
        </div>
      )}
      <div className="context-line">
        <strong>{photo?.filename ?? "Loading source inventory…"}</strong>
        <span>
          Baseline: {photo?.baselineStatus ?? "unknown"} · Combined run:{" "}
          {photo?.candidateStatus ?? "pending"}
        </span>
      </div>
      {(error || roiError) && (
        <p className="error" role="alert">
          {error || roiError}
        </p>
      )}
      <section
        className="comparison-grid"
        aria-label="Original and selected variants"
      >
        <article className="panel original">
          <header className="panel-title">
            <span className="slot">01</span>
            <div>
              <h2>Original photograph</h2>
              <span className="eyebrow">Observed source</span>
            </div>
            <span className="status original-label">Reference</span>
          </header>
          <Picture
            image={source}
            box={photo?.reference && state.view === "source" ? box : FULL}
            title={`Original source photo ${state.photo}`}
          />
          <div className="panel-body">
            <p className="caption">
              {photo?.reference
                ? "Original resized once to the recorded capture framing."
                : "Archived source upload; clean matched reference not available."}
            </p>
            <p className="muted">
              {state.view === "source"
                ? "Compare people, pose, faces, text, thin edges and object placement."
                : "This is the source camera photo. No real photograph exists here for the selected side view."}
            </p>
            <details className="provenance">
              <summary>Source details</summary>
              <dl>
                <dt>Memory ID</dt>
                <dd>
                  <code>{photo?.memoryId ?? "Not recorded"}</code>
                </dd>
                <dt>Original file SHA-256</dt>
                <dd>
                  <code>{photo?.sourceSha256 ?? "Not recorded"}</code>
                </dd>
                <dt>Matched reference SHA-256</dt>
                <dd>
                  <code>{photo?.reference?.sha256 ?? "Not recorded"}</code>
                </dd>
              </dl>
              {source && (
                <a href={source.url} target="_blank" rel="noreferrer">
                  Open source image ↗
                </a>
              )}
            </details>
          </div>
        </article>
        <VariantPanel
          label="A"
          variant={a}
          state={state}
          reference={photo?.reference}
          box={box}
        />
        <VariantPanel
          label="B"
          variant={b}
          state={state}
          reference={photo?.reference}
          box={box}
        />
      </section>
      <section className="notes-grid">
        <div>
          <h2>What this comparison can tell us</h2>
          <p>
            Depth-only captures isolate depth retention on the same frozen
            renderer. They exclude the new bodies, props and scenery. A
            completed job or a high source-view score does not establish
            recovered 3D geometry.
          </p>
          <p>
            Source metrics use matched clean captures. The changed-pixel
            diagnostic uses the recorded 10/255 threshold. Side views have no
            held-out photographic ground truth; inspect them for holes, broken
            edges and detached textures.
          </p>
        </div>
        <div>
          <h2>Open an interactive viewer</h2>
          <p>
            These links open independent viewers. Camera controls are not
            synchronized with this page, and neither link starts a model job.
          </p>
          <div className="live-links">
            <a href={live(5175)} target="_blank" rel="noreferrer">
              Frozen baseline viewer ↗
            </a>
            <a href={live(5176, true)} target="_blank" rel="noreferrer">
              Current renderer · {candidateReportKey(evidence?.activeReportUrl)}{" "}
              viewer ↗
            </a>
            <a href="http://127.0.0.1:5181" target="_blank" rel="noreferrer">
              Depth-only research viewer ↗
            </a>
          </div>
          <p className="muted">
            Saved capture presets above change only the displayed images. The
            page reads manifests every 30 seconds.
          </p>
        </div>
      </section>
      {evidence?.notices.length ? (
        <details className="load-notices">
          <summary>
            {evidence.notices.length} unavailable evidence sources
          </summary>
          <ul>
            {evidence.notices.map((notice, index) => (
              <li key={index}>{notice}</li>
            ))}
          </ul>
          <p>No unavailable result is counted as a successful capture.</p>
        </details>
      ) : null}
      <footer>
        <span>
          33-photo inventory ·{" "}
          {available.filter((value) => value.status === "ready").length}{" "}
          variants with recorded captures for this photo
        </span>
        <span>
          {evidence
            ? `Evidence read ${new Date(evidence.loadedAt).toLocaleTimeString()}`
            : "Reading evidence…"}
        </span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Review />);
