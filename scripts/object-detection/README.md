# Local object detection

Run from the repository root after `npm install`:

```powershell
npx tsx scripts/object-detection/detect-local.ts data/uploads/example.jpg
```

This uses the existing `@huggingface/transformers` package and CPU ONNX Runtime.
No Python, API key, paid inference service, or remote custom code is required.
The first run downloads public Apache-2.0 model weights into `data/models`:

* [OWLv2 base ensemble](https://huggingface.co/Xenova/owlv2-base-patch16-ensemble), quantized, proposes classes from the shared `src/memory-object-taxonomy.ts` registry while competing with confusing objects. Thermos, reusable-bottle and insulated-bottle aliases map to water bottle; soda-can and snack-bag aliases map to their corresponding supported categories. Aliases still compete with negative labels and undergo independent confirmation.
* [Grounding DINO tiny](https://huggingface.co/onnx-community/grounding-dino-tiny-ONNX), full precision, independently confirms category and box. Single-category queries are deliberate: combined queries misattributed labels during our actual-photo trial. Keep this export's native 800×800 processor size; changing it produced incorrect coordinates.
* [SlimSAM](https://huggingface.co/Xenova/slimsam-77-uniform), quantized, estimates the visible-object silhouette from automatically placed foreground/background points. This export supports point labels `1` and `0`; it does **not** treat labels `2` and `3` as box corners. Foreground points span the detected object's center line. Laptops additionally receive a lower center point and four lower lateral points, relative to their detected box: `(x,y) = (0.25,0.85), (0.75,0.85), (0.15,0.90), (0.85,0.90)`. These help include an angled keyboard rather than just its center. Background points are outside the confirmed box and within the available crop. Fingers and background excluded by the mask are not used as object texture.

Together the downloaded weights are about 900 MB. Models load sequentially and are disposed between stages. ONNX sessions use two intra-operation threads, one inter-operation thread, and disable CPU memory arenas and memory patterns. The production scene API additionally runs depth and frame-completion jobs in serialized child processes, waiting for exit before starting the next job so native allocations are reclaimed. The standalone CLI above runs in its own process. First-time analysis is slower than cached playback. The v7 search prioritizes semantic inventory classes and uses at most two additional crops of small evidenced items; the supplied boxes select search context, never accepted masks. Empty output is valid: ambiguous categories, disagreeing detectors, and unreliable silhouettes are rejected. Model scores are not calibrated probabilities and differ between models.

## Expanded photo inventory and bounded search

The shared registry now covers furniture, screens, electronics, containers, food, vehicles, architectural fixtures and wearables, with explicit dimensions and geometry policies. Solid furniture and vehicles stay fixed; small objects may be movable. Architecture, vegetation and worn items stay on the observed source surface, so classifying glasses or a window does not remove person or scenery pixels. A supported category means the pipeline can represent it; it does not promise that inference will find every instance.

`owlv2-dino-slimsam-v7-taxonomy` searches at most 24 classes per run in batches of 12 positive queries plus competing labels. Up to 12 proposed classes receive independent DINO confirmation; the existing bounded crop retry remains. The result array carries `coverage`, also preserved by the result cache: searched, unsearched and unconfirmed categories plus candidate/object limit flags. The source completion report must retain this metadata before mapping/filtering the array. Cache identity includes image content, algorithm version, and bounded inventory query/crop context. These are runtime budgets; their latency has not yet been measured on the expanded 33-photo album.

The expected-category fixture at `scripts/object-detection/fixtures/album-expected-objects.json` accounts for all 33 source photos, including ambiguous or unreadable items. It evaluates category presence, not exhaustive instance counts or visual quality. Generate a comparison without running models or mutating the album:

```powershell
npx tsx scripts/object-detection/report-album-coverage.ts --results .local/photo-scene-test-results.json --output .local/album-category-coverage.json
```

For a report in another checkout, pass its absolute path and optionally `--data-root` for the repository holding its media. The output distinguishes semantic labels from validated object descriptors, reports missing categories and missing solid descriptors, and leaves unfinished scenes pending. Model-ready descriptors are not proof of successful visual reconstruction. An empty detection array or a completed worker never implies perfect coverage.

In `owlv2-dino-slimsam-v6`, proposal scores must reach 0.20 and confirmation scores ordinarily 0.40, with box overlap of at least 0.35. A laptop proposal below 0.30 instead requires a DINO score of at least 0.60: two weakly agreeing detectors must not turn printed electronics packaging into a laptop. Other categories and stronger laptop proposals retain the 0.40 confirmation threshold. Only can/bottle proposals below 0.45 may change between those two categories during confirmation. At most four missed proposals scoring at least 0.30 receive a confirmation retry in a crop padded by 15% of object width/height and clamped to the image. Bottle crops may also use a thermos query. Cropped detections are translated back to image coordinates and must still pass confirmation and overlap checks.

Every SAM mask channel is assessed. The defaults require quality at least 0.70, at most 12% foreground outside the confirmed box plus a 10% margin, and sufficient connected foreground area and width/height coverage. Laptops require at least 70% height coverage to reject screen-only masks; other categories require 50%. Among valid channels, broader extent is preferred before model IoU. Only existing mask pixels inside the confirmed box and its largest connected component are retained; no hidden or missing pixels are synthesized. A partly occluded object can remain usable, but severe occlusion or uncertain boundaries can still cause abstention.

Detection results, including proposals, full-image/cropped confirmations and per-channel silhouette rejection reasons, are cached by image content and algorithm version under `data/models/object-detections`. Only completed inference is cached; a runtime failure is retriable. These local data and media files are gitignored. The CLI writes human-readable output into `.local/object-detection-results`.

The v6 changes follow a completed v5 six-frame run and separate prompt experiments. Packaging/camera/VR competing-query and retail-product-box-alias experiments did not suppress the reviewed false laptop and were not added to production. The same-video v6 rerun completed all six frames, improved the visible laptop keyboard and removed the reviewed packaging false positive. It took 591.977 seconds for the object upgrade, with existing depth/source frames retained, and 5.947 seconds to reopen from cache. All 199 health and 199 video-range probes succeeded during that run. Two additional v6 smoke checks preserved the native held-can detection with prominent fingers excluded and rejected the previously problematic cemetery marker. See [the evaluation record](../../docs/object-detection-evaluation.md) for measurements and remaining occlusion/person limitations; completed inference does not imply exact geometry or complete recognition.

For the existing Carriage archive, `npx tsx scripts/object-detection/review-carriage.ts` creates an observational review set and native-resolution video samples without downloading additional social media or changing the library. This is not a comprehensive benchmark. Hidden surfaces and metric dimensions cannot be recovered exactly from one image; the renderer uses observed pixels and silhouette, with inferred unseen geometry.

Reference: [Grounding DINO documentation](https://huggingface.co/docs/transformers/en/model_doc/grounding-dino), [SlimSAM usage](https://huggingface.co/Xenova/slimsam-77-uniform).
