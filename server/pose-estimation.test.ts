import test from 'node:test';
import assert from 'node:assert/strict';
import { associatePoses, constrainPoseToMask, matchPoseCandidates, type PoseDetection } from './pose-estimation.js';
import { HUMAN_POSE_LANDMARK_NAMES, type HumanPose, type WorldCompletion } from '../src/types.js';

function pose(x: number): HumanPose {
  return { version: 1, source: 'mediapipe-pose', model: 'pose-landmarker-full', confidence: .9, observedFraction: 1,
    sourceBox: [0, Math.max(0, x - .2), 1, Math.min(1, x + .2)],
    landmarks: HUMAN_POSE_LANDMARK_NAMES.map((name, i) => ({ name, image: [x, i < 11 ? .2 : .6, 0], world: [0, 0, 0], visibility: .9, presence: .9 })) };
}
const subjects: WorldCompletion['subjects'] = [
  { id: 'left', label: 'person', kind: 'person', box: [0, 0, 1, .8], maskUrl: '/uploads/reconstructions/test-left.png' },
  { id: 'right', label: 'person', kind: 'person', box: [0, .2, 1, 1], maskUrl: '/uploads/reconstructions/test-right.png' },
  { id: 'chair', label: 'chair', kind: 'object', box: [0, 0, 1, 1], maskUrl: '/uploads/reconstructions/test-chair.png' },
];

test('overlapping crowd boxes associate unique poses using observed person-mask pixels', () => {
  const masks = new Map(['left', 'right'].map((id, index) => [id, { width: 10, height: 10,
    data: Uint8Array.from({ length: 100 }, (_, i) => (i % 10 < 5) === (index === 0) ? 255 : 0) }]));
  const detections: PoseDetection[] = [{ pose: pose(.7), maskUrl: '/uploads/reconstructions/a.png' }, { pose: pose(.3), maskUrl: '/uploads/reconstructions/b.png' }];
  const result = associatePoses(subjects, detections, masks);
  assert.deepEqual(result.matches.map(match => [subjects[match.subject].id, match.detection]).sort(), [['left', 1], ['right', 0]]);
  assert.deepEqual(result.unmatched, []);
});

test('one pose cannot attach to two overlapping subjects and hidden joints cannot win matching', () => {
  const detection = { pose: pose(.4), maskUrl: '/uploads/reconstructions/a.png' };
  const result = associatePoses(subjects, [detection]);
  assert.equal(result.matches.length, 1);
  for (const point of detection.pose.landmarks) point.visibility = .2;
  assert.equal(associatePoses(subjects, [detection]).matches.length, 0);
});

test('a cropped or back-facing head does not prevent association from visible shoulders', () => {
  const detection = { pose: pose(.3), maskUrl: '/uploads/reconstructions/a.png' };
  for (const point of detection.pose.landmarks.slice(0, 11)) { point.image = [2, -1, 0]; point.visibility = .1; }
  const result = associatePoses([subjects[0]], [detection]);
  assert.equal(result.matches.length, 1);
});

test('mask evidence lowers confidence in a neighbour-owned limb without changing inferred shape or source points', () => {
  const original = pose(.3);
  original.landmarks[14].image = [.8, .5, .1];
  const mask = { width: 100, height: 100, data: Uint8Array.from({ length: 10000 }, (_, i) => i % 100 < 50 ? 255 : 0) };
  const constrained = constrainPoseToMask(original, mask);
  assert.equal(constrained.landmarks[14].visibility, .2);
  assert.equal(constrained.landmarks[14].presence, .9);
  assert.deepEqual(constrained.landmarks[14].image, original.landmarks[14].image);
  assert.deepEqual(constrained.landmarks[14].world, original.landmarks[14].world);
  assert.equal(constrained.landmarks[11].visibility, .9);
  assert.equal(original.landmarks[14].visibility, .9, 'Raw model evidence remains immutable.');
  assert.equal(constrained.observedFraction, 32 / 33);
});

test('global matching does not let a flexible candidate steal another person\'s only supported pose', () => {
  const matches = matchPoseCandidates([
    { subject: 0, detection: 0, score: 1.1 },
    { subject: 1, detection: 0, score: .99 },
    { subject: 0, detection: 1, score: .95 },
  ]);
  assert.deepEqual(matches.map(({ subject, detection }) => [subject, detection]), [[0, 1], [1, 0]]);
});

test('global pose assignment maximizes evidence within the same matching count', () => {
  const matches = matchPoseCandidates([
    { subject: 0, detection: 0, score: .8 }, { subject: 0, detection: 1, score: .7 },
    { subject: 1, detection: 0, score: .75 }, { subject: 1, detection: 1, score: .4 },
    { subject: 2, detection: 2, score: .9 },
  ]);
  assert.deepEqual(matches.map(({ subject, detection }) => [subject, detection]), [[0, 1], [1, 0], [2, 2]]);
  assert.equal(new Set(matches.map(match => match.detection)).size, 3);
});

test('partial head masks retain the person supported by three measured torso anchors', () => {
  const observed = pose(.5);
  observed.sourceBox = [.1, .3, .9, .7];
  observed.landmarks[11].image = [.4, .4, 0];
  observed.landmarks[12].image = [.6, .4, 0];
  observed.landmarks[23].image = [.4, .7, 0];
  observed.landmarks[24].image = [.6, .7, 0];
  const person = { ...subjects[0], box: [.1, .3, .9, .7] as [number, number, number, number] };
  const mask = { width: 100, height: 100, data: new Uint8Array(10000) };
  for (const index of [11, 23, 24]) {
    const [x, y] = observed.landmarks[index].image;
    mask.data[Math.floor(y * 100) * 100 + Math.floor(x * 100)] = 255;
  }
  const result = associatePoses([person], [{ pose: observed, maskUrl: '/uploads/reconstructions/partial.png' }], new Map([[person.id, mask]]));
  assert.equal(result.matches.length, 1, 'Missing face pixels must not create a second person.');
  assert.deepEqual(result.unmatched, []);
  observed.landmarks[24].visibility = .2;
  assert.equal(associatePoses([person], [{ pose: observed, maskUrl: '/uploads/reconstructions/partial.png' }], new Map([[person.id, mask]])).matches.length, 0,
    'Two supported torso points are insufficient to override absent head evidence.');
  observed.landmarks[24].visibility = .9;
  observed.sourceBox = [0, .4, .5, .6];
  assert.equal(associatePoses([person], [{ pose: observed, maskUrl: '/uploads/reconstructions/partial.png' }], new Map([[person.id, mask]])).matches.length, 0,
    'A loose group box cannot claim a separate smaller pose.');
});
