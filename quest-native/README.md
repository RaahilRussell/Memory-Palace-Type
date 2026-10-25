# Cal Hacks venue Quest demo

This builds a standalone, immersive OpenXR APK for the local **unpopulated Cal Hacks venue scan**. It bundles the scan mesh and its texture, so it does not contact the memoir server or use the laptop as a host. Video and multiplayer are outside this demo.

With the Quest 2 connected by USB and USB debugging authorized, run this from the repository root:

```powershell
./scripts/build-and-sideload-quest-static-demo.ps1
```

The script builds an ARM64 APK, installs it, and launches it. It saves the ignored build output at `.local/Again-Cal-Hacks-Venue.apk`. To build without installing, add `-BuildOnly`. Sideloaded apps appear in **Library → Unknown Sources**.

The build reads `data/uploads/scans/cal-hacks-venue/environment.obj` and `texture.jpg`. These are local scan files and are not included in Git. The viewer starts at the venue's front-side spawn point and tracks head movement; this first static demo has no venue locomotion controls or attendee population.

The native renderer is adapted from Khronos OpenXR-SDK-Source at commit `a9f14c416e383d05c142f5a2539a91fe3931b52a` (Apache-2.0). `stb_image.h` is from nothings/stb (public domain or MIT; see its header). The checked-in patch and build script apply the changes to a local ignored checkout.
