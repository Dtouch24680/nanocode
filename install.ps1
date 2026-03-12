$ErrorActionPreference = "Stop"

$Port = if ($env:PORT) { $env:PORT } else { "3000" }

# Ensure we're in the repo root
if (-not (Test-Path "package.json") -or -not (Select-String -Path "package.json" -Pattern '"nanocode"' -Quiet)) {
    Write-Host "Error: Run this script from the nanocode repo root." -ForegroundColor Red
    exit 1
}

Write-Host "=== Nanocode Installer ===" -ForegroundColor Green
Write-Host ""

# --- Node.js ---
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "Node.js not found. Installing via winget..."
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCmd) {
            Write-Host "Error: Node.js installed but not in PATH. Restart your terminal and re-run." -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "Error: winget not available. Install Node.js 20+ from https://nodejs.org and re-run." -ForegroundColor Red
        exit 1
    }
}

$nodeVer = (node -v) -replace 'v(\d+)\..*', '$1'
if ([int]$nodeVer -lt 18) {
    Write-Host "Error: Node.js 18+ required (found $(node -v))." -ForegroundColor Red
    exit 1
}
Write-Host "Node.js $(node -v) OK"

# --- Git ---
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Error: git is required. Install from https://git-scm.com and re-run." -ForegroundColor Red
    exit 1
}

# --- Python (needed by node-gyp) ---
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) { $pythonCmd = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $pythonCmd) {
    Write-Host "Python not found. Installing via winget..."
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        winget install Python.Python.3.12 --accept-source-agreements --accept-package-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    } else {
        Write-Host "Warning: Python not found. Native modules may fail to build." -ForegroundColor Yellow
    }
}

# --- Visual Studio Build Tools ---
$hasVS = $false
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
    $vsPath = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($vsPath) { $hasVS = $true }
}

if (-not $hasVS) {
    Write-Host ""
    Write-Host "Visual Studio Build Tools not found." -ForegroundColor Yellow
    Write-Host "Native module node-pty requires C++ build tools." -ForegroundColor Yellow
    Write-Host ""
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        $installVS = Read-Host "Install Visual Studio Build Tools via winget? [Y/n]"
        if ($installVS -eq "" -or $installVS -match "^[Yy]") {
            Write-Host "Installing Visual Studio Build Tools (this may take a few minutes)..."
            winget install Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
            Write-Host "Build Tools installed." -ForegroundColor Green
        }
    } else {
        Write-Host "Install manually: https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Yellow
        Write-Host "Select 'Desktop development with C++' workload" -ForegroundColor Yellow
        $cont = Read-Host "Continue anyway? [y/N]"
        if ($cont -notmatch "^[Yy]") { exit 1 }
    }
}

# --- Install dependencies ---
Write-Host "Installing dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "npm install failed. Common fixes:" -ForegroundColor Red
    Write-Host "  1. Install Visual Studio Build Tools with C++ workload" -ForegroundColor Yellow
    Write-Host "  2. Run: npm config set msvs_version 2022" -ForegroundColor Yellow
    Write-Host "  3. Restart terminal and re-run this script" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "=== Ready ===" -ForegroundColor Green
Write-Host "Run:  npm run dev"
Write-Host "Open: http://localhost:$Port"
Write-Host ""

$answer = Read-Host "Start now? [Y/n]"
if ($answer -eq "" -or $answer -match "^[Yy]") {
    npm run dev
}
