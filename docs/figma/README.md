# Memory Palace: Figma submission evidence

The workflow is now native and inspectable: source photographs → reusable Figma components and prototype → validated variable export → running lobby → embedded presentation. The existing immersive room was preserved.

## Open the work

- [Native desktop prototype](https://www.figma.com/proto/L7mSgSraOzY5NM0Mx8nGUH/Again?node-id=25-755&starting-point-node-id=25-755)
- [Foundations and decisions](https://www.figma.com/design/L7mSgSraOzY5NM0Mx8nGUH/Again?node-id=25-679)
- [Native component library](https://www.figma.com/design/L7mSgSraOzY5NM0Mx8nGUH/Again?node-id=25-680)
- [Figma Slides: interactive prototype on slide 14](https://www.figma.com/slides/hyPJeXoDGDhZ687G4GjLX9/Again?node-id=11-15)
- [Working local lobby](http://localhost:5173/) · [Motion study](http://localhost:5173/storyboard/index.html)

## What was built

48 native screens include all 29 original-photo viewers, desktop and mobile journeys, saved and empty states, and regular/reduced-motion storyboards. Four flow starting points organize the work. Five Auto Layout component families contain 14 variants: Action, Save, MomentCard, Navigation, and Destination. Sixteen variables define color, spacing, targets, radius and timing; the audit counted 645 bound nodes.

A reversible change to MomentCard's corner radius propagated to all 34 checked instances. The original value was restored. This measures component reuse, not time saved or usability.

Nine audited Figma variables now generate `src/palace/generated/figma-lobby-tokens.css`, imported by the lobby: seven colors, minimum target size, and hover duration. This is an explicit export/import workflow, not live synchronization. Regenerate with:

```sh
node scripts/figma/import-tokens.mjs docs/figma/evidence/native-audit.json
npm run build
```

Nine native Figma Slides were appended to the existing 12: five evidence slides and four stage logs. Slide 14 contains an interactive Figma prototype embed. No Figma Make use is claimed.

## Review and finish

- [Lobby behavior and prototype boundaries](lobby-guide.md)
- [Motion contract and wider Again recipes](motion-guide.md)
- [Verification and evidence](verification.md)
- [Four stage logs](stage-log.md)
- [Three-minute presentation and submission checklist](submission.md)
- [Prize assessment and highest-value remaining work](prize-assessment.md)

The Memory Palace lobby and floating room are now integrated into the team’s reconstruction/multiplayer repository; see [routes and integration boundaries](../memory-palace-integration.md). The published Figma file still uses its earlier Again/Mneme naming; this integration renamed the app, not the live design file. A public demo, judge access, actual team minutes/ratings, Edu confirmation, and physical Quest testing still need team completion. The eight earlier SVG layouts remain supporting assets; they are not the native component evidence.
