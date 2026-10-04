# Build the Electron portable WeportFlash executable.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  & npm run build:flash
  if ($LASTEXITCODE -ne 0) { throw 'WeportFlash build failed' }
} finally { Pop-Location }
