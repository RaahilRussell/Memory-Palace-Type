import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  buildVideoReconstruction,
  createVideoBackdropProjection,
  interpolateVideoPositions,
  partitionVideoTriangles,
  videoTrackMask,
  videoTrackedPose,
  videoFrameBlend,
  separateVideoActorFromBackdrop,
  videoInspectionNavigation,
} from "./video-world";
import { createDepthGeometry } from "./reconstruction";

test("video foreground masks separate actor triangles from the room", () => {
  const result = partitionVideoTriangles(
    new Uint32Array([0, 1, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    new Uint8Array([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]),
    new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 0]),
  );
  assert.deepEqual(Array.from(result.person), [0, 1, 2]);
  assert.deepEqual(Array.from(result.room), [7, 8, 9]);
  assert.throws(
    () =>
      partitionVideoTriangles(
        new Uint32Array([0, 1, 2]),
        new Uint8Array(2),
        new Uint8Array(2),
      ),
    /masks and triangles must match/,
  );
});

test("tracked video tins follow interpolated camera-space keyframes", () => {
  const track = {
    id: "mint-tin",
    label: "Mints",
    kind: "circular-tin" as const,
    radius: 0.03,
    thickness: 0.012,
    color: "#25c8c2",
    keyframes: [
      {
        time: 1,
        u: 0.4,
        v: 0.6,
        depth: 5,
        rotation: [0, 0, 0] as [number, number, number],
      },
      {
        time: 3,
        u: 0.8,
        v: 0.2,
        depth: 2,
        rotation: [1, 0.5, 0] as [number, number, number],
      },
      { time: 4, u: 0.8, v: 0.2, depth: 2, visible: false },
    ],
  };
  assert.deepEqual(videoTrackedPose(track, 0).visible, false);
  const mid = videoTrackedPose(track, 2);
  assert.equal(mid.visible, true);
  assert.ok(Math.abs(mid.u - 0.6) < 1e-8);
  assert.equal(mid.v, 0.4);
  assert.equal(mid.depth, 3.5);
  assert.deepEqual(mid.rotation, [0.5, 0.25, 0]);
  assert.deepEqual(videoTrackedPose(track, 5).u, 0.8);
  assert.equal(videoTrackedPose(track, 4).visible, false);
  assert.equal(videoTrackMask(track, 4, 128, 128, 60, 1).some(Boolean), false);
  const mask = videoTrackMask(track, 2, 128, 128, 60, 1);
  assert.ok(mask.some(Boolean));
  const indices = Array.from(mask, (value, index) =>
    value ? index : -1,
  ).filter((x) => x >= 0);
  const meanX =
    indices.reduce((sum, i) => sum + (i % 128), 0) / indices.length / 128;
  const meanY =
    indices.reduce((sum, i) => sum + Math.floor(i / 128), 0) /
    indices.length /
    128;
  assert.ok(Math.abs(meanX - 0.6) < 0.03);
  assert.ok(Math.abs(meanY - 0.4) < 0.03);
});

test("video playback, reverse scrubbing and looping select the correct depth samples", () => {
  const times = [0, 2, 4, 5.9];
  assert.deepEqual(videoFrameBlend(times, 1), {
    from: 0,
    to: 1,
    amount: 0.5,
    nearest: 1,
  });
  assert.deepEqual(videoFrameBlend(times, 3), {
    from: 1,
    to: 2,
    amount: 0.5,
    nearest: 2,
  });
  assert.equal(videoFrameBlend(times, 1.2).nearest, 1);
  assert.equal(videoFrameBlend(times, 0.2).nearest, 0);
  assert.deepEqual(videoFrameBlend(times, 10), {
    from: 3,
    to: 3,
    amount: 0,
    nearest: 3,
  });
  for (const time of [0, -10, NaN])
    assert.deepEqual(videoFrameBlend(times, time), {
      from: 0,
      to: 0,
      amount: 0,
      nearest: 0,
    });
});

test("moving geometry interpolates nearby surfaces while cutting depth discontinuities", () => {
  const a = Float32Array.of(1, 2, -3, 1, 2, -3);
  const b = Float32Array.of(2, 3, -3.3, 8, 9, -12);
  const output = new Float32Array(a.length);
  interpolateVideoPositions(a, b, 0.25, output);
  assert.equal(output[0], 1.25);
  assert.equal(output[1], 2.25);
  assert.ok(Math.abs(output[2] - -3.075) < 1e-6);
  assert.deepEqual(Array.from(output.slice(3)), [1, 2, -3]);
  interpolateVideoPositions(a, b, 0.75, output);
  assert.deepEqual(Array.from(output.slice(3)), [8, 9, -12]);
  assert.notDeepEqual(
    Array.from(output),
    Array.from(a),
    "time must actually change geometry",
  );
  interpolateVideoPositions(a, b, 0, output);
  assert.deepEqual(output, a);
  interpolateVideoPositions(a, b, 1, output);
  assert.deepEqual(output, b);
  assert.throws(
    () => interpolateVideoPositions(a, b.slice(0, 3), 0.5, output),
    /must match/,
  );
});

test("dense actor depth stays camera-aligned while sitting forward of the clean plate", () => {
  const source = Float32Array.of(1.2, 2.1, -4, -0.8, 3.2, -8);
  const projected = separateVideoActorFromBackdrop(source.slice(), 0.65);
  assert.ok(Math.abs(-projected[2] - 3.35) < 1e-6);
  assert.ok(Math.abs(-projected[5] - 7.35) < 1e-6);
  assert.ok(
    Math.abs(projected[0] / -projected[2] - source[0] / -source[2]) < 1e-6,
  );
  assert.ok(
    Math.abs(
      (projected[1] - 1.6) / -projected[2] - (source[1] - 1.6) / -source[2],
    ) < 1e-6,
  );
  assert.throws(
    () => separateVideoActorFromBackdrop(source.slice(), -1),
    /invalid/,
  );
});

test("video backing covers the source rays behind every sample and prop without changing foreground depth", () => {
  const depth = (value: number) => ({
    width: 2,
    height: 2,
    data: new Uint8Array(16).fill(value),
  });
  for (const strength of [0.35, 1.25, 2]) {
    const options = {
      near: 2,
      far: 12,
      fov: 60,
      aspect: 9 / 16,
      cameraHeight: 1.3,
      strength,
    };
    const samples = [
      createDepthGeometry(depth(128), options),
      createDepthGeometry(depth(0), options),
    ];
    const snapshots = samples.map((sample) => ({
      positions: sample.positions.slice(),
      indices: sample.indices.slice(),
      distances: sample.distances.slice(),
    }));
    for (const propDepth of [0, 30]) {
      const backing = createVideoBackdropProjection(
        samples.map((sample) => sample.distances),
        options,
        propDepth,
      );
      assert.equal(backing.positions.length, 12);
      assert.equal(
        backing.indices.length,
        6,
        "two triangles cover the complete source image",
      );
      for (const distance of backing.distances) {
        assert.ok(distance > propDepth);
        assert.ok(
          samples.every((sample) =>
            sample.distances.every((foreground) => distance > foreground),
          ),
        );
      }
      for (let i = 0; i < 4; i++) {
        const distance = -backing.positions[i * 3 + 2];
        const halfHeight = Math.tan((options.fov * Math.PI) / 360);
        const u =
          (backing.positions[i * 3] / (halfHeight * options.aspect * distance) +
            1) /
          2;
        const v =
          ((backing.positions[i * 3 + 1] - options.cameraHeight) /
            (halfHeight * distance) +
            1) /
          2;
        assert.ok(Math.abs(u - backing.uvs[i * 2]) < 1e-6);
        assert.ok(Math.abs(v - backing.uvs[i * 2 + 1]) < 1e-6);
      }
    }
    samples.forEach((sample, i) => {
      assert.deepEqual(sample.positions, snapshots[i].positions);
      assert.deepEqual(sample.indices, snapshots[i].indices);
      assert.deepEqual(sample.distances, snapshots[i].distances);
    });
  }
});

test("video inspection frames the largest photographed prop using its transformed bounds", () => {
  const prominent = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.6, 0.2),
    new THREE.MeshBasicMaterial(),
  );
  mesh.position.y = 0.1;
  prominent.add(mesh);
  prominent.position.set(-0.2, 1, -0.6);
  prominent.rotation.y = 0.4;
  const distant = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshBasicMaterial(),
  );
  distant.position.set(2, 1.6, -10);
  const props = [
    { group: distant, box: [0, 0, 0.1, 0.1] },
    { group: prominent, box: [0.2, 0.2, 0.8, 0.8] },
  ];
  try {
    for (const scale of [1, 2]) {
      prominent.scale.setScalar(scale);
      const navigation = videoInspectionNavigation(props);
      const sphere = new THREE.Box3()
        .setFromObject(prominent)
        .getBoundingSphere(new THREE.Sphere());
      assert.deepEqual(navigation.target, sphere.center.toArray());
      for (const view of [navigation.side, navigation.behind]) {
        const origin = new THREE.Vector3(...view);
        const distance = origin.distanceTo(sphere.center);
        assert.ok(distance >= 0.8 && distance >= sphere.radius * 3 - 1e-9);
        assert.ok(
          distance < 3,
          "small nearby props should fill the inspection view, not remain metres away",
        );
        const ray = new THREE.Raycaster(
          origin,
          sphere.center.clone().sub(origin).normalize(),
        );
        assert.ok(
          ray.intersectObject(prominent, true).length > 0,
          "each preset must aim at visible prop geometry",
        );
      }
    }
    assert.deepEqual(videoInspectionNavigation([]), {
      target: [0, 1.6, -4],
      side: [4, 1.6, -4],
      behind: [0, 1.6, -8],
    });
  } finally {
    mesh.geometry.dispose();
    mesh.material.dispose();
    distant.geometry.dispose();
    distant.material.dispose();
  }
});

test("video point view retains prop pixels and hides solid props through seeks and depth changes", async (t) => {
  // Supply deterministic image pixels at the browser boundary; build real Three.js
  // geometry and category meshes so this checks what each view actually renders.
  const globals = ["Image", "document"] as const;
  const previous = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  t.after(() => {
    globals.forEach((name, i) => {
      if (previous[i]) Object.defineProperty(globalThis, name, previous[i]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  });
  class FixtureImage {
    width = 16;
    height = 16;
    kind = "";
    onload: (() => void) | null = null;
    set src(value: string) {
      this.kind = value;
      queueMicrotask(() => this.onload?.());
    }
  }
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: FixtureImage,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        let image: FixtureImage;
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: (value: FixtureImage) => {
              image = value;
            },
            getImageData: (
              _x: number,
              _y: number,
              width: number,
              height: number,
            ) => {
              const data = new Uint8ClampedArray(width * height * 4);
              for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                  const value =
                    image.kind === "image/mask"
                      ? Number(
                          x >= width / 4 &&
                            x < (width * 3) / 4 &&
                            y >= height / 4 &&
                            y < (height * 3) / 4,
                        ) * 255
                      : image.kind === "image/far-depth"
                        ? 0
                        : 128;
                  data.set([value, value, value, 255], (y * width + x) * 4);
                }
              }
              return { data, width, height };
            },
          }),
        };
      },
    },
  });
  t.mock.method(URL, "createObjectURL", (blob: Blob) => blob.type);
  t.mock.method(URL, "revokeObjectURL", () => {});
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (!url.endsWith(".json")) {
      return new Response(
        new Blob([], {
          type: url.includes("mask")
            ? "image/mask"
            : url.includes("depth-1")
              ? "image/far-depth"
              : "image/source",
        }),
      );
    }
    return Response.json({
      version: 1,
      generatedBy: "local-segmentation",
      backgroundUrl: "/uploads/reconstructions/background.jpg",
      subjects: url.includes("world-2")
        ? []
        : [
            {
              id: "box",
              kind: "object",
              label: "box",
              box: url.includes("world-1")
                ? [0.25, 0.4, 0.75, 0.9]
                : [0.25, 0.25, 0.75, 0.75],
              maskUrl: "/uploads/reconstructions/mask.png",
              object: {
                category: "box",
                confidence: 0.9,
                color: "#808080",
                dimensions: [0.3, 0.3, 0.3],
              },
            },
          ],
    });
  });
  const frames = [0, 2, 4].map((time, i) => ({
    time,
    sourceUrl: `/uploads/reconstructions/source-${i}.jpg`,
    depthUrl: `/uploads/reconstructions/depth-${i}.png`,
    completionUrl: `/uploads/reconstructions/world-${i}.json`,
  }));
  const world = await buildVideoReconstruction({
    ...frames[0],
    video: { version: 1, duration: 5, frames },
  });
  const backdrop = world.group.getObjectByName(
    "Video background",
  ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  const ownedTexture = backdrop.material.map!;
  const videoTexture = new THREE.VideoTexture({} as HTMLVideoElement);
  let disposedBackdrop = 0,
    disposedMaterial = 0,
    disposedSource = 0,
    disposedVideo = 0;
  backdrop.geometry.addEventListener("dispose", () => disposedBackdrop++);
  backdrop.material.addEventListener("dispose", () => disposedMaterial++);
  ownedTexture.addEventListener("dispose", () => disposedSource++);
  videoTexture.addEventListener("dispose", () => disposedVideo++);
  try {
    const cloud = world.group.children.find(
      (child) => child instanceof THREE.Points,
    )!;
    const visibleProps = () => {
      const ids: string[] = [];
      world.group.traverseVisible((item) => {
        if (item.userData.memoryObject) ids.push(item.userData.memoryObject.id);
      });
      return ids;
    };
    assert.deepEqual(visibleProps(), ["0:box"]);
    const navigation = world.navigation;
    const firstTarget = navigation.target.slice();
    assert.deepEqual(navigation.front, [0, 1.6, 0]);
    assert.deepEqual(navigation.frontTarget, [0, 1.6, -4]);
    const firstForeground = world.surface.geometry
      .getAttribute("position")
      .array.slice();
    const backingBeforeSeek = backdrop.geometry
      .getAttribute("position")
      .array.slice();
    assert.ok(
      -backdrop.geometry.getAttribute("position").getZ(0) > 14.5,
      "backing starts behind later frames too",
    );
    world.setTexture(videoTexture);
    assert.equal(backdrop.material.map, videoTexture);
    assert.equal(world.surface.material.map, videoTexture);
    assert.deepEqual(
      world.surface.geometry.getAttribute("position").array,
      firstForeground,
      "assigning the live backdrop must not flatten or move the foreground",
    );
    const propPixel = 64 * 128 + 64;
    assert.ok(
      !Array.from(world.surface.geometry.index!.array).includes(propPixel),
    );
    world.setPointMode(true);
    assert.equal(world.surface.visible, false);
    assert.equal(backdrop.visible, false);
    assert.equal(cloud.visible, true);
    assert.equal(
      cloud.geometry.index,
      null,
      "the cloud must include every source pixel, including accepted props",
    );
    assert.equal(cloud.geometry.getAttribute("position").count, 128 * 128);
    for (const time of [2, 0, 1.8]) {
      world.updateTime(time);
      if (time === 2)
        assert.deepEqual(
          backdrop.geometry.getAttribute("position").array,
          backingBeforeSeek,
          "seeking must not move the global backing plane",
        );
      world.setStrength(1.6);
      assert.equal(
        world.navigation,
        navigation,
        "frame and depth updates preserve the navigation object used by the viewer",
      );
      const focusedProp = world.props.find(
        (prop) => prop.id === `${time < 1 ? 0 : 1}:box`,
      )!;
      const focus = new THREE.Box3()
        .setFromObject(focusedProp.group)
        .getCenter(new THREE.Vector3());
      assert.deepEqual(
        navigation.target,
        focus.toArray(),
        "inspection follows the current frame's actual placed prop",
      );
      if (time >= 1) assert.notDeepEqual(navigation.target, firstTarget);
      assert.deepEqual(navigation.front, [0, 1.6, 0]);
      assert.deepEqual(navigation.frontTarget, [0, 1.6, -4]);
      assert.equal(backdrop.visible, false);
      const backingDistance = -backdrop.geometry
        .getAttribute("position")
        .getZ(0);
      assert.ok(
        backingDistance > 18,
        "depth changes update backing behind the farthest sampled depth",
      );
      for (const prop of world.props) {
        assert.ok(
          backingDistance > -new THREE.Box3().setFromObject(prop.group).min.z,
        );
      }
      assert.deepEqual(
        visibleProps(),
        [],
        "seeking or changing depth must not restore solid props in point view",
      );
    }
    world.setPointMode(false);
    assert.equal(world.surface.visible, true);
    assert.equal(backdrop.visible, true);
    assert.equal(cloud.visible, false);
    assert.deepEqual(
      visibleProps(),
      ["1:box"],
      "returning to solid mode must restore only the current frame's props",
    );
    assert.ok(
      !Array.from(world.surface.geometry.index!.array).includes(propPixel),
      "solid mode must still omit replaced prop pixels",
    );
    world.updateTime(4);
    assert.deepEqual(
      navigation.target,
      [0, 1.6, -4],
      "a frame without props restores existing inspection fallback",
    );
    assert.deepEqual(navigation.side, [4, 1.6, -4]);
    assert.deepEqual(navigation.behind, [0, 1.6, -8]);
    assert.deepEqual(navigation.front, [0, 1.6, 0]);
    assert.deepEqual(navigation.frontTarget, [0, 1.6, -4]);
  } finally {
    world.dispose();
  }
  assert.equal(disposedBackdrop, 1);
  assert.equal(
    disposedMaterial,
    1,
    "the shared video material is released once",
  );
  assert.equal(disposedSource, 1);
  assert.equal(
    disposedVideo,
    0,
    "the caller retains ownership of the live video texture",
  );
  videoTexture.dispose();
});
