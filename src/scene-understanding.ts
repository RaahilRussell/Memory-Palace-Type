import { MEMORY_OBJECT_CATEGORIES, type MemoryObjectCategory } from './memory-objects';
import { isPoseIntent, type PoseIntent } from './pose-intent';

export const SCENE_STRUCTURE_KINDS = ['wall', 'floor', 'ceiling', 'column', 'window', 'door', 'stairs', 'railing', 'building', 'road', 'sidewalk'] as const;
export const SCENE_RELATIONS = ['on', 'under', 'inside', 'held-by', 'worn-by', 'in-front-of', 'behind', 'attached-to'] as const;
export type SourceBox = [number, number, number, number];
export interface SceneEntityEvidence {
  id: string;
  label: string;
  /** Full image [top, left, bottom, right], not coordinates within a crop. */
  box: SourceBox;
  confidence: number;
  visibility: 'clear' | 'partial' | 'uncertain';
}
export interface SceneUnderstanding {
  version: 1;
  source: 'gemini' | 'local';
  /** A completed analysis is an observed inventory, not guaranteed exhaustive coverage. */
  status: 'complete' | 'partial' | 'unavailable';
  environment: 'indoor' | 'outdoor' | 'mixed' | 'unknown';
  confidence: number;
  horizon?: number;
  structures: (SceneEntityEvidence & { kind: (typeof SCENE_STRUCTURE_KINDS)[number]; depthBand: 'near' | 'middle' | 'far' })[];
  objects: (SceneEntityEvidence & { category?: MemoryObjectCategory })[];
  people: (SceneEntityEvidence & { poseIntent?: PoseIntent })[];
  relations: { subjectId: string; relation: (typeof SCENE_RELATIONS)[number]; objectId: string; confidence: number }[];
  limitations: string[];
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const bounded = (v: unknown, min = 0, max = 1) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const text = (v: unknown, max = 160) => typeof v === 'string' && v.length > 0 && v.length <= max;
export const isSourceBox = (v: unknown): v is SourceBox => Array.isArray(v) && v.length === 4 && v.every(n => bounded(n)) && v[0] < v[2] && v[1] < v[3];

/** The model supplies bounded source evidence; never executable code or asset URLs. */
export function isSceneUnderstanding(value: unknown): value is SceneUnderstanding {
  if (!record(value) || !only(value, ['version', 'source', 'status', 'environment', 'confidence', 'horizon', 'structures', 'objects', 'people', 'relations', 'limitations'])) return false;
  if (value.version !== 1 || !['gemini', 'local'].includes(String(value.source)) || !['complete', 'partial', 'unavailable'].includes(String(value.status)) || !['indoor', 'outdoor', 'mixed', 'unknown'].includes(String(value.environment)) || !bounded(value.confidence) || value.horizon !== undefined && !bounded(value.horizon)) return false;
  if (!Array.isArray(value.structures) || value.structures.length > 24 || !Array.isArray(value.objects) || value.objects.length > 48 || !Array.isArray(value.people) || value.people.length > 24 || !Array.isArray(value.relations) || value.relations.length > 96 || !Array.isArray(value.limitations) || value.limitations.length > 12 || !value.limitations.every(v => text(v, 240))) return false;
  const ids = new Set<string>();
  const entity = (v: unknown, extra: string[]) => {
    if (!record(v) || !only(v, ['id', 'label', 'box', 'confidence', 'visibility', ...extra]) || !text(v.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(String(v.id)) || ids.has(String(v.id)) || !text(v.label) || !isSourceBox(v.box) || !bounded(v.confidence) || !['clear', 'partial', 'uncertain'].includes(String(v.visibility))) return false;
    ids.add(String(v.id));
    return true;
  };
  if (!value.structures.every(v => entity(v, ['kind', 'depthBand']) && SCENE_STRUCTURE_KINDS.includes(v.kind) && ['near', 'middle', 'far'].includes(v.depthBand))) return false;
  if (!value.objects.every(v => entity(v, ['category']) && (v.category === undefined || MEMORY_OBJECT_CATEGORIES.includes(v.category)))) return false;
  if (!value.people.every(v => entity(v, ['poseIntent']) && (v.poseIntent === undefined || isPoseIntent(v.poseIntent)))) return false;
  return value.relations.every(v => record(v) && only(v, ['subjectId', 'relation', 'objectId', 'confidence']) && ids.has(String(v.subjectId)) && ids.has(String(v.objectId)) && v.subjectId !== v.objectId && SCENE_RELATIONS.includes(v.relation as never) && bounded(v.confidence));
}

/** Match semantics to segmented people without assigning one pose hint twice. */
export function associateScenePeople(subjects: { id: string; kind: string; box: SourceBox }[], scene: SceneUnderstanding) {
  const candidates: { subjectId: string; person: SceneUnderstanding['people'][number]; score: number }[] = [];
  for (const subject of subjects.filter(s => s.kind === 'person')) for (const person of scene.people) {
    const a = subject.box, b = person.box;
    const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const area = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection;
    const score = area > 0 ? intersection / area : 0;
    if (score >= .35 && person.confidence >= .5 && person.poseIntent) candidates.push({ subjectId: subject.id, person, score });
  }
  const matched = new Set<string>(), used = new Set<string>();
  return candidates.sort((a, b) => b.score - a.score).filter(candidate => {
    if (matched.has(candidate.subjectId) || used.has(candidate.person.id)) return false;
    matched.add(candidate.subjectId); used.add(candidate.person.id); return true;
  });
}
