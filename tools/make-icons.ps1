# Draws the PNG app icons from the same shapes as icons/icon.svg.
# Run from the repository root:  powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# $mode: 'any' = rounded square like the SVG; 'maskable' and 'apple' = full-bleed square,
# with the tile shrunk to stay inside the area platforms may crop.
function Write-Icon([int]$size, [string]$mode, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  $teal = [System.Drawing.ColorTranslator]::FromHtml('#0a0a0a')
  $s = $size / 512.0
  if ($mode -eq 'any') {
    $g.FillPath((New-Object System.Drawing.SolidBrush $teal), (New-RoundRect 0 0 $size $size (96 * $s)))
  } else {
    $g.Clear($teal)
    $k = if ($mode -eq 'maskable') { 0.78 } else { 0.92 }
    $g.TranslateTransform([single]($size * (1 - $k) / 2), [single]($size * (1 - $k) / 2))
    $s = $s * $k
  }
  $edge = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#d6141c'))
  $face = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#fbfaf6'))
  $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0a0a0a'))
  $g.FillPath($edge, (New-RoundRect (104 * $s) (96 * $s) (304 * $s) (320 * $s) (40 * $s)))
  $g.FillPath($face, (New-RoundRect (104 * $s) (96 * $s) (304 * $s) (300 * $s) (40 * $s)))
  $center = New-Object System.Drawing.StringFormat
  $center.Alignment = 'Center'; $center.LineAlignment = 'Center'
  $big = [System.Drawing.Font]::new('Impact', [single](200 * $s), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $small = [System.Drawing.Font]::new('Arial', [single](56 * $s), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $g.DrawString('M', $big, $ink, [System.Drawing.RectangleF]::new([single](104 * $s), [single](96 * $s), [single](284 * $s), [single](290 * $s)), $center)
  $g.DrawString('3', $small, $ink, [System.Drawing.RectangleF]::new([single](336 * $s), [single](318 * $s), [single](64 * $s), [single](70 * $s)), $center)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$dir = Join-Path (Get-Location) 'icons'
Write-Icon 192 'any' (Join-Path $dir 'icon-192.png')
Write-Icon 512 'any' (Join-Path $dir 'icon-512.png')
Write-Icon 512 'maskable' (Join-Path $dir 'icon-maskable-512.png')
Write-Icon 180 'apple' (Join-Path $dir 'apple-touch-icon.png')
Get-ChildItem $dir -Filter *.png | Select-Object Name, Length
