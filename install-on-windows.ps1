# ZAI Agent - Windows Installation Script
# Run this on your Windows server (aicq.online) in PowerShell

$ErrorActionPreference = "Stop"
$InstallDir = "C:\zai"

Write-Host "=== ZAI Agent Windows Installer ===" -ForegroundColor Cyan

# Check Node.js
$nodeVersion = $null
try { $nodeVersion = & node --version 2>&1 } catch {}

if (-not $nodeVersion) {
    Write-Host "Installing Node.js..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

Write-Host "Node.js version: $(node --version)" -ForegroundColor Green

# Create directory
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Set-Location $InstallDir

# Clone from git
Write-Host "Cloning from GitHub..." -ForegroundColor Yellow
if (Test-Path "$InstallDir\.git") {
    git pull origin main
} else {
    git clone https://github.com/ctz168/zai.git .
}

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Yellow
npm install --production

# Build
Write-Host "Building..." -ForegroundColor Yellow
npm run build

# Login to Z.AI (if not already done)
$authFile = "$env:USERPROFILE\.zai\auth.json"
if (-not (Test-Path $authFile)) {
    Write-Host ""
    Write-Host "=== Z.AI Login ===" -ForegroundColor Cyan
    Write-Host "You need to login to Z.AI first. Opening browser..." -ForegroundColor Yellow
    node dist/cli.js login
} else {
    Write-Host "Z.AI auth found: $authFile" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Installation Complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "To start the agent:"
Write-Host "  cd $InstallDir" -ForegroundColor Yellow
Write-Host "  node dist/cli.js agent" -ForegroundColor Yellow
Write-Host ""
Write-Host "To start as daemon (background):"
Write-Host "  node dist/cli.js agent --daemon" -ForegroundColor Yellow
Write-Host ""
Write-Host "To check status:"
Write-Host "  node dist/cli.js agent --daemon status" -ForegroundColor Yellow
