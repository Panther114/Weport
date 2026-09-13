# Crop a region out of a screenshot so details (fonts, hairlines, stray borders)
# can be inspected at full resolution instead of squinting at a scaled preview.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height,
  [string]$Out = '',
  [double]$Scale = 1.0
)

Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile((Resolve-Path $Path).Path)
try {
  if ($Out -eq '') {
    $dir = Split-Path -Parent $Path
    $name = [System.IO.Path]::GetFileNameWithoutExtension($Path)
    $Out = Join-Path $dir "$name-crop.png"
  }

  $w = [Math]::Min($Width, $source.Width - $X)
  $h = [Math]::Min($Height, $source.Height - $Y)
  $targetW = [int][Math]::Round($w * $Scale)
  $targetH = [int][Math]::Round($h * $Scale)

  $bmp = New-Object System.Drawing.Bitmap($targetW, $targetH)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
      $dest = New-Object System.Drawing.Rectangle(0, 0, $targetW, $targetH)
      $src = New-Object System.Drawing.Rectangle($X, $Y, $w, $h)
      $g.DrawImage($source, $dest, $src, [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $g.Dispose() }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bmp.Dispose() }
} finally { $source.Dispose() }

Write-Output $Out
