# Carriage archive object review

The locally imported `carriage.senior.society` archive contains **seven photos and one video**, not a full copy of the Instagram profile. This review uses those actual files without importing additional posts or creating synthetic positives. Photo resolutions range from 1080 to 2048 pixels wide. The video is 960 × 720 and 21.866667 seconds long.

## Reproduce the evidence

```sh
npx tsx scripts/object-detection/review-carriage.ts
```

The read-only script creates `.local/carriage-object-audit/manifest.json`, photo and video contact sheets, and eight native-resolution video frames at the same timestamps as the reconstruction sampler. It makes no network or model calls and does not change the memory library. `ffmpeg` and `ffprobe` must be available, or supplied through `FFMPEG_PATH` and `FFPROBE_PATH`.

The manifest includes source memory IDs, local paths, dimensions, timestamps, and observational boxes. The script deliberately uses the eight known imported memory IDs rather than treating every future Instagram import as Carriage content. Generated media stay in ignored local storage.

## What is actually visible

Coordinates below are `[left, top, right, bottom]` in the original file, not normalized coordinates.

| Source memory                                             | Observation                                                                                       | Approximate box                        | Use in evaluation                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `instagram-fd427937e17e9f26d0d1` — color group photo      | Short white drink can, silver rim, small dark printing and a straw; hands cover part of the sides | `[1124,1042,1233,1176]` at 2048 × 1536 | Definite positive; compare reconstructed proportions and visible label details to the source |
| `instagram-21c762de5b9534ba7464` — monochrome group photo | Small light rectangle held in the left background, with dark camera-like circles                  | `[205,665,248,746]` at 1102 × 1116     | Probable phone, blurred and partly occluded; not definitive ground truth                     |
| `instagram-fd427937e17e9f26d0d1`                          | Tall blue portable speaker on top of a bookcase                                                   | `[410,175,457,262]`                    | Hard negative for water bottle                                                               |
| `instagram-fd427937e17e9f26d0d1`                          | Angled book or paper display on top of the bookcase; no keyboard or screen visible                | `[227,175,363,264]`                    | Hard negative for laptop                                                                     |
| `instagram-48d65fa54e34dc19b2f4` — video                  | Cemetery monuments and an obelisk, followed by an eye/title graphic and black frames              | Whole sequence                         | Hard negatives for bottles; no requested common-object positive found                        |

All seven photos were inspected. The video was reviewed at approximately one frame per second and at the eight exact reconstruction timestamps: 0, 3.095, 6.190, 9.286, 12.381, 15.476, 18.571, and 21.667 seconds. No definitive computer/laptop, water bottle, chip bag, box, or backpack positive was found in this small archive. The award poster contains shoulder handbags, which should not be relabeled as backpacks.

These observations are a small manual review, **not a comprehensive annotated benchmark**. They do not support an overall accuracy percentage. Object detection on the video is tested by correctly declining to create objects from monuments and graphics. It is not a positive video-object showcase.

## Fidelity criteria

- Preserve the white can's short, broad body, source printing and rim. A tall untextured soda-can primitive fails this example even if its category is correct.
- Exclude visible hands from the object texture where the mask supports it. Do not invent label text hidden by fingers.
- Keep any accepted monochrome phone monochrome; the source does not reveal its original color or a readable brand.
- Hidden surfaces remain inferred. A single visible side cannot verify exact back labels, thickness, or occluded shape.
- Generated shape galleries are separate geometry tests. They are not evidence of detection or fidelity on the archive.

Model inference results should be reported separately from the manual observations, including model/version, score threshold, accepted boxes, rejected hard negatives, and failures. The review script intentionally does not feed its manual boxes to the detector.

## Actual local inference results — 24 October 2026

The final run used `owlv2-dino-slimsam-v4` on **all seven native-resolution photos and all eight native-resolution video samples**. It made no Gemini calls. The model stack was:

- Proposals: `Xenova/owlv2-base-patch16-ensemble`, quantized CPU inference, including overlapping image tiles for small objects.
- Category confirmation: `onnx-community/grounding-dino-tiny-ONNX`, FP32 CPU inference, with separate category prompts and comparison among can/bottle/cup alternatives.
- Visible silhouette: `Xenova/slimsam-77-uniform`, quantized CPU inference, cropped around confirmed objects.

Proposal scores must be at least 0.20; confirmation scores must be at least 0.40 with sufficient box overlap; segmentation candidates must pass their quality and spill checks. These different model scores are **not calibrated probabilities of correctness**. Unsupported competing labels can reject a proposal but never create a prop.

| Actual archived input                                               | Accepted objects                               | Visual review                                                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Every wheel needs its spokes” — monochrome crowd poster (`c3b12…`) | 0                                              | No definitive target object visible; no invented prop                                                                                                         |
| “introducing our class of 2027 board” (`1e2b…`)                     | 0                                              | Poster/city imagery retained                                                                                                                                  |
| Senior Honor Awards poster (`ef90…`)                                | 0                                              | Shoulder handbags were not turned into backpacks                                                                                                              |
| “Every wheel needs its spokes” — red rush poster (`ea4c…`)          | 0                                              | Text/graphic imagery retained                                                                                                                                 |
| “Spokes have been assembled” (`fd427…`)                             | **1 drink can**, confirmation score **0.6221** | Correct can category and location; native-image mask excludes the prominent fingers on both sides, preserving the visible white body, printing and silver rim |
| “keep the family close” (`15e0…`)                                   | 0                                              | No definitive target object visible                                                                                                                           |
| “Time flies #finale” (`21c7…`)                                      | 0                                              | **Missed/abstained on the probable tiny background phone**; insufficient evidence for claiming phone detection success                                        |
| “THIS WILL BE TO DIE FOR” (`48d65…`), all 8 timestamps              | **0 in every frame**                           | Cemetery markers, obelisk, eye graphic and black frames remained negatives, including the previously misclassified 9.286-second marker                        |

The accepted native can bounds are approximately `[1122,1038,1234,1174]` at 2048 × 1536, close to the independent manual body observation. Its straw and finger-covered label portions are not recovered. The source-mask review is `.local/carriage-object-audit/actual-can-native-detection-v4.png`; it is detection evidence, not a rendered 3D comparison. Raw per-file outputs are in `.local/object-detection-results/`, with the checked aggregate in `.local/carriage-object-audit/final-evaluation-v4.json`.

Resolution mattered materially. A diagnostic run on the prepared 1600-pixel image found the correct can category (score 0.6120) but included left-hand pixels in its mask. Earlier versions also confused this can with a bottle. The production photo path therefore uses the original upload for detection and a separate lossless object texture, independently of depth/body processing. The prepared-image result is retained as a known failure, not counted as successful appearance matching. Even native-resolution segmentation remains approximate at boundaries; this one example does not establish reliable hand exclusion across arbitrary photos.

The measured uncached native-photo runs took roughly 48–140 seconds on this workstation; native video samples took roughly 10–12 seconds. Reused cached results returned in milliseconds. These are development observations, not a general performance benchmark.

The actual scene pipeline was also exercised: the can photo upgraded to the original-resolution texture and mask (`owlv2-dino-slimsam-v4-original-v2`) while retaining its people, and all eight 512-pixel video reconstruction samples completed with zero accepted objects. The video scene upgrade took about 214 seconds on CPU; the photo upgrade reused detection results and took about four seconds. These runs constructed no Gemini client.

This run supports one genuine can positive and rejection of the reviewed negatives. It does **not** establish positive detection accuracy for computers, laptops, phones, chip bags, bottles, boxes, backpacks, or objects moving in video. Those categories are supported by the pipeline and geometry builders but need positive examples beyond the currently imported archive.

## v5 supplied-video first-frame check — 24 October 2026

The later `owlv2-dino-slimsam-v5` check used frame 0 of the supplied `PXL_20261024_190713556.TS.mp4` clip. The detector input was the scene sampler's **288 × 512** JPEG, not the original video resolution. This is a separate observational check from the Carriage archive results above. Its uncached run took **112.646 seconds** on this workstation.

The implementation adds OWL thermos/reusable-bottle/insulated-bottle aliases, plus soda-can and snack-bag aliases, without bypassing negative-label competition. DINO retains separate category prompts at its native processor size. Up to four missed proposals scoring at least 0.30 receive a learned-box crop retry with 15% padding; bottles may additionally use a thermos query. A can/bottle class change is permitted only for proposals below 0.45. This prevents the strong thermos proposal from becoming a can solely because a crowded full-image query favors that label.

The SlimSAM prompt correction is significant: the cached export's point encoder recognizes foreground/background labels `1`/`0`, not the `2`/`3` box-corner convention used by a different SAM ONNX wrapper. The v5 implementation places supported foreground points along the object and background points outside its detected box. It evaluates all three channels, retaining quality/spill guards and checking connected mask extent before preferring broader valid coverage. These are automatic prompts, not manual annotations or supplied ground-truth boxes. See [the local detector instructions](../scripts/object-detection/README.md) for current thresholds and memory controls.

| First-frame result | Confirmation score | Visual review of accepted contour |
| --- | --- | --- |
| Foreground drink can | 0.7320 | Broad body and rim align with the visible can; minor boundary approximation remains |
| Backpack | 0.7054 | Mask aligns with the visible bag; nearby objects occlude it, so the full lower boundary cannot be verified |
| Foreground thermos, represented as water bottle | 0.4392 | Mask spans the visible body and cap instead of only the printed sticker; no table-sized spill observed |

Two background laptop confirmations and one small background bottle failed silhouette checks for spill, partial coverage or quality. They were **not** reconstructed as objects in this frame. The check therefore demonstrates recovery of these three foreground objects, not complete detection of everything visible. This first-frame check alone does not establish full-video or 3D reconstruction success. The v4 Carriage results above have not been rerun here under v5, so their negative accuracy must not be attributed to v5 without another real-image run. Unit tests cover alias competition, category gates, crop coordinates and silhouette selection, but do not replace those model evaluations.

Reproducible local evidence is in `.local/google-video-test/review-v5-first-frame.mjs` and its `first-frame-v5-overlay.png` contact sheet, showing the source, OWL proposals, confirmed/rejected boxes and accepted contours. The inference output is `.local/object-detection-results/d2a7758d67a5c1381c637954076c0e2f-source.json`; the detailed cache audit is `data/models/object-detections/afe7b70fba70c3b249d4fa569ef9a408aaace6945b4d15e7c165615ee1950246.json`. These diagnostics are gitignored.

## Completed v5 six-frame API run

The supplied-video API run subsequently returned HTTP 200 with all six sampled frames completed. This was a resumed request with earlier frame results cached: it took **327.784 seconds**, followed by a cached request taking **4.229 seconds**. These are not full cold-start timings. The logged completion-worker peak RSS reached approximately **2.48 GB**, a per-process measurement rather than the whole machine's peak. The worker exits between jobs so its native allocations do not accumulate in the API process.

| Frame / time | Accepted object instances | Categories |
| --- | --- | --- |
| 0 / 0.000 s | 3 | Drink can, backpack, water bottle |
| 1 / 1.665 s | 4 | Laptop, two drink cans, box |
| 2 / 3.330 s | 1 | Laptop |
| 3 / 4.995 s | 4 | Two boxes, chip bag, laptop **false category** |
| 4 / 6.660 s | 5 | Two boxes, computer, chip bag, drink can |
| 5 / 8.326 s | 0 | No supported object props |

These **17 frame-level instances** include repeated objects and a known false category; they are not 17 unique correctly detected objects. The frame-3 “laptop” is black camera/webcam retail packaging with a printed lens graphic, verified in the original-resolution frame. The real foreground laptop in frame 1 recovered some keyboard pixels, but still omitted its lower-left chassis and key columns. Its near-full mask height did not establish complete visible-object coverage.

Frame 4's accepted categories correspond to visible objects, but the large box mask includes some adjacent white VR-controller plastic. The screen-like rectangle is consistent with a monitor/computer category; its rear-facing view does not establish whether it belongs to a laptop. The final close-up has zero object props and zero isolated person subjects despite a prominently visible person. Frames 4 and 5 therefore must not be described as complete isolated-person reconstructions. Small background objects and partly occluded boundaries also remain uncertain. A successful six-frame API response confirms completed artifacts, not exact geometry, complete recognition, or recovered hidden surfaces.

The completed v5 response, cached response, world JSONs and aggregate overlay are preserved under `.local/google-video-test/fixed/v5-passed/`. Its `overlay-review.json` records object counts and actual mask bounds, and `all-frames-object-review.jpg` shows those masks over source frames. The original `fixed/frame1-laptop-actual-review.png` and `fixed/frame3-native-review.png` preserve the two identified failures. All these diagnostics are local and gitignored.

## v6 changes and completed same-video rerun

Two changes are implemented in `owlv2-dino-slimsam-v6`. The full same-video six-frame API rerun completed on 24 October 2026; its results are reported separately from v5 below.

First, the laptop prompt adds four foreground points at normalized detected-box positions `(0.25,0.85)`, `(0.75,0.85)`, `(0.15,0.90)` and `(0.85,0.90)`, retaining the existing center/background points. A SAM-only experiment on frame 1 reused the same cached DINO box and image embeddings for all variants. The selected mask's width extent increased from **72.8% to 94.5%** of that box, and its model quality estimate increased from **0.8674 to 0.9479**. Its spill-guard fraction was zero. Visual review confirmed substantially better left keyboard/chassis coverage without broad table/person spill; small hinge and key gaps remain. Those metrics are internal model/extent checks, not measured segmentation accuracy against ground truth. No missing pixels were manually filled.

Second, a laptop OWL proposal below **0.30** now requires DINO confirmation of at least **0.60**. All other categories and stronger laptop proposals keep the **0.40** threshold. The reviewed camera package had approximately 0.254 OWL and 0.451 DINO scores, so this rule rejects its weak agreement. Unit tests retain both strong-OWL/ordinary-DINO and weak-OWL/strong-DINO cases; broader real-image regression evidence is still required.

An OWL-only probe evaluated eight frame-3 query variants, including packaging/camera negatives, VR-headset/controller negatives, and a retail-product-box alias. **None suppressed the false laptop**, so none of these experimental queries were added to production. The optional genuine-laptop control was stopped before completion and does not validate the query variants. Raw evidence is under `.local/google-video-test/fixed/owl-packaging-probe/`; the SAM comparisons are under `sam-laptop-probe/`.

The v6 API response completed all six frames with recognition status `complete`, using one consistent detector version. The original 21,377,246-byte video, every sampled source frame and every depth image retained their recorded SHA-256 hashes. The cached response matched the complete reconstruction manifest. Existing source/depth artifacts were reused; object recognition and completion were upgraded under v6.

| Measurement | Actual result |
| --- | --- |
| First v6 upgrade request | 591.977 seconds |
| Cached reopen | 5.947 seconds |
| Health probes | 199 samples, 0 failures; median 16.58 ms, p95 20.68 ms, maximum 54.06 ms |
| Video-range probes | 199 samples, 0 failures; median 14.62 ms, p95 18.10 ms, maximum 29.98 ms |
| Reported completion-worker peak RSS | Approximately 2.48 GB; per-process, not machine-wide |

| Frame / time | Accepted instances | Categories and visual review |
| --- | --- | --- |
| 0 / 0.000 s | 4 | Can, backpack, water bottle and newly accepted background laptop; native-resolution inspection confirms the laptop lid, but its mask includes the bottle/cables in front |
| 1 / 1.665 s | 4 | Laptop, two cans and background box; final world mask now covers the visible left chassis and keyboard, with approximate boundaries |
| 2 / 3.330 s | 1 | Laptop |
| 3 / 4.995 s | 3 | Two boxes and chip bag; camera/webcam packaging is no longer a laptop prop, and is not relabeled as a box |
| 4 / 6.660 s | 5 | Two boxes, screen/computer, chip bag and can; some controller plastic remains included in the foreground box mask |
| 5 / 8.326 s | 0 | Close-up with no accepted supported object props |

The total remains **17 frame-level instances** because the new background laptop replaces the removed false laptop in the count. It is not a unique-object count or accuracy score. The foreground keyboard recovery and removal of the packaging false positive are visible in the final overlays. Occlusion boundaries remain approximate: the background laptop mask includes a transparent bottle and cables, while the foreground box includes part of an adjacent controller. Frames 4 and 5 still have no isolated person subjects; the final close-up visibly contains a person. The run demonstrates that the complete six-frame scene artifact can be produced and reopened without blocking health/video requests, not that all people/objects or their unseen geometry were faithfully reconstructed.

Final machine-readable evidence is `.local/google-video-test/fixed/summary.json`, `scene.json`, `cached-scene.json` and `latency.json`. Final masks/counts are recorded in `overlay-review.json`, with `all-frames-object-review.jpg`, per-frame review PNGs and the native-detail `frame0-v6-background-laptop-review.png`.

## v6 prior-case smoke checks

After the supplied-video run, two substantive earlier cases were run sequentially through v6:

| Input | Actual v6 result | Time |
| --- | --- | --- |
| Native 2048 × 1536 held-can photo, `data/uploads/e01b99bd-e04d-4008-addd-52dea3a74e07.jpg` | Exactly one drink can, confidence 0.6221347; pixel bounds approximately `[left=1123, top=1039, right=1234, bottom=1174]` | 185.660 seconds |
| Native 960 × 720 cemetery frame at 9.285714 s, `.local/carriage-object-audit/instagram-48d65fa54e34dc19b2f4-frame-3.jpg` | Zero objects; the previously problematic marker remains rejected | 18.056 seconds |

The native can polygon was overlaid on its original pixels and inspected at enlarged scale. It retains the visible white body, source printing and silver rim; its concavities exclude the prominent fingers on both sides. The straw and finger-covered label portions are not recovered. Boundary pixels remain approximate, and this example does not establish reliable hand exclusion on arbitrary photos. The review is `.local/google-video-test/fixed/regressions/native-can-v6-review.png`, with crop/coordinate metadata beside it. The two raw v6 outputs are `.local/object-detection-results/e01b99bd-e04d-4008-addd-52dea3a74e07.json` and `instagram-48d65fa54e34dc19b2f4-frame-3.json`.

These two positive/negative smoke checks passed. They do not constitute a rerun of all seven Carriage photos and all eight video frames, so the full v4 archive results remain historical evidence rather than a v6 benchmark.
