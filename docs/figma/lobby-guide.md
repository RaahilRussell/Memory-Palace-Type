# Lobby behavior and native Figma handoff

[Open the working lobby](http://localhost:5174/lobby/). The room remains at `/`; its HTML, CSS and Three.js source are unchanged. This lobby is a responsive browser menu, not an additional immersive scene.

| Intent | Running behavior |
| --- | --- |
| Enter | Your room → Enter the room → existing room → WebXR entry on supported hardware |
| Find | Browse all 29 exports; filter by moment number; open the unmodified original |
| Keep | Save favorites locally; revisit after reload; reopen or remove |
| Recover | Empty Saved and no-match search both provide a route back |
| Inspect design | Design in Figma leads to the native source, prototype, Slides and motion study |

Neutral numbers avoid inventing titles or dates. Search is by number/title, not semantic search. Favorites persist in this browser, do not sync between devices, and do not alter the room's 29 photos. Storage failure reports that favorites last for this visit. Original dialogs support Escape and return focus to the invoking control.

## Native Figma work

The `02 — Product & prototype` page now contains 48 native screens: desktop lobby/collection/recovery, 29 original viewers, five representative mobile states, seven motion states and handoff. Four starting points expose desktop, mobile, motion and reduced motion. The original product frames and source Pane 01–29 remain.

The `01 — Components` library has five Auto Layout component sets and 14 variants:

| Set | Variants |
| --- | --- |
| Action | Primary / Secondary / Focus |
| Save | Default / Saved / Focus |
| MomentCard | Default / Saved / Focus |
| Navigation | Default / Current / Focus |
| Destination | Default / Focus |

MomentCard preserves image and title overrides; its nested Save control is separate from selecting the photograph. A reversible radius probe reached 34/34 checked default instances. Sixteen variables bind the library and screens; nine feed actual lobby CSS through `scripts/figma/import-tokens.mjs`.

## Prototype boundaries

Moment 01 models the complete desktop save → original stays open → close to Saved → remove → empty → browse loop. All 29 photographs have original-viewer destinations, but arbitrary favorite combinations and search input are modeled with representative states. The running browser implements dynamic filtering and favorites across all 29. The mobile prototype models saving by navigating to Saved; the browser keeps its dialog open.

Collection navigation is instant. The collection frame has a fixed viewport and vertical scrolling. The storyboard's 450 ms dissolve is a motion proposal; actual lobby entry navigates to another page. The lobby preview floats 10 CSS pixels over 9 seconds and stops under reduced motion.

## Reproduce the handoff

1. Inspect the source frames, variable collection and component instances in Figma.
2. Run the audit script through Figma Scripter to export actual variable IDs and values. The recorded result is `docs/figma/evidence/native-audit.json`.
3. Run `node scripts/figma/import-tokens.mjs docs/figma/evidence/native-audit.json`; review `src/generated/figma-lobby-tokens.css`.
4. Run `npm run build` and, when app behavior changes, `node scripts/check-lobby.mjs`.

Build and browser verification passed after the token import. See [verification](verification.md). Do not rerun `build-native.js` as a routine update: it is a guarded initial construction script. The earlier eight SVG layouts are supporting historical assets, not the native component system.
