param(
    [string]$VideoPath = ".local/mint-vr-scene/data/uploads/102f940c-e4cd-4469-ab4a-02a09174416c.mp4",
    [string]$ReconstructionPath = ".local/mint-vr-scene/data/uploads/reconstructions/059477bbfcb9c5745546cf3a11e8b3f8.json",
    [string]$MotionPath = "$env:USERPROFILE\Downloads\PXL_20261025_083908971.TS_customModel_jjdkTKijbmuNrKmcVNd7Tb.bvh",
    [string]$AssetDirectory = ".local/mint-mint-quest-assets-hq",
    [string]$OpenXrSourceDirectory = ".local/mint-openxr-source",
    [string]$OutputApk = ".local/mint toss demo std local v3.apk",
    [switch]$RebuildHuman
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
function Resolve-RepoPath([string]$path) {
    if ([IO.Path]::IsPathRooted($path)) { return $path }
    return Join-Path $repoRoot $path
}

$VideoPath = Resolve-RepoPath $VideoPath
$ReconstructionPath = Resolve-RepoPath $ReconstructionPath
$MotionPath = Resolve-RepoPath $MotionPath
$AssetDirectory = Resolve-RepoPath $AssetDirectory
$OpenXrSourceDirectory = Resolve-RepoPath $OpenXrSourceDirectory
$OutputApk = Resolve-RepoPath $OutputApk
$nativeProject = Join-Path $OpenXrSourceDirectory "src/tests/hello_xr"
$sceneDescriptor = Join-Path $AssetDirectory "mint.scene"
if (-not (Test-Path $sceneDescriptor)) {
    & npx tsx (Join-Path $repoRoot "scripts/export-mint-quest-assets.ts") $VideoPath $ReconstructionPath $AssetDirectory
    if ($LASTEXITCODE -ne 0) { throw "Mint scene asset export failed ($LASTEXITCODE)." }
}
$humanMesh = Join-Path $AssetDirectory "human.mesh"
if (-not (Test-Path $MotionPath) -and ($RebuildHuman -or -not (Test-Path $humanMesh))) { throw "The supplied matching BVH motion file was not found: $MotionPath" }
if ($RebuildHuman -or -not (Test-Path $humanMesh)) {
    & npx tsx (Join-Path $repoRoot "scripts/export-mint-human.ts") $MotionPath $ReconstructionPath $AssetDirectory $humanMesh
    if ($LASTEXITCODE -ne 0) { throw "Articulated Mint human asset export failed ($LASTEXITCODE)." }
} else {
    $humanHeader = [IO.File]::ReadAllBytes($humanMesh)
    if ($humanHeader.Length -lt 36 -or [Text.Encoding]::ASCII.GetString($humanHeader, 0, 4) -ne "H3D2") {
        throw "The cached articulated human mesh is invalid; remove it or pass -RebuildHuman."
    }
}

if (-not (Test-Path (Join-Path $OpenXrSourceDirectory ".git"))) {
    $pinnedSource = "a9f14c416e383d05c142f5a2539a91fe3931b52a"
    & git clone --no-checkout https://github.com/KhronosGroup/OpenXR-SDK-Source.git $OpenXrSourceDirectory
    if ($LASTEXITCODE -ne 0) { throw "Could not clone the pinned OpenXR source." }
    & git -C $OpenXrSourceDirectory checkout --detach $pinnedSource
    if ($LASTEXITCODE -ne 0) { throw "Could not check out pinned OpenXR source $pinnedSource." }
    & git -C $OpenXrSourceDirectory apply (Join-Path $repoRoot "quest-native/openxr-sample.patch")
    if ($LASTEXITCODE -ne 0) { throw "Could not apply the base Quest room renderer." }
    & git -C $OpenXrSourceDirectory apply (Join-Path $repoRoot "quest-native/mint-video-scene.patch")
    if ($LASTEXITCODE -ne 0) { throw "Could not apply the Mint Toss renderer." }
}
if (-not (Select-String -Path (Join-Path $nativeProject "graphicsplugin_opengles.cpp") -Pattern 'LoadMintScene' -Quiet)) {
    throw "The OpenXR source checkout exists but is not prepared with the Mint Toss patches. Remove only that ignored checkout or set -OpenXrSourceDirectory to a prepared checkout."
}
Copy-Item -LiteralPath (Join-Path $repoRoot "quest-native/third_party/stb_image.h") -Destination (Join-Path $nativeProject "venue_stb_image.h") -Force

$assetsPath = Join-Path $nativeProject "mint_assets"
if (Test-Path $assetsPath) {
    $resolvedAssetsPath = (Resolve-Path $assetsPath).Path
    $expectedAssetsPath = [IO.Path]::GetFullPath($assetsPath)
    if (-not [string]::Equals($resolvedAssetsPath, $expectedAssetsPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace an asset directory whose resolved path differs from the generated Mint asset path."
    }
    Remove-Item -LiteralPath $resolvedAssetsPath -Recurse -Force
}
New-Item -ItemType Directory -Path $assetsPath -Force | Out-Null
Copy-Item -Path (Join-Path $AssetDirectory "*") -Destination $assetsPath -Recurse -Force

$gradle = Join-Path $nativeProject "gradlew.bat"
Push-Location $nativeProject
try {
    & $gradle --no-daemon --console=plain assembleOpenGLESDebug
    if ($LASTEXITCODE -ne 0) { throw "The standalone OpenXR Mint Toss APK build failed ($LASTEXITCODE)." }
} finally {
    Pop-Location
}

$apk = Get-ChildItem (Join-Path $nativeProject "build/outputs/apk") -Filter "*.apk" -Recurse |
    Where-Object { $_.FullName -match "(?i)opengles" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $apk) { throw "Gradle completed but did not produce the OpenGLES APK." }
New-Item -ItemType Directory -Path (Split-Path $OutputApk) -Force | Out-Null
Copy-Item -LiteralPath $apk.FullName -Destination $OutputApk -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputApk).Hash
Write-Output "APK: $OutputApk"
Write-Output "Bytes: $((Get-Item -LiteralPath $OutputApk).Length)"
Write-Output "SHA256: $hash"
