import * as THREE from "three";
import type { HumanPose } from "../types";
import { isPoseIntent, type PoseIntent, type PoseArmGesture } from "../pose-intent";

export type HumanJoint =
  | "hips"
  | "shoulders"
  | "head"
  | `${"left" | "right"}${"Shoulder" | "Elbow" | "Wrist" | "Hip" | "Knee" | "Ankle" | "Heel" | "Toe"}`;
export interface HumanPoseRig {
  joints: Record<HumanJoint, THREE.Vector3>;
  confidenceByJoint: Record<string, number>;
  sourceLandmarkIndex: Record<string, number>;
  torsoQuaternion: THREE.Quaternion;
  shoulderWidth: number;
  hipWidth: number;
  torsoLength: number;
  sourceAnchor: [number, number];
  pixelsPerMeter: number;
  sourceSize: { width: number; height: number };
  headRoll: number;
  pose: HumanPose;
  /** Semantic-prior joints remain inferred; source landmark scores stay intact. */
  inferredIntentJoints?: HumanJoint[];
  poseIntent?: PoseIntent;
}
export function humanPoseReprojection(rig: HumanPoseRig) {
  const errors = Object.entries(rig.sourceLandmarkIndex)
    .flatMap(([name, index]) => {
      if (name === "head" || rig.confidenceByJoint[name] < 0.6) return [];
      const p = rig.joints[name as HumanJoint],
        target = rig.pose.landmarks[index].image;
      return [
        Math.hypot(
          (rig.sourceAnchor[0] - target[0]) * rig.sourceSize.width +
            p.x * rig.pixelsPerMeter,
          (rig.sourceAnchor[1] - target[1]) * rig.sourceSize.height -
            p.y * rig.pixelsPerMeter,
        ),
      ];
    })
    .sort((a, b) => a - b);
  return {
    observedJoints: errors.length,
    medianPixels: errors.length ? errors[Math.floor(errors.length / 2)] : 0,
    maximumPixels: errors.length ? errors[errors.length - 1] : 0,
  };
}
const clamp = THREE.MathUtils.clamp;
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const UP = new THREE.Vector3(0, 1, 0);

/** Recover articulated anatomy from observed joints. Image directions carry the
 * photographic pose; world depth disambiguates foreshortening. Weak joints use
 * explicit local priors, never an unreliable detector coordinate. */
export function fitHumanPose(
  pose: HumanPose | undefined,
  image: { width: number; height: number },
  intent?: PoseIntent,
): HumanPoseRig | undefined {
  if (!pose || pose.landmarks.length !== 33 || pose.confidence < 0.25) return;
  const lm = pose.landmarks;
  const confidence = (i: number) => Math.min(lm[i].visibility, lm[i].presence);
  // Occlusion is per joint: one hidden shoulder must not discard a visible
  // seated torso, face or raised arm and replace the person with a standing body.
  const shouldersObserved = Math.min(confidence(11), confidence(12)) >= 0.32;
  if (Math.max(confidence(11), confidence(12)) < 0.32 && confidence(0) < 0.6)
    return;
  const world = (i: number) =>
    new THREE.Vector3(lm[i].world[0], -lm[i].world[1], -lm[i].world[2]);
  const photo = (i: number) =>
    new THREE.Vector2(
      lm[i].image[0] * image.width,
      -lm[i].image[1] * image.height,
    );
  const scales: number[] = [];
  for (const [a, b] of [
    [11, 12],
    [11, 23],
    [12, 24],
    [23, 24],
    [11, 13],
    [12, 14],
    [23, 25],
    [24, 26],
  ]) {
    if (Math.min(confidence(a), confidence(b)) < 0.5) continue;
    const w = world(a).sub(world(b));
    const px = photo(a).distanceTo(photo(b));
    const projected = Math.hypot(w.x, w.y);
    if (projected > 0.08 && px > 5) scales.push(px / projected);
  }
  const shoulderPx = photo(11).distanceTo(photo(12));
  const pixelsPerMeter = clamp(
    scales.length ? median(scales) : shoulderPx / 0.39,
    30,
    image.height * 5,
  );
  const vector = (a: number, b: number) => {
    const p = photo(b).sub(photo(a)).divideScalar(pixelsPerMeter);
    return new THREE.Vector3(p.x, p.y, clamp(world(b).z - world(a).z, -1, 1));
  };
  const length = (
    a: number,
    b: number,
    fallback: number,
    lo: number,
    hi: number,
  ) => {
    const c = Math.min(confidence(a), confidence(b));
    const measured = world(a).distanceTo(world(b));
    return THREE.MathUtils.lerp(
      fallback,
      clamp(measured, lo, hi),
      clamp((c - 0.3) / 0.5, 0, 0.85),
    );
  };
  const hipsObserved = Math.min(confidence(23), confidence(24)) >= 0.35;
  const hipMid = photo(23).add(photo(24)).multiplyScalar(0.5);
  const torsoLength = hipsObserved
    ? clamp(
        (length(11, 23, 0.47, 0.36, 0.62) + length(12, 24, 0.47, 0.36, 0.62)) /
          2,
        0.36,
        0.62,
      )
    : 0.47;
  const torsoVectors = [
    [23, 11],
    [24, 12],
  ]
    .filter(
      ([hip, shoulder]) =>
        Math.min(confidence(hip), confidence(shoulder)) >= 0.35,
    )
    .map(([hip, shoulder]) => vector(hip, shoulder));
  let torsoUp = torsoVectors.length
    ? torsoVectors.reduce((a, b) => a.add(b), new THREE.Vector3()).normalize()
    : world(11).add(world(12)).sub(world(23)).sub(world(24)).normalize();
  if (torsoUp.lengthSq() < 0.5) torsoUp = UP.clone();
  // Rig left/right names are camera-side. Keep the source association explicit:
  // a rear view reverses MediaPipe's anatomical left/right without crossing arms.
  const left = lm[11].image[0] <= lm[12].image[0] ? 11 : 12;
  const right = left === 11 ? 12 : 11;
  let across = (
    shouldersObserved ? vector(left, right) : world(right).sub(world(left))
  ).normalize();
  across.addScaledVector(torsoUp, -across.dot(torsoUp)).normalize();
  if (across.lengthSq() < 0.5) across.set(1, 0, 0);
  const front = across.clone().cross(torsoUp).normalize();
  const torsoQuaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(across, torsoUp, front),
  );
  const shoulderWidth = length(11, 12, 0.39, 0.29, 0.55);
  const hipWidth = hipsObserved ? length(23, 24, 0.205, 0.17, 0.34) : 0.205;
  const joints = {
    hips: new THREE.Vector3(),
    shoulders: torsoUp.clone().multiplyScalar(torsoLength),
  } as Record<HumanJoint, THREE.Vector3>;
  const anchorShoulder = confidence(11) >= confidence(12) ? 11 : 12;
  const anchorJoint = joints.shoulders
    .clone()
    .addScaledVector(
      across,
      ((anchorShoulder === left ? -1 : 1) * shoulderWidth) / 2,
    );
  const sourceAnchor: [number, number] = hipsObserved
    ? [hipMid.x / image.width, -hipMid.y / image.height]
    : [
        lm[anchorShoulder].image[0] -
          (anchorJoint.x * pixelsPerMeter) / image.width,
        lm[anchorShoulder].image[1] +
          (anchorJoint.y * pixelsPerMeter) / image.height,
      ];
  const confidenceByJoint: Record<string, number> = {
    hips: Math.min(confidence(23), confidence(24)),
    shoulders: Math.min(confidence(11), confidence(12)),
  };
  const sourceLandmarkIndex: Record<string, number> = {};
  const chain = (
    name: HumanJoint,
    parent: HumanJoint,
    a: number,
    b: number,
    fallback: THREE.Vector3,
    nominal: number,
    min: number,
    max: number,
  ) => {
    const c = Math.min(confidence(a), confidence(b));
    const measured =
      confidence(a) >= 0.38
        ? vector(a, b)
        : new THREE.Vector3(
            ((lm[b].image[0] - sourceAnchor[0]) * image.width) / pixelsPerMeter,
            (-(lm[b].image[1] - sourceAnchor[1]) * image.height) /
              pixelsPerMeter,
            world(b).z,
          ).sub(joints[parent]);
    const dir =
      confidence(b) >= 0.38 && measured.lengthSq() > 1e-5
        ? measured.normalize()
        : fallback.clone().normalize();
    joints[name] = joints[parent]
      .clone()
      .addScaledVector(dir, length(a, b, nominal, min, max));
    confidenceByJoint[name] = c;
    sourceLandmarkIndex[name] = b;
  };
  for (const [side, shoulder, sign] of [
    ["left", left, -1],
    ["right", right, 1],
  ] as const) {
    const hip = shoulder + 12,
      elbow = shoulder + 2,
      wrist = shoulder + 4,
      knee = shoulder + 14,
      ankle = shoulder + 16;
    joints[`${side}Shoulder`] = joints.shoulders
      .clone()
      .addScaledVector(across, (sign * shoulderWidth) / 2);
    joints[`${side}Hip`] = joints.hips
      .clone()
      .addScaledVector(across, (sign * hipWidth) / 2);
    for (const [name, i] of [
      [`${side}Shoulder`, shoulder],
      [`${side}Hip`, hip],
    ] as const) {
      confidenceByJoint[name] = confidence(i);
      sourceLandmarkIndex[name] = i;
    }
    chain(
      `${side}Elbow`,
      `${side}Shoulder`,
      shoulder,
      elbow,
      torsoUp
        .clone()
        .negate()
        .addScaledVector(across, sign * 0.18),
      0.29,
      0.22,
      0.38,
    );
    chain(
      `${side}Wrist`,
      `${side}Elbow`,
      elbow,
      wrist,
      joints[`${side}Elbow`].clone().sub(joints[`${side}Shoulder`]),
      0.255,
      0.2,
      0.34,
    );
    chain(
      `${side}Knee`,
      `${side}Hip`,
      hip,
      knee,
      new THREE.Vector3(0, -1, 0.04),
      0.415,
      0.32,
      0.53,
    );
    // With an uncertain ankle, a crowd detector's inward knee can otherwise
    // extrapolate an entire leg across its neighbor. Use a conservative prior
    // only for that uncertain chain; observed cross-legged poses stay intact.
    const thigh = joints[`${side}Knee`].clone().sub(joints[`${side}Hip`]);
    const thighLength = thigh.length(),
      inward = thigh.dot(across) * sign;
    const minimumLateral = -thighLength * Math.sin(Math.PI / 6);
    if (
      inward < minimumLateral &&
      (confidence(knee) < 0.6 || confidence(ankle) < 0.38)
    ) {
      const lateral = thigh.dot(across);
      const other = thigh
        .clone()
        .addScaledVector(across, -lateral)
        .normalize()
        .multiplyScalar(
          Math.sqrt(
            thighLength * thighLength - minimumLateral * minimumLateral,
          ),
        );
      joints[`${side}Knee`]
        .copy(joints[`${side}Hip`])
        .add(other)
        .addScaledVector(across, sign * minimumLateral);
    }
    chain(
      `${side}Ankle`,
      `${side}Knee`,
      knee,
      ankle,
      joints[`${side}Knee`].clone().sub(joints[`${side}Hip`]),
      0.405,
      0.3,
      0.52,
    );
    if (confidence(knee) < .38 && confidence(ankle) >= .55 && confidence(hip) >= .5) {
      // An observed ankle constrains a hidden knee even without a semantic hint.
      // A downwards default knee followed by an observed crossed ankle otherwise
      // creates a spurious hanging leg on a clearly seated person.
      const root = joints[`${side}Hip`];
      const observedAnkle = new THREE.Vector3(
        ((lm[ankle].image[0] - sourceAnchor[0]) * image.width) / pixelsPerMeter,
        (-(lm[ankle].image[1] - sourceAnchor[1]) * image.height) / pixelsPerMeter,
        world(ankle).z,
      );
      const preferred = root.clone().addScaledVector(front, .4).addScaledVector(across, sign * .1);
      const solved = solveElbow(root, observedAnkle, preferred,
        length(hip, knee, .415, .32, .53), length(knee, ankle, .405, .3, .52));
      joints[`${side}Knee`].copy(solved.elbow);
      joints[`${side}Ankle`].copy(solved.wrist);
    }
    chain(
      `${side}Heel`,
      `${side}Ankle`,
      ankle,
      shoulder + 18,
      new THREE.Vector3(0, -0.45, -0.5),
      0.06,
      0.035,
      0.1,
    );
    chain(
      `${side}Toe`,
      `${side}Ankle`,
      ankle,
      shoulder + 20,
      new THREE.Vector3(0, -0.25, 1),
      0.15,
      0.1,
      0.22,
    );
  }
  const face = [0, 7, 8].filter((i) => confidence(i) > 0.45);
  const headDir = face.length
    ? face
        .map((i) =>
          new THREE.Vector3(
            ((lm[i].image[0] - sourceAnchor[0]) * image.width) / pixelsPerMeter,
            (-(lm[i].image[1] - sourceAnchor[1]) * image.height) /
              pixelsPerMeter,
            world(i).z,
          ).sub(joints.shoulders),
        )
        .reduce((a, b) => a.add(b), new THREE.Vector3())
        .normalize()
    : torsoUp;
  joints.head = joints.shoulders
    .clone()
    .addScaledVector(headDir.lengthSq() > 0.5 ? headDir : torsoUp, 0.245);
  confidenceByJoint.head = face.length
    ? face.reduce((sum, i) => sum + confidence(i), 0) / face.length
    : 0;
  sourceLandmarkIndex.head = 0;
  const eyes = photo(5).sub(photo(2));
  const headRoll =
    Math.min(confidence(2), confidence(5)) > 0.5
      ? Math.atan2(eyes.y * Math.sign(eyes.x || 1), Math.abs(eyes.x))
      : 0;
  const rig: HumanPoseRig = {
    joints,
    confidenceByJoint,
    sourceLandmarkIndex,
    torsoQuaternion,
    shoulderWidth,
    hipWidth,
    torsoLength,
    sourceAnchor,
    pixelsPerMeter,
    // Browser ImageData exposes width/height through prototype getters, so
    // spreading it produces an empty object and poisons all scene placements.
    sourceSize: { width: image.width, height: image.height },
    headRoll,
    pose,
  };
  if (isPoseIntent(intent)) applyPoseIntent(rig, intent);
  return rig;
}

/** Two-bone IK keeps a gesture's wrist target inside anatomical reach. The
 * preferred bend selects the elbow side instead of allowing the inverse
 * solution to snap through the chest. */
function solveElbow(
  shoulder: THREE.Vector3, target: THREE.Vector3, preferred: THREE.Vector3,
  upper: number, lower: number,
) {
  const axis = target.clone().sub(shoulder);
  const distance = clamp(axis.length(), Math.abs(upper - lower) + .005, upper + lower - .005);
  if (axis.lengthSq() < 1e-8) axis.set(0, -1, 0);
  axis.normalize();
  const wrist = shoulder.clone().addScaledVector(axis, distance);
  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  const bend = preferred.clone().sub(shoulder);
  bend.addScaledVector(axis, -bend.dot(axis));
  if (bend.lengthSq() < 1e-8) {
    bend.set(0, 0, 1).addScaledVector(axis, -axis.z);
    if (bend.lengthSq() < 1e-8) bend.set(1, 0, 0).addScaledVector(axis, -axis.x);
  }
  const elbow = shoulder.clone().addScaledVector(axis, along).addScaledVector(bend.normalize(), height);
  return { elbow, wrist };
}

/** Constrain occluded limbs from source-grounded semantic hints. Measured
 * landmarks always win: even a very confident gesture cannot overwrite a
 * visible wrist, elbow, or leg. No detector coordinates/confidences are edited. */
export function applyPoseIntent(rig: HumanPoseRig, intent: PoseIntent) {
  if (!isPoseIntent(intent) || intent.confidence < .7) return rig;
  rig.poseIntent = structuredClone(intent);
  const changed = new Set<HumanJoint>(rig.inferredIntentJoints ?? []);
  const jointConfidence = (joint: HumanJoint) => {
    const landmark = rig.pose.landmarks[rig.sourceLandmarkIndex[joint]];
    return landmark ? Math.min(landmark.visibility, landmark.presence) : 0;
  };
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.torsoQuaternion);
  const across = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.torsoQuaternion);
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.torsoQuaternion);
  const local = (x: number, y: number, z: number) => rig.joints.hips.clone()
    .addScaledVector(across, x).addScaledVector(up, y).addScaledVector(front, z);
  const setInferred = (joint: HumanJoint, position: THREE.Vector3) => {
    if (jointConfidence(joint) >= .55) return;
    rig.joints[joint].copy(position);
    changed.add(joint);
  };
  for (const [side, sign] of [["left", -1], ["right", 1]] as const) {
    const shoulderName = `${side}Shoulder` as const;
    const elbowName = `${side}Elbow` as const;
    const wristName = `${side}Wrist` as const;
    const anatomicalSide = rig.sourceLandmarkIndex[shoulderName] === 11 ? "leftArm" : "rightArm";
    const arm = intent[anatomicalSide];
    if (!arm || arm.confidence < .7 || arm.gesture === "unknown" || jointConfidence(shoulderName) < .4) continue;
    if (jointConfidence(elbowName) >= .55 && jointConfidence(wristName) >= .55) continue;
    const shoulder = rig.joints[shoulderName], elbow = rig.joints[elbowName], wrist = rig.joints[wristName];
    const upper = clamp(shoulder.distanceTo(elbow), .22, .38);
    const lower = clamp(elbow.distanceTo(wrist), .2, .34);
    const t = rig.torsoLength;
    const wristTargets: Record<Exclude<PoseArmGesture, "unknown">, THREE.Vector3> = {
      relaxed: local(sign * (rig.shoulderWidth / 2 + .06), t - upper - lower, .035),
      crossed: local(-sign * rig.shoulderWidth * .32, t * .58 + (side === "left" ? .025 : -.025), .145 + (side === "left" ? .025 : 0)),
      "hand-in-pocket": local(sign * rig.hipWidth * .66, -.035, .095),
      "hand-on-hip": local(sign * rig.hipWidth * .82, .10, .06),
      "hand-to-chin": rig.joints.head.clone().addScaledVector(up, -.085).addScaledVector(front, .105),
      raised: shoulder.clone().addScaledVector(up, upper + lower - .025).addScaledVector(across, sign * .07).addScaledVector(front, .04),
    };
    const preferred = arm.gesture === "crossed"
      ? local(sign * rig.shoulderWidth * .62, t * .38, .13)
      : arm.gesture === "hand-to-chin"
        ? local(sign * rig.shoulderWidth * .65, t * .5, .14)
        : local(sign * (rig.shoulderWidth / 2 + .13), t * .42, .08);
    const target = jointConfidence(wristName) >= .55 ? wrist.clone() : wristTargets[arm.gesture];
    if (jointConfidence(elbowName) >= .55) {
      // A visible elbow anchors the hand even when a semantic target is farther away.
      const direction = target.clone().sub(elbow).normalize();
      if (direction.lengthSq() > .5) setInferred(wristName, elbow.clone().addScaledVector(direction, lower));
    } else {
      const solved = solveElbow(shoulder, target, preferred, upper, lower);
      setInferred(elbowName, solved.elbow);
      setInferred(wristName, solved.wrist);
    }
  }
  if (intent.confidence >= .8 && (intent.posture === "seated" || intent.posture === "crouched")) {
    for (const [side, sign] of [["left", -1], ["right", 1]] as const) {
      const hip = rig.joints[`${side}Hip`], knee = rig.joints[`${side}Knee`], ankle = rig.joints[`${side}Ankle`];
      const thigh = clamp(hip.distanceTo(knee), .32, .53), calf = clamp(knee.distanceTo(ankle), .30, .52);
      const kneeTarget = hip.clone().addScaledVector(up, intent.posture === "seated" ? -.08 : -.24)
        .addScaledVector(front, intent.posture === "seated" ? .4 : .28)
        .addScaledVector(across, sign * .035);
      kneeTarget.sub(hip).normalize().multiplyScalar(thigh).add(hip);
      // A visible foot still anchors the leg when the knee is occluded. Solve
      // toward that observation instead of pulling the knee to a sitting prior.
      const anchoredKnee = jointConfidence(`${side}Ankle`) >= .55
        ? solveElbow(hip, ankle, kneeTarget, thigh, calf).elbow : kneeTarget;
      setInferred(`${side}Knee`, anchoredKnee);
      const ankleTarget = rig.joints[`${side}Knee`].clone().addScaledVector(up, -calf).addScaledVector(front, -.025);
      setInferred(`${side}Ankle`, ankleTarget);
      setInferred(`${side}Heel`, rig.joints[`${side}Ankle`].clone().addScaledVector(up, -.035).addScaledVector(front, -.045));
      setInferred(`${side}Toe`, rig.joints[`${side}Ankle`].clone().addScaledVector(up, -.035).addScaledVector(front, .14));
    }
  }
  if (changed.size) {
    rig.inferredIntentJoints = [...changed];
    rig.poseIntent = structuredClone(intent);
  }
  return rig;
}

/** Visible index/pinky landmarks orient the hand independently from the
 * forearm. Occluded hands use a bounded gesture direction instead of extending
 * straight through the face for a chin pose. This does not infer finger joints. */
export function posedHandDirection(rig: HumanPoseRig, side: "left" | "right") {
  const wristIndex = rig.sourceLandmarkIndex[`${side}Wrist`];
  const wrist = rig.pose.landmarks[wristIndex];
  if (wrist && Math.min(wrist.visibility, wrist.presence) >= .55) {
    const fingers = [wristIndex + 2, wristIndex + 4].map(i => rig.pose.landmarks[i])
      .filter(joint => joint && Math.min(joint.visibility, joint.presence) >= .55);
    const direction = new THREE.Vector3();
    let count = 0;
    for (const finger of fingers) {
      const measured = new THREE.Vector3(
        (finger.image[0] - wrist.image[0]) * rig.sourceSize.width / rig.pixelsPerMeter,
        -(finger.image[1] - wrist.image[1]) * rig.sourceSize.height / rig.pixelsPerMeter,
        -(finger.world[2] - wrist.world[2]),
      );
      if (measured.length() >= .025 && measured.length() <= .25) { direction.add(measured); count++; }
    }
    if (count && direction.lengthSq() > .0001) return direction.normalize();
  }
  const anatomical = rig.sourceLandmarkIndex[`${side}Shoulder`] === 11 ? "leftArm" : "rightArm";
  const arm = rig.poseIntent?.[anatomical];
  const sign = side === "left" ? -1 : 1;
  if (arm && arm.confidence >= .7) {
    const local = arm.gesture === "hand-to-chin" ? new THREE.Vector3(-sign * .15, .65, .75)
      : arm.gesture === "hand-in-pocket" ? new THREE.Vector3(sign * .1, -1, .05)
        : arm.gesture === "crossed" ? new THREE.Vector3(-sign, .05, .05) : undefined;
    if (local) return local.normalize().applyQuaternion(rig.torsoQuaternion);
  }
  return rig.joints[`${side}Wrist`].clone().sub(rig.joints[`${side}Elbow`]).normalize();
}

/** A per-bone camera registration avoids stretching an upright photo crop over
 * a seated torso or sending shoulder fabric down a raised forearm. */
export function projectPosePoint(
  point: THREE.Vector3,
  rig: HumanPoseRig,
  image: { width: number; height: number },
  part: string,
): { u: number; v: number; confidence: number } {
  const side = part.startsWith("left") ? "left" : "right";
  let a: HumanJoint = "hips",
    b: HumanJoint = "shoulders";
  if (/upper.arm|sleeve/.test(part)) {
    a = `${side}Shoulder`;
    b = `${side}Elbow`;
  } else if (/forearm|hand|finger|thumb/.test(part)) {
    a = `${side}Elbow`;
    b = `${side}Wrist`;
  } else if (/thigh/.test(part)) {
    a = `${side}Hip`;
    b = `${side}Knee`;
  } else if (/calf|knee/.test(part)) {
    a = `${side}Knee`;
    b = `${side}Ankle`;
  } else if (/shoe|sole/.test(part)) {
    a = `${side}Heel`;
    b = `${side}Toe`;
  }
  if (a === "hips")
    return {
      u: rig.sourceAnchor[0] + (point.x * rig.pixelsPerMeter) / image.width,
      v: rig.sourceAnchor[1] - (point.y * rig.pixelsPerMeter) / image.height,
      confidence: Math.min(
        rig.confidenceByJoint.hips,
        rig.confidenceByJoint.shoulders,
      ),
    };
  const ai = rig.sourceLandmarkIndex[a],
    bi = rig.sourceLandmarkIndex[b];
  const pa = rig.pose.landmarks[ai].image,
    pb = rig.pose.landmarks[bi].image;
  const ja = rig.joints[a],
    jb = rig.joints[b];
  const px = point.x - ja.x,
    py = point.y - ja.y,
    pz = point.z - ja.z;
  const bx = jb.x - ja.x,
    by = jb.y - ja.y,
    bz = jb.z - ja.z;
  const t = clamp(
    (px * bx + py * by + pz * bz) /
      Math.max(0.0001, bx * bx + by * by + bz * bz),
    -0.2,
    1.2,
  );
  return {
    u:
      THREE.MathUtils.lerp(pa[0], pb[0], t) +
      ((px - bx * t) * rig.pixelsPerMeter) / image.width,
    v:
      THREE.MathUtils.lerp(pa[1], pb[1], t) -
      ((py - by * t) * rig.pixelsPerMeter) / image.height,
    confidence: Math.min(rig.confidenceByJoint[a], rig.confidenceByJoint[b]),
  };
}
