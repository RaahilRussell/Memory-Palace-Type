import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cachedSceneUnderstanding, localSceneUnderstanding, localLayoutEvidence, SCENE_UNDERSTANDING_VERSION } from './scene-understanding.js';
import { associateScenePeople, isSceneUnderstanding, type SceneUnderstanding } from '../src/scene-understanding.js';
import type { WorldCompletion } from '../src/types.js';

const person = { id: 'person-a', label: 'person with one hand at chin', box: [.1, .1, .9, .4] as [number, number, number, number], confidence: .9, visibility: 'partial' as const, poseIntent: { version: 1 as const, source: 'image-understanding' as const, posture: 'seated' as const, confidence: .8, leftArm: { gesture: 'hand-to-chin' as const, confidence: .85 }, rightArm: { gesture: 'unknown' as const, confidence: .2 } } };
const evidence: SceneUnderstanding = { version: 1, source: 'gemini', status: 'complete', environment: 'outdoor', confidence: .9, horizon: .6, structures: [{ id: 'column', label: 'visible brick column', kind: 'column', depthBand: 'middle', box: [.1, .5, .9, .55], confidence: .9, visibility: 'clear' }], objects: [{ id: 'phone', label: 'phone', category: 'phone', box: [.3, .2, .4, .3], confidence: .9, visibility: 'partial' }], people: [person], relations: [{ subjectId: 'phone', relation: 'held-by', objectId: 'person-a', confidence: .8 }], limitations: ['Hidden hands are uncertain.'] };

test('scene evidence validates relations, bounded boxes, uncertain gestures, and finite confidence', () => {
  assert.ok(isSceneUnderstanding(evidence));
  for (const invalid of [
    { ...evidence, horizon: NaN },
    { ...evidence, instructions: 'execute this' },
    { ...evidence, people: [{ ...person, box: [0, 0, 1, 2] }] },
    { ...evidence, people: [{ ...person, poseIntent: { ...person.poseIntent, source: 'mediapipe-pose' } }] },
    { ...evidence, objects: [{ ...evidence.objects[0], id: 'person-a' }] },
    { ...evidence, relations: [{ ...evidence.relations[0], objectId: 'missing' }] },
    { ...evidence, objects: Array.from({ length: 49 }, (_, i) => ({ ...evidence.objects[0], id: `o${i}` })) },
  ]) assert.equal(isSceneUnderstanding(invalid), false);
});

test('semantic arm intent is assigned one-to-one by source overlap, never array position', () => {
  const subjects = [{ id: 'right', kind: 'person', box: [.1, .6, .9, .9] as [number, number, number, number] }, { id: 'left', kind: 'person', box: person.box }, { id: 'duplicate', kind: 'person', box: person.box }];
  const matches = associateScenePeople(subjects, evidence);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].subjectId, 'left');
  assert.equal(matches[0].person.poseIntent?.leftArm?.gesture, 'hand-to-chin');
});

test('local fallback inventories detected objects without fabricating structures or arm positions', () => {
  const world: WorldCompletion = { version: 1, generatedBy: 'local-segmentation', backgroundUrl: '/uploads/reconstructions/test-background.jpg', subjects: [{ id: 'person', kind: 'person', label: 'person', box: person.box, maskUrl: '/uploads/reconstructions/person.png' }, { id: 'phone', kind: 'object', label: 'phone', box: [.2, .2, .3, .3], maskUrl: '/uploads/reconstructions/phone.png' }] };
  const local = localSceneUnderstanding(world);
  assert.ok(isSceneUnderstanding(local));
  assert.equal(local.status, 'partial');
  assert.equal(local.environment, 'unknown');
  assert.deepEqual(local.structures, []);
  assert.equal(local.people[0].poseIntent, undefined);
  assert.equal(local.objects[0].category, 'phone');
});

test('existing local panoptic labels supply structural evidence without turning a wall into a foreground object', () => {
  const layout = localLayoutEvidence([
    { label: 'ceiling-merged', box: [0, 0, .2, 1], confidence: .9, fraction: .17 },
    { label: 'wall-brick', box: [.2, 0, .8, .4], confidence: .92, fraction: .15 },
    { label: 'floor-wood', box: [.8, 0, 1, 1], confidence: .88, fraction: .19 },
    { label: 'door-stuff', box: [.2, .4, .8, .7], confidence: .55, fraction: .12 },
  ]);
  assert.equal(layout.environment, 'indoor');
  assert.deepEqual(layout.structures.map(s => s.kind), ['ceiling', 'wall', 'floor']);
  assert.equal(layout.structures.some(s => s.kind === 'column'), false);
  const outdoor = localLayoutEvidence([{ label: 'sky-other-merged', box: [0, 0, .6, 1], confidence: .93, fraction: .5 }, { label: 'building-other-merged', box: [.3, .2, .8, .7], confidence: .85, fraction: .18 }]);
  assert.equal(outdoor.environment, 'outdoor');
  assert.equal(outdoor.structures[0].kind, 'building');
  assert.equal(localLayoutEvidence([{ label: 'wall-brick', box: [0, 0, 1, 1], confidence: .9, fraction: .9 }]).environment, 'unknown', 'a wall alone does not establish that the camera is indoors');
});

test('scene analysis caches successful evidence and does not repeat charged failed or interrupted calls', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scene-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fallback = { ...evidence, source: 'local' as const, status: 'partial' as const };
  let calls = 0;
  const provider = async () => { calls++; return evidence; };
  const key = 'a'.repeat(32);
  assert.deepEqual(await cachedSceneUnderstanding(directory, key, Buffer.alloc(0), fallback, provider), evidence);
  assert.deepEqual(await cachedSceneUnderstanding(directory, key, Buffer.alloc(0), fallback, provider), evidence);
  assert.equal(calls, 1);
  const failureKey = 'b'.repeat(32);
  const failed = async () => { calls++; throw new Error('provider unavailable'); };
  assert.deepEqual(await cachedSceneUnderstanding(directory, failureKey, Buffer.alloc(0), fallback, failed), fallback);
  assert.deepEqual(await cachedSceneUnderstanding(directory, failureKey, Buffer.alloc(0), fallback, provider), fallback);
  assert.equal(calls, 2);
  const pendingKey = 'c'.repeat(32);
  await writeFile(path.join(directory, `${pendingKey}-${SCENE_UNDERSTANDING_VERSION}.json`), '{"status":"pending"}');
  assert.deepEqual(await cachedSceneUnderstanding(directory, pendingKey, Buffer.alloc(0), fallback, provider), fallback);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(await readFile(path.join(directory, `${key}-${SCENE_UNDERSTANDING_VERSION}.json`), 'utf8')).status, 'complete');
});

test('invalid model data is cached as unavailable and never inserted into scene state', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scene-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const provider = async () => { calls++; return { ...evidence, people: [{ ...person, box: [0, 0, Infinity, 1] }] } as SceneUnderstanding; };
  assert.deepEqual(await cachedSceneUnderstanding(directory, 'd'.repeat(32), Buffer.alloc(0), evidence, provider), evidence);
  await cachedSceneUnderstanding(directory, 'd'.repeat(32), Buffer.alloc(0), evidence, provider);
  assert.equal(calls, 1);
});
