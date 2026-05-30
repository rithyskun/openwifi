param(
    [string]$Name = ""
)

$Host.UI.RawUI.ForegroundColor = "Cyan"
Write-Host @"
  ╔══════════════════════════════════════╗
  ║        OpenWiFi Mesh Installer       ║
  ╚══════════════════════════════════════╝
"@
$Host.UI.RawUI.ForegroundColor = "White"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    $Host.UI.RawUI.ForegroundColor = "Red"
    Write-Host "  Error: Node.js is not installed."
    $Host.UI.RawUI.ForegroundColor = "White"
    Write-Host ""
    Write-Host "  Download from: https://nodejs.org (v18 or later)"
    Write-Host "  Or install via winget:"
    Write-Host "    winget install OpenJS.NodeJS"
    exit 1
}

$nodeVersion = [int]((node -v) -replace 'v', '' -replace '\..*', '')
if ($nodeVersion -lt 18) {
    $Host.UI.RawUI.ForegroundColor = "Yellow"
    Write-Host "  Warning: Node.js v18+ recommended (found v$(node -v -replace 'v', ''))"
    $Host.UI.RawUI.ForegroundColor = "White"
}

Write-Host "  $([char]0x2713) Node.js $(node -v) detected"
Write-Host "  $([char]0x2713) npm $(npm -v) detected"
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "  Installing dependencies..."
npm install

Write-Host ""
$Host.UI.RawUI.ForegroundColor = "Green"
Write-Host "  $([char]0x2713) Installation complete!"
$Host.UI.RawUI.ForegroundColor = "White"
Write-Host ""
$Host.UI.RawUI.ForegroundColor = "Cyan"
Write-Host "  Usage:"
$Host.UI.RawUI.ForegroundColor = "White"
Write-Host "    npm start                                  Run with default name"
Write-Host "    npm start -- --name ""MyNode""               Run with custom name"
Write-Host "    npm start -- --secret ""my passphrase""      Encrypt database with passphrase"
Write-Host "    OPENWIFI_SECRET=""secret"" npm start         Set secret via env var"
Write-Host "    node src/index.js --web-port 8080           Run on specific web port"
Write-Host ""
$Host.UI.RawUI.ForegroundColor = "Cyan"
Write-Host "  Run two nodes to test:"
$Host.UI.RawUI.ForegroundColor = "White"
Write-Host "    Terminal 1:  npm start -- --name ""Alpha"" --secret ""my key"""
Write-Host "    Terminal 2:  npm start -- --name ""Beta"" --secret ""my key"""
Write-Host ""
Write-Host "  Then open the Web UI URLs printed in the terminal."
Write-Host "  Nodes on the same LAN will discover each other automatically."
Write-Host ""
