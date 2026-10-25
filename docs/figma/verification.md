# Verification and evidence

Checked on October 25, 2026. This records structural and browser checks, not a human usability study or headset certification.

## Native Figma

[The exported native audit](evidence/native-audit.json) ran at 11:17 UTC. It found 48 screens, five component sets, 14 variants, 188 reactions (including inherited interactions), 16 variables and 645 nodes with variable bindings. It reported no missing fonts or broken destination IDs. Those checks establish structural integrity; they do not prove every interaction's semantics.

A temporary MomentCard radius change from 24 to 25 propagated to 34 of 34 checked instances. The original value was restored. This demonstrates reuse, not a measured saving of time.

After the audit, final presentation testing corrected the home motion destination and moved desktop viewer Close controls beside the primary action. The heading and audit-layer visibility were also cleaned up. These changes did not add screens, components, variables or reactions. The audit JSON remains the earlier dated snapshot.

The native Slides audience view was exercised through Browse → Moment 01 → Save original → Close to Saved → Remove → empty → Browse again. Final screenshots:

- [Saved collection after Close](evidence/slide14-saved.png)
- [Empty state after Remove](evidence/slide14-empty.png)
- [Recovered collection after Browse](evidence/slide14-recovery.png)

These screenshots are cropped from the live presentation; they are not mockups. All 29 native originals have viewer destinations. Moment 01 provides the complete scripted saved/recovery journey; the other heart controls demonstrate component states. The mobile prototype represents the journey, with a simplified save transition. See [lobby-guide.md](lobby-guide.md) for those boundaries.

The deck and standalone source prototype loaded in fresh signed-out Chrome pages at 11:45 UTC. The deck showed the native embedded lobby and photographs; neither page required authentication. The Slides share dialog showed Anyone can view. This verifies initial access; the complete interaction walkthrough above was performed in the signed-in audience session. No sharing settings were changed.

## Working browser product

`npm run build` passed after the variable handoff. The existing room bundle still produces Vite's large-chunk advisory.

`node scripts/check-lobby.mjs` passed in Chrome after the handoff. Coverage includes 29 moments, original preview, favorite persistence, search and empty-state recovery, dialog focus, unavailable-storage fallback, layouts at 320/390/768 px, reduced motion, room entry/return and the supporting storyboard. No browser errors were reported. Chrome initially could not launch within the sandbox; the same check passed with an approved browser launch.

Nine variables were imported from the actual Figma audit into `src/generated/figma-lobby-tokens.css`: seven colors, a 44 px minimum target, and 180 ms hover duration. This is a deliberate export/import step. Repeat it with:

```sh
node scripts/figma/import-tokens.mjs docs/figma/evidence/native-audit.json
npm run build
node scripts/check-lobby.mjs
```

To export a fresh audit, run `scripts/figma/audit-native.js` in the source Design file using Scripter. Its report is stored in the `Mneme / Audit JSON` text layer and the prototype band's plugin data. Export that JSON, then pass its path to the import command. The existing audit layer is hidden to keep the canvas tidy. `scripts/figma/finalize-viewers.js` reapplies the presentation-tested desktop control placement if the prototype is rebuilt.

## Immersive room preservation

SHA-256 comparisons passed at 11:35 UTC for all three protected files:

| File | SHA-256 |
| --- | --- |
| `index.html` | `a0d70056a5e7fe14ae9ab41a04b1fbb638b331b54b7c688832cca60315627c04` |
| `src/main.js` | `41e70ef220000ab46153a53832fccf8d1d8864e99590264637dbdbf05f757dc5` |
| `src/style.css` | `ecb63ecd7df9da052e3ee846885f884e551125fbc58fe93551f711120d486272` |

The immersive room was byte-for-byte unchanged by this Figma work. Browser checks do not establish Quest 2 comfort, stereo scale, controller behavior or headset frame rate.

## Still needs the team

Actual minutes/ratings in the four logs; Education confirmation; public repository/demo access; final video at or below three minutes; integration with the separate multiplayer/reconstruction codebase if claimed; and physical Quest testing before making hardware claims. No Figma Make use, live Figma synchronization, human-test improvement, deployment or multiplayer integration is claimed by this package.
