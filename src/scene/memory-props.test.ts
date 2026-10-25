import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  MEMORY_OBJECT_CATEGORIES,
  memoryObjectPolicy,
  type MemoryObjectSpec,
} from "../memory-objects";
import { buildMemoryProp, placeMemoryProp } from "./memory-props";

const source = { width: 4, height: 4, data: new Uint8Array(64) };
for (let y = 0; y < 4; y++)
  for (let x = 0; x < 4; x++)
    source.data.set([x * 50, y * 50, 160, 255], (y * 4 + x) * 4);
const object: MemoryObjectSpec = {
  category: "drink-can",
  confidence: 0.95,
  color: "#cf231b",
  dimensions: [0.067, 0.123, 0.067],
};

test("a crop-only local umbrella cannot erase a table through direct prop construction", () => {
  const uncertain: MemoryObjectSpec = {
    ...object, category: "umbrella", dimensions: [2, 2.5, 2],
    evidence: { version: 1, source: "local-detector", proposalConfidence: .415,
      confirmationConfidence: .544, confirmation: "crop", labelMatched: true,
      conflictingCategories: ["backpack", "television"] },
  };
  assert.throws(() => buildMemoryProp({ id: "ambiguous-table", label: "Umbrella?", object: uncertain,
    source, box: [0, 0, 1, 1] }), /observed source surface/);
});

test("furniture has supporting geometry and fixed props ignore hand anchors", () => {
  for (const category of [
    "table",
    "round-table",
    "chair",
    "umbrella",
  ] as const) {
    const prop = buildMemoryProp({
      id: category,
      label: category,
      object: { ...object, category, dimensions: [1, 1, 1] },
      source,
      box: [0, 0, 1, 1],
    });
    assert.equal(prop.group.userData.memoryObject.interaction, "fixed");
    const parts = prop.group.userData.geometryParts as string[];
    assert.ok(
      parts.some((name) => /leg|pole/i.test(name)),
      `${category} has real supports`,
    );
    assert.ok(parts.length >= 4);
    prop.dispose();
  }
  for (const category of ["building", "glasses", "clothing", "bridge"] as const)
    assert.throws(
      () =>
        buildMemoryProp({
          id: category,
          label: category,
          object: { ...object, category },
          source,
          box: [0, 0, 1, 1],
        }),
      /source surface/,
    );
  const input = {
    box: [0.4, 0.4, 0.7, 0.7] as [number, number, number, number],
    depth: { width: 10, height: 10, data: new Uint8Array(400).fill(180) },
    object: {
      ...object,
      category: "chair" as const,
      dimensions: [0.5, 0.85, 0.55] as [number, number, number],
    },
  };
  assert.deepEqual(
    placeMemoryProp({
      ...input,
      anchors: [{ image: [0.5, 0.5], position: [0, 1, -1], confidence: 1 }],
    }),
    placeMemoryProp(input),
  );
});

test("all common props have complete centered metric bounds and photographed color", () => {
  for (const category of MEMORY_OBJECT_CATEGORIES.filter(
    (category) => memoryObjectPolicy(category).reconstruction === "solid",
  )) {
    const dimensions: [number, number, number] = [0.3, 0.4, 0.12];
    const prop = buildMemoryProp({
      id: category,
      label: category,
      object: { ...object, category, dimensions },
      source,
      box: [0.25, 0.25, 0.75, 0.75],
    });
    const bounds = new THREE.Box3().setFromObject(prop.group);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    assert.ok(center.length() < 1e-6, `${category} grab pivot stays centered`);
    size
      .toArray()
      .forEach((dimension, i) =>
        assert.ok(
          Math.abs(dimension - dimensions[i]) < 1e-6,
          `${category} dimension ${i}`,
        ),
      );
    let colored = false;
    const textures = new Set<THREE.Texture>();
    prop.group.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      assert.equal(node.castShadow, true);
      assert.equal(node.receiveShadow, true);
      assert.ok(
        Array.from(node.geometry.getAttribute("position").array).every(
          Number.isFinite,
        ),
      );
      for (const mat of Array.isArray(node.material)
        ? node.material
        : [node.material]) {
        if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
        colored ||= mat.color.getHexString() === "cf231b";
        if (mat.map) textures.add(mat.map);
      }
    });
    assert.ok(colored, `${category} retains inferred source material color`);
    assert.equal(
      textures.size,
      1,
      `${category} shares its own crop across details`,
    );
    const texture = [...textures][0] as THREE.DataTexture;
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
    assert.deepEqual(
      Array.from(texture.image.data.slice(0, 4)),
      [50, 100, 160, 255],
      "front crop retains RGB and correct +Y orientation",
    );
    prop.dispose();
  }
});

test("moving and disposing one prop does not affect another object's resources", () => {
  const make = (id: string) =>
    buildMemoryProp({ id, label: id, object, source, box: [0, 0, 1, 1] });
  const first = make("first"),
    second = make("second");
  const world = new THREE.Group(),
    controller = new THREE.Group();
  world.add(first.group, second.group, controller);
  first.group.position.set(1, 2, -3);
  world.updateMatrixWorld(true);
  controller.attach(first.group);
  controller.position.set(0, 1, 0);
  world.updateMatrixWorld(true);
  assert.deepEqual(
    first.group.getWorldPosition(new THREE.Vector3()).toArray(),
    [1, 3, -3],
  );
  assert.deepEqual(second.group.position.toArray(), [0, 0, 0]);
  const resources = (group: THREE.Group) => {
    const result = new Set<
      THREE.BufferGeometry | THREE.Material | THREE.Texture
    >();
    group.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      result.add(node.geometry);
      for (const mat of Array.isArray(node.material)
        ? node.material
        : [node.material]) {
        result.add(mat);
        if (mat instanceof THREE.MeshStandardMaterial && mat.map)
          result.add(mat.map);
      }
    });
    return result;
  };
  const a = resources(first.group),
    b = resources(second.group);
  assert.ok([...a].every((resource) => !b.has(resource)));
  let disposed = 0;
  a.forEach((resource) =>
    resource.addEventListener("dispose", () => {
      disposed++;
    }),
  );
  first.dispose();
  first.dispose();
  assert.equal(disposed, a.size);
  assert.equal(first.group.parent, null);
  assert.equal(second.group.parent, world);
  second.dispose();
});

test("placement keeps the photographed center and bounded physical size despite background depth", () => {
  const box: [number, number, number, number] = [0.53, 0.63, 0.63, 0.69];
  const depth = { width: 40, height: 30, data: new Uint8Array(40 * 30 * 4) };
  for (const backgroundDepth of [0, 128, 255]) {
    depth.data.fill(backgroundDepth);
    const placement = placeMemoryProp({
      box,
      depth,
      object,
      cameraHeight: 1.1,
    });
    const [x, y, z] = placement.position;
    const halfHeight = Math.tan(Math.PI / 6);
    const u = 0.5 + x / ((-z * 2 * halfHeight * 4) / 3);
    const v = 0.5 - (y - 1.1) / (-z * 2 * halfHeight);
    assert.ok(Math.abs(u - 0.66) < 1e-9);
    assert.ok(Math.abs(v - 0.58) < 1e-9);
    assert.ok(placement.scale >= 0.75 && placement.scale <= 1.5);
    const apparentHeight =
      (object.dimensions[1] * placement.scale) / (-z * 2 * halfHeight);
    assert.ok(
      Math.abs(apparentHeight - 0.1) < 1e-9,
      "projected full 3D object matches photographed size",
    );
    assert.ok(
      -z < 2,
      "far background does not send a hand-held object many metres away",
    );
  }
});

test("placement excludes background samples outside the object mask and handles orientation", () => {
  const depth = { width: 10, height: 10, data: new Uint8Array(400) };
  const mask = { width: 10, height: 10, data: new Uint8Array(400) };
  const box: [number, number, number, number] = [0.25, 0.25, 0.75, 0.75];
  const rotated: MemoryObjectSpec = {
    ...object,
    category: "phone",
    dimensions: [0.075, 0.15, 0.01],
    rotation: [0, 0, Math.PI / 2],
  };
  for (let y = 3; y <= 6; y++)
    for (let x = 3; x <= 6; x++) {
      mask.data[(y * 10 + x) * 4] = 255;
      depth.data[(y * 10 + x) * 4] = 230;
    }
  const masked = placeMemoryProp({ box, depth, mask, object: rotated });
  const uniform = placeMemoryProp({
    box,
    depth: { ...depth, data: new Uint8Array(400).fill(230) },
    object: rotated,
  });
  assert.deepEqual(masked, uniform);
  const largerMask = { width: 20, height: 20, data: new Uint8Array(1600) };
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 20; x++)
      largerMask.data[(y * 20 + x) * 4] =
        mask.data[(Math.floor(y / 2) * 10 + Math.floor(x / 2)) * 4];
  assert.deepEqual(
    placeMemoryProp({ box, depth, mask: largerMask, object: rotated }),
    masked,
    "mask resolution does not change which source pixels determine distance",
  );
  assert.ok(masked.position.every(Number.isFinite));
  const built = buildMemoryProp({
    id: "rotated-phone",
    label: "phone",
    object: rotated,
    source,
    box,
  });
  const size = new THREE.Box3()
    .setFromObject(built.group)
    .getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 0.15) < 1e-6);
  assert.ok(Math.abs(size.y - 0.075) < 1e-6);
  built.dispose();
});

test("a confident photographed hand keeps a prop at its person's distance and on its image ray", () => {
  const depth = {
    width: 100,
    height: 100,
    data: new Uint8Array(40000).fill(180),
  };
  const box: [number, number, number, number] = [0.5, 0.55, 0.56, 0.59];
  const input = { box, depth, object, aspect: 4 / 3, cameraHeight: 1.15 };
  const independent = placeMemoryProp(input);
  const held = placeMemoryProp({
    ...input,
    anchors: [
      { image: [0.61, 0.53], position: [0.5, 1.0, -3], confidence: 0.95 },
    ],
  });
  assert.ok(
    -independent.position[2] < 2.5,
    "independent category-size estimate was separated from the hand",
  );
  assert.equal(held.position[2], -3);
  const [x, y, z] = held.position;
  const verticalSpan = -z * 2 * Math.tan(Math.PI / 6);
  assert.ok(Math.abs(0.5 + x / (verticalSpan * input.aspect) - 0.57) < 1e-9);
  assert.ok(
    Math.abs(0.5 - (y - input.cameraHeight) / verticalSpan - 0.53) < 1e-9,
  );
  assert.ok(
    Math.abs((object.dimensions[1] * held.scale) / verticalSpan - 0.06) < 1e-9,
  );
  assert.ok(
    held.scale <= 2,
    "the category size prior still limits physical size",
  );
});

test("unrelated, uncertain, implausible and ambiguous hands preserve independent prop placement", () => {
  const depth = {
    width: 100,
    height: 100,
    data: new Uint8Array(40000).fill(180),
  };
  const box: [number, number, number, number] = [0.5, 0.55, 0.56, 0.59];
  const input = { box, depth, object, aspect: 4 / 3 };
  const independent = placeMemoryProp(input);
  const hand = {
    image: [0.61, 0.53] as [number, number],
    position: [0.5, 1, -3] as [number, number, number],
    confidence: 0.95,
  };
  const alternatives = [
    [{ ...hand, confidence: 0.4 }],
    [{ ...hand, image: [0.8, 0.8] as [number, number] }],
    [{ ...hand, position: [0.5, 1, -7] as [number, number, number] }],
    [hand, { ...hand, position: [0.5, 1, -2] as [number, number, number] }],
  ];
  for (const anchors of alternatives)
    assert.deepEqual(placeMemoryProp({ ...input, anchors }), independent);
});

test("a foreground hand does not pull an overlapping background prop forward", () => {
  const depth = {
    width: 100,
    height: 100,
    data: new Uint8Array(40000).fill(20),
  };
  const box: [number, number, number, number] = [0.5, 0.55, 0.56, 0.59];
  for (let y = 51; y <= 55; y++)
    for (let x = 60; x <= 63; x++) depth.data[(y * 100 + x) * 4] = 230;
  const input = { box, depth, object, aspect: 4 / 3 };
  assert.deepEqual(
    placeMemoryProp({
      ...input,
      anchors: [
        { image: [0.61, 0.53], position: [0.5, 1, -3], confidence: 0.95 },
      ],
    }),
    placeMemoryProp(input),
  );
});
