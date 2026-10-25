# Motion contract

The native Figma product page has two motion flow starts: **Mneme / motion storyboard** and **Mneme / reduced motion**. Regular flow uses Arrive → Aim → Open → Return with 450 ms ease-in-out dissolves. Reduced motion uses instant Arrive → Open → Return transitions. Both return to the lobby. The separate [HTML study](http://localhost:5174/storyboard/index.html) includes the lobby as an additional opening beat and supports manual playback.

| Surface | Contract | Implementation boundary |
| --- | --- | --- |
| Lobby controls | 180 ms hover; minimum 44 CSS px targets | Values exported from native Figma variables into CSS |
| Lobby photo preview | Slow 10 px drift over 9 seconds; disabled for reduced motion | Running browser behavior |
| Figma room storyboard | 450 ms dissolve, instant reduced-motion alternative | Communicates sequence; does not simulate XR |
| Existing room | Photo focus uses continuous easing; return is immediate | Runtime is not an exact 450 ms dissolve; room code untouched |
| Viewer | Fixed origin; no automatic camera push | Physical Quest comfort and performance remain untested |

The source includes a 450 ms motion handoff variable, but Figma transition durations are explicitly set in reactions. Do not claim that the variable automatically controls prototype transition settings. The room's current focus distance is 2.35 m; 2D drawings cannot validate stereoscopic scale, latency or controller targets.

## Apply the same method across Again

These are design recipes for the wider product, based on the repository documentation. They are not claims that these flows were implemented or tested in this local Memory Palace prototype.

| Journey | Storyboard states | Minimal motion | Truthful completion / recovery |
| --- | --- | --- | --- |
| Add moments | Room → native picker → decoding → added / failed | New photo fades in, 350 ms; existing layout stays stable | Reveal only after decode succeeds. Cancel returns unchanged; failure offers retry. Local imports are session-only. |
| Find a moment | Scrapbook → query → searching → results / empty / error | Results dissolve, 200 ms; keep query in place | Wait for actual search result; label fallback search when used. Keep editable query on failure. |
| View original | Memory → original → memory | Photo-to-photo dissolve, 200 ms | Preserve the unmodified source and return context. Do not label a graded preview as the original. |
| Step inside | Photo → preparing scene → first render ready → scene / failed | Keep source photo visible; crossfade 600 ms after ready | Do not replace readiness with a timer. Allow cancel/retry and label inferred geometry. No forced VR camera movement. |
| Remember together | Private → share choice → invitation → waiting → joined / expired | Overlay dissolve, 200 ms; presence appears on confirmation | Do not show another person before a real membership event. Preserve privacy defaults; provide leave/revoke where supported. |
| Choose what to share | Private memory → selected scope → confirmation → shared | Instant selection; 200 ms confirmation | Show actual selected scope before committing; reflect server success, not click alone. |
| Tell the story | Chapter → editable words → saving → saved / failed | Stable text; quiet status fade | Keep typed content on failure. AI suggestions need review before acceptance. |
| Revisit a room | Collection → chosen room → loading → room / unavailable | 350 ms dissolve after assets are ready | Keep a clear route back. Never leave a blank screen while waiting. |

For each row, prototype one successful path and one meaningful failure path. There is no need to animate every screenshot or model every backend edge case in Figma.

## Reusable handoff note

```text
Intent:
Figma frame/component + version:
Trigger:
Initial → waiting → success / failure → return:
Properties changed / duration / easing:
Reduced-motion behavior:
Actual data or render event that means ready:
Cancel, retry, and return behavior:
Code location + final revision:
Observed test result / remaining limitation:
```

The existing native library covers lobby Action, Save, MomentCard, Navigation and Destination. A full spatial MemoryWindow state library would be additional work; it is not claimed as shipped.
