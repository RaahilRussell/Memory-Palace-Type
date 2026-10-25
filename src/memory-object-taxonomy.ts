/** Shared detection, geometry and interaction vocabulary. Dimensions are priors, not measurements. */
export type MemoryObjectGeometry =
  | "legacy"
  | "table"
  | "chair"
  | "sofa"
  | "cabinet"
  | "umbrella"
  | "screen"
  | "speaker"
  | "mouse"
  | "power-strip"
  | "charger"
  | "cable"
  | "cup"
  | "glass"
  | "plate"
  | "container"
  | "food"
  | "fruit"
  | "egg"
  | "candy"
  | "bag"
  | "suitcase"
  | "cushion"
  | "cloth"
  | "book"
  | "football"
  | "car"
  | "airplane"
  | "ground-vehicle"
  | "bicycle"
  | "scooter"
  | "cone"
  | "bin"
  | "source-surface";
export interface MemoryObjectProfile {
  dimensions: [number, number, number];
  interaction: "movable" | "fixed" | "attached";
  reconstruction: "solid" | "source-surface";
  geometry: MemoryObjectGeometry;
  query: string;
  aliases: readonly string[];
}
const p = (
  dimensions: [number, number, number],
  geometry: MemoryObjectGeometry,
  query: string,
  aliases: readonly string[] = [],
  interaction: MemoryObjectProfile["interaction"] = "movable",
): MemoryObjectProfile => ({
  dimensions,
  geometry,
  query,
  aliases,
  interaction,
  reconstruction: geometry === "source-surface" ? "source-surface" : "solid",
});
const observed = (
  dimensions: [number, number, number],
  query: string,
  aliases: readonly string[] = [],
  attached = false,
) =>
  p(
    dimensions,
    "source-surface",
    query,
    aliases,
    attached ? "attached" : "fixed",
  );

/** Source surfaces classify context and worn items without erasing their pixels or inventing movable scenery. */
export const MEMORY_OBJECT_PROFILES = {
  laptop: p([0.34, 0.23, 0.25], "legacy", "laptop", [
    "notebook computer",
    "macbook",
  ]),
  computer: p([0.5, 0.4, 0.18], "legacy", "computer monitor", [
    "monitor",
    "desktop pc",
    "desktop tower",
    "imac",
  ]),
  phone: p([0.075, 0.15, 0.009], "legacy", "cell phone", [
    "cellphone",
    "cell phone",
    "smartphone",
    "iphone",
  ]),
  "drink-can": p([0.066, 0.123, 0.066], "legacy", "aluminum drink can", [
    "soda can",
    "beverage can",
    "beer can",
    "aluminum can",
    "aluminium can",
    "energy drink can",
    "can of soda",
    "can of beer",
    "coke can",
  ]),
  "chip-bag": p([0.16, 0.24, 0.07], "legacy", "bag of potato chips", [
    "chips bag",
    "crisp bag",
    "crisps bag",
    "snack bag",
    "snack packet",
    "chip packet",
    "chips packet",
    "bag of chips",
    "bag of crisps",
  ]),
  "water-bottle": p([0.075, 0.24, 0.075], "legacy", "water bottle", [
    "bottle",
    "plastic bottle",
    "drink bottle",
    "drinking bottle",
    "bottle of water",
    "thermos",
    "reusable bottle",
    "insulated bottle",
    "juice bottle",
  ]),
  box: p([0.3, 0.24, 0.24], "legacy", "cardboard box", [
    "carton",
    "cardboard package",
    "food box",
  ]),
  backpack: p([0.31, 0.45, 0.18], "legacy", "backpack", [
    "rucksack",
    "knapsack",
    "bookbag",
    "school bag",
  ]),
  table: p(
    [1.2, 0.74, 0.75],
    "table",
    "table",
    ["desk", "worktable", "dining table", "folding table"],
    "fixed",
  ),
  "round-table": p(
    [1, 0.74, 1],
    "table",
    "round table",
    ["round patio table", "circular table"],
    "fixed",
  ),
  chair: p(
    [0.5, 0.85, 0.55],
    "chair",
    "chair",
    ["seat", "folding chair", "patio chair", "bench", "airport seating"],
    "fixed",
  ),
  sofa: p(
    [1.9, 0.85, 0.85],
    "sofa",
    "sofa",
    ["couch", "recliner", "armchair"],
    "fixed",
  ),
  cabinet: p(
    [1.1, 0.75, 0.45],
    "cabinet",
    "cabinet",
    ["tv stand", "television stand", "shelf", "bookcase", "sideboard"],
    "fixed",
  ),
  umbrella: p(
    [2.2, 2.3, 2.2],
    "umbrella",
    "patio umbrella",
    ["parasol", "sun umbrella"],
    "fixed",
  ),
  television: p(
    [1.1, 0.7, 0.08],
    "screen",
    "television",
    ["tv", "television screen"],
    "fixed",
  ),
  "projector-screen": p(
    [3, 1.9, 0.08],
    "screen",
    "projection screen",
    ["projection screen", "projector screen", "presentation screen"],
    "fixed",
  ),
  speaker: p(
    [0.4, 0.65, 0.35],
    "speaker",
    "loudspeaker",
    ["loudspeaker", "audio speaker"],
    "fixed",
  ),
  mouse: p([0.065, 0.035, 0.11], "mouse", "computer mouse", [
    "computer mouse",
    "wireless mouse",
  ]),
  "power-strip": p([0.28, 0.04, 0.06], "power-strip", "power strip", [
    "extension strip",
    "multi socket",
  ]),
  charger: p([0.06, 0.055, 0.04], "charger", "power adapter", [
    "power adapter",
    "charging adapter",
    "charging brick",
  ]),
  cable: p([0.4, 0.015, 0.13], "cable", "electrical cable", [
    "cord",
    "charging cable",
    "usb cable",
    "electrical cable",
  ]),
  cup: p([0.09, 0.1, 0.09], "cup", "cup", ["mug", "coffee cup", "paper cup"]),
  glass: p([0.07, 0.13, 0.07], "glass", "drinking glass", [
    "drinking glass",
    "tumbler",
  ]),
  plate: p([0.23, 0.025, 0.23], "plate", "plate", ["paper plate", "dish"]),
  "food-container": p([0.12, 0.055, 0.12], "container", "food container", [
    "sauce container",
    "sauce cup",
    "condiment cup",
    "plastic tub",
    "bowl",
    "bucket",
  ]),
  food: p([0.13, 0.06, 0.1], "food", "food", ["bread", "pastry", "potato"]),
  bagel: p([0.11, 0.035, 0.11], "food", "bagel", []),
  sandwich: p([0.14, 0.065, 0.1], "food", "sandwich", ["burrito", "food wrap"]),
  fruit: p([0.08, 0.08, 0.08], "fruit", "fruit", ["apple", "orange", "banana"]),
  egg: p([0.045, 0.06, 0.045], "egg", "boiled egg", [
    "boiled egg",
    "hard boiled egg",
  ]),
  candy: p([0.065, 0.025, 0.04], "candy", "wrapped candy", [
    "wrapped candy",
    "sweet",
    "chocolate bar",
    "lollipop",
    "candy packet",
  ]),
  bag: p([0.35, 0.4, 0.14], "bag", "shopping bag", [
    "shopping bag",
    "tote bag",
    "plastic bag",
    "handbag",
    "carry bag",
  ]),
  suitcase: p([0.4, 0.55, 0.23], "suitcase", "suitcase", [
    "luggage",
    "briefcase",
    "carry on",
  ]),
  pillow: p([0.55, 0.2, 0.4], "cushion", "pillow", ["cushion"]),
  blanket: p([1.3, 0.04, 1.6], "cloth", "blanket", [
    "towel",
    "quilt",
    "folded fabric",
  ]),
  rug: observed([2, 0.01, 3], "rug", ["carpet", "floor mat"]),
  book: p([0.16, 0.025, 0.24], "book", "book", ["notebook", "magazine"]),
  paper: p([0.21, 0.004, 0.3], "cloth", "sheet of paper", [
    "sheet of paper",
    "napkin",
    "foil wrapper",
    "food wrapper",
  ]),
  football: p([0.18, 0.18, 0.28], "football", "american football", [
    "american football",
    "sports ball",
  ]),
  car: p(
    [1.8, 1.5, 4.2],
    "car",
    "car",
    ["automobile", "sedan", "suv", "van"],
    "fixed",
  ),
  airplane: p(
    [28, 9, 32],
    "airplane",
    "airplane",
    ["aeroplane", "aircraft", "passenger jet"],
    "fixed",
  ),
  "ground-vehicle": p(
    [2, 1.7, 3],
    "ground-vehicle",
    "airport ground vehicle",
    [
      "airport tug",
      "baggage tractor",
      "ground service vehicle",
      "service truck",
    ],
    "fixed",
  ),
  bicycle: p([0.6, 1.1, 1.75], "bicycle", "bicycle", ["bike"], "fixed"),
  scooter: p(
    [0.5, 1.1, 1.1],
    "scooter",
    "kick scooter",
    ["kick scooter", "electric scooter"],
    "fixed",
  ),
  "traffic-cone": p(
    [0.3, 0.55, 0.3],
    "cone",
    "traffic cone",
    ["safety cone", "bollard"],
    "fixed",
  ),
  "trash-bin": p(
    [0.5, 0.85, 0.5],
    "bin",
    "trash bin",
    ["trash can", "garbage bin", "recycling bin", "waste bin", "dumpster"],
    "fixed",
  ),
  plant: observed([0.6, 1, 0.6], "plant", [
    "tree",
    "bush",
    "shrub",
    "potted plant",
    "planter",
  ]),
  building: observed([12, 8, 8], "building", [
    "storefront",
    "facade",
    "wall",
    "roof",
    "ceiling",
  ]),
  window: observed([1.5, 1.5, 0.08], "window", ["window pane"]),
  door: observed([0.9, 2.1, 0.06], "door", ["entrance door", "doorway"]),
  column: observed([0.5, 3, 0.5], "column", ["pillar", "structural column"]),
  railing: observed([2, 1, 0.08], "railing", [
    "handrail",
    "fence",
    "balustrade",
  ]),
  stairs: observed([3, 1.5, 2], "stairs", ["staircase", "steps"]),
  bridge: observed([40, 12, 8], "bridge", ["suspension bridge"]),
  light: observed([1, 0.1, 0.12], "ceiling light", [
    "ceiling light",
    "light fixture",
    "streetlight",
    "street lamp",
    "lamp",
    "fluorescent light",
  ]),
  sign: observed([0.8, 0.6, 0.04], "sign", [
    "road sign",
    "street sign",
    "shop sign",
    "banner",
    "poster",
    "billboard",
  ]),
  "traffic-light": observed([0.3, 0.9, 0.25], "traffic light", [
    "traffic signal",
  ]),
  "power-outlet": observed([0.07, 0.11, 0.015], "electrical outlet", [
    "electrical outlet",
    "power outlet",
    "wall socket",
  ]),
  stage: observed([8, 0.8, 4], "stage platform", ["stage platform"]),
  sculpture: observed([1, 2, 1], "sculpture", ["statue", "monument"]),
  "moving-walkway": observed([1.5, 0.9, 10], "moving walkway", [
    "travelator",
    "moving sidewalk",
    "escalator",
  ]),
  fan: observed([1, 0.25, 1], "ceiling fan", ["ceiling fan"]),
  hat: observed(
    [0.26, 0.16, 0.26],
    "hat",
    ["cap", "baseball cap", "fedora"],
    true,
  ),
  glasses: observed(
    [0.14, 0.05, 0.14],
    "eyeglasses",
    ["eyeglasses", "spectacles"],
    true,
  ),
  sunglasses: observed([0.14, 0.05, 0.14], "sunglasses", ["sun glasses"], true),
  mask: observed(
    [0.17, 0.12, 0.04],
    "costume mask",
    ["costume mask", "face mask", "masquerade mask"],
    true,
  ),
  watch: observed(
    [0.04, 0.02, 0.22],
    "wristwatch",
    ["wristwatch", "smartwatch"],
    true,
  ),
  bracelet: observed(
    [0.07, 0.01, 0.07],
    "bracelet",
    ["wristband", "glow bracelet", "glow stick"],
    true,
  ),
  lanyard: observed([0.03, 0.45, 0.01], "lanyard", ["badge", "id badge"], true),
  clothing: observed(
    [0.5, 0.7, 0.1],
    "clothing",
    [
      "shirt",
      "hoodie",
      "sweatshirt",
      "jacket",
      "coat",
      "trousers",
      "pants",
      "shorts",
      "scarf",
      "tie",
      "costume",
      "jersey",
    ],
    true,
  ),
  shoe: observed(
    [0.1, 0.12, 0.28],
    "shoe",
    ["sneaker", "boot", "sandal", "sock"],
    true,
  ),
  headphones: observed(
    [0.2, 0.22, 0.08],
    "headphones",
    ["headset", "earbuds", "earphones"],
    true,
  ),
} satisfies Record<string, MemoryObjectProfile>;
export type MemoryObjectCategory = keyof typeof MEMORY_OBJECT_PROFILES;
export const MEMORY_OBJECT_CATEGORIES = Object.freeze(
  Object.keys(MEMORY_OBJECT_PROFILES) as [
    MemoryObjectCategory,
    ...MemoryObjectCategory[],
  ],
);
export const MAX_MEMORY_OBJECTS = 48;
export function memoryObjectPolicy(
  category: MemoryObjectCategory,
): MemoryObjectProfile {
  return MEMORY_OBJECT_PROFILES[category];
}
export function memoryObjectDimensionLimit(category: MemoryObjectCategory) {
  return Math.max(
    3,
    Math.min(100, Math.max(...MEMORY_OBJECT_PROFILES[category].dimensions) * 4),
  );
}

export interface ObjectRecognitionCoverage {
  strategy: "local-evidence-priority" | "gemini-inventory";
  searchedCategories: MemoryObjectCategory[];
  unsearchedCategories: MemoryObjectCategory[];
  /** Proposals whose category has no accepted mask, including budget-deferred confirmations. */
  unconfirmedCategories: MemoryObjectCategory[];
  candidateLimitReached: boolean;
  objectLimitReached: boolean;
}
export function isObjectRecognitionCoverage(
  value: unknown,
): value is ObjectRecognitionCoverage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "strategy",
          "searchedCategories",
          "unsearchedCategories",
          "unconfirmedCategories",
          "candidateLimitReached",
          "objectLimitReached",
        ].includes(key),
    )
  )
    return false;
  const categories = (list: unknown): list is MemoryObjectCategory[] =>
    Array.isArray(list) &&
    list.length <= MEMORY_OBJECT_CATEGORIES.length &&
    new Set(list).size === list.length &&
    list.every((category) => MEMORY_OBJECT_CATEGORIES.includes(category));
  if (
    !["local-evidence-priority", "gemini-inventory"].includes(
      String(v.strategy),
    ) ||
    !categories(v.searchedCategories) ||
    !categories(v.unsearchedCategories) ||
    !categories(v.unconfirmedCategories) ||
    typeof v.candidateLimitReached !== "boolean" ||
    typeof v.objectLimitReached !== "boolean"
  )
    return false;
  const searched = v.searchedCategories,
    unsearched = v.unsearchedCategories,
    unconfirmed = v.unconfirmedCategories;
  return (
    searched.every((category) => !unsearched.includes(category)) &&
    unconfirmed.every((category) => searched.includes(category))
  );
}
