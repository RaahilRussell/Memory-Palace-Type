import * as THREE from "three";
import type {
  VideoReconstructionSpec,
  VideoTrackedObjectSpec,
  WorldCompletion,
} from "../types";
import { isWorldCompletion } from "../world-completion-validation";
import { createDepthGeometry, type ProjectionOptions } from "./reconstruction";
import type { Reconstruction, ReconstructionInput } from "./volume-world";
import { buildMemoryProp, placeMemoryProp } from "./memory-props";
import type { VolumePixels } from "./volume";
import { canReconstructMemoryObject } from "../memory-objects";

/** Binary interval lookup is deterministic for scrubbing, reverse seeks and looping. */
export function videoFrameBlend(times: readonly number[], time: number) {
  if (!times.length) throw new Error("A video needs depth frames.");
  const current = Number.isFinite(time) ? time : 0;
  if (current <= times[0]) return { from: 0, to: 0, amount: 0, nearest: 0 };
  const last = times.length - 1;
  if (current >= times[last])
    return { from: last, to: last, amount: 0, nearest: last };
  let low = 0,
    high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= current) low = middle;
    else high = middle;
  }
  const amount = (current - times[low]) / (times[high] - times[low]);
  return { from: low, to: high, amount, nearest: amount < 0.5 ? low : high };
}

/** Large depth jumps are occlusions/cuts, not a surface to stretch across time. */
export function interpolateVideoPositions(
  a: Float32Array,
  b: Float32Array,
  amount: number,
  output: Float32Array,
) {
  if (a.length !== b.length || output.length !== a.length || a.length % 3)
    throw new Error("Video depth grids must match.");
  const mix = THREE.MathUtils.clamp(amount, 0, 1);
  for (let i = 0; i < a.length; i += 3) {
    const stable =
      Math.abs(a[i + 2] - b[i + 2]) <=
      Math.max(0.4, Math.min(Math.abs(a[i + 2]), Math.abs(b[i + 2])) * 0.22);
    const weight = stable ? mix : mix < 0.5 ? 0 : 1;
    for (let j = 0; j < 3; j++)
      output[i + j] = a[i + j] * (1 - weight) + b[i + j] * weight;
  }
}

/** Move the actor shell forward from the clean plate while keeping its camera projection fixed. */
export function separateVideoActorFromBackdrop(
  positions: Float32Array,
  gap = 0.65,
) {
  if (positions.length % 3 || !Number.isFinite(gap) || gap < 0 || gap > 2)
    throw new Error("Video actor depth separation is invalid.");
  for (let i = 0; i < positions.length; i += 3) {
    const distance = -positions[i + 2];
    const separated = Math.max(0.5, distance - gap);
    const ratio = separated / distance;
    positions[i] *= ratio;
    positions[i + 1] = (positions[i + 1] - 1.6) * ratio + 1.6;
    positions[i + 2] = -separated;
  }
  return positions;
}

function resizeBinaryMask(
  mask: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
) {
  const resized = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(
      sourceHeight - 1,
      Math.floor(((y + 0.5) * sourceHeight) / height),
    );
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(
        sourceWidth - 1,
        Math.floor(((x + 0.5) * sourceWidth) / width),
      );
      resized[y * width + x] = mask[sourceY * sourceWidth + sourceX];
    }
  }
  return resized;
}

function writeDynamicIndices(
  geometry: THREE.BufferGeometry,
  indices: Uint32Array | number[],
  capacity: number,
) {
  let attribute = geometry.getIndex();
  if (!attribute || attribute.array.length < capacity) {
    const values = new Uint32Array(capacity);
    values.set(indices);
    geometry.setIndex(
      new THREE.BufferAttribute(values, 1).setUsage(THREE.DynamicDrawUsage),
    );
    attribute = geometry.getIndex()!;
  } else {
    (attribute.array as Uint32Array).set(indices);
    attribute.needsUpdate = true;
  }
  geometry.setDrawRange(0, indices.length);
}

/** Split the sampled video surface into independently rendered person and room
 * triangles. Conservative boundaries keep background pixels out of the actor. */
export function partitionVideoTriangles(
  indices: Uint32Array,
  personMask: Uint8Array,
  objectMask: Uint8Array,
) {
  if (
    personMask.length !== objectMask.length ||
    indices.length % 3 ||
    indices.some((index) => index >= personMask.length)
  )
    throw new Error("Video masks and triangles must match.");
  const room: number[] = [];
  const person: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i],
      b = indices[i + 1],
      c = indices[i + 2];
    const actorTriangle =
      personMask[a] &&
      personMask[b] &&
      personMask[c] &&
      !objectMask[a] &&
      !objectMask[b] &&
      !objectMask[c];
    if (actorTriangle) {
      person.push(a, b, c);
      continue;
    }
    if (
      !personMask[a] &&
      !personMask[b] &&
      !personMask[c] &&
      !objectMask[a] &&
      !objectMask[b] &&
      !objectMask[c]
    )
      room.push(a, b, c);
  }
  return { room: new Uint32Array(room), person: new Uint32Array(person) };
}

export function videoTrackedPose(track: VideoTrackedObjectSpec, time: number) {
  const frames = track.keyframes;
  const current = Number.isFinite(time) ? time : 0;
  let from = 0;
  while (from + 1 < frames.length && frames[from + 1].time <= current) from++;
  const to = Math.min(from + 1, frames.length - 1);
  const a = frames[from],
    b = frames[to];
  const amount =
    a === b
      ? 0
      : THREE.MathUtils.clamp((current - a.time) / (b.time - a.time), 0, 1);
  const rotationA = a.rotation ?? [0, 0, 0];
  const rotationB = b.rotation ?? [0, 0, 0];
  return {
    visible: current >= frames[0].time && frames[from].visible !== false,
    u: THREE.MathUtils.lerp(a.u, b.u, amount),
    v: THREE.MathUtils.lerp(a.v, b.v, amount),
    depth: THREE.MathUtils.lerp(a.depth, b.depth, amount),
    rotation: rotationA.map((value, i) =>
      THREE.MathUtils.lerp(value, rotationB[i], amount),
    ) as [number, number, number],
  };
}

export function videoTrackMask(
  track: VideoTrackedObjectSpec,
  time: number,
  width: number,
  height: number,
  fov: number,
  aspect: number,
) {
  const mask = new Uint8Array(width * height);
  const pose = videoTrackedPose(track, time);
  if (!pose.visible) return mask;
  const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const radiusU = Math.max(
    track.radius / (2 * tan * aspect * pose.depth),
    1.25 / width,
  );
  const radiusV = Math.max(
    track.radius / (2 * tan * pose.depth),
    1.25 / height,
  );
  const left = Math.max(0, Math.floor((pose.u - radiusU) * width));
  const right = Math.min(width - 1, Math.ceil((pose.u + radiusU) * width));
  const top = Math.max(0, Math.floor((pose.v - radiusV) * height));
  const bottom = Math.min(height - 1, Math.ceil((pose.v + radiusV) * height));
  for (let y = top; y <= bottom; y++)
    for (let x = left; x <= right; x++) {
      const dx = ((x + 0.5) / width - pose.u) / radiusU;
      const dy = ((y + 0.5) / height - pose.v) / radiusV;
      if (dx * dx + dy * dy <= 1) mask[y * width + x] = 1;
    }
  return mask;
}

/** Fill camera-facing cuts with the current video while retaining every sampled
 * foreground vertex. One fixed depth across all frames avoids background jumps. */
export function createVideoBackdropProjection(
  frameDistances: readonly Float32Array[],
  options: ProjectionOptions,
  propDepth = 0,
) {
  let distance = propDepth;
  for (const frame of frameDistances)
    for (const value of frame) distance = Math.max(distance, value);
  distance += 0.05;
  return createDepthGeometry(
    { width: 2, height: 2, data: new Uint8Array(16).fill(255) },
    { ...options, near: distance, far: distance + 1, strength: 1 },
  );
}

/** Side/rear inspection follows the most prominent photographed prop, whose
 * inferred metric placement can be much nearer than the sampled depth surface. */
export function videoInspectionNavigation(
  props: readonly { group: THREE.Object3D; box: readonly number[] }[],
): Pick<Reconstruction["navigation"], "target" | "side" | "behind"> {
  let prominent: (typeof props)[number] | undefined;
  let largestArea = 0;
  for (const prop of props) {
    const [top, left, bottom, right] = prop.box;
    const area = (bottom - top) * (right - left);
    if (area > largestArea) {
      prominent = prop;
      largestArea = area;
    }
  }
  const bounds = prominent
    ? new THREE.Box3().setFromObject(prominent.group)
    : new THREE.Box3();
  if (bounds.isEmpty())
    return {
      target: [0, 1.6, -4],
      side: [4, 1.6, -4],
      behind: [0, 1.6, -8],
    };
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const { x, y, z } = sphere.center;
  const distance = Math.max(0.8, sphere.radius * 3);
  return {
    target: [x, y, z],
    side: [x + distance, y, z],
    behind: [x, y, z - distance],
  };
}

async function loadImage(url: string) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok)
    throw new Error(
      "A video depth frame could not be loaded. Reopen this video to rebuild it.",
    );
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error("A video frame could not be decoded."));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function pixels(
  image: HTMLImageElement,
  width: number,
  height: number,
): VolumePixels {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw new Error("This browser could not read a video depth frame.");
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height);
  return { width, height, data: data.data };
}

/** Video remains a sampled moving depth surface, with closed category meshes for
 * recognized props. It does not claim to recover a volumetric performance or
 * unseen moving people from a single camera. All geometry is bounded for Quest. */
export async function buildVideoReconstruction(
  input: ReconstructionInput & { video: VideoReconstructionSpec },
): Promise<Reconstruction & { updateTime(time: number): void }> {
  const firstImage = await loadImage(input.sourceUrl);
  const aspect = input.aspect ?? firstImage.width / firstImage.height;
  const width = aspect >= 1 ? 128 : Math.max(16, Math.round(128 * aspect));
  const height = aspect >= 1 ? Math.max(16, Math.round(128 / aspect)) : 128;
  let strength = input.strength ?? 1.25;
  const group = new THREE.Group();
  group.name = "Moving video memory";
  const ownedProps: ReturnType<typeof buildMemoryProp>[] = [];
  const props: Reconstruction["props"] = [];
  const ownedTexture = new THREE.Texture(firstImage);
  ownedTexture.colorSpace = THREE.SRGBColorSpace;
  ownedTexture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    map: ownedTexture,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.BufferGeometry();
  const surface = new THREE.Mesh(geometry, material);
  group.add(surface);
  const personGeometry = new THREE.BufferGeometry();
  const personSurface = new THREE.Mesh(personGeometry, material);
  personSurface.name = "Video person";
  personSurface.visible = false;
  const personGroup = new THREE.Group();
  personGroup.name = "Segmented moving person";
  personGroup.add(personSurface);
  group.add(personGroup);
  // The first sample is a clean plate for this locked-camera recording. It
  // keeps the room visible behind the independently rendered moving person.
  const backdropTexture = new THREE.Texture(firstImage);
  backdropTexture.colorSpace = THREE.SRGBColorSpace;
  backdropTexture.needsUpdate = true;
  const backdropMaterial = new THREE.MeshBasicMaterial({
    map: backdropTexture,
    side: THREE.DoubleSide,
  });
  const backdropGeometry = new THREE.BufferGeometry();
  const backdrop = new THREE.Mesh(backdropGeometry, backdropMaterial);
  backdrop.name = "Fixed-camera clean plate";
  group.add(backdrop);
  const pointGeometry = new THREE.BufferGeometry();
  const pointMaterial = new THREE.ShaderMaterial({
    uniforms: { image: { value: ownedTexture } },
    vertexShader:
      "varying vec2 imageUv; void main() { imageUv = uv; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_PointSize = clamp(14.0 / max(.2, -p.z), 1.5, 8.0); }",
    fragmentShader:
      "uniform sampler2D image; varying vec2 imageUv; void main() { if (length(gl_PointCoord - .5) > .5) discard; gl_FragColor = texture2D(image, imageUv);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
  });
  const points = new THREE.Points(pointGeometry, pointMaterial);
  points.visible = false;
  group.add(points);
  const trackedMeshes: { spec: VideoTrackedObjectSpec; group: THREE.Group }[] =
    [];
  const ownedTrackGeometry: THREE.BufferGeometry[] = [];
  const ownedTrackMaterials: THREE.Material[] = [];
  const ownedTrackTextures: THREE.Texture[] = [];
  const frames: {
    depth: VolumePixels;
    projection: ReturnType<typeof createDepthGeometry>;
    personMask: Uint8Array;
    personIndices: Uint32Array;
    fullIndices: Uint32Array;
    props: THREE.Group;
    objectMask: Uint8Array;
    placements: {
      item: ReturnType<typeof buildMemoryProp>;
      subject: WorldCompletion["subjects"][number];
      mask: VolumePixels;
    }[];
  }[] = [];
  const actorFrames: {
    time: number;
    depth: Uint8Array;
    mask: Uint8Array;
    width: number;
    height: number;
  }[] = [];
  const projectionOptions = () => ({ ...input, aspect, strength });
  const dispose = () => {
    group.removeFromParent();
    ownedProps.forEach((prop) => prop.dispose());
    geometry.dispose();
    personGeometry.dispose();
    backdropGeometry.dispose();
    pointGeometry.dispose();
    ownedTrackGeometry.forEach((item) => item.dispose());
    ownedTrackMaterials.forEach((item) => item.dispose());
    ownedTrackTextures.forEach((item) => item.dispose());
    material.dispose();
    backdropMaterial.dispose();
    backdropTexture.dispose();
    pointMaterial.dispose();
    ownedTexture.dispose();
    // VideoTexture ownership belongs to MemoryWorld so switching memories is safe.
  };
  try {
    for (const [index, frame] of input.video.frames.entries()) {
      const depthImage = await loadImage(frame.depthUrl);
      const depth = pixels(depthImage, width, height);
      const objectMask = new Uint8Array(width * height);
      const personMask = new Uint8Array(width * height);
      const frameProps = new THREE.Group();
      frameProps.visible = !index;
      group.add(frameProps);
      const placements: (typeof frames)[number]["placements"] = [];
      if (frame.completionUrl) {
        const response = await fetch(frame.completionUrl, {
          cache: "no-cache",
        });
        if (!response.ok)
          throw new Error("The video object metadata could not be loaded.");
        const completion: unknown = await response.json();
        if (!isWorldCompletion(completion))
          throw new Error(
            "The video object metadata is invalid. Rebuild this video.",
          );
        const sourceImage = index
          ? await loadImage(frame.sourceUrl)
          : firstImage;
        const source = pixels(
          sourceImage,
          sourceImage.width,
          sourceImage.height,
        );
        for (const subject of completion.subjects) {
          if (
            subject.kind === "object" &&
            (!subject.object || !canReconstructMemoryObject(subject.object))
          )
            continue;
          const maskImage = await loadImage(subject.maskUrl);
          const mask = pixels(maskImage, width, height);
          const targetMask =
            subject.kind === "person" ? personMask : objectMask;
          for (let i = 0; i < targetMask.length; i++)
            if (Number(mask.data[i * 4]) >= 128) targetMask[i] = 1;
          if (subject.kind !== "object" || !subject.object) continue;
          const item = buildMemoryProp({
            id: `${index}:${subject.id}`,
            label: subject.label,
            object: subject.object,
            source,
            mask: pixels(maskImage, source.width, source.height),
            box: subject.box,
          });
          ownedProps.push(item);
          frameProps.add(item.group);
          const placement = placeMemoryProp({
            ...projectionOptions(),
            object: subject.object,
            box: subject.box,
            depth,
            mask,
          });
          item.group.position.fromArray(placement.position);
          item.group.scale.setScalar(placement.scale);
          props.push({
            id: `${index}:${subject.id}`,
            label: subject.label,
            group: item.group,
            movable: false,
          });
          placements.push({ item, subject, mask });
        }
      }
      const fullProjection = createDepthGeometry(depth, projectionOptions());
      const partition = partitionVideoTriangles(
        fullProjection.indices,
        personMask,
        objectMask,
      );
      frames.push({
        depth,
        props: frameProps,
        objectMask,
        personMask,
        personIndices: partition.person,
        fullIndices: fullProjection.indices,
        placements,
        projection: {
          ...fullProjection,
          indices: partition.room,
        },
      });
    }
    const actorSpecs = input.video.actorFrames ?? [];
    for (let start = 0; start < actorSpecs.length; start += 16) {
      const loaded = await Promise.all(
        actorSpecs.slice(start, start + 16).map(async (frame) => {
          const image = await loadImage(frame.surfaceUrl);
          const surfacePixels = pixels(image, image.width, image.height);
          const count = image.width * image.height;
          const depth = new Uint8Array(count);
          const mask = new Uint8Array(count);
          for (let pixel = 0; pixel < count; pixel++) {
            depth[pixel] = surfacePixels.data[pixel * 4];
            mask[pixel] = surfacePixels.data[pixel * 4 + 3] >= 128 ? 1 : 0;
          }
          return {
            time: frame.time,
            depth,
            mask,
            width: image.width,
            height: image.height,
          };
        }),
      );
      actorFrames.push(...loaded);
    }
    if (
      actorFrames.length ||
      frames.some((frame) => frame.personIndices.length > 0)
    )
      props.unshift({
        id: "moving-person",
        label: "Person",
        group: personGroup,
        movable: false,
      });
    for (const track of input.video.trackedObjects ?? []) {
      const makeTexture = (
        canvasWidth: number,
        canvasHeight: number,
        lid: boolean,
      ) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const context = canvas.getContext("2d");
        if (!context)
          throw new Error("A tracked-object texture could not be created.");
        context.fillStyle = track.color;
        context.fillRect(0, 0, canvasWidth, canvasHeight);
        context.fillStyle = "rgba(255,255,255,.24)";
        if (lid) {
          context.beginPath();
          context.arc(
            canvasWidth / 2,
            canvasHeight / 2,
            canvasWidth * 0.42,
            0,
            Math.PI * 2,
          );
          context.fill();
          context.fillStyle = "rgba(4,28,32,.9)";
          context.font = `bold ${Math.round(canvasWidth * 0.105)}px sans-serif`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(
            track.label.slice(0, 18).toUpperCase(),
            canvasWidth / 2,
            canvasHeight / 2,
          );
        } else {
          for (
            let x = 8;
            x < canvasWidth;
            x += Math.max(80, Math.round(canvasWidth * 0.28))
          ) {
            context.beginPath();
            context.ellipse(
              x,
              canvasHeight / 2,
              canvasHeight * 0.13,
              canvasHeight * 0.3,
              0,
              0,
              Math.PI * 2,
            );
            context.fill();
          }
          context.fillStyle = "rgba(4,28,32,.88)";
          context.font = `bold ${Math.round(canvasHeight * 0.39)}px sans-serif`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(
            track.label.slice(0, 22).toUpperCase(),
            canvasWidth / 2,
            canvasHeight / 2,
          );
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        ownedTrackTextures.push(texture);
        return texture;
      };
      const sideMaterial = new THREE.MeshStandardMaterial({
        map: makeTexture(1024, 256, false),
        metalness: 0.52,
        roughness: 0.3,
      });
      const lidMaterial = new THREE.MeshStandardMaterial({
        map: makeTexture(512, 512, true),
        metalness: 0.36,
        roughness: 0.32,
      });
      const geometry = new THREE.CylinderGeometry(
        track.radius,
        track.radius,
        track.thickness,
        48,
        1,
      );
      ownedTrackGeometry.push(geometry);
      ownedTrackMaterials.push(sideMaterial, lidMaterial);
      const cylinder = new THREE.Mesh(geometry, [
        sideMaterial,
        lidMaterial,
        lidMaterial,
      ]);
      cylinder.castShadow = true;
      cylinder.receiveShadow = true;
      const objectGroup = new THREE.Group();
      objectGroup.name = `Tracked object: ${track.label}`;
      objectGroup.add(cylinder);
      group.add(objectGroup);
      trackedMeshes.push({ spec: track, group: objectGroup });
      props.push({
        id: track.id,
        label: track.label,
        group: objectGroup,
        movable: false,
      });
    }
    const hasIndependentActor =
      actorFrames.length > 0 ||
      frames.some((frame) => frame.personIndices.length > 0);
    if (!hasIndependentActor) {
      // Ordinary video uses its live frame throughout; segmented actors retain their clean plate.
      backdrop.material = material;
      backdrop.name = "Video background";
    }
    const updateBackdrop = () => {
      let propDepth = 0;
      for (const prop of ownedProps) {
        const bounds = new THREE.Box3().setFromObject(prop.group);
        if (!bounds.isEmpty()) propDepth = Math.max(propDepth, -bounds.min.z);
      }
      const projection = hasIndependentActor
        ? createDepthGeometry(frames[0].depth, projectionOptions())
        : createVideoBackdropProjection(
            frames.map((frame) => frame.projection.distances),
            projectionOptions(),
            propDepth,
          );
      if (hasIndependentActor) {
        for (let i = 2; i < projection.positions.length; i += 3)
          projection.positions[i] -= 0.04;
      }
      const positions = backdropGeometry.getAttribute("position");
      if (positions) {
        positions.array.set(projection.positions);
        positions.needsUpdate = true;
      } else {
        backdropGeometry.setAttribute(
          "position",
          new THREE.BufferAttribute(projection.positions, 3),
        );
        backdropGeometry.setAttribute(
          "uv",
          new THREE.BufferAttribute(projection.uvs, 2),
        );
        backdropGeometry.setIndex(
          new THREE.BufferAttribute(projection.indices, 1),
        );
      }
      backdropGeometry.computeBoundingSphere();
    };
    updateBackdrop();
    const currentPositions = frames[0].projection.positions.slice();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(currentPositions, 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    geometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(frames[0].projection.uvs, 2),
    );
    personGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(
        frames[0].projection.positions.slice(),
        3,
      ).setUsage(THREE.DynamicDrawUsage),
    );
    personGeometry.setAttribute("uv", geometry.getAttribute("uv"));
    personGeometry.setIndex(
      new THREE.BufferAttribute(frames[0].personIndices, 1),
    );
    pointGeometry.setAttribute("position", geometry.getAttribute("position"));
    pointGeometry.setAttribute("uv", geometry.getAttribute("uv"));
    let pointMode = false;
    let previousNearest = -1,
      previousMaskFrame = -1,
      previousActorFrame = -1,
      lastTime = -1;
    let previousTrackMask = new Uint8Array(width * height);
    const navigation: Reconstruction["navigation"] = {
      ...videoInspectionNavigation([]),
      front: [0, 1.6, 0],
      frontTarget: [0, 1.6, -4],
      bounds: { min: [-10, 0, -18], max: [10, 5, 4] },
      obstacles: [],
    };
    const times = input.video.frames.map((frame) => frame.time);
    const actorTimes = actorFrames.map((frame) => frame.time);
    let actorProjection: ReturnType<typeof createDepthGeometry> | undefined;
    let actorPositionAttribute = personGeometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    let actorMaskForVisibility: Uint8Array | undefined;
    const updateTrackedObjects = (time: number) => {
      const halfHeight = Math.tan(
        THREE.MathUtils.degToRad(input.fov ?? 60) / 2,
      );
      for (const tracked of trackedMeshes) {
        const pose = videoTrackedPose(tracked.spec, time);
        tracked.group.visible = pose.visible && !pointMode;
        tracked.group.position.set(
          (pose.u * 2 - 1) * halfHeight * aspect * pose.depth,
          (1 - pose.v * 2) * halfHeight * pose.depth + 1.6,
          -pose.depth,
        );
        tracked.group.rotation.set(
          Math.PI / 2 + pose.rotation[0],
          pose.rotation[1],
          pose.rotation[2],
        );
      }
    };
    const updateTime = (time: number) => {
      if (time === lastTime) return;
      lastTime = time;
      const blend = videoFrameBlend(times, time);
      interpolateVideoPositions(
        frames[blend.from].projection.positions,
        frames[blend.to].projection.positions,
        blend.amount,
        currentPositions,
      );
      geometry.getAttribute("position").needsUpdate = true;
      if (!actorFrames.length) {
        interpolateVideoPositions(
          frames[blend.from].projection.positions,
          frames[blend.to].projection.positions,
          blend.amount,
          actorPositionAttribute.array as Float32Array,
        );
        actorPositionAttribute.needsUpdate = true;
      }
      if (previousNearest !== blend.nearest) {
        previousNearest = blend.nearest;
        frames.forEach((frame, i) => {
          frame.props.visible = !pointMode && i === blend.nearest;
        });
        Object.assign(
          navigation,
          videoInspectionNavigation(
            frames[blend.nearest].placements.map(({ item, subject }) => ({
              group: item.group,
              box: subject.box,
            })),
          ),
        );
      }
      const frame = frames[blend.nearest];
      const actorBlend = actorFrames.length
        ? videoFrameBlend(actorTimes, time)
        : undefined;
      const actorIndex = actorBlend?.nearest ?? -1;
      const actorFrame = actorIndex >= 0 ? actorFrames[actorIndex] : undefined;
      const actorChanged = !!actorFrame && actorIndex !== previousActorFrame;
      let personMask = frame.personMask;
      let personMaskWidth = width;
      let personMaskHeight = height;
      if (actorChanged && actorFrame) {
        actorProjection = createDepthGeometry(
          {
            width: actorFrame.width,
            height: actorFrame.height,
            data: actorFrame.depth,
          },
          projectionOptions(),
        );
        separateVideoActorFromBackdrop(actorProjection.positions);
        if (
          actorPositionAttribute.array.length ===
          actorProjection.positions.length
        ) {
          (actorPositionAttribute.array as Float32Array).set(
            actorProjection.positions,
          );
          actorPositionAttribute.needsUpdate = true;
        } else {
          actorPositionAttribute = new THREE.BufferAttribute(
            actorProjection.positions.slice(),
            3,
          ).setUsage(THREE.DynamicDrawUsage);
          personGeometry.setAttribute("position", actorPositionAttribute);
        }
        if (
          personGeometry.getAttribute("uv").array.length !==
          actorProjection.uvs.length
        )
          personGeometry.setAttribute(
            "uv",
            new THREE.BufferAttribute(actorProjection.uvs, 2),
          );
        actorMaskForVisibility = actorFrame.mask;
        personMask = actorFrame.mask;
        personMaskWidth = actorFrame.width;
        personMaskHeight = actorFrame.height;
        previousActorFrame = actorIndex;
      }
      if (actorFrame) {
        personMask = actorFrame.mask;
        personMaskWidth = actorFrame.width;
        personMaskHeight = actorFrame.height;
      }
      const trackMask = new Uint8Array(width * height);
      for (const track of input.video.trackedObjects ?? []) {
        const mask = videoTrackMask(
          track,
          time,
          width,
          height,
          input.fov ?? 60,
          aspect,
        );
        for (let i = 0; i < trackMask.length; i++)
          if (mask[i]) trackMask[i] = 1;
      }
      const roomPersonMask = actorFrame
        ? resizeBinaryMask(
            personMask,
            personMaskWidth,
            personMaskHeight,
            width,
            height,
          )
        : personMask;
      const actorTrackMask = actorFrame
        ? new Uint8Array(personMaskWidth * personMaskHeight)
        : trackMask;
      if (actorFrame)
        for (const track of input.video.trackedObjects ?? []) {
          const mask = videoTrackMask(
            track,
            time,
            personMaskWidth,
            personMaskHeight,
            input.fov ?? 60,
            aspect,
          );
          for (let i = 0; i < actorTrackMask.length; i++)
            if (mask[i]) actorTrackMask[i] = 1;
        }
      let maskChanged = previousMaskFrame !== blend.nearest || actorChanged;
      if (!maskChanged)
        for (let i = 0; i < trackMask.length; i++)
          if (trackMask[i] !== previousTrackMask[i]) {
            maskChanged = true;
            break;
          }
      if (maskChanged) {
        const objects = Uint8Array.from(frame.objectMask);
        for (let i = 0; i < objects.length; i++)
          if (trackMask[i]) objects[i] = 1;
        const roomPartition = partitionVideoTriangles(
          frame.fullIndices,
          roomPersonMask,
          objects,
        );
        writeDynamicIndices(
          geometry,
          roomPartition.room,
          frame.fullIndices.length,
        );
        if (actorFrame && actorProjection) {
          const actorObjects = Uint8Array.from(actorTrackMask);
          const actorPartition = partitionVideoTriangles(
            actorProjection.indices,
            personMask,
            actorObjects,
          );
          writeDynamicIndices(
            personGeometry,
            actorPartition.person,
            actorProjection.indices.length,
          );
          personSurface.visible =
            !pointMode && actorPartition.person.length > 0;
        } else {
          const sparsePartition = partitionVideoTriangles(
            frame.fullIndices,
            personMask,
            objects,
          );
          writeDynamicIndices(
            personGeometry,
            sparsePartition.person,
            frame.fullIndices.length,
          );
          personSurface.visible =
            !pointMode && sparsePartition.person.length > 0;
        }
        actorPositionAttribute.needsUpdate = true;
        personGeometry.computeBoundingSphere();
        // Point view hides replacement solids, so retain every photographed pixel.
        // Actor/object cutouts only apply to the solid meshes above.
        previousMaskFrame = blend.nearest;
        previousTrackMask = trackMask;
      }
      updateTrackedObjects(time);
      geometry.computeBoundingSphere();
      pointGeometry.boundingSphere = geometry.boundingSphere;
      if (!actorFrames.length)
        personGeometry.boundingSphere = geometry.boundingSphere;
    };
    updateTime(0);
    return {
      group,
      surface,
      props,
      navigation,
      updateTime,
      setStrength(value) {
        strength = THREE.MathUtils.clamp(value, 0.1, 3);
        for (const frame of frames) {
          const fullProjection = createDepthGeometry(
            frame.depth,
            projectionOptions(),
          );
          const partition = partitionVideoTriangles(
            fullProjection.indices,
            frame.personMask,
            frame.objectMask,
          );
          frame.projection = { ...fullProjection, indices: partition.room };
          frame.personIndices = partition.person;
          frame.fullIndices = fullProjection.indices;
          for (const { item, subject, mask } of frame.placements) {
            const placement = placeMemoryProp({
              ...projectionOptions(),
              object: subject.object!,
              box: subject.box,
              depth: frame.depth,
              mask,
            });
            item.group.position.fromArray(placement.position);
            item.group.scale.setScalar(placement.scale);
          }
        }
        updateBackdrop();
        const time = lastTime;
        lastTime = -1;
        previousNearest = -1;
        previousMaskFrame = -1;
        previousActorFrame = -1;
        updateTime(time);
      },
      setPointMode(enabled) {
        pointMode = enabled;
        surface.visible = !enabled;
        backdrop.visible = !enabled;
        personSurface.visible =
          !enabled &&
          (actorMaskForVisibility
            ? actorMaskForVisibility.some((value) => value > 0)
            : previousNearest >= 0 &&
              frames[previousNearest].personIndices.length > 0);
        points.visible = enabled;
        updateTrackedObjects(lastTime < 0 ? 0 : lastTime);
        frames.forEach((frame, i) => {
          frame.props.visible = !enabled && i === previousNearest;
        });
      },
      setTexture(texture) {
        material.map = texture;
        material.needsUpdate = true;
        pointMaterial.uniforms.image.value = texture;
      },
      hasBodyShapes: false,
      setBodyShape: async () => false,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
