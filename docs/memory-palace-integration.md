# Memory Palace integration

The Figma lobby and floating window room now share the repository with the photo/video reconstruction, import, and multiplayer application. The window room retains its existing geometry, lighting, photo filter, glow, and drift. New navigation connects it to the library and generated scenes.

| Route | Experience |
| --- | --- |
| `/`, `/lobby/` | Lobby, searchable moments, local favorites, and Figma design links |
| `/room/` | Floating window room; up to 36 library memories |
| `/room/?template=1` | Original 29-photo room regardless of library content |
| `/library/` | Existing import, organization, reconstruction, and multiplayer UI |
| `/library/?import=1` | Add moments |
| `/library/?memory=<encoded-id>&from=lobby` | Selected memory’s generation/viewer flow |
| `/preview/` | Lobby and sample room shown together |
| `/storyboard/index.html` | Motion study |

The lobby loads `/api/memories` and shows real library thumbnails when available. The room uses the same source. With an empty library, both use the 29 supplied Figma exports. The backend’s built-in demo entries do not count as personal media, so they also leave the Figma template active. If the API is unavailable, sample mode remains usable and the lobby reports that the library is unavailable. No sample is uploaded or reconstructed automatically. The Design screen’s **Preview the template** link always opens the sample room.

**Step inside** appears for real memories and opens the existing scene request flow. Favorites stay in browser storage; the legacy key is preserved, with numeric sample IDs kept distinct from real string IDs. Existing OAuth callbacks and shared-room links at the old root are routed to the library. Switching pages may require entering VR again; desktop checks do not establish physical Quest performance or comfort.

The app is named **Memory Palace**. Published Figma files and earlier evidence may still say Again or Mneme. Their names were not changed by this integration, and historical IDs, storage keys, and source URLs remain compatible.

## Figma evidence

The [Figma evidence index](figma/README.md) links the native file, prototype, component library, and Slides. The checked-in audit records 48 native screens, five component families with 14 variants, and 16 variables. Nine audited variables are exported to `src/palace/generated/figma-lobby-tokens.css` for the live lobby. This is an explicit export/import handoff, not live synchronization. The Figma sample images also supply the room’s 29 photographs. The storyboard documents motion and reduced-motion behavior.

These artifacts support the design workflow claim. They do not establish Figma Make use, measured time savings, completed user studies, or a prize outcome. The combined preview is a screenshot comparison of the implemented UI, not a headset recording or an interactive Figma embed.

## Run and verify

```sh
npm install
npm run dev
# Open http://localhost:5173/preview/ and then enter the room.
```

```sh
npm test
npm run typecheck
npm run build
npx tsx scripts/check-palace-server.ts
PALACE_URL=http://localhost:5173 node scripts/check-palace-lobby.mjs
PALACE_URL=http://localhost:5173 node scripts/check-palace-room.mjs
PALACE_URL=http://localhost:5173 node scripts/check-palace-library.mjs
node scripts/figma/import-tokens.mjs docs/figma/evidence/native-audit.json
```

The lobby browser check requires Chrome and `@playwright/test`. It mocks library responses to verify empty/populated/offline states, safe titles, sample/string favorite compatibility, encoded scene links, keyboard focus, reduced motion, and narrow layouts. It does not invoke expensive reconstruction. Use the repository’s generation tests and Quest workflow for those separate checks; retain local media, provider secrets, and generated caches outside Git.

## Photo/video integration review

This branch combines the latest main work with the Mint actor renderer and photo mask-ownership changes. Shared depth/model caching, the 30-minute worker default, tracked video props and dense actor motion are retained. Clips exceeding the 2,000-frame dense budget fall back to sampled reconstruction. Photo fidelity adds preserved 518px depth artifacts, conservative nearby navigation, mask ownership and stricter evidence for completed objects.

Independent reviews covered backend generation and lobby/library navigation. Fresh invitation links bypass first-run onboarding, and selected memory IDs are encoded through the scene request. Browser checks use mocked API responses; they verify navigation without starting reconstruction or joining a live multiplayer room.

Final merge validation: 472 automated tests passed with one skipped, typecheck and production build passed, all eight library browser scenarios passed, and the production route/asset check passed. The photo-review model tests (15) and Python pose-candidate tests (4) also passed.

Automated checks do not establish visual quality. The existing photo review records v2 photos 02/04/06 as failing wider-view/body/object acceptance; the remaining cases await review. Dense video surfaces may consume substantial browser memory, and camera motion or a nonempty opening frame can produce artifacts. Physical Quest 2 performance, controller comfort and real generation acceptance still require testing with the intended media.
