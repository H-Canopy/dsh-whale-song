# Build a .ico for the desktop pet shortcut, and point the shortcut at it.
#
# Why hand-rolled: this machine has no ImageMagick, and Windows shortcuts cannot use a
# .png directly as IconLocation (that produced the generic document icon).
#
# Why BMP/DIB entries and not PNG for the small sizes:
#   I first packed every size as an embedded PNG (legal per the ICO spec, and .NET's
#   Image class reads it back fine) - but `System.Drawing.Icon` returned GARBAGE for it
#   (48px corners came out 182/40/88/216 instead of ~0) and Windows Shell showed the
#   fallback icon, i.e. the shell's decoder failed the same way.
#   So: 16/32/48/64 are written as classic BMP/DIB entries (BITMAPINFOHEADER, 32bpp,
#   bottom-up BGRA, plus the AND mask), which every Windows version decodes reliably.
#   Only the 256x256 entry stays PNG, which is the one case Windows expects as PNG.
#
# ASCII only (PS 5.1 misreads BOM-less UTF-8 Chinese and eats quotes).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$petDir = Join-Path $env:APPDATA 'DS-WhaleSong-Pet'
New-Item -ItemType Directory -Force -Path $petDir | Out-Null

# Source must have a REAL alpha channel. Do not use assets/model/icon.png:
# it is 268x268 fully opaque (A=255 everywhere, dark RGB(33,33,33) corners),
# i.e. a picture WITH a dark square backdrop - using it produced a black square icon.
# desktop/icon-source.png (2048x2048, ARGB with transparent regions) is the right one.
$src = Join-Path $repo 'desktop\icon-source.png'
if (-not (Test-Path $src)) { throw "icon source not found: $src" }
$check = New-Object System.Drawing.Bitmap $src
$sawTransparent = $false
for ($y = 0; $y -lt $check.Height -and -not $sawTransparent; $y += 16) {
  for ($x = 0; $x -lt $check.Width; $x += 16) {
    if ($check.GetPixel($x, $y).A -lt 16) { $sawTransparent = $true; break }
  }
}
$check.Dispose()
if (-not $sawTransparent) {
  throw "icon source has no transparent pixels: $src  (it would render as a solid square)"
}
$icoPath = Join-Path $petDir 'pet.ico'

# Render the source into a square, centred, transparent-backed bitmap of the given size.
function Render-Square([System.Drawing.Image]$image, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $ratio = [Math]::Min($size / $image.Width, $size / $image.Height)
  $w = [int]($image.Width * $ratio)
  $h = [int]($image.Height * $ratio)
  $g.DrawImage($image, [int](($size - $w) / 2), [int](($size - $h) / 2), $w, $h)
  $g.Dispose()
  return $bmp
}

# Classic ICO entry: BITMAPINFOHEADER + bottom-up BGRA rows + AND mask.
function To-Dib([System.Drawing.Bitmap]$bmp) {
  $size = $bmp.Width
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  # BITMAPINFOHEADER: height is doubled (XOR image + AND mask).
  $bw.Write([UInt32]40)                 # biSize
  $bw.Write([Int32]$size)               # biWidth
  $bw.Write([Int32]($size * 2))         # biHeight
  $bw.Write([UInt16]1)                  # biPlanes
  $bw.Write([UInt16]32)                 # biBitCount
  $bw.Write([UInt32]0)                  # biCompression = BI_RGB
  $bw.Write([UInt32]($size * $size * 4))# biSizeImage
  $bw.Write([Int32]0); $bw.Write([Int32]0)   # resolution
  $bw.Write([UInt32]0); $bw.Write([UInt32]0) # palette
  # XOR image: BGRA, bottom-up.
  for ($y = $size - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $size; $x++) {
      $c = $bmp.GetPixel($x, $y)
      $bw.Write([Byte]$c.B); $bw.Write([Byte]$c.G); $bw.Write([Byte]$c.R); $bw.Write([Byte]$c.A)
    }
  }
  # AND mask: 1bpp, rows padded to 4 bytes, transparent pixels -> 1.
  # Built with plain integer arithmetic (no array indexing) on purpose: PowerShell kept
  # throwing IndexOutOfRange here - `New-Object byte[] $n` is parsed as a constructor
  # call, and a single-element byte array can be unwrapped to a scalar, which then
  # fails on `$row[$i] = ...`. Accumulating the byte value avoids both traps.
  for ($y = $size - 1; $y -ge 0; $y--) {
    $bytes = @()
    for ($b = 0; $b -lt [int]([Math]::Ceiling($size / 8.0)); $b++) {
      $v = 0
      for ($bit = 0; $bit -lt 8; $bit++) {
        $x = $b * 8 + $bit
        if ($x -lt $size -and $bmp.GetPixel($x, $y).A -lt 128) { $v = $v -bor (0x80 -shr $bit) }
      }
      $bytes += [byte]$v
    }
    foreach ($by in $bytes) { $bw.Write([byte]$by) }
  }
  $bw.Flush()
  $bytes = $ms.ToArray()
  $bw.Dispose(); $ms.Dispose()
  return ,$bytes
}

$image = [System.Drawing.Image]::FromFile($src)
$entries = @()
foreach ($size in @(16, 32, 48, 64)) {
  $bmp = Render-Square $image $size
  $entries += ,@{ Size = $size; Bytes = (To-Dib $bmp); IsPng = $false }
  $bmp.Dispose()
}
# 256 stays PNG: that is the one size Windows expects as PNG.
$big = Render-Square $image 256
$ms = New-Object System.IO.MemoryStream
$big.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$entries += ,@{ Size = 256; Bytes = $ms.ToArray(); IsPng = $true }
$ms.Dispose(); $big.Dispose()
$image.Dispose()

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type: 1 = icon
$bw.Write([UInt16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
  $dim = if ($e.Size -ge 256) { 0 } else { $e.Size }
  $bw.Write([Byte]$dim)
  $bw.Write([Byte]$dim)
  $bw.Write([Byte]0)                 # palette colours
  $bw.Write([Byte]0)                 # reserved
  $bw.Write([UInt16]1)               # colour planes
  $bw.Write([UInt16]32)              # bits per pixel
  $bw.Write([UInt32]$e.Bytes.Length)
  $bw.Write([UInt32]$offset)
  $offset += $e.Bytes.Length
}
foreach ($e in $entries) { $bw.Write($e.Bytes) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
$bw.Dispose(); $out.Dispose()

Write-Output ("built icon: " + $icoPath + "  (" + (Get-Item $icoPath).Length + " bytes)")
foreach ($e in $entries) {
  Write-Output ("  " + $e.Size + "x" + $e.Size + "  " + $e.Bytes.Length + " bytes  " + $(if ($e.IsPng) { 'PNG' } else { 'BMP/DIB' }))
}

# Point the desktop shortcut at the exe (which carries this icon embedded).
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Restart Desktop Pet.lnk'
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = (Join-Path $petDir 'RestartPet.exe')
$s.WorkingDirectory = $repo
$s.Description = 'Restart the DS Whale Song desktop pet'
$s.IconLocation = "$icoPath,0"
$s.Save()
Write-Output ("shortcut icon -> " + $s.IconLocation)
