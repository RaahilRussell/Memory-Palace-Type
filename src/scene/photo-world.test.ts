import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as THREE from "three";
import { buildReconstruction } from "./volume-world";
import { HUMAN_POSE_LANDMARK_NAMES, type HumanPose } from "../types";
import { isHumanPose } from "../human-pose-validation";
import { assessPoseSupport } from "../pose-intent";

function supportedFixturePose(): HumanPose {
  const joints: Record<number, number[]> = {
    0: [0, .69, .04], 2: [-.033, .72, .03], 5: [.033, .72, .03],
    7: [-.08, .7, 0], 8: [.08, .7, 0],
    11: [-.195, .46, 0], 12: [.195, .46, 0],
    13: [-.25, .18, .02], 14: [.25, .18, .02],
    15: [-.27, -.07, .04], 16: [.27, -.07, .04],
    23: [-.103, 0, 0], 24: [.103, 0, 0],
    25: [-.11, -.415, .02], 26: [.11, -.415, .02],
    27: [-.12, -.82, 0], 28: [.12, -.82, 0],
    29: [-.12, -.87, -.03], 30: [.12, -.87, -.03],
    31: [-.12, -.88, .14], 32: [.12, -.88, .14],
  };
  return {
    version: 1, source: "mediapipe-pose", model: "pose-landmarker-full",
    confidence: .95, observedFraction: 1, sourceBox: [.1, .05, .9, .5],
    landmarks: HUMAN_POSE_LANDMARK_NAMES.map((name, i) => {
      const [x, y, z] = joints[i] ?? [0, .69, 0];
      return { name, image: [.275 + x * .4, .45 - y * .4, -z * .4],
        world: [x, -y, -z], visibility: .98, presence: .99 };
    }),
  };
}

const heldFixtureProp = (u: number, v: number) => u >= .24 && u < .255 && v >= .12 && v < .205;
const fixturePatterns = {
  head: [[220, 40, 210], [20, 180, 230]],
  torso: [[25, 55, 230], [240, 200, 20]],
} as const;
function posedFixtureColor(u: number, v: number) {
  if (heldFixtureProp(u, v)) return [0, 255, 0, 255];
  // Small, contrasting two-colour marks cannot be reproduced by either
  // region's dominant fallback palette (brown skin and blue-grey clothing).
  if (u >= .265 && u < .285 && v >= .14 && v < .17) return [...fixturePatterns.head[0], 255];
  if (u >= .285 && u < .305 && v >= .18 && v < .21) return [...fixturePatterns.head[1], 255];
  if (u >= .255 && u < .285 && v >= .33 && v < .37) return [...fixturePatterns.torso[0], 255];
  if (u >= .29 && u < .31 && v >= .37 && v < .4) return [...fixturePatterns.torso[1], 255];
  return v >= .28 && v < .65 ? [75, 95, 115, 255] : [160, 110, 75, 255];
}

function mockPhotoWorld(t: TestContext, options: { failedPersonMask?: boolean; generatedBackground?: boolean;
  sofaTracingPerson?: boolean; posedPerson?: boolean; heldProp?: boolean } = {}) {
  const requests: string[] = [];
  const unexpectedRequests: string[] = [];
  const globals = [
    "Image",
    "HTMLImageElement",
    "ImageData",
    "document",
  ] as const;
  const previous = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  t.after(() =>
    globals.forEach((name, i) => {
      if (previous[i]) Object.defineProperty(globalThis, name, previous[i]!);
      else Reflect.deleteProperty(globalThis, name);
    }),
  );
  class FixtureImage {
    width = options.posedPerson ? 96 : 16;
    height = this.width;
    naturalWidth = this.width;
    naturalHeight = this.height;
    kind = "";
    onload: (() => void) | null = null;
    set src(value: string) {
      this.kind = value;
      queueMicrotask(() => this.onload?.());
    }
  }
  class FixturePixels {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
    ) {}
  }
  for (const name of ["Image", "HTMLImageElement"])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: FixtureImage,
    });
  Object.defineProperty(globalThis, "ImageData", {
    configurable: true,
    value: FixturePixels,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        let image: FixtureImage | undefined;
        let stored: FixturePixels | undefined;
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: (value: FixtureImage) => {
              image = value;
            },
            putImageData: (data: FixturePixels) => {
              stored = data;
            },
            getImageData: (
              _x: number,
              _y: number,
              width: number,
              height: number,
            ) => {
              const data = new Uint8ClampedArray(width * height * 4);
              for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                  const u = (x + .5) / width, v = (y + .5) / height;
                  const isPerson = options.posedPerson
                    ? (u >= .24 && u < .32 && v >= .1 && v < .28) ||
                      (u >= .1 && u < .45 && v >= .28 && v < .65) ||
                      ((u >= .14 && u < .26 || u >= .32 && u < .44) && v >= .65 && v < .9)
                    : u >= .05 && u < .5 && v >= .1 && v < .9;
                  const maskValue = image?.kind === "image/person-mask" ? Number(isPerson) * 255 :
                    image?.kind === "image/box-mask" ? Number(options.heldProp ? heldFixtureProp(u, v) :
                      u >= .65 && u < .85 && v >= .2 && v < .4) * 255 :
                    image?.kind === "image/chair-mask" ? Number(options.sofaTracingPerson ? isPerson :
                      u >= .6 && u < .95 && v >= .55 && v < .9) * 255 : undefined;
                  const sourceColor = options.posedPerson
                    ? posedFixtureColor(u, v)
                    : [80 + x * 3, 60 + y * 4, 40 + x, 255];
                  data.set(maskValue === undefined ? sourceColor :
                    [maskValue, maskValue, maskValue, 255], (y * width + x) * 4);
                }
              return stored ?? { data, width, height };
            },
          }),
        };
      },
    },
  });
  t.mock.method(URL, "createObjectURL", (blob: Blob) => blob.type);
  t.mock.method(URL, "revokeObjectURL", () => {});
  const imageKinds = new Map([
    ["/source.jpg", "image/source"], ["/depth.png", "image/depth"],
    ["/uploads/reconstructions/person-mask.png", "image/person-mask"],
    ["/uploads/reconstructions/chair-mask.png", "image/chair-mask"],
    ["/uploads/reconstructions/mask.png", "image/box-mask"],
    ["/uploads/reconstructions/background.jpg", "image/generated-background"],
  ]);
  const templateFailures = new Set(["slim", "average", "broad"].map(shape => `/models/human/${shape}.glb`));
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (templateFailures.has(url)) return new Response("Synthetic fixture: optional template unavailable", { status: 503 });
    if (url !== "/world.json" && !imageKinds.has(url)) {
      unexpectedRequests.push(url);
      throw new Error(`Unexpected fixture network request: ${url}`);
    }
    return url === "/world.json"
      ? Response.json({
          version: 1,
          generatedBy: "local-segmentation",
          textureSource: options.generatedBackground ? "gemini" : "source-inpaint",
          backgroundUrl: "/uploads/reconstructions/background.jpg",
          subjects: [
            {
              id: "unposed-person", label: "seated person", kind: "person",
              box: [0.1, 0.05, 0.9, 0.5], maskUrl: "/uploads/reconstructions/person-mask.png",
              ...(options.posedPerson ? { humanPose: supportedFixturePose() } : {}),
            },
            {
              id: "box",
              label: "box",
              kind: "object",
              box: options.heldProp ? [.12, .24, .205, .255] : [0.2, 0.65, 0.4, 0.85],
              maskUrl: "/uploads/reconstructions/mask.png",
              object: {
                category: "box",
                confidence: 0.9,
                color: "#808080",
                dimensions: [0.3, 0.3, 0.3],
              },
            },
            {
              id: "chair", label: options.sofaTracingPerson ? "sofa" : "chair", kind: "object",
              box: options.sofaTracingPerson ? [0.1, 0.05, 0.9, 0.5] : [0.55, 0.6, 0.9, 0.95],
              maskUrl: "/uploads/reconstructions/chair-mask.png",
              object: { category: options.sofaTracingPerson ? "sofa" : "chair", confidence: .95,
                color: "#808080", dimensions: [.5, .9, .5] },
            },
          ],
        })
      : options.failedPersonMask && url.endsWith("person-mask.png")
      ? new Response("Missing mask", { status: 404 })
      : new Response(
          new Blob([], {
            type: imageKinds.get(url)!,
          }),
        );
  });
  t.after(() => assert.deepEqual(unexpectedRequests, [], "the fixture must never contact models or external services"));
  return { requests, unexpectedRequests };
}

test("photo fidelity is default and mode changes cannot restore hidden props or collisions", async (t) => {
  mockPhotoWorld(t);
  const world = await buildReconstruction({
    sourceUrl: "/source.jpg",
    depthUrl: "/depth.png",
    completionUrl: "/world.json",
  });
  try {
    const photo = world.group.getObjectByName("Photo fidelity surfaces")!;
    const cloud = world.group.children.find(
      (item) => item instanceof THREE.Points,
    )!;
    assert.equal(world.hasPhotoMode, true);
    assert.equal(photo.visible, true);
    assert.equal(world.props.length, 2);
    assert.equal(world.props[0].movable, true);
    assert.equal(world.props[1].movable, false, 'furniture is classified but cannot be picked up like a handheld prop');
    assert.equal(world.group.userData.detectedPeople, 1);
    assert.equal(world.group.userData.retainedPeople, 1);
    assert.equal(world.group.userData.completedBodies, 0, 'an unposed seated person is not replaced by standing anatomy');
    const initialSourceView = [...world.navigation.front];
    assert.equal(world.props[0].group.visible, false);
    assert.equal(
      world.surface.visible,
      true,
      "interaction surface follows the visible photo",
    );
    assert.deepEqual(world.navigation.obstacles, []);
    assert.equal(world.navigation.front[0], 0);
    assert.equal(world.navigation.front[2], 0);
    world.setPointMode(true);
    assert.equal(
      (cloud as THREE.Points).geometry.getAttribute("position").array,
      world.surface.geometry.getAttribute("position").array,
      "point rendering preserves photographic depth and spacing",
    );
    world.setPointMode(false);
    world.setPhotoMode!(false);
    assert.equal(photo.visible, false);
    assert.equal(world.surface.visible, true, 'unreplaced people and scene context remain photographed');
    const inferredFloor = world.group.getObjectByName("Photographic ground with metre-scale detail") as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    assert.equal(inferredFloor.material.depthWrite, false, 'an inferred floor cannot erase photographed people or ground details');
    assert.ok(inferredFloor.renderOrder < world.surface.renderOrder);
    assert.equal(world.props[0].group.visible, true);
    assert.ok(world.navigation.obstacles!.length > 0);
    world.setPointMode(true);
    world.setStrength(1.7);
    assert.deepEqual(world.navigation.front, initialSourceView, 'depth changes preserve the capture origin');
    assert.equal(cloud.visible, true);
    assert.equal(world.props[0].group.visible, false);
    world.setPhotoMode!(true);
    assert.equal(photo.visible, false, "point view takes precedence");
    world.setPointMode(false);
    assert.equal(photo.visible, true);
    assert.equal(world.props[0].group.visible, false);
    assert.deepEqual(world.navigation.obstacles, []);
    world.setPhotoMode!(false);
    assert.equal(world.props[0].group.visible, true);
    assert.ok(world.navigation.obstacles!.length > 0);
  } finally {
    world.dispose();
  }
});

test("failed subject masks cannot enable an atlas that already erased the missing person", async (t) => {
  mockPhotoWorld(t, { failedPersonMask: true, generatedBackground: true });
  const world = await buildReconstruction({ sourceUrl: "/source.jpg", depthUrl: "/depth.png", completionUrl: "/world.json" });
  try {
    world.setPhotoMode!(false);
    const surface = world.surface as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    assert.equal(world.props.length, 2, "the other accepted props still load");
    assert.notEqual(surface.material.map!.image.kind, "image/generated-background",
      "missing person must remain in the source-derived context even when every loaded mask is replaced");
    assert.equal(typeof surface.material.map!.image.getContext, "function", "selective source inpainting supplies the context");
  } finally { world.dispose(); }
});

test("ownership rejection precedes prop creation and both person and background removal", async (t) => {
  mockPhotoWorld(t, { sofaTracingPerson: true, generatedBackground: true });
  const world = await buildReconstruction({ sourceUrl: "/source.jpg", depthUrl: "/depth.png", completionUrl: "/world.json" });
  try {
    assert.equal(world.group.userData.bodyPhotoSource, "original-rgb-with-validity-mask");
    assert.deepEqual(world.props.map(prop => prop.id), ["box"]);
    const ownership = world.group.userData.objectMaskOwnership.decisions.find((item: { id: string }) => item.id === "chair");
    assert.equal(ownership.reason, "person-overlap");
    assert.equal(world.group.userData.retainedPeople, 1, "weak-pose people are protected too");
    const inventory = world.group.userData.objectInventory.find((item: { id: string }) => item.id === "chair");
    assert.equal(inventory.category, "sofa");
    assert.equal(inventory.geometryUnsupportedReason, "person-overlap");
    assert.equal(inventory.representation, "photographed");
    world.setPhotoMode!(false);
    const surface = world.surface as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    const photo = surface.material.map!.image;
    assert.notEqual(photo.kind, "image/generated-background", "cached atlas that erased this person is not reused");
    const pixels = photo.getContext("2d").getImageData(0, 0, 16, 16).data;
    assert.deepEqual(Array.from(pixels.slice((8 * 16 + 4) * 4, (8 * 16 + 4) * 4 + 4)),
      [92, 92, 44, 255], "rejected sofa cannot inpaint original person RGB");
    world.setStrength(1.7);
    assert.deepEqual(world.props.map(prop => prop.id), ["box"], "settings cannot restore rejected geometry");
  } finally { world.dispose(); }
});

test("reopening saved completion replays ownership without restoring cached erasure", async (t) => {
  mockPhotoWorld(t, { sofaTracingPerson: true, generatedBackground: true });
  const results = [];
  for (let pass = 0; pass < 2; pass++) {
    const world = await buildReconstruction({ sourceUrl: "/source.jpg", depthUrl: "/depth.png", completionUrl: "/world.json" });
    try {
      world.setPhotoMode!(false);
      const surface = world.surface as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      assert.notEqual(surface.material.map!.image.kind, "image/generated-background");
      results.push({ ownership: world.group.userData.objectMaskOwnership,
        inventory: world.group.userData.objectInventory, props: world.props.map(prop => prop.id),
        pixels: Array.from(surface.material.map!.image.getContext("2d").getImageData(0, 0, 16, 16).data) });
    } finally { world.dispose(); }
  }
  assert.deepEqual(results[1], results[0]);
});

test("a posed live-world fallback separates fitting silhouette from accepted-prop texture validity", async (t) => {
  const pose = supportedFixturePose();
  assert.equal(isHumanPose(pose), true);
  assert.equal(assessPoseSupport(pose).canReplace, true);
  const options = { posedPerson: true, heldProp: false, sofaTracingPerson: true, generatedBackground: true };
  const network = mockPhotoWorld(t, options);
  const snapshots: { headPositions: number[]; headBounds: number[]; headTexture: Uint8Array;
    torsoTexture: Uint8Array; greenSamples: number }[] = [];
  // First demonstrate that the synthetic green prop reaches a body texture
  // without its exclusion; then admit it, and finally remove the rejected sofa
  // detection. Every pass goes through buildReconstruction, not helper mocks.
  for (const [heldProp, sofaTracingPerson] of [[false, true], [true, true], [true, false]]) {
    options.heldProp = heldProp;
    options.sofaTracingPerson = sofaTracingPerson;
    const world = await buildReconstruction({ sourceUrl: "/source.jpg", depthUrl: "/depth.png", completionUrl: "/world.json" });
    try {
      assert.equal(world.group.userData.completedBodies, 1, "the supported person must execute body building");
      assert.equal(world.group.userData.retainedPeople, 0);
      const body = world.group.children.find(child => child.userData.kind === "complete-human")!;
      assert.ok(body);
      assert.equal(body.userData.poseTemplateFallback, true, "the explicit model failure must reach procedural posing");
      assert.equal(body.userData.humanPoseFitted, true);
      const box = world.group.userData.objectMaskOwnership.decisions.find((item: { id: string }) => item.id === "box");
      assert.equal(box.accepted, true, "a small held prop stays reconstructable");
      if (sofaTracingPerson) {
        const sofa = world.group.userData.objectMaskOwnership.decisions.find((item: { id: string }) => item.id === "chair");
        assert.equal(sofa.reason, "person-overlap");
        assert.equal(world.props.some(prop => prop.id === "chair"), false);
        world.setPhotoMode!(false);
        const material = world.surface.material as THREE.MeshBasicMaterial;
        assert.notEqual(material.map!.image.kind, "image/generated-background");
      }
      const head = body.getObjectByName("head") as THREE.Mesh;
      const torso = body.getObjectByName("shirt-torso") as THREE.Mesh;
      const textureBytes = (mesh: THREE.Mesh) => {
        const texture = (mesh.material as THREE.MeshStandardMaterial).map as THREE.DataTexture;
        assert.ok(texture?.isDataTexture, `${mesh.name} must have an actual baked photograph texture`);
        return Uint8Array.from(texture.image.data as ArrayLike<number>);
      };
      const headTexture = textureBytes(head), torsoTexture = textureBytes(torso);
      let greenSamples = 0;
      for (const data of [headTexture, torsoTexture]) for (let i = 0; i < data.length; i += 4) {
        if (data[i + 1] > data[i] + 50 && data[i + 1] > data[i + 2] + 50) greenSamples++;
      }
      head.geometry.computeBoundingBox();
      snapshots.push({ headPositions: Array.from(head.geometry.getAttribute("position").array),
        headBounds: [...head.geometry.boundingBox!.min.toArray(), ...head.geometry.boundingBox!.max.toArray()],
        headTexture, torsoTexture, greenSamples });
    } finally { world.dispose(); }
  }
  assert.ok(snapshots[0].greenSamples > 0, "the control must prove the source prop can contaminate this exact body path");
  assert.equal(snapshots[1].greenSamples, 0, "accepted prop RGB cannot be baked onto the posed body");
  const assertObservedPatterns = (textures: Pick<typeof snapshots[number], "headTexture" | "torsoTexture">) => {
    const counts = { head: [0, 0], torso: [0, 0] };
    for (const region of ["head", "torso"] as const) {
      const data = textures[`${region}Texture`];
      for (let i = 0; i < data.length; i += 4) for (const [mark, rgb] of fixturePatterns[region].entries())
        if (rgb.every((channel, c) => data[i + c] === channel)) counts[region][mark]++;
      assert.ok(counts[region].every(count => count >= 8),
        `${region} must independently retain both original pattern colours; observed counts: ${counts[region]}`);
    }
    return counts;
  };
  const counts = assertObservedPatterns(snapshots[1]);
  t.diagnostic(`Original pattern texels: head ${counts.head.join("/")}; torso ${counts.torso.join("/")}`);
  // Output-only negative controls prove the assertion fails if either body
  // region loses its photograph, even while the other region stays intact.
  // A single sampled source colour is still a flat palette, not its pattern.
  for (const region of ["head", "torso"] as const) {
    const flattened = snapshots[1][`${region}Texture`].slice();
    for (let i = 0; i < flattened.length; i += 4) flattened.set([...fixturePatterns[region][0], 255], i);
    assert.throws(() => assertObservedPatterns({ ...snapshots[1], [`${region}Texture`]: flattened }),
      new RegExp(`${region} must independently retain both original pattern colours`));
  }
  assert.deepEqual(snapshots[1].headPositions, snapshots[0].headPositions,
    "texture-validity holes at the face edge cannot reshape the original fitting silhouette");
  assert.deepEqual(snapshots[1].headBounds, snapshots[0].headBounds);
  assert.deepEqual(snapshots[1].headTexture, snapshots[2].headTexture,
    "a rejected sofa detection cannot change the actual observed head texture");
  assert.deepEqual(snapshots[1].torsoTexture, snapshots[2].torsoTexture,
    "a rejected sofa detection cannot erase original torso RGB");
  assert.ok(network.requests.some(url => url.startsWith("/models/human/")), "the template fallback must actually be exercised");
  assert.deepEqual(network.unexpectedRequests, []);
});
