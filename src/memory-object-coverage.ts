import {
  MEMORY_OBJECT_CATEGORIES,
  classifyMemoryObject,
  isMemoryObjectSpec,
  isMemoryObjectClassVerified,
  canReconstructMemoryObject,
  memoryObjectPolicy,
  type MemoryObjectCategory,
  type ObjectRecognitionCoverage,
} from "./memory-objects";

export interface ExpectedPhotoObjects {
  index: number;
  filename: string;
  expectedCategories: readonly string[];
  ambiguousOrUnreadable: readonly string[];
}
export interface ObservedObjectEvidence {
  kind?: string;
  label: string;
  category?: string;
  object?: unknown;
}

/** Category presence audit, not instance recall or visual reconstruction acceptance.
 * Semantic labels and verified object descriptors are reported separately. */
export function evaluateObjectCoverage(
  expected: ExpectedPhotoObjects,
  subjects: readonly ObservedObjectEvidence[],
  inventory: readonly ObservedObjectEvidence[] = [],
  coverage?: ObjectRecognitionCoverage,
) {
  const supported = (value: string): value is MemoryObjectCategory =>
    MEMORY_OBJECT_CATEGORIES.includes(value as MemoryObjectCategory);
  const expectedCategories = [
    ...new Set(expected.expectedCategories.filter(supported)),
  ];
  const unsupportedExpected = expected.expectedCategories.filter(
    (category) => !supported(category),
  );
  const descriptors = new Set(
    subjects.flatMap((subject) =>
      isMemoryObjectSpec(subject.object) ? [subject.object.category] : [],
    ),
  );
  const semantic = new Set<MemoryObjectCategory>();
  const verifiedDescriptors = new Set(subjects.flatMap(subject =>
    isMemoryObjectSpec(subject.object) && isMemoryObjectClassVerified(subject.object) ? [subject.object.category] : []));
  const solidDescriptors = new Set(subjects.flatMap(subject =>
    isMemoryObjectSpec(subject.object) && canReconstructMemoryObject(subject.object) ? [subject.object.category] : []));
  const unknownLabels: string[] = [];
  for (const item of [...subjects, ...inventory]) {
    if (item.kind === "person") continue;
    const category =
      item.category && supported(item.category)
        ? item.category
        : classifyMemoryObject(item.label);
    if (category) semantic.add(category);
    else if (item.label) unknownLabels.push(item.label);
  }
  const classified = new Set([...semantic, ...descriptors]);
  const matched = expectedCategories.filter((category) =>
    classified.has(category),
  );
  const solidExpected = expectedCategories.filter(
    (category) => memoryObjectPolicy(category).reconstruction === "solid",
  );
  return {
    index: expected.index,
    filename: expected.filename,
    expectedCategories,
    unsupportedExpected,
    matchedCategories: matched,
    missingCategories: expectedCategories.filter(
      (category) => !classified.has(category),
    ),
    descriptorCategories: [...descriptors].sort(),
    verifiedDescriptorCategories: [...verifiedDescriptors].sort(),
    tentativeDescriptorCategories: [...descriptors].filter(category => !verifiedDescriptors.has(category)).sort(),
    semanticOnlyCategories: [...semantic]
      .filter((category) => !descriptors.has(category))
      .sort(),
    solidGeometryEligibleCategories: [...solidDescriptors].sort(),
    sourceSurfaceCategories: [...classified].filter(
      (category) =>
        memoryObjectPolicy(category).reconstruction === "source-surface",
    ),
    missingSolidDescriptors: solidExpected.filter(
      (category) => !solidDescriptors.has(category),
    ),
    expectedButUnsearched: expectedCategories.filter((category) =>
      coverage?.unsearchedCategories.includes(category),
    ),
    uncertainCategories: coverage?.unconfirmedCategories ?? [],
    unknownLabels: [...new Set(unknownLabels)],
    ambiguousOrUnreadable: [...expected.ambiguousOrUnreadable],
    expectedCategoryPresence: {
      matched: matched.length,
      total: expectedCategories.length,
    },
    expectedSolidDescriptors: {
      matched: solidExpected.filter((category) => solidDescriptors.has(category))
        .length,
      total: solidExpected.length,
    },
    inferenceCoverage: coverage ?? null,
  };
}
