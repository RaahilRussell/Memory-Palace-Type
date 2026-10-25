import type { HumanPose } from "./types";

export const POSE_ARM_GESTURES = [
  "relaxed", "crossed", "hand-in-pocket", "hand-on-hip", "hand-to-chin", "raised", "unknown",
] as const;
export type PoseArmGesture = (typeof POSE_ARM_GESTURES)[number];
export interface PoseArmIntent {
  gesture: PoseArmGesture;
  confidence: number;
}
/** Semantic evidence from the photograph, not measured joints. Left and right
 * mean the person's anatomical sides, including in a rear-facing photograph. */
export interface PoseIntent {
  version: 1;
  source: "image-understanding";
  confidence: number;
  posture: "standing" | "seated" | "crouched" | "unknown";
  leftArm?: PoseArmIntent;
  rightArm?: PoseArmIntent;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const score = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every(key => keys.includes(key));
export function isPoseIntent(value: unknown): value is PoseIntent {
  if (!record(value) || !only(value, ["version", "source", "confidence", "posture", "leftArm", "rightArm"]) ||
    value.version !== 1 || value.source !== "image-understanding" || !score(value.confidence) ||
    !["standing", "seated", "crouched", "unknown"].includes(String(value.posture))) return false;
  return [value.leftArm, value.rightArm].every(arm => arm === undefined ||
    record(arm) && only(arm, ["gesture", "confidence"]) &&
    POSE_ARM_GESTURES.includes(arm.gesture as PoseArmGesture) && score(arm.confidence));
}

/** A completed detector pass is not proof that this person has a usable pose.
 * Semantic hints can support hidden arms only when a measured torso anchors
 * them. They never create a measured person or raise landmark confidence. */
export function assessPoseSupport(pose: HumanPose | undefined, intent?: PoseIntent) {
  const measured = (index: number) => {
    const joint = pose?.landmarks[index];
    return joint ? Math.min(joint.visibility, joint.presence) : 0;
  };
  const observedJointCount = pose?.landmarks.filter(joint =>
    Math.min(joint.visibility, joint.presence) >= .55).length ?? 0;
  const observedArmCount = [[13, 15], [14, 16]].filter(indices => indices.every(i => measured(i) >= .55)).length;
  const observedKneeCount = [25, 26].filter(index => measured(index) >= .55).length;
  const semanticArmCount = isPoseIntent(intent) && intent.confidence >= .8
    ? [intent.leftArm, intent.rightArm].filter(arm => arm && arm.confidence >= .8 && arm.gesture !== "unknown").length : 0;
  const shoulders = measured(11) >= .5 && measured(12) >= .5;
  const hips = measured(23) >= .4 && measured(24) >= .4;
  const bodyAnchored = !!pose && pose.confidence >= .4 && shoulders && hips;
  const semanticPosture = isPoseIntent(intent) && intent.confidence >= .8 && intent.posture !== "unknown";
  const partialAnchored = !!pose && pose.confidence >= .4 && shoulders && measured(0) >= .6 && semanticPosture;
  // Hidden knees do not establish a standing body. This matters for seated
  // people whose torso/arms can score highly while a cloak or table hides legs.
  const postureSupported = observedKneeCount === 2 || semanticPosture;
  const canReplace = (bodyAnchored || partialAnchored) && postureSupported &&
    (observedArmCount === 2 || [0, 1].every(i => {
      const arm = i === 0 ? intent?.leftArm : intent?.rightArm;
      return [13 + i, 15 + i].every(index => measured(index) >= .55) ||
        semanticArmCount > 0 && !!arm && arm.confidence >= .8 && arm.gesture !== "unknown";
    }));
  return {
    canReplace,
    reason: canReplace ? (observedArmCount === 2 && observedKneeCount === 2 ? "measured-pose" : "measured-torso-with-inferred-limbs") : "insufficient-pose-evidence",
    observedJointCount, observedArmCount, observedKneeCount, semanticArmCount, postureSupported,
    poseConfidence: pose?.confidence ?? 0,
  };
}
