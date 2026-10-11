# smtc-helper.ps1 -- one-shot Windows SMTC (media session) bridge for the whale-song pet
# host (lib/index.js). Originally written for the NetEase-only backend of
# dsh-whale-widget; now the host-side "unified layer": ANY player that publishes a media
# session (NetEase / QQ Music / Kugou / Spotify / foobar2000 / PotPlayer / VLC / browsers)
# can be read and controlled through the same contract.
#
# Contract with the host (lib/index.js):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File smtc-helper.ps1 `
#     -Cmd <get|play|pause|next|prev> [-App '<regex>'] [-List]
#     stdout : EXACTLY one line of UTF-8 JSON -- nothing else, ever
#     stderr : diagnostics only (the host forwards them to its console on failure)
#     exit   : always 0; success/failure travels inside the JSON, so a non-zero exit from
#              PowerShell itself (unhandled error, parse error) is the only "no JSON" case
#              and the host already turns that into a readable message.
#
# Output shapes (the host parses stdout as JSON, so these keys are a contract):
#   get                -> {"ok":true,"nowPlaying":{"title":"","artist":"","status":"Playing","appId":"cloudmusic.exe"}}
#   get, no session    -> {"ok":true,"nowPlaying":null}
#   -List              -> {"ok":true,"sessions":[{"appId":"","title":"","artist":"","status":""}]}
#   play/pause/next/prev -> {"ok":true,"did":"pause","appId":"cloudmusic.exe"}
#   any failure        -> {"ok":false,"error":"no-session" | "smtc-unavailable" | "control-failed"}
#
# Which session is "the" session:
#   default (no -App)  -> the NetEase Cloud Music session only. The media session list is
#                         shared machine-wide (browsers, other players, DSH itself can all
#                         publish sessions), so a filter is the whole safety boundary of this
#                         helper: without one we would be pausing whatever the user happens to
#                         be watching in Chrome. The default therefore never widens by itself.
#   -App '<regex>'     -> first session whose AppId matches the regex, case-insensitive.
#                         '-App ".*"' = "whatever session exists" (used by the unified layer
#                         once the user has picked a player).
#   -List              -> enumerate every session; no filter, no control, read-only.
#
# Why ASCII-only: Windows PowerShell 5.1 decodes .ps1 files as ANSI unless they carry a
# UTF-8 BOM, so a non-ASCII byte here would be mangled on a non-UTF8 system codepage.
# Every string a user actually reads is produced host-side (lib/index.js).
#
# Why Windows PowerShell 5.1 and not pwsh 7: the WinRT projection used below is built on
# System.Runtime.WindowsRuntime, a .NET Framework assembly that pwsh 7 cannot load.
# The host defaults to %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('get', 'play', 'pause', 'next', 'prev')]
  [string]$Cmd,

  # Session filter (regex, case-insensitive). Empty = keep the original NetEase-only default
  # so existing callers cannot accidentally widen their reach.
  [string]$App = '',

  # Enumerate all media sessions (read-only; takes priority over -Cmd).
  [switch]$List
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# stdout: one JSON line, written as raw UTF-8 bytes.
# Redirected stdout uses the OEM code page by default (e.g. GBK on zh-CN), so a Chinese
# song title written through [Console]::Out would reach the host as GBK bytes and be
# decoded as UTF-8 => mojibake. Writing the encoded bytes ourselves sidesteps the code
# page entirely. Diagnostics go to stderr so stdout stays a single parseable line.
# ---------------------------------------------------------------------------
function Write-JsonLine([string]$Json) {
  $text = $Json + "`n"
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $out = [System.Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
  } catch {
    try { [Console]::Out.Write($text) } catch { }
  }
}
function Write-Result($Result) {
  $json = $null
  try { $json = $Result | ConvertTo-Json -Compress -Depth 4 } catch { }
  if ([string]::IsNullOrEmpty($json)) { $json = '{"ok":false,"error":"smtc-unavailable"}' }
  Write-JsonLine $json
}
function Write-Failure([string]$Reason) {
  Write-Result @{ ok = $false; error = $Reason }
}
function Write-Diag([string]$Message) {
  try { [Console]::Error.WriteLine('[smtc] ' + $Message) } catch { }
}

# The AppId is the only handle we have on a session, and reading it must never throw
# (a session can disappear between GetSessions() and the property read).
function Get-SessionAppId($Session) {
  try { return [string]$Session.SourceAppUserModelId } catch { return '' }
}

# First session whose AppId matches $Pattern. An empty pattern keeps the historical
# NetEase-only behaviour. Over-long patterns are treated as "matches nothing" instead of
# being handed to .NET's regex engine, where a pathological expression could hang us.
function Select-Session($Manager, [string]$Pattern) {
  $effective = $Pattern
  if ([string]::IsNullOrEmpty($effective)) { $effective = '(?i)cloudmusic|netease' }
  if ($effective.Length -gt 128) {
    Write-Diag 'app filter too long (>128), ignoring'
    return $null
  }
  $sessions = @()
  try { $sessions = $Manager.GetSessions() } catch { $sessions = @() }
  foreach ($candidate in $sessions) {
    $candidateId = Get-SessionAppId $candidate
    if ([string]::IsNullOrEmpty($candidateId)) { continue }
    try {
      if ($candidateId -match $effective) { return $candidate }
    } catch {
      Write-Diag ('bad app filter, treating as no match: ' + $_.Exception.Message)
      return $null
    }
  }
  return $null
}

# Read title/artist/status for one session. Shared by `get` and `-List` so both report the
# same field set.
function Read-SessionInfo($Session) {
  $title = ''
  $artist = ''
  try {
    $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    $props = Await-Operation ($Session.TryGetMediaPropertiesAsync()) $propsType
    $title = [string]$props.Title
    $artist = [string]$props.Artist
  } catch {
    Write-Diag ('media properties unavailable: ' + $_.Exception.Message)
  }
  $status = ''
  try { $status = [string]$Session.GetPlaybackInfo().PlaybackStatus } catch { $status = '' }
  return @{
    appId  = (Get-SessionAppId $Session)
    title  = $title
    artist = $artist
    status = $status
  }
}

# ---------------------------------------------------------------------------
# The classic WinRT "await" shim: WinRT async operations are IAsyncOperation<T>, which
# PowerShell cannot await directly. System.WindowsRuntimeSystemExtensions.AsTask<T> turns
# one into a .NET Task<T>; the generic method has to be picked by reflection because the
# T of the method is only known from the operation we were handed.
# ---------------------------------------------------------------------------
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  if ($null -eq $asTaskGeneric) {
    Write-Diag 'AsTask<IAsyncOperation<T>> not found in System.Runtime.WindowsRuntime'
    Write-Failure 'smtc-unavailable'
    exit 0
  }
} catch {
  Write-Diag ('WinRT bootstrap failed: ' + $_.Exception.Message)
  Write-Failure 'smtc-unavailable'
  exit 0
}

function Await-Operation($Operation, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($Operation))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

try {
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await-Operation ($managerType::RequestAsync()) $managerType

  # --- read-only enumeration: every session on this machine ------------------
  if ($List) {
    $all = @()
    try { $all = $manager.GetSessions() } catch { $all = @() }
    $rows = @()
    foreach ($one in $all) {
      try { $rows += Read-SessionInfo $one } catch {
        Write-Diag ('skipping session: ' + $_.Exception.Message)
      }
    }
    Write-Result @{ ok = $true; sessions = $rows }
    exit 0
  }

  $session = Select-Session $manager $App

  if ($Cmd -eq 'get') {
    if ($null -eq $session) {
      # No matching session == "nothing is playing as far as we are concerned". This is not
      # an error: the host turns it into nowPlaying:null and the frontend shows "not running".
      Write-Result @{ ok = $true; nowPlaying = $null }
      exit 0
    }
    Write-Result @{ ok = $true; nowPlaying = (Read-SessionInfo $session) }
    exit 0
  }

  if ($null -eq $session) {
    Write-Failure 'no-session'
    exit 0
  }

  # TryPlayAsync/TryPauseAsync/TrySkipNextAsync/TrySkipPreviousAsync all return
  # IAsyncOperation<bool>; false means "the client refused" (e.g. nothing queued for next).
  switch ($Cmd) {
    'play' { $operation = $session.TryPlayAsync() }
    'pause' { $operation = $session.TryPauseAsync() }
    'next' { $operation = $session.TrySkipNextAsync() }
    'prev' { $operation = $session.TrySkipPreviousAsync() }
    default { $operation = $null }
  }
  if ($null -eq $operation) {
    Write-Failure 'smtc-unavailable'
    exit 0
  }
  $done = Await-Operation $operation ([bool])
  if ($done -eq $true) {
    # Report which session actually took the command: with -App ".*" the caller cannot know
    # otherwise, and the client uses this to highlight the player that is really in effect.
    Write-Result @{ ok = $true; did = $Cmd; appId = (Get-SessionAppId $session) }
  } else {
    Write-Failure 'control-failed'
  }
  exit 0
} catch {
  # Never leak a full .NET exception (stack traces, HRESULTs, localised framework text) into
  # stdout: the host maps these short tokens to Chinese sentences for the user.
  Write-Diag ('command failed: ' + $Cmd + ' -- ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)
  Write-Failure 'smtc-unavailable'
  exit 0
}
