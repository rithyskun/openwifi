param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$NodeArgs
)

$Host.UI.RawUI.ForegroundColor = "Cyan"
Write-Host @"
  ╔══════════════════════════════════════╗
  ║          OpenWiFi Mesh Node          ║
  ╚══════════════════════════════════════╝
"@
$Host.UI.RawUI.ForegroundColor = "White"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    $Host.UI.RawUI.ForegroundColor = "Red"
    Write-Host "  Error: Node.js is not installed."
    $Host.UI.RawUI.ForegroundColor = "White"
    Write-Host "  Download from: https://nodejs.org (v18+)"
    exit 1
}

$nodeVersion = [int]((node -v) -replace 'v', '' -replace '\..*', '')
if ($nodeVersion -lt 18) {
    $Host.UI.RawUI.ForegroundColor = "Yellow"
    Write-Host "  Warning: Node.js v18+ recommended (found v$(node -v -replace 'v', ''))"
    $Host.UI.RawUI.ForegroundColor = "White"
}

Write-Host "  $([char]0x2713) Node.js $(node -v)"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

if (-not (Test-Path "node_modules")) {
    Write-Host ""
    $Host.UI.RawUI.ForegroundColor = "Yellow"
    Write-Host "  Installing dependencies..."
    $Host.UI.RawUI.ForegroundColor = "White"
    npm install
    Write-Host ""
}

Write-Host ""
$Host.UI.RawUI.ForegroundColor = "Cyan"
Write-Host "  Starting node..."
$Host.UI.RawUI.ForegroundColor = "White"
Write-Host ""

$psi = @{
    FilePath = "node"
    ArgumentList = @("src/index.js") + $NodeArgs
    NoNewWindow = $true
    Wait = $true
}

$proc = Start-Process @psi -PassThru
exit $proc.ExitCode
