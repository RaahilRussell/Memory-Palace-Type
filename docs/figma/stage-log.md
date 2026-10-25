# Stage logs — team facts pending

Each entry is under 200 words. Fill actual approximate minutes and team usefulness ratings before submission. These logs describe this Memory Palace iteration; the wider Again project may add earlier work.

## 1. Ideation

Tools / why: Figma Design holds the product screens and 29 source photos. User feedback established a lightly sunlit, floating-photo room with minimal persistent controls. A native foundations board records the palette, target sizes, and division between room and lobby.

Time: [team minutes]. Rating: [team rating 1–5].

Output → product: Keep the immersive room quiet; move finding originals and saving favorites into a separate lobby. The same Pane 01–29 assets appear in Figma and the working interface.

Limitation: The existing scrapbook product and Memory Palace room remain separate surfaces. This iteration preserves the room rather than claiming a complete product integration.

## 2. Prototyping

Tools / why: Figma Design, with authored scripts run through Scripter, created native editable screens, component instances, and interactions. Four starting flows cover desktop, mobile, motion, and reduced motion.

Time: [team minutes]. Rating: [team rating 1–5].

Output → product: 48 screens include 29 original viewers and a representative Moment 01 save/remove/empty/recovery loop. The motion storyboard uses 450 ms dissolves; reduced-motion navigation is instant. Browsing uses a vertically scrolling collection.

Observed rework: Figma rejected self-navigation links; final wiring removes those links. The audit found no missing fonts or broken destinations. Motion states explain sequence, not stereoscopic comfort; physical Quest 2 testing remains outstanding.

## 3. Handoff

Tools / why: Native Figma variables, Auto Layout, five component families with 14 variants, and an exported JSON audit make shared decisions inspectable. Source asset names stay stable across design and runtime.

Time: [team minutes]. Rating: [team rating 1–5].

Output → product: The audit found 16 variables and 645 bound nodes. A reversible corner-radius probe propagated to all 34 checked MomentCard instances, then restored the original. Nine exported variables feed lobby colors, minimum touch targets, and hover duration.

Limitation: This measures structural reuse, not time saved or user satisfaction. The prototype models a representative save flow; browser code persists arbitrary favorites. The importer is an explicit export/import step, not automatic live sync.

## 4. Code generation

Tools / why: Codex edits the Vite/Three.js/WebXR application. A validated importer converts actual Figma variable values into lobby CSS; Playwright checks browser interactions. No Figma Make generation is claimed.

Time: [team minutes]. Rating: [team rating 1–5].

Output → product: The separate lobby supports 29 originals, search, local favorites, empty-state recovery, and a visible route to the native Figma prototype. Imported tokens replace duplicated color, touch-target, and timing decisions. The immersive room's three source files remain byte-identical during this Figma expansion.

Limitation: The local prototype is not yet integrated with the separate team repository's multiplayer/reconstruction work. Human stage ratings, public demo access, and headset validation must be supplied by the team. See the latest verification report for build and browser results.
