$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$vendorDirectory = Join-Path $projectDirectory 'vendor'
$manifest = Get-Content -LiteralPath (Join-Path $vendorDirectory 'CLOUDFLARED-VERSION.json') -Raw | ConvertFrom-Json
$downloadUri = [uri]$manifest.source
if ($downloadUri.Scheme -ne 'https' -or $downloadUri.Host -ne 'github.com' -or -not $downloadUri.AbsolutePath.StartsWith('/cloudflare/cloudflared/releases/download/')) { throw 'Expected an official Cloudflare release URL.' }
$binaryPath = Join-Path $vendorDirectory 'cloudflared.exe'
if ((Test-Path -LiteralPath $binaryPath) -and (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.sha256) { Write-Output 'Cloudflare helper already verified.'; exit 0 }
Invoke-WebRequest -Uri $manifest.source -OutFile $binaryPath
if ((Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'Cloudflare helper checksum mismatch. Do not build or run this download.' }
Write-Output "Verified official Cloudflare helper $($manifest.version)."
