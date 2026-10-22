param(
  [Parameter(Mandatory = $true)][string]$InputFile
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}
Add-Type -AssemblyName Microsoft.VisualBasic

function Emit-Result($path, $ok, $errorText) {
  [pscustomobject]@{
    path  = $path
    ok    = [bool]$ok
    error = $errorText
  } | ConvertTo-Json -Compress -Depth 3
}

try {
  $raw = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8
  $parsed = $raw | ConvertFrom-Json
  if ($null -ne $parsed.paths) {
    $paths = @($parsed.paths)
  } elseif ($parsed -is [System.Array]) {
    $paths = @($parsed)
  } else {
    $paths = @($parsed)
  }
} catch {
  Emit-Result '' $false ('Cannot read path list: ' + $_.Exception.Message)
  exit 1
}

foreach ($p in $paths) {
  try {
    if ([System.IO.Directory]::Exists($p)) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        $p,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
      )
    } elseif ([System.IO.File]::Exists($p)) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $p,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
      )
    } else {
      throw 'Path not found'
    }
    Emit-Result $p $true $null
  } catch {
    Emit-Result $p $false $_.Exception.Message
  }
}
