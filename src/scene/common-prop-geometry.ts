import * as THREE from "three";
import {
  memoryObjectPolicy,
  type MemoryObjectCategory,
} from "../memory-objects";
type V = [number, number, number];
type M = THREE.Material | THREE.Material[];
export interface CommonPropGeometryContext {
  mesh(
    name: string,
    geometry: THREE.BufferGeometry,
    material: M,
    position?: V,
  ): THREE.Mesh;
  rounded(
    name: string,
    width: number,
    height: number,
    depth: number,
    material: M,
    position?: V,
    radius?: number,
  ): THREE.Mesh;
  cylinder(
    name: string,
    top: number,
    bottom: number,
    height: number,
    material: M,
    position?: V,
  ): THREE.Mesh;
  loop(
    name: string,
    points: V[],
    radius: number,
    material: THREE.Material,
  ): THREE.Mesh;
  base: THREE.Material;
  photo: THREE.Material;
  dark: THREE.Material;
  metal: THREE.Material;
  seam: THREE.Material;
}

/** Bounded category geometry. These are inferred structural shapes, never recovered scans.
 * Each family has supporting parts; broad architecture and worn items stay in source geometry. */
export function buildCommonPropGeometry(
  category: MemoryObjectCategory,
  c: CommonPropGeometryContext,
) {
  const { mesh, rounded, cylinder, loop, base, photo, dark, metal, seam } = c;
  const box = (
    name: string,
    w: number,
    h: number,
    d: number,
    position: V = [0, 0, 0],
    mat: THREE.Material = base,
  ) => rounded(name, w, h, d, mat, position);
  const sphere = (
    name: string,
    size: V,
    position: V = [0, 0, 0],
    mat: THREE.Material = base,
  ) => {
    const g = new THREE.SphereGeometry(0.5, 24, 16);
    g.scale(...size);
    return mesh(name, g, mat, position);
  };
  const tube = (
    name: string,
    points: V[],
    radius = 0.025,
    mat: THREE.Material = metal,
  ) => loop(name, points, radius, mat);
  const fourLegs = (top = 0.35, bottom = -0.5, inset = 0.4) => {
    for (const x of [-inset, inset])
      for (const z of [-inset, inset])
        tube(
          "Support leg",
          [
            [x, bottom, z],
            [x, top, z],
          ],
          0.025,
        );
  };
  const wheel = (x: number, z: number, r = 0.14) => {
    const w = cylinder("Wheel", r, r, 0.09, dark, [x, -0.32, z]);
    w.rotation.z = Math.PI / 2;
    return w;
  };
  switch (memoryObjectPolicy(category).geometry) {
    case "table":
      if (category === "round-table") {
        cylinder("Round tabletop", 0.5, 0.5, 0.055, base, [0, 0.45, 0]);
        fourLegs(0.42, -0.5, 0.29);
        tube(
          "Under-table cross brace",
          [
            [-0.29, -0.1, -0.29],
            [0.29, -0.1, 0.29],
          ],
          0.02,
        );
        tube(
          "Under-table cross brace",
          [
            [0.29, -0.1, -0.29],
            [-0.29, -0.1, 0.29],
          ],
          0.02,
        );
      } else {
        box("Tabletop", 1, 0.055, 0.85, [0, 0.45, 0]);
        fourLegs(0.42, -0.5, 0.36);
      }
      break;
    case "chair":
      box("Seat", 0.82, 0.07, 0.8, [0, -0.03, 0]);
      box("Backrest", 0.82, 0.48, 0.065, [0, 0.28, -0.36]);
      fourLegs(-0.05, -0.5, 0.34);
      tube(
        "Left back support",
        [
          [-0.34, -0.1, -0.36],
          [-0.34, 0.52, -0.36],
        ],
        0.025,
      );
      tube(
        "Right back support",
        [
          [0.34, -0.1, -0.36],
          [0.34, 0.52, -0.36],
        ],
        0.025,
      );
      break;
    case "sofa":
      box("Sofa base", 1, 0.23, 0.8, [0, -0.3, 0]);
      box("Upholstered back", 1, 0.63, 0.18, [0, 0.13, -0.34]);
      for (const x of [-0.46, 0.46])
        box("Armrest", 0.12, 0.5, 0.8, [x, -0.05, 0]);
      for (const x of [-0.22, 0.22])
        box("Seat cushion", 0.42, 0.14, 0.61, [x, -0.12, 0.07]);
      fourLegs(-0.35, -0.5, 0.36);
      break;
    case "cabinet":
      for (const x of [-0.47, 0.47])
        box("Cabinet side", 0.06, 1, 0.6, [x, 0, 0]);
      for (const y of [-0.47, 0, 0.47])
        box("Cabinet shelf", 1, 0.06, 0.6, [0, y, 0]);
      box("Cabinet backing", 1, 1, 0.035, [0, 0, -0.3]);
      break;
    case "umbrella": {
      cylinder("Umbrella pole", 0.015, 0.015, 1, metal, [0, 0, 0]);
      const canopy = mesh(
        "Umbrella canopy",
        new THREE.ConeGeometry(0.5, 0.19, 16, 1, false),
        base,
        [0, 0.4, 0],
      );
      canopy.rotation.y = Math.PI / 16;
      for (let n = 0; n < 8; n++) {
        const a = (n * Math.PI) / 4;
        tube(
          "Canopy rib",
          [
            [0, 0.49, 0],
            [Math.cos(a) * 0.48, 0.31, Math.sin(a) * 0.48],
          ],
          0.006,
        );
      }
      cylinder("Umbrella foot", 0.13, 0.18, 0.05, dark, [0, -0.49, 0]);
      break;
    }
    case "screen":
      box("Screen frame", 1, 0.65, 0.04, [0, 0, 0], dark);
      box("Photographic display", 0.96, 0.61, 0.008, [0, 0, 0.025], photo);
      if (category === "television")
        for (const x of [-0.32, 0.32])
          tube(
            "Display foot",
            [
              [x, -0.3, 0],
              [x, -0.39, 0.1],
            ],
            0.015,
          );
      break;
    case "speaker":
      box("Speaker enclosure", 0.65, 1, 0.5);
      for (const [y, r] of [
        [-0.18, 0.22],
        [0.29, 0.11],
      ]) {
        const driver = cylinder("Speaker driver", r, r, 0.018, dark, [
          0,
          y,
          0.26,
        ]);
        driver.rotation.x = Math.PI / 2;
      }
      break;
    case "mouse":
      sphere("Mouse shell", [0.7, 0.35, 1]);
      box("Mouse center seam", 0.012, 0.012, 0.55, [0, 0.16, 0.03], seam);
      box("Scroll wheel", 0.045, 0.05, 0.11, [0, 0.17, -0.13], dark);
      break;
    case "power-strip":
      box("Power strip body", 1, 0.15, 0.25);
      for (const x of [-0.32, 0, 0.32])
        for (const z of [-0.035, 0.035])
          box("Socket opening", 0.055, 0.008, 0.015, [x, 0.078, z], dark);
      break;
    case "charger":
      box("Charger body", 0.85, 0.8, 0.6);
      for (const x of [-0.15, 0.15])
        box("Plug pin", 0.055, 0.23, 0.045, [x, -0.48, 0], metal);
      break;
    case "cable":
      tube(
        "Flexible cable",
        [
          [-0.5, 0, -0.15],
          [-0.24, 0.01, 0.22],
          [0.1, 0, -0.2],
          [0.46, 0, 0.15],
        ],
        0.018,
        dark,
      );
      for (const x of [-0.5, 0.46])
        box("Connector", 0.1, 0.055, 0.055, [x, 0, x < 0 ? -0.15 : 0.15], base);
      break;
    case "cup":
    case "glass":
    case "container": {
      const isGlass = category === "glass",
        r = isGlass ? 0.28 : 0.4,
        h = category === "food-container" ? 0.45 : 1;
      const profile = [
        new THREE.Vector2(0, -h / 2),
        new THREE.Vector2(r * 0.75, -h / 2),
        new THREE.Vector2(r, h / 2),
        new THREE.Vector2(r * 0.94, h / 2),
        new THREE.Vector2(r * 0.7, -h / 2 + 0.05),
        new THREE.Vector2(0, -h / 2 + 0.05),
      ];
      mesh(
        "Open container with inner wall",
        new THREE.LatheGeometry(profile, 32),
        base,
      );
      if (category === "cup")
        tube(
          "Cup handle",
          [
            [r * 0.85, 0.3, 0],
            [r * 1.55, 0.26, 0],
            [r * 1.55, -0.22, 0],
            [r * 0.78, -0.27, 0],
          ],
          0.04,
          base,
        );
      break;
    }
    case "plate": {
      const points = [
        [0, -0.02],
        [0.35, -0.02],
        [0.5, 0.025],
        [0.5, 0.04],
        [0.35, 0],
        [0, 0],
      ].map(([x, y]) => new THREE.Vector2(x, y));
      mesh("Shallow plate with rim", new THREE.LatheGeometry(points, 40), base);
      break;
    }
    case "food":
      if (category === "bagel") {
        const g = new THREE.TorusGeometry(0.33, 0.17, 16, 32);
        g.rotateX(Math.PI / 2);
        g.scale(1, 0.5, 1);
        mesh("Bagel ring", g, base);
      } else if (category === "sandwich") {
        box("Lower bread", 1, 0.15, 0.7, [0, -0.18, 0]);
        box("Filling", 0.92, 0.18, 0.63, [0, 0, 0], seam);
        box("Upper bread", 1, 0.15, 0.7, [0, 0.18, 0]);
      } else sphere("Visible food portion", [1, 0.45, 0.75]);
      break;
    case "fruit":
      sphere("Fruit body", [0.92, 1, 0.92]);
      tube(
        "Short fruit stem",
        [
          [0, 0.42, 0],
          [0.02, 0.57, 0],
        ],
        0.025,
        seam,
      );
      break;
    case "egg":
      sphere("Egg", [0.74, 1, 0.74]);
      break;
    case "candy":
      box("Wrapped sweet", 0.7, 0.3, 0.38);
      for (const x of [-0.42, 0.42])
        box("Wrapper end", 0.18, 0.08, 0.3, [x, 0, 0], seam);
      break;
    case "bag":
      box("Soft bag body", 0.85, 0.78, 0.36, [0, -0.1, 0]);
      for (const z of [-0.13, 0.13])
        tube(
          "Bag handle",
          [
            [-0.23, 0.28, z],
            [-0.19, 0.55, z],
            [0.19, 0.55, z],
            [0.23, 0.28, z],
          ],
          0.025,
          base,
        );
      break;
    case "suitcase":
      box("Luggage case", 0.75, 0.9, 0.4);
      for (const x of [-0.25, 0.25]) wheel(x, 0, 0.07);
      tube(
        "Luggage handle",
        [
          [-0.15, 0.4, 0],
          [-0.15, 0.6, 0],
          [0.15, 0.6, 0],
          [0.15, 0.4, 0],
        ],
        0.025,
      );
      break;
    case "cushion":
      sphere("Cushioned pillow", [1, 0.4, 0.75]);
      break;
    case "cloth":
      box("Folded textile or paper", 1, 0.025, 0.8);
      break;
    case "book":
      box("Book pages", 0.94, 0.12, 0.96, [0, 0, 0], base);
      for (const y of [-0.075, 0.075])
        box("Book cover", 1, 0.025, 1, [0, y, 0], seam);
      box("Book spine", 0.04, 0.17, 1, [-0.48, 0, 0], seam);
      break;
    case "football":
      sphere("Oval football", [0.65, 0.65, 1]);
      for (const z of [-0.18, -0.09, 0, 0.09, 0.18])
        box("Football lace", 0.16, 0.015, 0.025, [0, 0.325, z], metal);
      break;
    case "car":
    case "ground-vehicle": {
      box("Vehicle lower body", 0.88, 0.33, 1, [0, -0.1, 0]);
      if (category === "car") {
        box("Cabin", 0.76, 0.36, 0.52, [0, 0.22, 0]);
        box("Windscreen", 0.67, 0.22, 0.015, [0, 0.24, 0.27], dark);
      } else box("Service equipment housing", 0.7, 0.36, 0.58, [0, 0.2, -0.12]);
      for (const x of [-0.45, 0.45]) for (const z of [-0.32, 0.32]) wheel(x, z);
      break;
    }
    case "airplane": {
      sphere("Aircraft fuselage", [0.14, 0.16, 1]);
      const wing = box("Main wings", 1, 0.018, 0.19, [0, -0.015, 0.03]);
      wing.rotation.y = 0.08;
      box("Tail wings", 0.4, 0.015, 0.12, [0, 0.04, -0.4]);
      box("Vertical tail", 0.025, 0.23, 0.16, [0, 0.13, -0.4]);
      for (const x of [-0.2, 0.2]) {
        const e = cylinder("Engine", 0.055, 0.055, 0.18, base, [
          x,
          -0.08,
          0.05,
        ]);
        e.rotation.x = Math.PI / 2;
      }
      break;
    }
    case "bicycle":
    case "scooter": {
      for (const z of [-0.4, 0.4]) {
        const g = new THREE.TorusGeometry(
          category === "bicycle" ? 0.22 : 0.07,
          0.025,
          8,
          24,
        );
        g.rotateY(Math.PI / 2);
        mesh("Two-wheeler wheel", g, dark, [0, -0.3, z]);
      }
      if (category === "bicycle") {
        tube(
          "Bicycle frame",
          [
            [0, -0.3, -0.4],
            [0, 0.1, -0.15],
            [0, -0.3, 0.1],
            [0, -0.3, -0.4],
          ],
          0.02,
          base,
        );
        tube(
          "Upper frame",
          [
            [0, 0.1, -0.15],
            [0, 0.13, 0.3],
            [0, -0.3, 0.1],
          ],
          0.02,
          base,
        );
        box("Saddle", 0.2, 0.04, 0.17, [0, 0.16, -0.15], dark);
      } else box("Scooter deck", 0.18, 0.045, 0.8, [0, -0.25, 0]);
      tube(
        "Front fork and stem",
        [
          [0, -0.3, 0.4],
          [0, 0.43, 0.3],
        ],
        0.02,
        base,
      );
      tube(
        "Handlebars",
        [
          [-0.25, 0.43, 0.3],
          [0.25, 0.43, 0.3],
        ],
        0.025,
        dark,
      );
      break;
    }
    case "cone":
      box("Cone foot", 0.65, 0.06, 0.65, [0, -0.47, 0]);
      cylinder("Traffic cone", 0.035, 0.26, 0.9, base, [0, 0, 0]);
      break;
    case "bin":
      cylinder("Waste container", 0.42, 0.35, 0.9, base);
      cylinder("Bin rim", 0.45, 0.45, 0.06, seam, [0, 0.47, 0]);
      break;
    case "source-surface":
      throw new Error(
        `Category ${category} belongs to the observed source surface, not an independent prop.`,
      );
    case "legacy":
      throw new Error(
        `Legacy category ${category} must use its detailed prop builder.`,
      );
  }
}
