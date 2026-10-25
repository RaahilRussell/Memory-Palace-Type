import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  buildPhotoEnvironment,
  environmentPanoramaUv,
  projectEnvironmentPoint,
  projectSceneStructure,
} from "./photo-environment";
import type { VolumePixels } from "./volume";
import type { SceneUnderstanding } from '../scene-understanding';

function photograph(gray = false): VolumePixels {
  const width = 72,
    height = 48;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const red = 20 + x,
        green = gray ? red : 10 + y,
        blue = gray ? red : 15;
      data.set([red, green, blue, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}

test("source features project along the same camera ray across walls and floor", () => {
  const projection = {
    origin: [0, 1.6, 0] as [number, number, number],
    aspect: 1.5,
    fov: 60,
    horizon: 0.69,
  };
  const close = projectEnvironmentPoint([1, 2.1, -4], projection);
  const distant = projectEnvironmentPoint([3, 3.1, -12], projection);
  assert.ok(close.visible && distant.visible);
  close.uv.forEach((value, i) =>
    assert.ok(Math.abs(value - distant.uv[i]) < 1e-12),
  );
  assert.deepEqual(
    projectEnvironmentPoint([0, 1.6, -10], projection).uv,
    [0.5, 0.31000000000000005],
  );
  assert.equal(
    projectEnvironmentPoint([0, 1.6, 10], projection).visible,
    false,
  );
  assert.equal(
    projectEnvironmentPoint([12, 1.6, -2], projection).visible,
    false,
  );
});

test("the 360 image covers unseen directions without repeating a narrow photograph", () => {
  assert.deepEqual(environmentPanoramaUv([0, 0, -1]), [0.5, 0.5]);
  assert.deepEqual(environmentPanoramaUv([1, 0, 0]), [0.75, 0.5]);
  assert.deepEqual(environmentPanoramaUv([-1, 0, 0]), [0.25, 0.5]);
  assert.equal(environmentPanoramaUv([0, 1, 0])[1], 1);
  assert.equal(environmentPanoramaUv([0, -1, 0])[1], 0);
  assert.equal(environmentPanoramaUv([0, 0, 1])[0], 1);
});

test("high-resolution photo pixels and their original color space are retained", () => {
  const source = photograph();
  const result = buildPhotoEnvironment({
    source,
    environment: "outdoor",
    sceneEnvironment: "city",
  });
  const floor = result.group.getObjectByName(
    "Photographic ground with metre-scale detail",
  ) as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  const photo = floor.material.uniforms.photograph.value as THREE.DataTexture;
  assert.equal(photo.image.width, source.width);
  assert.equal(photo.image.height, source.height);
  assert.deepEqual(photo.image.data, source.data);
  assert.equal(photo.colorSpace, THREE.SRGBColorSpace);
  assert.equal(photo.flipY, true);
  assert.equal(
    floor.geometry.parameters.width /
      floor.material.uniforms.repeatScale.value.x,
    2,
  );
  assert.equal(floor.material.uniforms.hasPanorama.value, 0);
  assert.ok(result.group.children.length < 30);
  result.dispose();
});

test("room walls retain full depth, ordinary dimensions, and a corridor around the people", () => {
  const result = buildPhotoEnvironment({
    source: photograph(true),
    environment: "indoor",
  });
  assert.equal(result.group.userData.environmentKind, "interior");
  const ceiling = result.group.getObjectByName(
    "Photographic ceiling",
  ) as THREE.Mesh<THREE.BoxGeometry>;
  assert.ok(ceiling.position.y < 4);
  assert.equal(ceiling.geometry.parameters.depth, 17.5);
  for (const wall of result.obstacles) {
    const intersectsPeople =
      wall.x + wall.radiusX > -4 &&
      wall.x - wall.radiusX < 4 &&
      wall.z + wall.radiusZ > -9 &&
      wall.z - wall.radiusZ < 2;
    assert.equal(intersectsPeople, false);
    assert.ok(wall.radiusX > 0 && wall.radiusZ > 0);
  }
  result.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const value of object.geometry.getAttribute("position").array)
      assert.ok(Number.isFinite(value));
    const surface = object.material as
      THREE.ShaderMaterial | THREE.ShadowMaterial;
    const color =
      surface instanceof THREE.ShadowMaterial
        ? surface.color
        : (surface.uniforms.fallbackColor.value as THREE.Color);
    assert.ok(
      Math.abs(color.r - color.g) < 1e-12 &&
        Math.abs(color.r - color.b) < 1e-12,
    );
  });
  result.dispose();
});

test("body shadows darken photographic ground without relighting it or being blocked by an inferred ceiling", () => {
  for (const environment of ["indoor", "outdoor"] as const) {
    const result = buildPhotoEnvironment({
      source: photograph(),
      environment,
      sceneEnvironment: "street",
    });
    const receivers: THREE.Mesh[] = [];
    result.group.traverse((object) => {
      if (object instanceof THREE.Mesh && object.userData.bodyShadowReceiver)
        receivers.push(object);
    });
    assert.equal(receivers.length, environment === "indoor" ? 1 : 3);
    const floor = result.group.getObjectByName(
      "Photographic ground with metre-scale detail",
    ) as THREE.Mesh;
    const receiver = receivers[0];
    assert.equal(receiver.geometry, floor.geometry);
    assert.ok(
      receiver.position.y > floor.position.y && receiver.position.y < 0,
    );
    for (const mesh of receivers) {
      const material = mesh.material as THREE.ShadowMaterial;
      assert.ok(material instanceof THREE.ShadowMaterial);
      assert.equal(mesh.receiveShadow, true);
      assert.equal(mesh.castShadow, false);
      assert.equal(material.transparent, true);
      assert.equal(material.depthWrite, false);
      assert.ok(material.opacity > 0 && material.opacity < 1);
    }
    const ceiling = result.group.getObjectByName("Photographic ceiling") as
      THREE.Mesh | undefined;
    if (ceiling) assert.equal(ceiling.castShadow, false);
    let geometryDisposals = 0,
      materialDisposals = 0;
    receiver.geometry.addEventListener("dispose", () => geometryDisposals++);
    (receiver.material as THREE.Material).addEventListener(
      "dispose",
      () => materialDisposals++,
    );
    result.dispose();
    result.dispose();
    assert.equal(geometryDisposals, 1);
    assert.equal(materialDisposals, 1);
  }
});

test("disposing the scene does not dispose caller-owned photo or panorama textures", () => {
  const photo = new THREE.Texture();
  const panorama = new THREE.Texture();
  let photoDisposals = 0,
    panoramaDisposals = 0;
  photo.addEventListener("dispose", () => photoDisposals++);
  panorama.addEventListener("dispose", () => panoramaDisposals++);
  const result = buildPhotoEnvironment({
    source: photograph(),
    photoTexture: photo,
    panoramaTexture: panorama,
  });
  const sky = result.group.getObjectByName(
    "Continuous photographed and extrapolated panorama",
  ) as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  assert.equal(sky.material.uniforms.panorama.value, panorama);
  assert.equal(sky.material.uniforms.hasPanorama.value, 1);
  result.dispose();
  result.dispose();
  assert.equal(photoDisposals, 0);
  assert.equal(panoramaDisposals, 0);
  assert.equal(result.group.children.length, 0);
});

test("a completed room does not reproject secondary crowd silhouettes onto walls", () => {
  const panorama = new THREE.Texture();
  const result = buildPhotoEnvironment({
    source: photograph(true),
    panoramaTexture: panorama,
    environment: "indoor",
  });
  result.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.material instanceof THREE.ShadowMaterial) return;
    const material = object.material as THREE.ShaderMaterial;
    assert.equal(material.uniforms.photoWeight.value, 0);
    if (material.uniforms.groundDetail.value === 1) {
      assert.equal(material.uniforms.hasPanorama.value, 0);
      assert.equal(material.uniforms.panoramaGroundTile.value, 0, 'an arbitrary panorama rectangle is not verified floor evidence');
    } else {
      assert.equal(material.uniforms.hasPanorama.value, 1);
      assert.equal(material.uniforms.panoramaGroundTile.value, 0);
    }
  });
  result.dispose();
});

test("street reconstruction avoids invented near branches and oversized foreground facades", () => {
  const result = buildPhotoEnvironment({
    source: photograph(),
    panoramaTexture: new THREE.Texture(),
    environment: "outdoor",
    sceneEnvironment: "street",
  });
  assert.equal(
    result.group.getObjectByName("Photographed tree branch"),
    undefined,
  );
  const facade = result.group.getObjectByName(
    "Original right storefront volume",
  ) as THREE.Mesh<THREE.BoxGeometry>;
  assert.ok(facade.position.z + facade.geometry.parameters.depth / 2 <= -12);
  const ground = result.group.getObjectByName(
    "Photographic ground with metre-scale detail",
  ) as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  assert.ok(ground.material.uniforms.hasPanorama.value < 0.25);
  result.dispose();
});

test("a completed panorama does not make locally filled foreground safe to project onto the street", () => {
  const source = photograph();
  const excludedMask: VolumePixels = {
    width: source.width,
    height: source.height,
    data: new Uint8Array(source.width * source.height * 4).fill(255),
  };
  const result = buildPhotoEnvironment({
    source,
    excludedMask,
    textureSource: "source-inpaint",
    panoramaTexture: new THREE.Texture(),
    environment: "outdoor",
    sceneEnvironment: "street",
  });
  for (const name of [
    "Original right storefront volume",
    "Continuous photographed and extrapolated panorama",
  ]) {
    const mesh = result.group.getObjectByName(name) as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.ShaderMaterial
    >;
    assert.equal(
      mesh.material.uniforms.excludeForeground.value,
      1,
      "the original photo's filled foreground stays excluded",
    );
    assert.equal(
      mesh.material.uniforms.hasPanorama.value,
      1,
      "the completed panorama remains available behind excluded photograph pixels",
    );
  }
  result.dispose();
});

test("capture height calibration keeps all environment projections and the panorama aligned", () => {
  for (const environment of ["indoor", "outdoor"] as const) {
    const result = buildPhotoEnvironment({
      source: photograph(),
      environment,
      horizon: 0.64,
    });
    const projection = result.group.userData.projection;
    const original = projectEnvironmentPoint([0.3, 1.9, -5], projection);
    const floor = result.group.getObjectByName(
      "Photographic ground with metre-scale detail",
    )!;
    const floorY = floor.position.y;
    for (const height of [2.1, 1.2]) {
      result.setCaptureHeight(height);
      assert.deepEqual(projection.origin, [0, height, 0]);
      assert.equal(projection.horizon, 0.64);
      const projected = projectEnvironmentPoint(
        [0.3, height + 0.3, -5],
        projection,
      );
      projected.uv.forEach((value, i) =>
        assert.ok(Math.abs(value - original.uv[i]) < 1e-12),
      );
      result.group.traverse((object) => {
        if (
          !(object instanceof THREE.Mesh) ||
          !(object.material instanceof THREE.ShaderMaterial)
        )
          return;
        assert.deepEqual(
          object.material.uniforms.captureOrigin.value.toArray(),
          [0, height, 0],
        );
        assert.equal(object.material.uniforms.horizon.value, 0.64);
      });
      const sky = result.group.getObjectByName(
        "Continuous photographed and extrapolated panorama",
      );
      if (sky) assert.deepEqual(sky.position.toArray(), [0, height, 0]);
      assert.equal(floor.position.y, floorY);
    }
    for (const invalid of [NaN, Infinity, 0, -1])
      assert.throws(() => result.setCaptureHeight(invalid));
    assert.deepEqual(projection.origin, [0, 1.2, 0]);
    result.dispose();
  }
});

const supportedRoom: SceneUnderstanding = {
  version: 1, source: 'gemini', status: 'complete', environment: 'indoor', confidence: .9, horizon: .55,
  structures: [{ id: 'pillar', label: 'visible brick column', kind: 'column', box: [.1, .1, .9, .15], confidence: .95, visibility: 'clear', depthBand: 'middle' }],
  objects: [], people: [], relations: [], limitations: [],
};

test('indoor scenes have no invented column and unknown outdoor scenes have no fabricated storefront', () => {
  const indoor = buildPhotoEnvironment({ source: photograph(), environment: 'indoor' });
  assert.equal(indoor.group.getObjectByName('Left room column'), undefined);
  assert.equal(indoor.group.userData.observedStructureCount, 0);
  const unknown = buildPhotoEnvironment({ source: photograph(), sceneEnvironment: 'gallery' });
  assert.equal(unknown.group.getObjectByName('Original right storefront volume'), undefined);
  assert.equal(unknown.group.getObjectByName('Original left street-edge volume'), undefined);
  indoor.dispose(); unknown.dispose();
});

test('supported structures preserve their source rays and collision height as capture height changes', () => {
  const room = buildPhotoEnvironment({ source: photograph(), sceneUnderstanding: supportedRoom });
  const column = room.group.getObjectByName('Observed column: pillar') as THREE.Mesh;
  assert.ok(column);
  assert.equal(room.group.userData.environmentKind, 'interior');
  assert.equal(room.group.userData.observedStructureCount, 1);
  const projection = room.group.userData.projection;
  const expected = projectSceneStructure(supportedRoom.structures[0], projection);
  assert.deepEqual(column.position.toArray(), expected.position);
  const point = projectEnvironmentPoint(expected.position, projection);
  assert.ok(Math.abs(point.uv[0] - .125) < 1e-12);
  assert.ok(Math.abs(point.uv[1] - .5) < 1e-12);
  const collision = room.obstacles.at(-1)!;
  const originalMin = collision.minY!;
  room.setCaptureHeight(2.1);
  assert.ok(Math.abs(column.position.y - expected.position[1] - .5) < 1e-12);
  assert.ok(Math.abs(collision.minY! - originalMin - .5) < 1e-12);
  assert.deepEqual(projectEnvironmentPoint(column.position.toArray() as [number, number, number], projection).uv, point.uv);
  room.dispose();
});

test('uncertain structural evidence remains inventory data without unsupported geometry or collisions', () => {
  for (const overrides of [{ confidence: .6 }, { visibility: 'uncertain' as const }]) {
    const scene = { ...supportedRoom, structures: [{ ...supportedRoom.structures[0], ...overrides }] };
    const room = buildPhotoEnvironment({ source: photograph(), sceneUnderstanding: scene });
    assert.equal(room.group.getObjectByName('Observed column: pillar'), undefined);
    assert.equal(room.group.userData.observedStructureCount, 0);
    room.dispose();
  }
});
