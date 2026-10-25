param([switch]$BuildOnly)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$localRoot = Join-Path $repoRoot '.local'
$sdkRoot = Join-Path $localRoot 'quest-static-openxr-source'
$patchFile = Join-Path $repoRoot 'quest-native/openxr-sample.patch'
$scanRoot = Join-Path $repoRoot 'data/uploads/scans/cal-hacks-venue'
$appRoot = Join-Path $sdkRoot 'src/tests/hello_xr'
$assetRoot = Join-Path $appRoot 'src/main/assets'
$outputApk = Join-Path $localRoot 'Again-Cal-Hacks-Venue.apk'
$sdkCommit = 'a9f14c416e383d05c142f5a2539a91fe3931b52a'

foreach ($file in @('environment.obj', 'texture.jpg')) {
    if (-not (Test-Path -LiteralPath (Join-Path $scanRoot $file))) {
        throw "The local Cal Hacks venue scan is missing '$file' under $scanRoot."
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'quest-native/stb_image.h'))) {
    throw 'The bundled image decoder is missing from quest-native/stb_image.h.'
}
New-Item -ItemType Directory -Force -Path $localRoot | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $sdkRoot '.git'))) {
    git clone --depth 1 https://github.com/KhronosGroup/OpenXR-SDK-Source.git $sdkRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the Khronos OpenXR sample.' }
    git -C $sdkRoot fetch --depth 1 origin $sdkCommit
    if ($LASTEXITCODE -ne 0) { throw "Could not fetch OpenXR source revision $sdkCommit." }
    git -C $sdkRoot checkout --detach $sdkCommit
    if ($LASTEXITCODE -ne 0) { throw "Could not select OpenXR source revision $sdkCommit." }
} elseif ((git -C $sdkRoot rev-parse HEAD).Trim() -ne $sdkCommit) {
    throw "The generated OpenXR checkout at $sdkRoot is not at the pinned revision $sdkCommit. Move it aside and rerun this script."
}

git -C $sdkRoot apply --reverse --check $patchFile 2>$null
if ($LASTEXITCODE -ne 0) {
    git -C $sdkRoot apply --check $patchFile
    if ($LASTEXITCODE -ne 0) { throw 'The OpenXR checkout has unexpected edits; refusing to overwrite them.' }
    git -C $sdkRoot apply $patchFile
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply the static venue viewer patch.' }
}

New-Item -ItemType Directory -Force -Path $assetRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'quest-native/stb_image.h') -Destination (Join-Path $appRoot 'venue_stb_image.h') -Force
Copy-Item -LiteralPath (Join-Path $scanRoot 'environment.obj') -Destination (Join-Path $assetRoot 'venue.obj') -Force
Copy-Item -LiteralPath (Join-Path $scanRoot 'texture.jpg') -Destination (Join-Path $assetRoot 'venue.jpg') -Force

Push-Location $appRoot
try {
    & .\gradlew.bat assembleOpenGLESDebug --no-daemon
    if ($LASTEXITCODE -ne 0) { throw 'The Quest Android build failed.' }
} finally {
    Pop-Location
}

$builtApk = Join-Path $appRoot 'build/outputs/apk/OpenGLES/debug/hello_xr-OpenGLES-debug.apk'
if (-not (Test-Path -LiteralPath $builtApk)) { throw "The build completed without producing $builtApk." }
Copy-Item -LiteralPath $builtApk -Destination $outputApk -Force
Write-Host "Built standalone venue APK: $outputApk"

if (-not $BuildOnly) {
    $adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
    $devices = & $adb devices
    if ($LASTEXITCODE -ne 0 -or -not ($devices | Select-String -Quiet -Pattern '^\S+\s+device(\s|$)')) {
        throw 'No authorized Quest device is connected over USB. Reconnect it and accept the USB debugging prompt.'
    }
    & $adb install -r $outputApk
    if ($LASTEXITCODE -ne 0) { throw 'ADB could not install the venue APK on the Quest.' }
    $metavr = Join-Path $env:USERPROFILE '.metavr/bin/metavr.exe'
    if (Test-Path -LiteralPath $metavr) {
        & $metavr app launch com.againmemoir.venue.opengles --wait-for-idle --wait-timeout 25 --verify
    } else {
        & $adb shell am start -W -n com.againmemoir.venue.opengles/android.app.NativeActivity
    }
    if ($LASTEXITCODE -ne 0) { throw 'The APK installed, but the Quest app did not launch cleanly.' }
}
