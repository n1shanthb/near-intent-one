# NIO mainnet autonomy ship script — requires Ledger USB + NEAR app unlocked.
# Run from repo root in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\mainnet\ship-autonomy-today.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "package.json"))) { $Root = (Get-Location).Path }
Set-Location $Root

$Near = Join-Path $env:USERPROFILE "bin\near-cli-rs\near-cli-rs-x86_64-pc-windows-msvc\near.exe"
$Wasm = Join-Path $Root "contracts\policy\target\wasm32-unknown-unknown\release\policy.wasm"
$HD = "m/44'/397'/0'/0'/1'"
$Policy = "policy.nishanthb.near"
$Owner = "nishanthb.near"
$ArgsDir = Join-Path $env:USERPROFILE ".nio-secure\mainnet-demo"
New-Item -ItemType Directory -Force -Path $ArgsDir | Out-Null

Write-Host "=== PRECHECK ===" -ForegroundColor Cyan
node scripts/mainnet/j18-deploy-upgrade.mjs --plan
if ($LASTEXITCODE -ne 0) { throw "plan failed" }

Write-Host "`nUnlock Ledger, open NEAR app, then press Enter..." -ForegroundColor Yellow
[void][System.Console]::ReadLine()

Write-Host "=== 1) DeployContract (NO init) ===" -ForegroundColor Cyan
& $Near contract deploy $Policy use-file $Wasm without-init-call network-config mainnet sign-with-ledger --seed-phrase-hd-path $HD usb send
if ($LASTEXITCODE -ne 0) { throw "deploy failed" }

Start-Sleep -Seconds 3
node scripts/mainnet/j18-deploy-upgrade.mjs --verify

Write-Host "=== 2) migrate_state_v1_autonomy ===" -ForegroundColor Cyan
& $Near contract call-function as-transaction $Policy migrate_state_v1_autonomy json-args "{}" prepaid-gas "50.0 Tgas" attached-deposit "0 NEAR" sign-as $Owner network-config mainnet sign-with-ledger --seed-phrase-hd-path $HD usb send
if ($LASTEXITCODE -ne 0) { throw "migrate failed" }

Start-Sleep -Seconds 2
node scripts/mainnet/j18-deploy-upgrade.mjs --verify

# Build mandate args with 24h expiry
$nowNs = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) * 1000000
$until = $nowNs + (24L * 3600L * 1000000000L)
$mandate = @{
  limits = @{
    max_trade_value = "1000000"
    daily_turnover_limit = "5000000"
    max_pending_exposure = "2000000"
    max_slippage_bps = 100
    allowed_assets = @(
      "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
      "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "nep141:wrap.near"
    )
    allowed_destinations = @("nishanthb.near", "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4")
    valid_until = "$until"
    token_scope = "allowlist"
    allowed_chains = @("near", "eip155:1", "eip155:42161", "eip155:8453")
    allowed_venues = @("near_intents_1click")
    max_gas_budget = "2500000000000000"
  }
  policy_hash = "nio-mainnet-demo-mandate-v1"
  strategy_hash = "nio-live-llm-fitter-v1"
  enforce_autonomous_on_agent = $true
  autonomous_trading = $true
  unpause_now = $false
} | ConvertTo-Json -Depth 8 -Compress
$MandateFile = Join-Path $ArgsDir "activate_autonomous_mandate.args.json"
Set-Content -Path $MandateFile -Value $mandate -NoNewline
Write-Host "Mandate args written: $MandateFile"

Write-Host "=== 3) activate_autonomous_mandate (unpause_now=false) ===" -ForegroundColor Cyan
& $Near contract call-function as-transaction $Policy activate_autonomous_mandate file-args $MandateFile prepaid-gas "80.0 Tgas" attached-deposit "0 NEAR" sign-as $Owner network-config mainnet sign-with-ledger --seed-phrase-hd-path $HD usb send
if ($LASTEXITCODE -ne 0) { throw "activate failed" }

Write-Host "=== 4) Provision mainnet journal secret if missing ===" -ForegroundColor Cyan
$JDir = Join-Path $env:USERPROFILE ".nio-secure\mainnet"
New-Item -ItemType Directory -Force -Path $JDir | Out-Null
$JSecret = Join-Path $JDir "journal.secret"
if (-not (Test-Path $JSecret)) {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $b64 = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  Set-Content -Path $JSecret -Value $b64 -NoNewline
  Write-Host "Provisioned mainnet journal secret (not printed)"
} else {
  Write-Host "Reusing existing mainnet journal secret"
}
$env:NIO_TX_JOURNAL_SECRET_PATH = $JSecret

Write-Host "=== 5) unpause (separate Ledger confirm) ===" -ForegroundColor Cyan
$UnpauseFile = Join-Path $ArgsDir "unpause.args.json"
Set-Content -Path $UnpauseFile -Value "{}" -NoNewline
& $Near contract call-function as-transaction $Policy unpause file-args $UnpauseFile prepaid-gas "30.0 Tgas" attached-deposit "0 NEAR" sign-as $Owner network-config mainnet sign-with-ledger --seed-phrase-hd-path $HD usb send
if ($LASTEXITCODE -ne 0) { throw "unpause failed" }

Write-Host "=== 6) Keeper one-shot LIVE_LLM (funded unlock) ===" -ForegroundColor Cyan
$env:NIO_NETWORK = "mainnet"
$env:NIO_POLICY = $Policy
$env:NIO_KEEPER_MODE = "LIVE_LLM"
$env:NIO_MAINNET_AUTONOMOUS_EXEC = "1"
node scripts/mainnet/autonomous-demo-cycle.mjs
Write-Host "DONE — see docs/evidence/MAINNET_* and DEMO_*" -ForegroundColor Green
