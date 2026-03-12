$ErrorActionPreference = "Stop"

$Repo = "https://github.com/victoriacity/nanocode.git"
$Dir = "nanocode"
$Port = if ($env:PORT) { $env:PORT } else { "3000" }

Write-Host "=== Nanocode Installer ===" -ForegroundColor Green
Write-Host ""

# Check for Node.js
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "Node.js not found. Installing via winget..."
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Refresh PATH
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

# Check for Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Error: git is required. Install from https://git-scm.com and re-run." -ForegroundColor Red
    exit 1
}

# Clone or update
if (Test-Path $Dir) {
    Write-Host "Updating existing install..."
    Push-Location $Dir
    git pull --ff-only
} else {
    Write-Host "Cloning repository..."
    git clone $Repo $Dir
    Push-Location $Dir
}

# Install dependencies
Write-Host "Installing dependencies..."
npm install

Write-Host ""
Write-Host "=== Ready ===" -ForegroundColor Green
Write-Host "Run:  cd $Dir; npm run dev"
Write-Host "Open: http://localhost:$Port"
Write-Host ""

$answer = Read-Host "Start now? [Y/n]"
if ($answer -eq "" -or $answer -match "^[Yy]") {
    npm run dev
}

Pop-Location
