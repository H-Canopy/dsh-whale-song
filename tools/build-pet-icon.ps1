# Build a .ico for the desktop pet shortcut, and point the shortcut at it.
#
# Why hand-rolled: this machine has no ImageMagick, and Windows shortcuts cannot use a
# .png directly as IconLocation (that is why the shortcut showed the generic document
# icon). An ICO container may embed PNG blobs for each size (Vista+), which is the
# simplest lossless route here.
#
# ASCII only (PS 5.1 misreads BOM-less UTF-8 Chinese and eats quotes).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$petDir = Join-Path $env:APPDATA 'DS-WhaleSong-Pet'
New-Item -ItemType Directory -Force -Path $petDir | Out-Null

$src = Join-Path $repo 'assets\model\icon.png'
if (-not (Test-Path $src)) { throw "icon source not found: $src" }
$icoPath = Join-Path $petDir 'pet.ico'

# Render the source into the sizes an ICO normally carries.
$sizes = @(256, 64, 48, 32, 16)
$image = [System.Drawing.Image]::FromFile($src)
$blobs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  # Fit inside the square, preserving aspect ratio, centred.
  $ratio = [Math]::Min($s / $image.Width, $s / $image.Height)
  $w = [int]($image.Width * $ratio)
  $h = [int]($image.Height * $ratio)
  $g.DrawImage($image, [int](($s - $w) / 2), [int](($s - $h) / 2), $w, $h)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $blobs += ,@{ Size = $s; Bytes = $ms.ToArray() }
  $ms.Dispose(); $bmp.Dispose()
}
$image.Dispose()

# Pack the ICO: 6-byte header, 16-byte directory entry per image, then the PNG payloads.
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type: 1 = icon
$bw.Write([UInt16]$blobs.Count)
$offset = 6 + 16 * $blobs.Count
foreach ($b in $blobs) {
  $dim = if ($b.Size -ge 256) { 0 } else { $b.Size }   # 0 means 256 in the ICO header
  $bw.Write([Byte]$dim)              # width
  $bw.Write([Byte]$dim)              # height
  $bw.Write([Byte]0)                 # palette colours
  $bw.Write([Byte]0)                 # reserved
  $bw.Write([UInt16]1)               # colour planes
  $bw.Write([UInt16]32)              # bits per pixel
  $bw.Write([UInt32]$b.Bytes.Length) # payload size
  $bw.Write([UInt32]$offset)         # payload offset
  $offset += $b.Bytes.Length
}
foreach ($b in $blobs) { $bw.Write($b.Bytes) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
$bw.Dispose(); $out.Dispose()
Write-Output ("built icon: " + $icoPath + "  (" + (Get-Item $icoPath).Length + " bytes, " + $blobs.Count + " sizes)")

# Point the desktop shortcut (and the exe's own icon) at it.
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
