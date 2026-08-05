# fn_qycs Build & Package Script

$ErrorActionPreference = "Stop"
$srcDir = Join-Path $PSScriptRoot "server-src"
$serverDir = Join-Path $PSScriptRoot "package\app\server"

if (-not (Test-Path $serverDir)) {
    New-Item -ItemType Directory -Path $serverDir -Force | Out-Null
}

# ========== 读取版本号 ==========
$manifestPath = Join-Path (Join-Path $PSScriptRoot "package") "manifest"
$version = $null
if (Test-Path $manifestPath) {
    $m = Get-Content $manifestPath | Select-String -Pattern "^\s*version\s*=\s*(\S+)"
    if ($m) { $version = $m.Matches[0].Groups[1].Value.Trim() }
}
if (-not $version) {
    Write-Host "[WARN] version not found in manifest, using 0.0.0" -ForegroundColor Yellow
    $version = "0.0.0"
}

Write-Host ""
Write-Host "========== fn_qycs Build (v$version) ==========" -ForegroundColor Cyan
Write-Host "Source: $srcDir"
Write-Host "Output: $serverDir"
Write-Host ""

$ldflags = "-s -w -X main.appVersion=$version"

# ========== 注入版本号到 app.js（必须在 Go build 前执行，因为 //go:embed static/* 在编译时嵌入） ==========
$appJsPath = Join-Path $srcDir "static\js\app.js"
if (Test-Path $appJsPath) {
    $appJs = [System.IO.File]::ReadAllText($appJsPath, [System.Text.Encoding]::UTF8)
    $appJs = $appJs -replace "const VERSION\s*=\s*'[^']*'", "const VERSION = '$version'"
    [System.IO.File]::WriteAllText($appJsPath, $appJs, (New-Object System.Text.UTF8Encoding $false))
    Write-Host ("[VERSION] app.js VERSION = {0} (from manifest)" -f $version) -ForegroundColor Green
}

function Build-Binary {
    param(
        [string]$GOOS,
        [string]$GOARCH,
        [string]$Output,
        [string]$Label
    )

    Write-Host "[BUILD] $Label ..." -ForegroundColor Yellow

    $env:GOOS = $GOOS
    $env:GOARCH = $GOARCH
    $env:CGO_ENABLED = "0"

    Push-Location $srcDir
    try {
        & go build -ldflags $ldflags -o $Output .
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[FAIL] $Label" -ForegroundColor Red
            exit 1
        }
    }
    finally {
        Pop-Location
    }

    $size = (Get-Item $Output).Length / 1MB
    Write-Host ("[DONE] {0} ({1:N1} MB) -> {2}" -f $Label, $size, $Output) -ForegroundColor Green
}

Build-Binary -GOOS "linux" -GOARCH "amd64" -Output (Join-Path $serverDir "fn_qycs-server-amd64") -Label "Linux AMD64"
Build-Binary -GOOS "linux" -GOARCH "arm64" -Output (Join-Path $serverDir "fn_qycs-server-arm64") -Label "Linux ARM64"
Build-Binary -GOOS "windows" -GOARCH "amd64" -Output (Join-Path $PSScriptRoot "fn_qycs_test.exe") -Label "Windows"

$env:GOOS = ""
$env:GOARCH = ""
$env:CGO_ENABLED = ""

Write-Host ""
Write-Host "========== Build Complete ==========" -ForegroundColor Cyan
Write-Host "fn_qycs-server-amd64: $serverDir\fn_qycs-server-amd64"
Write-Host "fn_qycs-server-arm64: $serverDir\fn_qycs-server-arm64"
Write-Host "fn_qycs_test.exe:     $PSScriptRoot\fn_qycs_test.exe"
Write-Host ""

# ========== fpk 打包 ==========
$fnpack = Join-Path $PSScriptRoot "fnpack.exe"
$pkgDir = Join-Path $PSScriptRoot "package"
$fpkName = "fn_qycs v$version.fpk"
$fpkOut  = Join-Path $PSScriptRoot $fpkName

if ((Test-Path $fnpack) -and (Test-Path $pkgDir)) {
    Write-Host ("[PACK] fnpack build -d package (v{0}) ..." -f $version) -ForegroundColor Yellow
    $fnpackOutput = & $fnpack build -d $pkgDir 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] fnpack error (exit $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }

    $generated = Get-ChildItem -Path $PSScriptRoot -Filter *.fpk | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $generated) {
        $generated = Get-ChildItem -Path $pkgDir -Filter *.fpk | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if ($generated) {
        if (Test-Path $fpkOut) { Remove-Item $fpkOut -Force }
        Move-Item -Path $generated.FullName -Destination $fpkOut -Force
        $size = (Get-Item $fpkOut).Length / 1MB
        Write-Host ("[DONE] fpk: {0} ({1:N1} MB)" -f $fpkOut, $size) -ForegroundColor Green
    } else {
        Write-Host "[WARN] .fpk file not found" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "========== All Done ==========" -ForegroundColor Cyan
