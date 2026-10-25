import * as THREE from "three";
import { buildHumanBody } from "./human-body";
import { analyzeHumanAppearance } from "./human-appearance";
import {
  layoutHumanBodies,
  humanPoseScales,
  estimateCaptureHeight,
} from "./human-layout";
import { fitHumanPose } from "./human-pose";
import {
  poseAppearance,
  fitPosedHumanPhotographs,
  capturePosePhotographs,
} from "./posed-human-photographs";
import type { HumanPose } from "../types";
import { memoryObjectPolicy, canReconstructMemoryObject, type MemoryObjectSpec } from "../memory-objects";
import { assessPoseSupport, type PoseIntent } from "../pose-intent";
import {
  buildMemoryProp,
  placeMemoryProp,
  type MemoryPropAnchor,
} from "./memory-props";
import { buildPhotoEnvironment } from "./photo-environment";
import {
  selectNeuralAssetShape,
  type NeuralAssetDescriptor,
} from "../neural-asset-validation";
import {
  createBodyShapeController,
  type BodyShapeChoice,
} from "./body-shape-controller";
import type { WorldObstacle } from "./world-collisions";
import { isWorldCompletion } from "../world-completion-validation";
import { createDepthGeometry, type ProjectionOptions } from "./reconstruction";
import {
  backgroundPhotoDepth,
  cleanPhotoDepth,
  photoRemovalMask,
} from "./photo-depth";
import { createDepthEdgeCoverage, createPhotoSurface } from "./photo-surface";
import { sceneObjectInventory } from "./scene-object-inventory";
import { auditObjectMaskOwnership, observedPersonPhotoMask } from "./mask-ownership";
import {
  createClosedVolume,
  depthSilhouettes,
  type VolumePixels,
} from "./volume";

type Vector = [number, number, number];
export interface ReconstructionInput extends ProjectionOptions {
  sourceUrl: string;
  depthUrl: string;
  completionUrl?: string;
  sceneEnvironment?: string;
  mediaType?: "image" | "video";
}
export interface Reconstruction {
  group: THREE.Group;
  surface: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  props: { id: string; label: string; group: THREE.Group; movable: boolean }[];
  navigation: {
    target: Vector;
    front: Vector;
    frontTarget?: Vector;
    side: Vector;
    behind: Vector;
    bounds: { min: Vector; max: Vector };
    obstacles?: WorldObstacle[];
    /** Source-view camera movement limits, used only in photographic mode. */
    photoBounds?: { min: Vector; max: Vector };
  };
  setStrength: (value: number) => void;
  setPointMode: (enabled: boolean) => void;
  setTexture: (texture: THREE.Texture) => void;
  hasPhotoMode?: boolean;
  setPhotoMode?: (enabled: boolean) => void;
  hasBodyShapes: boolean;
  setBodyShape: (choice: BodyShapeChoice) => Promise<boolean>;
  dispose: () => void;
}

async function loadImage(url: string) {
  // Completion can replace masks and textures under the same local asset name.
  // Explicit revalidation also repairs older clients holding the former 1h cache.
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok)
    throw new Error("The memory world texture could not be loaded.");
  const objectUrl = URL.createObjectURL(await response.blob());
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("The memory world texture could not be loaded."));
    };
    image.src = objectUrl;
  });
}
function pixels(
  image: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser could not read the photo.");
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}
function textureOf(image: HTMLImageElement | HTMLCanvasElement) {
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}
function canvasOf(data: VolumePixels) {
  const canvas = document.createElement("canvas");
  canvas.width = data.width;
  canvas.height = data.height;
  const context = canvas.getContext("2d")!;
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(Array.from(data.data)),
      data.width,
      data.height,
    ),
    0,
    0,
  );
  return canvas;
}
function fillHiddenPixels(source: VolumePixels, masks: VolumePixels[]) {
  const { width: w, height: h } = source;
  const data = Uint8ClampedArray.from(source.data);
  const filled = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let i = 0; i < w * h; i++)
    if (
      !masks.some((mask) => {
        const x = Math.min(
          mask.width - 1,
          Math.floor((((i % w) + 0.5) * mask.width) / w),
        );
        const y = Math.min(
          mask.height - 1,
          Math.floor(((Math.floor(i / w) + 0.5) * mask.height) / h),
        );
        return Number(mask.data[(y * mask.width + x) * 4]) > 60;
      })
    ) {
      filled[i] = 1;
      queue.push(i);
    }
  if (!queue.length) {
    // With no observed background there is nothing to extend. A flat sampled
    // colour is safer than leaving a duplicate photograph of the subject.
    const color = [0, 1, 2].map((channel) => {
      let sum = 0;
      for (let i = 0; i < w * h; i++)
        sum += Number(source.data[i * 4 + channel]);
      return Math.round(sum / Math.max(1, w * h));
    });
    for (let i = 0; i < w * h; i++) data.set([...color, 255], i * 4);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const i = queue[cursor];
    const x = i % w;
    const y = Math.floor(i / w);
    for (const n of [
      x ? i - 1 : -1,
      x < w - 1 ? i + 1 : -1,
      y ? i - w : -1,
      y < h - 1 ? i + w : -1,
    ]) {
      if (n < 0 || filled[n]) continue;
      filled[n] = 1;
      queue.push(n);
      for (let c = 0; c < 4; c++) data[n * 4 + c] = data[i * 4 + c];
    }
  }
  return { width: w, height: h, data };
}

function pointMaterial(texture: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: { image: { value: texture } },
    vertexShader:
      "varying vec2 imageUv; void main() { imageUv = uv; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_PointSize = clamp(14.0 / max(.2, -p.z), 1.5, 8.0); }",
    fragmentShader:
      "uniform sampler2D image; varying vec2 imageUv; void main() { if (length(gl_PointCoord - .5) > .5) discard; gl_FragColor = texture2D(image, imageUv);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
  });
}

export async function buildReconstruction(
  input: ReconstructionInput,
): Promise<Reconstruction> {
  const completionPromise = input.completionUrl
    ? fetch(input.completionUrl, { cache: "no-cache" })
        .then(async (response) => {
          if (!response.ok) return undefined;
          const value: unknown = await response.json();
          return isWorldCompletion(value) ? value : undefined;
        })
        .catch(() => undefined)
    : Promise.resolve(undefined);
  const [sourceImage, depthImage, completion] = await Promise.all([
    loadImage(input.sourceUrl),
    loadImage(input.depthUrl),
    completionPromise,
  ]);
  const aspect = sourceImage.naturalWidth / sourceImage.naturalHeight;
  // Use retained model detail where available, with a bounded geometry budget.
  // Enlarging legacy 256px depth cannot recover missing evidence, so do not.
  const longEdge = Math.min(384, Math.max(depthImage.naturalWidth, depthImage.naturalHeight));
  const width = Math.max(2, Math.round(longEdge * aspect / Math.max(1, aspect)));
  const height = Math.max(2, Math.round(longEdge / Math.max(1, aspect)));
  // Nearest sampling avoids inventing intermediate depth along silhouettes.
  const depthCanvas = document.createElement("canvas");
  depthCanvas.width = width;
  depthCanvas.height = height;
  const depthContext = depthCanvas.getContext("2d", {
    willReadFrequently: true,
  })!;
  depthContext.imageSmoothingEnabled = false;
  depthContext.drawImage(depthImage, 0, 0, width, height);
  const depth = cleanPhotoDepth(depthContext.getImageData(0, 0, width, height));
  const source = pixels(sourceImage, width, height);
  // People can share one photographic atlas; decode it only once per world.
  const atlasImages = new Map<string, Promise<HTMLImageElement | undefined>>();
  const loadAtlas = (url: string) => {
    if (!atlasImages.has(url))
      atlasImages.set(
        url,
        loadImage(url).catch(() => undefined),
      );
    return atlasImages.get(url)!;
  };
  const resources = await Promise.all([
    completion?.backgroundUrl
      ? loadImage(completion.backgroundUrl).catch(() => undefined)
      : undefined,
    completion?.rearAtlasUrl
      ? loadImage(completion.rearAtlasUrl).catch(() => undefined)
      : undefined,
    completion?.panoramaUrl
      ? loadImage(completion.panoramaUrl).catch(() => undefined)
      : undefined,
    Promise.all(
      (completion?.subjects ?? []).map(async (subject) => ({
        subject,
        image: await loadImage(subject.maskUrl).catch(() => undefined),
        bodyImage: subject.bodyAtlasUrl
          ? await loadAtlas(subject.bodyAtlasUrl)
          : undefined,
      })),
    ),
    completion?.objectSourceUrl
      ? loadImage(completion.objectSourceUrl).catch(() => undefined)
      : undefined,
  ]);
  const [
    backgroundImage,
    rearImage,
    panoramaImage,
    subjectImages,
    objectSourceImage,
  ] = resources;
  type Subject = {
    id: string;
    label: string;
    kind: "person" | "object";
    box: [number, number, number, number];
    mask: VolumePixels;
    detailMask?: VolumePixels;
    photoMask?: VolumePixels;
    photoExclusion?: VolumePixels;
    ownershipMask?: VolumePixels;
    objectMask?: VolumePixels;
    photographicBody?: Parameters<typeof buildHumanBody>[0]["photographicBody"];
    neuralAsset?: NeuralAssetDescriptor;
    humanPose?: HumanPose;
    poseIntent?: PoseIntent;
    object?: MemoryObjectSpec;
    thickness: number;
  };
  // Body details need the original photo's resolution; depth tessellation does not.
  const detailScale = Math.min(
    1,
    1200 / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight),
  );
  const detailWidth = Math.round(sourceImage.naturalWidth * detailScale);
  const detailHeight = Math.round(sourceImage.naturalHeight * detailScale);
  const detailSource = pixels(sourceImage, detailWidth, detailHeight);
  const subjects: Subject[] = [];
  const atlasPixels = new Map<HTMLImageElement, VolumePixels>();
  for (const { subject, image, bodyImage } of subjectImages) {
    if (!image) continue;
    if (bodyImage && !atlasPixels.has(bodyImage)) {
      atlasPixels.set(
        bodyImage,
        pixels(bodyImage, bodyImage.naturalWidth, bodyImage.naturalHeight),
      );
    }
    const nativeMask = subject.kind === "person" || subject.object
      ? pixels(image, image.naturalWidth, image.naturalHeight) : undefined;
    subjects.push({
      id: subject.id,
      label: subject.label,
      kind: subject.kind,
      box: subject.box,
      mask: pixels(image, width, height),
      detailMask:
        subject.kind === "person" || subject.object
          ? pixels(image, detailWidth, detailHeight)
          : undefined,
      // Object texture boundaries need the learned mask's original resolution;
      // the separate body-analysis budget must not blur fingers into labels.
      objectMask: subject.object ? nativeMask : undefined,
      ownershipMask: nativeMask,
      thickness: subject.thickness ?? 0.7,
      neuralAsset: subject.neuralAsset,
      humanPose: subject.humanPose,
      poseIntent: subject.poseIntent,
      object: subject.object,
      photographicBody: bodyImage
        ? {
            front: atlasPixels.get(bodyImage)!,
            back: atlasPixels.get(bodyImage)!,
            frontBox: subject.bodyFrontBox,
            backBox: subject.bodyBackBox,
          }
        : undefined,
    });
  }
  if (!subjects.length) {
    depthSilhouettes(depth).forEach((mask, i) =>
      subjects.push({
        id: `depth-object-${i + 1}`,
        label: `Inferred object ${i + 1}`,
        kind: "object",
        box: [0, 0, 1, 1],
        mask,
        thickness: 0.8,
      }),
    );
  }
  const detectedPeople = subjects.filter((subject) => subject.kind === "person");
  const classEligibleObjects = subjects.filter(subject => subject.object &&
    canReconstructMemoryObject(subject.object));
  const ownership = auditObjectMaskOwnership(classEligibleObjects.map(subject => ({
    id: subject.id, box: subject.box, mask: subject.ownershipMask ?? subject.mask,
    removalMask: subject.mask })),
    (completion?.subjects ?? detectedPeople).filter(subject => subject.kind === "person")
      .map(subject => ({ id: subject.id, box: subject.box,
        mask: detectedPeople.find(person => person.id === subject.id)?.ownershipMask,
        removalMask: detectedPeople.find(person => person.id === subject.id)?.mask })), { width, height });
  const acceptedObjectIds = new Set(ownership.decisions.filter(decision => decision.accepted)
    .map(decision => decision.id));
  // One decision governs every destructive path, not only appearance sampling.
  // Rejected geometry retains its original class/inventory and source pixels.
  const solidObject = (subject: Subject) => subject.object &&
    canReconstructMemoryObject(subject.object) && acceptedObjectIds.has(subject.id);
  const propMasks = subjects
    .filter((subject) => solidObject(subject) && subject.detailMask)
    .map((subject) => subject.detailMask!);
  const propValidityMasks = subjects.filter(subject => solidObject(subject))
    .map(subject => subject.objectMask ?? subject.detailMask ?? subject.mask);
  // Small label details should use every available reconstruction-source pixel;
  // the lower body-analysis resolution is a separate CPU/memory budget.
  const propImage = objectSourceImage ?? sourceImage;
  const propSource = propMasks.length
    ? pixels(propImage, propImage.naturalWidth, propImage.naturalHeight)
    : detailSource;
  // Original photo RGB is never inpainted before body analysis or UV baking.
  // Separate validity masks withhold accepted prop pixels; unseen body regions
  // keep inferred material rather than treating a propagated color as evidence.
  const personSource = detailSource;
  for (const person of detectedPeople) {
    person.photoMask = observedPersonPhotoMask(person.detailMask!, propValidityMasks,
      { width: sourceImage.naturalWidth, height: sourceImage.naturalHeight }, person.ownershipMask);
    // Appearance keeps the original silhouette for fitting, but uses the same
    // conservative post-resize evidence validity as the photo projection paths.
    person.photoExclusion = { width: detailWidth, height: detailHeight,
      data: Uint8ClampedArray.from(person.photoMask.data, (value, i) =>
        i % 4 === 3 ? 255 : value >= 100 ? 0 : 255) };
  }
  const people = detectedPeople.filter((subject) => subject.neuralAsset ||
    assessPoseSupport(subject.humanPose, subject.poseIntent).canReplace);
  const poseRigs = people.map((subject) =>
    subject.neuralAsset
      ? undefined
      : fitHumanPose(subject.humanPose, personSource, subject.poseIntent),
  );
  const appearances = people.map((subject) =>
    analyzeHumanAppearance({
      source: personSource,
      mask: subject.detailMask!,
      box: subject.box,
      label: subject.label,
      pose: subject.humanPose,
      excludedMasks: [subject.photoExclusion!],
    }),
  );
  poseRigs.forEach((rig, i) => {
    if (rig) appearances[i] = poseAppearance(appearances[i], rig, personSource);
  });
  const personScales = humanPoseScales(
    poseRigs.map((poseRig) => ({ poseRig })),
  );
  const posePhotographs: (
    ReturnType<typeof capturePosePhotographs> | undefined
  )[] = [];
  const buildPerson = async (
    i: number,
    choice: BodyShapeChoice = "photo-fit",
    allowFallback = false,
  ) => {
    const subject = people[i];
    const asset =
      subject.neuralAsset && choice !== "photo-fit"
        ? selectNeuralAssetShape(subject.neuralAsset, choice)
        : subject.neuralAsset;
    if (asset) {
      try {
        const { loadNeuralAsset } = await import("./neural-asset");
        const body = await loadNeuralAsset(
          asset,
          appearances[i].height ?? 1.76,
        );
        try {
          if (
            asset.appearance === "vertex-color" &&
            ["inferred-full-body", "anatomical-template"].includes(
              asset.inputKind,
            )
          ) {
            const { fitNeuralHumanPhotographs } =
              await import("./neural-photo-fitting");
            const fitted = await fitNeuralHumanPhotographs(body.group, {
              source: personSource,
              mask: subject.photoMask!,
              appearance: appearances[i],
              photographicBody: subject.photographicBody,
            });
            const releaseModel = body.dispose;
            body.dispose = () => {
              fitted.dispose?.();
              releaseModel();
            };
            // Reference atlases face +Z. Restore the photographed body's
            // direction only after baking its front and rear references.
            body.group.rotation.y = appearances[i].yaw ?? 0;
            body.group.updateMatrixWorld(true);
            body.bounds.setFromObject(body.group, true);
          }
          return body;
        } catch (error) {
          body.dispose();
          throw error;
        }
      } catch (error) {
        if (!allowFallback) throw error;
        // A failed optional model must not prevent the archived photo from opening.
        // Keep the source-grounded complete-body fallback and record its use.
      }
    }
    const rig = poseRigs[i];
    if (rig) {
      try {
        const {
          loadHumanPoseTemplate,
          deformHumanTemplate,
          choosePoseTemplateShape,
        } = await import("./posed-template");
        const shape =
          choice !== "photo-fit" ? choice : choosePoseTemplateShape(rig);
        const body = await loadHumanPoseTemplate(shape);
        try {
          deformHumanTemplate(body.group, rig);
          const fitted = posePhotographs[i]
            ? posePhotographs[i]!(body.group)
            : await fitPosedHumanPhotographs(body.group, rig, {
                source: personSource,
                mask: subject.photoMask!,
                appearance: appearances[i],
              });
          posePhotographs[i] ??= capturePosePhotographs(body.group);
          const dispose = body.dispose;
          body.dispose = () => {
            fitted.dispose();
            dispose();
          };
          body.group.scale.setScalar(personScales[i]);
          body.group.updateMatrixWorld(true);
          body.bounds.setFromObject(body.group, true);
          return body;
        } catch (error) {
          body.dispose();
          throw error;
        }
      } catch {
        // A missing optional template still has a closed, articulated fallback.
      }
    }
    const body = buildHumanBody({
      source: personSource,
      mask: subject.photoMask!,
      fittingMask: subject.detailMask!,
      box: subject.box,
      label: subject.label,
      appearance: appearances[i],
      photographicBody: subject.photographicBody,
      poseRig: rig,
    });
    if (rig) {
      body.group.scale.setScalar(personScales[i]);
      body.group.updateMatrixWorld(true);
      body.bounds.setFromObject(body.group, true);
      body.group.userData.poseTemplateFallback = true;
    }
    if (subject.neuralAsset) body.group.userData.neuralAssetFallback = true;
    return body;
  };
  const humans = await Promise.all(
    people.map((_, i) => buildPerson(i, "photo-fit", true)),
  );
  const groundingOffsets = humans.map((human) => human.group.position.y);
  // Remove only pixels for replacements we can actually support. Weak poses,
  // wearables, architecture and unclassified objects remain photographed.
  const replacedIds = new Set(people.map((subject) => subject.id));
  const replacedSubjects = subjects.filter((subject) => replacedIds.has(subject.id) ||
    solidObject(subject));
  const replacementIds = new Set(replacedSubjects.map(subject => subject.id));
  const masks = replacedSubjects.map((subject) => subject.mask);
  const backgroundDepth = backgroundPhotoDepth(depth, masks);
  const removalMask = photoRemovalMask(depth, masks);
  const generatedBackground =
    backgroundImage &&
    // The generated atlas also erased subjects whose mask failed to load. It
    // is safe only when every original subject has a usable replacement.
    completion?.subjects.every(subject => replacementIds.has(subject.id)) &&
    (completion?.textureSource === "gemini" ||
      completion?.textureSource === "imagegen");
  const hiddenSource = generatedBackground
    ? backgroundImage
    : canvasOf(fillHiddenPixels(detailSource, [removalMask]));
  const texture = textureOf(sourceImage);
  const backgroundTexture = textureOf(hiddenSource);
  const rearTexture = rearImage ? textureOf(rearImage) : undefined;
  const panoramaTexture = panoramaImage ? textureOf(panoramaImage) : undefined;
  const group = new THREE.Group();
  group.name = "Full-body memory world";
  group.userData.objectMaskOwnership = ownership;
  group.userData.bodyPhotoSource = "original-rgb-with-validity-mask";
  const surfaceGeometry = new THREE.BufferGeometry();
  const completedEdgeGeometry = new THREE.BufferGeometry();
  const backgroundMaterial = new THREE.MeshBasicMaterial({
    map: backgroundTexture,
    side: THREE.FrontSide,
  });
  const surface = new THREE.Mesh(surfaceGeometry, backgroundMaterial);
  const completedEdges = new THREE.Mesh(completedEdgeGeometry, backgroundMaterial);
  completedEdges.name = "Completed context edge coverage";
  surface.add(completedEdges);
  surface.name = "Original landscape depth surface";
  // Preserve source geometry for unsupported people and objects. Only accepted
  // replacement footprints are removed from this photographed context.
  surface.visible = true;
  group.add(surface);
  const environment = buildPhotoEnvironment({
    source: pixels(hiddenSource, detailWidth, detailHeight),
    photoTexture: backgroundTexture,
    panoramaTexture,
    environment: completion?.environment,
    sceneEnvironment: input.sceneEnvironment,
    sceneUnderstanding: completion?.sceneUnderstanding,
    fov: input.fov,
    horizon: completion?.horizon,
    excludedMask: removalMask,
    textureSource: generatedBackground
      ? completion?.textureSource
      : "source-inpaint",
  });
  if (input.mediaType !== "video") {
    // The enclosure's floor and depth bands are inferred. They must not erase
    // observed pixels merely because relative photo depth falls below y=0 or
    // beyond an estimated wall. Draw the enclosure as background context;
    // observed surfaces and accepted bodies still depth-test against each other.
    environment.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.userData.bodyShadowReceiver) return;
      object.renderOrder = object.material instanceof THREE.Material && object.material.side === THREE.BackSide ? -20 : -10;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.depthWrite = false;
    });
  }
  group.add(environment.group);
  humans.forEach((human) => group.add(human.group));
  // Retain these independent groups for controller grabs. Slider changes only
  // update their original layout, never replace held geometry or its materials.
  const recognizedProps = subjects
    .filter((subject) => subject.kind === "object" && solidObject(subject))
    .map((subject) => ({
      subject,
      ...buildMemoryProp({
        id: subject.id,
        label: subject.label,
        object: subject.object!,
        source: propSource,
        mask: subject.objectMask,
        box: subject.box,
      }),
    }));
  recognizedProps.forEach((prop) => group.add(prop.group));
  const props: Reconstruction["props"] = recognizedProps.map((prop) => ({
    id: prop.subject.id,
    label: prop.subject.label,
    group: prop.group,
    movable: input.mediaType !== "video" &&
      memoryObjectPolicy(prop.subject.object!.category).interaction === "movable",
  }));
  const shadowPixels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const radius = Math.hypot((x - 31.5) / 31.5, (y - 31.5) / 31.5);
      shadowPixels[(y * 64 + x) * 4 + 3] = Math.round(
        70 * Math.pow(Math.max(0, 1 - radius), 2),
      );
    }
  const shadowTexture = new THREE.DataTexture(shadowPixels, 64, 64);
  shadowTexture.needsUpdate = true;
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const shadowGeometry = new THREE.PlaneGeometry(1.1, 0.8);
  const contactShadows = humans.map(() => {
    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.name = "Soft contact shadow beneath completed feet";
    shadow.rotation.x = -Math.PI / 2;
    group.add(shadow);
    return shadow;
  });
  const frontMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.FrontSide,
  });
  const backMaterial = new THREE.MeshStandardMaterial({
    map: rearTexture ?? null,
    vertexColors: !rearTexture,
    color: 0xffffff,
    roughness: 0.92,
    side: THREE.FrontSide,
  });
  // Keep the observed image available without replacing its people with fitted
  // anatomy. The completed-object view remains available for broader movement.
  const photoGeometry = new THREE.BufferGeometry();
  const photoBackgroundGeometry = new THREE.BufferGeometry();
  const photoEdgeGeometry = new THREE.BufferGeometry();
  const photoGroup = new THREE.Group();
  photoGroup.name = "Photo fidelity surfaces";
  const photoSurface = new THREE.Mesh(photoGeometry, frontMaterial);
  photoGroup.add(photoSurface);
  const photoEdges = new THREE.Mesh(photoEdgeGeometry, frontMaterial);
  photoEdges.name = "Photographed edge coverage";
  photoGroup.add(photoEdges);
  photoGroup.add(new THREE.Mesh(photoBackgroundGeometry, backgroundMaterial));
  group.add(photoGroup);
  const volumeMeshes: THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>[] = [];
  const cloudGeometry = new THREE.BufferGeometry();
  const cloudMaterial = pointMaterial(texture);
  const cloud = new THREE.Points(cloudGeometry, cloudMaterial);
  cloud.visible = false;
  group.add(cloud);
  const navigation: Reconstruction["navigation"] = {
    target: [0, 1, -3.8],
    front: [0, 1.6, 0.5],
    side: [4, 1.6, -3.8],
    behind: [0, 1.6, -7.2],
    bounds: { min: [-20, 0.45, -29], max: [20, 12, 12] },
  };
  let pointMode = false;
  let photoMode = input.mediaType !== "video";
  let completedObstacles: WorldObstacle[] = [];
  let photoCloudPositions: Float32Array | undefined;
  let completedCloudPositions: Float32Array | undefined;
  const updateVisibility = () => {
    surface.visible = !photoMode && !pointMode;
    photoGroup.visible = photoMode && !pointMode;
    photoSurface.visible = photoMode && !pointMode;
    cloud.visible = pointMode;
    const cloudPositions = photoMode
      ? photoCloudPositions
      : completedCloudPositions;
    if (
      cloudPositions &&
      cloudGeometry.getAttribute("position")?.array !== cloudPositions
    ) {
      cloudGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(cloudPositions, 3),
      );
      cloudGeometry.computeBoundingSphere();
    }
    environment.group.visible = !photoMode && !pointMode;
    humans.forEach((human) => {
      human.group.visible = !photoMode && !pointMode;
    });
    contactShadows.forEach((shadow) => {
      shadow.visible = !photoMode && !pointMode;
    });
    volumeMeshes.forEach((mesh) => {
      mesh.visible = !photoMode && !pointMode;
    });
    recognizedProps.forEach((prop) => {
      prop.group.visible = !photoMode && !pointMode;
    });
    navigation.obstacles = photoMode || pointMode ? [] : completedObstacles;
    group.userData.photoMode = photoMode;
  };
  const addObstacle = (bounds: THREE.Box3) => {
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    navigation.obstacles!.push({
      x: center.x,
      z: center.z,
      radiusX: Math.max(0.12, (bounds.max.x - bounds.min.x) / 2),
      radiusZ: Math.max(0.12, (bounds.max.z - bounds.min.z) / 2),
      minY: bounds.min.y,
      maxY: bounds.max.y,
    });
  };
  let currentStrength = input.strength ?? 1.25;
  let fixedCaptureHeight: number | undefined;
  const setStrength = (strength: number) => {
    currentStrength = strength;
    for (const mesh of volumeMeshes) {
      group.remove(mesh);
      mesh.geometry.dispose();
    }
    volumeMeshes.length = 0;
    navigation.obstacles = [...environment.obstacles];
    const bounds = new THREE.Box3();
    const positions = layoutHumanBodies(
      people.map((person, i) => ({
        box: person.box,
        faceBox: appearances[i].faceBox,
        mask: person.mask,
        poseRig: poseRigs[i],
        bodyMinY: humans[i].bounds.min.y / personScales[i],
        bodyScale: personScales[i],
      })),
      depth,
      strength,
      { fov: input.fov, aspect },
    );
    humans.forEach((human, i) => {
      human.group.position.fromArray(positions[i]);
      human.group.position.y += groundingOffsets[i];
      human.group.visible = !pointMode;
      human.group.updateMatrixWorld(true);
      contactShadows[i].position.set(
        positions[i][0],
        0.008,
        positions[i][2] + 0.04,
      );
      contactShadows[i].visible = !pointMode;
      // Builder bounds include body scale/yaw and its grounding correction.
      const bodyBounds = human.bounds
        .clone()
        .translate(new THREE.Vector3(...positions[i]));
      bounds.union(bodyBounds);
      addObstacle(bodyBounds);
    });
    const captureHeight = fixedCaptureHeight ??= estimateCaptureHeight(
      poseRigs.flatMap((rig, i) => {
        const face = appearances[i].faceBox;
        if (!rig || !face) return [];
        const head = rig.joints.head
          .clone()
          .multiplyScalar(personScales[i])
          .add(humans[i].group.position);
        return [
          {
            worldY: head.y,
            depth: -head.z,
            photoV: (face[0] + face[2]) / 2,
            confidence: rig.confidenceByJoint.head,
          },
        ];
      }),
      input.fov ?? 60,
    );
    const projectionOptions = {
      ...input,
      aspect,
      strength,
      cameraHeight: captureHeight,
    };
    environment.setCaptureHeight(captureHeight);
    const projected = createDepthGeometry(depth, projectionOptions);
    const photographic = createPhotoSurface(depth, projectionOptions);
    photoCloudPositions = photographic.foreground.positions;
    completedCloudPositions = projected.positions;
    for (const [geometry, data] of [
      [photoGeometry, photographic.foreground],
      [photoBackgroundGeometry, photographic.background],
      [photoEdgeGeometry, photographic.edgeCoverage],
    ] as const) {
      geometry.dispose();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(data.positions, 3),
      );
      geometry.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.computeBoundingSphere();
    }
    const backgroundProjected = createDepthGeometry(
      backgroundDepth,
      projectionOptions,
    );
    const completedCoverage = createDepthEdgeCoverage(backgroundProjected);
    completedEdgeGeometry.dispose();
    completedEdgeGeometry.setAttribute("position", new THREE.BufferAttribute(completedCoverage.positions, 3));
    completedEdgeGeometry.setAttribute("uv", new THREE.BufferAttribute(completedCoverage.uvs, 2));
    completedEdgeGeometry.setIndex(new THREE.BufferAttribute(completedCoverage.indices, 1));
    completedEdgeGeometry.computeBoundingSphere();
    surfaceGeometry.dispose();
    surfaceGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(backgroundProjected.positions, 3),
    );
    surfaceGeometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(backgroundProjected.uvs, 2),
    );
    surfaceGeometry.setIndex(
      new THREE.BufferAttribute(backgroundProjected.indices, 1),
    );
    surfaceGeometry.computeBoundingSphere();
    cloudGeometry.dispose();
    cloudGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(projected.positions, 3),
    );
    cloudGeometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(projected.uvs, 2),
    );
    cloudGeometry.computeBoundingSphere();
    const propAnchors: MemoryPropAnchor[] = poseRigs.flatMap((rig, i) => {
      if (!rig) return [];
      return (["leftWrist", "rightWrist"] as const).flatMap((joint) => {
        const landmark = rig.pose.landmarks[rig.sourceLandmarkIndex[joint]];
        if (!landmark) return [];
        const hand = rig.joints[joint]
          .clone()
          .multiplyScalar(personScales[i])
          .add(humans[i].group.position);
        return [
          {
            image: [landmark.image[0], landmark.image[1]] as [number, number],
            position: hand.toArray() as Vector,
            confidence: rig.confidenceByJoint[joint],
          },
        ];
      });
    });
    recognizedProps.forEach((prop) => {
      // An object that has been picked up must not snap out of a controller or
      // back to its original photograph when another scene setting changes.
      if (
        prop.group.parent === group &&
        prop.group.userData.memoryPropMoved !== true
      ) {
        const placement = placeMemoryProp({
          ...input,
          box: prop.subject.box,
          object: prop.subject.object!,
          depth,
          mask: prop.subject.mask,
          aspect,
          strength,
          cameraHeight: captureHeight,
          anchors: propAnchors,
        });
        prop.group.position.fromArray(placement.position);
        prop.group.scale.setScalar(placement.scale);
      }
      prop.group.visible = !pointMode;
      prop.group.updateMatrixWorld(true);
      bounds.union(new THREE.Box3().setFromObject(prop.group));
      if (memoryObjectPolicy(prop.subject.object!.category).interaction === "fixed")
        addObstacle(new THREE.Box3().setFromObject(prop.group));
      // Movable small props cannot leave stale navigation collision cylinders.
      // Their complete geometry remains available for controller ray hits.
    });
    for (const subject of subjects.filter(
      (subject) => input.mediaType === "video" && subject.kind !== "person" && !subject.object,
    )) {
      try {
        const volume = createClosedVolume(
          projected,
          subject.mask,
          source,
          subject.thickness * Math.max(0.65, Math.sqrt(strength)),
        );
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(volume.positions, 3),
        );
        geometry.setAttribute("uv", new THREE.BufferAttribute(volume.uvs, 2));
        geometry.setAttribute(
          "color",
          new THREE.BufferAttribute(volume.colors, 3),
        );
        geometry.setIndex(new THREE.BufferAttribute(volume.indices, 1));
        geometry.addGroup(0, volume.frontIndexCount, 0);
        geometry.addGroup(
          volume.frontIndexCount,
          volume.indices.length - volume.frontIndexCount,
          1,
        );
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, [frontMaterial, backMaterial]);
        mesh.name = `${subject.label} — colored object reconstruction`;
        mesh.visible = !pointMode;
        group.add(mesh);
        volumeMeshes.push(mesh);
        const objectBounds = new THREE.Box3(
          new THREE.Vector3(...volume.bounds.min),
          new THREE.Vector3(...volume.bounds.max),
        );
        bounds.union(objectBounds);
        addObstacle(objectBounds);
      } catch {
        /* Subpixel silhouettes remain in the landscape depth surface. */
      }
    }
    if (!bounds.isEmpty()) {
      const center = bounds.getCenter(new THREE.Vector3());
      navigation.target = [
        center.x,
        people.length ? 1 : Math.max(1.2, Math.min(2.2, center.y)),
        center.z,
      ];
      const framing = Math.max(2.7, (bounds.max.x - bounds.min.x) * 0.9);
      navigation.side = [
        Math.min(18, bounds.max.x + framing),
        1.6,
        center.z + 0.4,
      ];
      navigation.behind = [
        center.x,
        1.6,
        Math.max(-27, bounds.min.z - framing),
      ];
    }
    // Every photographic subject uses this source camera, including unposed
    // people and object-only scenes. Recentering introduces artificial parallax.
    navigation.front = [0, captureHeight, 0];
    navigation.frontTarget = [0, captureHeight, -4];
    let nearestPhoto = Infinity;
    for (const value of photographic.foreground.distances) nearestPhoto = Math.min(nearestPhoto, value);
    const lateral = Math.min(0.18, nearestPhoto * 0.06);
    navigation.photoBounds = {
      min: [-lateral, captureHeight - 0.12, -Math.min(0.25, nearestPhoto * 0.1)],
      max: [lateral, captureHeight + 0.12, 0.35],
    };
    group.userData.completedBodies = humans.length;
    group.userData.detectedPeople = detectedPeople.length;
    group.userData.retainedPeople = detectedPeople.length - humans.length;
    group.userData.retainedObjects = subjects.filter((subject) =>
      subject.kind === "object" && !solidObject(subject)).length;
    group.userData.poseFittedBodies = humans.filter(
      (human) => human.group.userData.humanPoseFitted === true,
    ).length;
    group.userData.poseEstimatedBodies = detectedPeople.length;
    group.userData.completedVolumes = volumeMeshes.length + props.length;
    group.userData.completedProps = props.length;
    group.userData.semanticSource = completion?.generatedBy ?? "depth-fallback";
    group.userData.objectInventory = sceneObjectInventory(
      completion?.subjects ?? subjects, completion?.sceneUnderstanding, props,
      ownership.decisions,
    );
    group.userData.objectCoverage = completion?.objectRecognition?.coverage;
    group.userData.sceneUnderstanding = completion?.sceneUnderstanding;
    completedObstacles = navigation.obstacles ?? [];
    updateVisibility();
  };
  setStrength(input.strength ?? 1.25);
  const bodyShapes = createBodyShapeController(
    humans,
    buildPerson,
    (next, previous) => {
      previous.forEach((human) => group.remove(human.group));
      humans.splice(0, humans.length, ...next);
      groundingOffsets.splice(
        0,
        groundingOffsets.length,
        ...next.map((human) => human.group.position.y),
      );
      next.forEach((human) => group.add(human.group));
      setStrength(currentStrength);
    },
  );
  return {
    group,
    get surface() {
      return photoMode ? photoSurface : surface;
    },
    props,
    navigation,
    setStrength,
    hasPhotoMode: input.mediaType !== "video",
    setPhotoMode: (enabled) => {
      photoMode = enabled && input.mediaType !== "video";
      updateVisibility();
    },
    hasBodyShapes:
      poseRigs.some(Boolean) ||
      people.some((subject) => Boolean(subject.neuralAsset?.shapeVariants)),
    setBodyShape: bodyShapes.select,
    setPointMode: (enabled) => {
      pointMode = enabled;
      updateVisibility();
    },
    setTexture: (next) => {
      // Human bodies use the reconstruction frame's inferred clothing/face atlas.
      // Video still updates the landscape surface and diagnostic point view.
      frontMaterial.map = next;
      frontMaterial.needsUpdate = true;
      backgroundMaterial.map = next;
      backgroundMaterial.needsUpdate = true;
      cloudMaterial.uniforms.image.value = next;
    },
    dispose: () => {
      surfaceGeometry.dispose();
      completedEdgeGeometry.dispose();
      photoGeometry.dispose();
      photoBackgroundGeometry.dispose();
      photoEdgeGeometry.dispose();
      cloudGeometry.dispose();
      volumeMeshes.forEach((mesh) => mesh.geometry.dispose());
      recognizedProps.forEach((prop) => prop.dispose());
      bodyShapes.dispose();
      posePhotographs.length = 0;
      backgroundMaterial.dispose();
      frontMaterial.dispose();
      backMaterial.dispose();
      cloudMaterial.dispose();
      texture.dispose();
      backgroundTexture.dispose();
      rearTexture?.dispose();
      panoramaTexture?.dispose();
      shadowTexture.dispose();
      shadowMaterial.dispose();
      shadowGeometry.dispose();
      environment.dispose();
    },
  };
}
