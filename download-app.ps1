$ErrorActionPreference = 'Stop'

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repo = 'DreamChaser-strive/cdrive-cleaner'
$api = "https://api.github.com/repos/$repo/releases/latest"
$headers = @{
  Accept    = 'application/vnd.github+json'
  'User-Agent' = 'CDriveCleaner-Downloader'
}

Write-Host 'Looking for the latest Windows portable app...'
$release = Invoke-RestMethod -Uri $api -Headers $headers
$asset = $release.assets | Where-Object { $_.name -like '*portable.exe' } | Select-Object -First 1

if (-not $asset) {
  throw 'The latest release does not contain a portable .exe asset.'
}

$outDir = (Get-Location).Path
$outFile = Join-Path $outDir $asset.name

Write-Host "Downloading $($asset.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $outFile -Headers @{ 'User-Agent' = 'CDriveCleaner-Downloader' }

Write-Host ''
Write-Host "Saved to: $outFile"
Write-Host 'Double-click the exe to start the app. Keep the .exe file; the .bat launcher is not required.'
