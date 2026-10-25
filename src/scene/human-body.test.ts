import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { buildHumanBody, type HumanAppearance } from "./human-body";
import { fitHumanPose } from "./human-pose";
import { HUMAN_POSE_LANDMARK_NAMES, type HumanPose } from "../types";
import type { VolumePixels } from "./volume";

const pixels = (fn: (x: number, y: number) => number[]): VolumePixels => ({
  width: 64,
  height: 80,
  data: Array.from({ length: 64 * 80 }, (_, i) => fn(i % 64, Math.floor(i / 64))).flat(),
});
const source = pixels((x, y) => y < 24 ? [131, 87, 63, 255] : [215, 78 + x, 123, 255]);
const mask = pixels(() => [255, 255, 255, 255]);
const appearance: HumanAppearance = {
  shirtColor: "#d74e7b", pantsColor: "#292c31", skinColor: "#83573f",
  hairColor: "#211b18", shoeColor: "#323236", height: 1.76,
  faceBox: [0, 0.2, 0.3, 0.8], chestBox: [0.3, 0.2, 0.8, 0.8],
  sleeves: "short", yaw: 0,
};
const build = (override: Partial<HumanAppearance> = {}) => buildHumanBody({
  source, mask, box: [0, 0, 1, 1], label: "waist-cropped photograph",
  appearance: { ...appearance, ...override },
});

test("a cropped portrait produces a complete adult body with two grounded feet", () => {
  const human = build();
  assert.ok(Math.abs(human.bounds.min.y) < 0.00001);
  assert.ok(human.bounds.max.y > 1.70 && human.bounds.max.y < 1.80);
  for (const side of ["left", "right"]) {
    for (const part of ["upper-arm", "forearm", "hand", "thumb", "thigh", "knee", "calf", "shoe"]) {
      const mesh = human.group.getObjectByName(`${side}-${part}`) as THREE.Mesh;
      assert.ok(mesh?.isMesh, `${side} ${part} must exist even though it was not photographed`);
      const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
      assert.ok(size.x > 0 && size.y > 0 && size.z > 0.01, `${part} must enclose depth`);
    }
    const foot = new THREE.Box3().setFromObject(human.group.getObjectByName(`${side}-sole`)!);
    assert.ok(Math.abs(foot.min.y) < 0.00001);
  }
  const left = new THREE.Box3().setFromObject(human.group.getObjectByName("left-shoe")!);
  const right = new THREE.Box3().setFromObject(human.group.getObjectByName("right-shoe")!);
  assert.ok(left.max.x < right.min.x, "the feet remain separate, with a walkable gap between the legs");
  human.dispose();
});

test("torso has independently visible front and rear surfaces and finite smooth normals", () => {
  const human = build();
  const torso = human.group.getObjectByName("shirt-torso") as THREE.Mesh;
  for (const z of [-2, 2]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 1.22, z), new THREE.Vector3(0, 0, -Math.sign(z)));
    assert.ok(ray.intersectObject(torso).length > 0, `the ${z > 0 ? "front" : "back"} must be solid`);
  }
  human.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const name of ["position", "normal"]) {
      const attribute = object.geometry.getAttribute(name);
      assert.ok(Array.from(attribute.array).every(Number.isFinite), `${object.name} ${name} contains only finite values`);
    }
  });
  human.dispose();
});

test("original shirt RGB remains in the front albedo and sampled color wraps the back", () => {
  const human = build();
  const material = (human.group.getObjectByName("shirt-torso") as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const map = material.map! as THREE.DataTexture;
  assert.equal(map.colorSpace, THREE.SRGBColorSpace);
  const { data, width, height } = map.image;
  const front = ((Math.floor(height / 2) * width) + Math.floor(width / 2)) * 4;
  assert.equal(data[front], 215);
  assert.equal(data[front + 2], 123);
  const back = (Math.floor(height / 2) * width) * 4;
  assert.deepEqual(Array.from(data.slice(back, back + 3)), [215, 78, 123]);
  human.dispose();
});

test("a source back view projects onto the back without becoming a flattened body", () => {
  const human = build({ sourceView: "back", yaw: Math.PI, headYaw: 0.4 });
  const material = (human.group.getObjectByName("shirt-torso") as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const { data, width, height } = (material.map as THREE.DataTexture).image;
  const sourceBack = (Math.floor(height / 2) * width) * 4;
  assert.ok(data[sourceBack + 1] > 100, "source shirt variation is visible on the local back");
  const inferredFront = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  assert.equal(data[inferredFront + 1], 78);
  const observedNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(
    human.group.getObjectByName("head")!.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(observedNormal.z > 0.999, "the photographed head view still faces the reference camera");
  assert.ok(human.bounds.max.z - human.bounds.min.z > 0.25);
  assert.ok(Math.abs(human.bounds.min.y) < 0.00001);
  human.dispose();
});

test("heads remain solid from every side even when rear skin matches a grayscale wall", () => {
  const human = build({ skinColor: "#535353", hairColor: "#212121", headYaw: 0.45 });
  const head = human.group.getObjectByName("head") as THREE.Mesh;
  for (const [x, z] of [[0, 2], [0, -2], [2, 0], [-2, 0]]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 1.6, z), new THREE.Vector3(-x, 0, -z).normalize());
    assert.ok(ray.intersectObject(head).length > 0, `head must remain visible from x=${x}, z=${z}`);
  }
  const { data, width, height } = ((head.material as THREE.MeshStandardMaterial).map as THREE.DataTexture).image;
  const back = (Math.floor(height / 2) * width) * 4;
  assert.equal(data[back], data[back + 1], "the inferred rear retains the photograph's monochrome palette");
  assert.equal(data[back + 1], data[back + 2]);
  assert.equal(data[back + 3], 255, "the rear remains fully opaque");
  human.dispose();
});

test("a profile photograph retains its face and hair without a generic overlay or a second head turn", () => {
  const human = build({ headYaw: 0.78 });
  const head = human.group.getObjectByName("head") as THREE.Mesh;
  const material = head.material as THREE.MeshStandardMaterial;
  const { data, width, height } = (material.map as THREE.DataTexture).image;
  const face = (Math.floor(height * 0.4) * width + Math.floor(width / 2)) * 4;
  assert.deepEqual(Array.from(data.slice(face, face + 3)), [131, 87, 63]);
  assert.equal(material.emissiveMap, material.map, "photo illumination is preserved in the albedo");
  assert.ok(material.emissiveIntensity > 0.8);
  for (const overlay of ["hair", "nose-bridge", "nose-tip", "face-mouth", "left-ear", "right-ear"])
    assert.equal(human.group.getObjectByName(overlay), undefined, `${overlay} must not obscure photographed details`);
  const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(direction.z > 0.999, "the already-turned source face remains visible from the original camera");
  human.dispose();
});

test("head silhouette follows the source mask while enclosing a rounded skull", () => {
  const asymmetricalMask = pixels((x, y) => {
    const left = y < 12 ? 19 : 27;
    const right = y < 12 ? 48 : 50;
    return x >= left && x <= right ? [255, 255, 255, 255] : [0, 0, 0, 255];
  });
  const human = buildHumanBody({ source, mask: asymmetricalMask, box: [0, 0, 1, 1],
    label: "observed profile", appearance });
  const geometry = (human.group.getObjectByName("head") as THREE.Mesh).geometry;
  const pos = geometry.getAttribute("position");
  let left = Infinity, right = -Infinity, front = -Infinity, rear = Infinity;
  for (let i = 0; i < pos.count; i++) {
    left = Math.min(left, pos.getX(i)); right = Math.max(right, pos.getX(i));
    front = Math.max(front, pos.getZ(i)); rear = Math.min(rear, pos.getZ(i));
  }
  assert.ok(right + left > 0.01, "the actual asymmetric profile controls its horizontal outline");
  assert.ok(front - rear > 0.16, "the head is a full rounded volume rather than an extruded card");
  human.dispose();
});

test("photographic turnaround textures cover inferred legs on both sides while source identity wins", () => {
  const front = pixels(() => [41, 77, 123, 255]);
  const back = pixels(() => [88, 55, 33, 255]);
  const human = buildHumanBody({ source, mask, box: [0, 0, 1, 1], label: "completed clothing",
    appearance, photographicBody: { front, back } });
  const thigh = human.group.getObjectByName("left-thigh") as THREE.Mesh;
  const thighMap = (thigh.material as THREE.MeshStandardMaterial).map as THREE.DataTexture;
  const { data, width, height } = thighMap.image;
  // The limb's local UV seam is rolled relative to the world camera. Look for
  // both observed colors around the actual ring, not two arbitrary seam texels.
  const ring = Array.from({ length: width }, (_, x) => {
    const offset = (Math.floor(height / 2) * width + x) * 4;
    return Array.from(data.slice(offset, offset + 3)).join();
  });
  assert.ok(ring.includes("41,77,123"), "camera-facing leg retains the inferred front RGB");
  assert.ok(ring.includes("88,55,33"), "rear-facing leg retains the inferred back RGB");
  const head = human.group.getObjectByName("head") as THREE.Mesh;
  const photo = ((head.material as THREE.MeshStandardMaterial).map as THREE.DataTexture).image;
  const observed = (Math.floor(photo.height * 0.4) * photo.width + Math.floor(photo.width / 2)) * 4;
  assert.deepEqual(Array.from(photo.data.slice(observed, observed + 3)), [131, 87, 63],
    "a generated turnaround must never replace the source person's visible face");
  human.dispose();
});

test("bare arms inside a person mask cannot become orange stripes on a black shirt", () => {
  const photograph = pixels((x) => x > 37 ? [232, 154, 89, 255]
    : x >= 30 && x <= 33 ? [249, 249, 249, 255] : [22, 19, 18, 255]);
  const human = buildHumanBody({ source: photograph, mask, box: [0, 0, 1, 1], label: "shirt beside bare arms",
    appearance: { ...appearance, skinColor: "#e89a59", shirtColor: "#161312", torsoBox: [.3, .2, .8, .8] } });
  const torso = human.group.getObjectByName("shirt-torso") as THREE.Mesh;
  const { data, width, height } = ((torso.material as THREE.MeshStandardMaterial).map as THREE.DataTexture).image;
  const stripe = (Math.floor(height * .4) * width + Math.floor(width * .62)) * 4;
  assert.deepEqual(Array.from(data.slice(stripe, stripe + 3)), [22, 19, 18]);
  const graphic = (Math.floor(height * .4) * width + Math.floor(width * .5)) * 4;
  assert.deepEqual(Array.from(data.slice(graphic, graphic + 3)), [249, 249, 249],
    "high-contrast printed fabric must remain visible");
  human.dispose();
});

function observedPose(): HumanPose {
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
    confidence: .95, observedFraction: 1, sourceBox: [0, 0, 1, 1],
    landmarks: HUMAN_POSE_LANDMARK_NAMES.map((name, i) => {
      const [x, y, z] = joints[i] ?? [0, .69, 0];
      return { name, image: [.5 + x * .4, .45 - y * .4, -z * .4],
        world: [x, -y, -z], visibility: .98, presence: .99 };
    }),
  };
}

for (const posed of [false, true]) {
  test(`${posed ? "posed" : "unposed"} photo textures reject excluded bilinear neighbors without losing valid source details`, () => {
    // Thin horizontal prop strips expose the former nearest-mask/bilinear-RGB
    // mismatch even when torso checks also inspect left and right mask pixels.
    // The open regions between strips represent valid photo holes, not a bbox
    // exclusion: photographed hands/fingers there must remain eligible.
    const invalid = (y: number) => y % 8 === 3;
    const validRGB = [24, 87, 163];
    const clean = pixels(() => [...validRGB, 255]);
    const contaminated = pixels((_x, y) => invalid(y) ? [255, 0, 255, 255] : [...validRGB, 255]);
    const validity = pixels((_x, y) => invalid(y) ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const beforeSource = Array.from(contaminated.data), beforeMask = Array.from(validity.data);
    const poseRig = posed ? fitHumanPose(observedPose(), clean) : undefined;
    if (posed) assert.ok(poseRig);
    const make = (photo: VolumePixels) => buildHumanBody({
      source: photo, mask: validity, poseRig, box: [0, 0, 1, 1], label: "prop-boundary regression",
      appearance: { ...appearance, neckBox: [.2, .2, .4, .8] },
    });
    const reference = make(clean), result = make(contaminated);
    try {
      const parts = posed ? ["head", "shirt-torso", "neck", "left-hand", "left-finger-0"]
        : ["head", "shirt-torso", "neck"];
      for (const part of parts) {
        const textureData = (human: ReturnType<typeof make>) => {
          const mesh = human.group.getObjectByName(part) as THREE.Mesh;
          const map = (mesh.material as THREE.MeshStandardMaterial).map as THREE.DataTexture;
          return map.image.data as Uint8Array;
        };
        const actual = textureData(result), expected = textureData(reference);
        assert.equal(Buffer.compare(Buffer.from(actual), Buffer.from(expected)), 0,
          `${part} must be independent of every excluded RGB value, including interpolation neighbors`);
        let observedPixels = 0;
        for (let i = 0; i < actual.length; i += 4)
          if (validRGB.every((value, channel) => actual[i + channel] === value)) observedPixels++;
        assert.ok(observedPixels > 0, `${part} must retain valid original photo pixels between excluded strips`);
      }
      assert.deepEqual(Array.from(contaminated.data), beforeSource, "source photograph remains unchanged");
      assert.deepEqual(Array.from(validity.data), beforeMask, "validity holes remain unchanged");
    } finally {
      reference.dispose(); result.dispose();
    }
  });
}

for (const suppliedAppearance of [true, false]) {
  test(`fitting silhouette preserves anatomy across photo holes with ${suppliedAppearance ? "supplied" : "automatic"} appearance`, () => {
    const blocked = (x: number, y: number) => x < 32 && y < 30;
    const clean = pixels(() => [24, 87, 163, 255]);
    const contaminated = pixels((x, y) => blocked(x, y) ? [255, 0, 255, 255] : [24, 87, 163, 255]);
    const validity = pixels((x, y) => blocked(x, y) ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const before = [contaminated, validity, mask].map(image => Array.from(image.data));
    const make = (photo: VolumePixels, photoMask: VolumePixels) => buildHumanBody({
      source: photo, mask: photoMask, fittingMask: mask, box: [0, 0, 1, 1],
      label: "held prop beside face", appearance: suppliedAppearance ? appearance : undefined,
    });
    const complete = make(clean, mask), occluded = make(clean, validity), result = make(contaminated, validity);
    try {
      for (const human of [occluded, result]) {
        complete.group.traverse(reference => {
          if (!(reference instanceof THREE.Mesh)) return;
          const actual = human.group.getObjectByName(reference.name) as THREE.Mesh;
          for (const name of ["position", "normal", "uv"]) {
            const expectedArray: ArrayBufferView = reference.geometry.getAttribute(name).array;
            const actualArray = actual.geometry.getAttribute(name).array;
            assert.equal(Buffer.compare(
              Buffer.from(actualArray.buffer, actualArray.byteOffset, actualArray.byteLength),
              Buffer.from(expectedArray.buffer, expectedArray.byteOffset, expectedArray.byteLength)), 0,
            `${reference.name} ${name} must use the fitting silhouette, not the occluder hole`);
          }
          assert.deepEqual(actual.matrixWorld.elements, reference.matrixWorld.elements,
            `${reference.name} placement must not shift around a photo-validity hole`);
        });
        assert.deepEqual(human.bounds, complete.bounds);
      }
      const texture = (human: ReturnType<typeof make>, name: string) => {
        const mesh = human.group.getObjectByName(name) as THREE.Mesh;
        return ((mesh.material as THREE.MeshStandardMaterial).map as THREE.DataTexture).image.data as Uint8Array;
      };
      for (const name of ["head", "shirt-torso"]) {
        assert.equal(Buffer.compare(Buffer.from(texture(result, name)), Buffer.from(texture(occluded, name))), 0,
          `${name} must still exclude prop RGB while fitting to the complete silhouette`);
      }
      const head = texture(result, "head");
      let observedPixels = 0;
      for (let i = 0; i < head.length; i += 4)
        if (head[i] === 24 && head[i + 1] === 87 && head[i + 2] === 163) observedPixels++;
      assert.ok(observedPixels > 0, "the unobscured face retains photographed pixels");
      if (suppliedAppearance) assert.notEqual(
        Buffer.compare(Buffer.from(head), Buffer.from(texture(complete, "head"))), 0,
        "excluding an occluder changes the face texture, not its geometry");
      assert.deepEqual([contaminated, validity, mask].map(image => Array.from(image.data)), before,
        "source RGB, photo-validity holes and fitting silhouette remain unchanged");
    } finally {
      complete.dispose(); occluded.dispose(); result.dispose();
    }
  });
}
