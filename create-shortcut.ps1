$ErrorActionPreference = 'Stop'

$app = $PSScriptRoot
$launcher = Get-ChildItem -LiteralPath $app -Filter '*.bat' |
  Where-Object { $_.Name -ne 'create-shortcut.bat' } |
  Sort-Object Name |
  Select-Object -First 1

if (-not $launcher) {
  throw 'Launcher .bat was not found next to this script.'
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutName = $launcher.BaseName
# Drop the leading Chinese verb (U+542F U+52A8) for a cleaner shortcut title.
$startPrefix = [string][char]0x542F + [string][char]0x52A8
if ($shortcutName.StartsWith($startPrefix)) {
  $shortcutName = $shortcutName.Substring($startPrefix.Length)
}
$shortcutPath = Join-Path $desktop ($shortcutName + '.lnk')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher.FullName
$shortcut.WorkingDirectory = $app
$shortcut.IconLocation = Join-Path $env:SystemRoot 'System32\imageres.dll,3'
$shortcut.Description = 'C drive space cleaner'
$shortcut.Save()

Write-Output ('Shortcut created: ' + $shortcutPath)
