import test from "node:test";
import assert from "node:assert/strict";
import { layoutHumanBodies, estimateCaptureHeight } from "./human-layout";
import type { HumanPoseRig } from "./human-pose";
import { Vector3 } from "three";

test("source camera height follows reliable photographed heads and resists bad grounding", () => {
  const heads = [1.08, 1.1, 1.12, 6].map((captureHeight, i) => {
    const worldY = 1.4 + i * 0.1;
    const depth = 2 + i * 0.2;
    return {
      worldY,
      depth,
      photoV:
        0.5 + (captureHeight - worldY) / (2 * Math.tan(Math.PI / 6) * depth),
      confidence: 0.95,
    };
  });
  assert.ok(
    Math.abs(
      estimateCaptureHeight([
        ...heads,
        { worldY: 5, depth: 2, photoV: 0.5, confidence: 0.2 },
        { worldY: Number.NaN, depth: 2, photoV: 0.5, confidence: 1 },
      ]) - 1.11,
    ) < 1e-9,
  );
  assert.equal(estimateCaptureHeight([]), 1.6);
  assert.ok(Math.abs(estimateCaptureHeight([heads[0]]) - 1.08) < 1e-9);
  assert.equal(estimateCaptureHeight([heads[3], heads[3]]), 1.8);
});

test("legacy cropped people retain photograph spacing at every depth setting", () => {
  const pixels = { width: 4, height: 4, data: new Uint8Array(64).fill(255) };
  const subjects = [0.25, 0.5, 0.75].map((u) => ({
    box: [0.2, u - 0.2, 1, u + 0.2] as [number, number, number, number],
    faceBox: [0.2, u - 0.06, 0.4, u + 0.06] as [number, number, number, number],
    mask: pixels,
  }));
  for (const strength of [0.35, 1.25, 2]) {
    const positions = layoutHumanBodies(subjects, pixels, strength);
    assert.equal(positions.length, 3);
    assert.ok(positions.every((p) => p.every(Number.isFinite) && p[1] === 0));
    assert.ok(Math.abs(positions[1][0] - positions[0][0] - 0.34) < 0.00001);
    assert.ok(Math.abs(positions[2][0] - positions[1][0] - 0.34) < 0.00001);
    assert.equal(positions[1][0], 0);
    positions.forEach(([x, , z], i) => {
      const u = 0.5 + x / (-z * 2 * Math.tan(Math.PI / 6));
      assert.ok(Math.abs(u - [0.25, 0.5, 0.75][i]) < 1e-9);
      assert.ok(
        Math.abs(0.272 / (-z * 2 * Math.tan(Math.PI / 6)) - 0.2) < 1e-9,
        "head scale fixes distance without adding a minimum horizontal gap",
      );
    });
  }
});

test("an off-center unposed person retains their source camera ray when another pose becomes available", () => {
  const depth = {
    width: 64,
    height: 48,
    data: new Uint8Array(64 * 48 * 4).fill(128),
  };
  const unposed = {
    box: [0.2, 0.65, 1, 0.9] as [number, number, number, number],
    faceBox: [0.25, 0.72, 0.37, 0.81] as [number, number, number, number],
    mask: { ...depth, data: new Uint8Array(64 * 48 * 4) },
  };
  const alone = layoutHumanBodies([unposed], depth)[0];
  const together = layoutHumanBodies(
    [unposed, crowdPerson(0.25, 2, 5, 20)],
    depth,
  )[0];
  assert.deepEqual(together, alone);
  assert.ok(alone[0] > 0.5, "a lone off-center subject is not recentered");
  const u = 0.5 + alone[0] / (-alone[2] * 2 * Math.tan(Math.PI / 6) * (4 / 3));
  assert.ok(Math.abs(u - 0.765) < 1e-9);
});

test("mask sampling retains depth when masks and depth images have different resolutions", () => {
  const depth = { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) };
  for (let y = 0; y < depth.height; y++)
    for (let x = 0; x < depth.width; x++)
      depth.data[(y * depth.width + x) * 4] = x < 4 ? 220 : 30;
  const subjects = (width: number, height: number) =>
    [0, 1].map((side) => {
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          if (Number(x >= width / 2) === side) data[(y * width + x) * 4] = 255;
      const u = side ? 0.8 : 0.2;
      return {
        box: [0.2, u - 0.1, 1, u + 0.1] as [number, number, number, number],
        faceBox: [0.2, u - 0.03, 0.28, u + 0.03] as [
          number,
          number,
          number,
          number,
        ],
        mask: { width, height, data },
      };
    });
  const full = layoutHumanBodies(subjects(8, 4), depth);
  const small = layoutHumanBodies(subjects(4, 2), depth);
  assert.deepEqual(small, full);
  assert.ok(full[0][2] > full[1][2], "near mask still samples the near side");
});

test("source aspect overrides a resized depth image for both posed and unposed people", () => {
  const posed = crowdPerson(0.7, 2, 40, 60);
  const unposed = { ...posed, poseRig: undefined };
  const depth = {
    width: 8,
    height: 8,
    data: new Uint8Array(8 * 8 * 4).fill(128),
  };
  for (const subject of [posed, unposed]) {
    const [x, , z] = layoutHumanBodies([subject], depth, 1.25, {
      aspect: 2,
    })[0];
    const head = subject.poseRig?.joints.head ?? new Vector3();
    const u =
      0.5 + (x + head.x) / (-(z + head.z) * 2 * Math.tan(Math.PI / 6) * 2);
    assert.ok(Math.abs(u - 0.7) < 1e-9);
  }
});

test("head centers keep a wide outstretched-arm mask in the correct place", () => {
  const pixels = { width: 4, height: 4, data: new Uint8Array(64).fill(128) };
  const positions = layoutHumanBodies(
    [
      { box: [0.2, 0, 1, 0.95], faceBox: [0.2, 0.6, 0.4, 0.72], mask: pixels },
      { box: [0.2, 0.1, 1, 0.4], faceBox: [0.2, 0.18, 0.4, 0.3], mask: pixels },
    ],
    pixels,
  );
  assert.ok(positions[0][0] > positions[1][0]);
  assert.deepEqual(layoutHumanBodies([], pixels), []);
});

function crowdPerson(
  u: number,
  distance: number,
  left: number,
  right: number,
  faceSize = 0.09,
) {
  const width = 64,
    height = 48,
    data = new Uint8Array(width * height * 4);
  for (let y = 18; y < height; y++)
    for (let x = left; x < right; x++) data[(y * width + x) * 4] = 255;
  const mask = { width, height, data };
  const rig = {
    sourceAnchor: [u, 0.6],
    sourceSize: { width: 1200, height: 900 },
    pixelsPerMeter: 900 / (2 * Math.tan(Math.PI / 6)) / distance,
    confidenceByJoint: { head: 0.9 },
    joints: { head: new Vector3(0.07, 0.65, 0.1) },
  } as unknown as HumanPoseRig;
  return {
    mask,
    poseRig: rig,
    bodyScale: 1,
    bodyMinY: -0.9,
    faceBox: [
      0.3,
      u - faceSize / 2,
      0.3 + (faceSize * 4) / 3,
      u + faceSize / 2,
    ] as [number, number, number, number],
    box: [0.2, left / width, 1, right / width] as [
      number,
      number,
      number,
      number,
    ],
  };
}

test("touching people retain crowd proximity despite conflicting individual depth estimates", () => {
  const subjects = [
    crowdPerson(0.44, 1.4, 12, 32),
    crowdPerson(0.55, 3, 32, 53),
  ];
  const depth = {
    ...subjects[0].mask,
    data: new Uint8Array(64 * 48 * 4).fill(128),
  };
  for (const strength of [0.35, 1.25, 2]) {
    const positions = layoutHumanBodies(subjects, depth, strength);
    assert.ok(
      Math.abs(positions[0][2] - positions[1][2]) <= 0.45001,
      "uncertain depth cannot introduce a walkable aisle between touching people",
    );
    assert.ok(
      Math.hypot(
        positions[0][0] - positions[1][0],
        positions[0][2] - positions[1][2],
      ) < 0.65,
    );
    assert.ok(
      Math.abs((positions[0][2] + positions[1][2]) / 2 + 2.2) < 1e-9,
      "correct relative spacing without moving the entire group closer",
    );
    const focal = 900 / (2 * Math.tan(Math.PI / 6));
    positions.forEach((position, i) => {
      const head = subjects[i].poseRig.joints.head;
      const projectedFace =
        0.5 +
        (((position[0] + head.x) / -(position[2] + head.z)) * focal) / 1200;
      assert.ok(
        Math.abs(projectedFace - subjects[i].poseRig.sourceAnchor[0]) < 1e-9,
        "visible faces keep their photographed horizontal positions after compaction",
      );
      assert.equal(position[1], 0.9, "grounding is unchanged");
    });
  }
});

test("separate silhouettes and truly smaller distant faces retain their depth separation", () => {
  for (const subjects of [
    [crowdPerson(0.44, 1.4, 10, 24), crowdPerson(0.55, 3, 40, 56)],
    [crowdPerson(0.44, 1.4, 12, 32), crowdPerson(0.55, 3, 32, 53, 0.025)],
  ]) {
    const depth = {
      ...subjects[0].mask,
      data: new Uint8Array(64 * 48 * 4).fill(128),
    };
    const positions = layoutHumanBodies(subjects, depth);
    assert.ok(
      Math.abs(positions[0][2] - positions[1][2]) > 1.5,
      "proximity correction must not flatten unrelated foreground and background people",
    );
  }
});
