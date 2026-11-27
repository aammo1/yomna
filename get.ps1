# Yomna one-line installer for Windows 10 and 11 (stock Windows PowerShell 5.1 and the built-in curl.exe).
#
#   curl.exe -fsSL https://raw.githubusercontent.com/aammo1/yomna/main/get.ps1 | powershell -NoProfile -ExecutionPolicy Bypass -Command -
#
# Downloads the latest release's installer, runs it silently (per user, no admin prompt) and opens Yomna.
# Use curl.exe, not curl: in Windows PowerShell 5.1, curl is an alias for Invoke-WebRequest.
#
# Environment:
#   YOMNA_VERSION    install that release (for example v0.2.0) instead of the latest
#   YOMNA_REPO       GitHub owner/repo to download from (default aammo1/yomna)
#   YOMNA_URL        exact installer URL to use instead
#   YOMNA_NO_OPEN    set to 1 to install without starting Yomna
#
# Read from stdin, PowerShell runs each complete statement as soon as it has it, so everything sits in one
# script block that closes on the last line: a download cut off halfway through runs nothing. Keep this file
# ASCII; Windows PowerShell reads piped text in the console code page.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  # Keep in step with the "Attach to a draft release" step in .github/workflows/release.yml.
  $name = 'Yomna-windows-x64-setup.exe'
  $repo = if ($env:YOMNA_REPO) { $env:YOMNA_REPO } else { 'aammo1/yomna' }
  $url = $env:YOMNA_URL
  if (-not $url) {
    if ($env:YOMNA_VERSION) { $url = "https://github.com/$repo/releases/download/$($env:YOMNA_VERSION)/$name" }
    else { $url = "https://github.com/$repo/releases/latest/download/$name" }
  }

  if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Host 'error: Yomna needs 64-bit Windows.' -ForegroundColor Red
    exit 1
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('yomna-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $setup = Join-Path $tmp $name
  $sums = Join-Path $tmp 'SHA256SUMS'

  try {
    Write-Host 'Yomna installer'
    Write-Host "-> downloading $url"
    $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($curl) {
      & $curl.Source -fsSL $url -o $setup
      if ($LASTEXITCODE -ne 0) { throw "download failed: $url (curl exit code $LASTEXITCODE)" }
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $url -OutFile $setup -UseBasicParsing
    }
    if (-not (Test-Path $setup) -or (Get-Item $setup).Length -lt 1MB) { throw "download failed: $url" }

    if ($url -notlike 'file://*') {
      $sumsUrl = $url.Substring(0, $url.LastIndexOf('/')) + '/SHA256SUMS'
      if ($curl) {
        & $curl.Source -fsSL $sumsUrl -o $sums
        if ($LASTEXITCODE -ne 0) { throw "couldn't download SHA256SUMS for verification ($sumsUrl)" }
      } else {
        Invoke-WebRequest -Uri $sumsUrl -OutFile $sums -UseBasicParsing
      }
      $expected = $null
      foreach ($line in (Get-Content $sums)) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
          if ($matches[2] -eq $name) {
            $expected = $matches[1].ToLower()
            break
          }
        }
      }
      if (-not $expected) { throw "no checksum entry for $name in SHA256SUMS" }
      $actual = (Get-FileHash -Path $setup -Algorithm SHA256).Hash.ToLower()
      if ($actual -ne $expected) { throw "checksum mismatch for $name (expected $expected, got $actual)" }
    }

    # Close a running copy so the installer can replace it.
    $dirs = @((Join-Path $env:LOCALAPPDATA 'Yomna'), (Join-Path $env:ProgramFiles 'Yomna'))
    Get-Process -Name yomna -ErrorAction SilentlyContinue | Where-Object {
      $p = $_.Path; $p -and ($dirs | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })
    } | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host '-> installing'
    $proc = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "the installer failed (exit code $($proc.ExitCode))" }

    $app = $dirs | ForEach-Object { Join-Path $_ 'yomna.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $app) { throw 'the installer finished, but Yomna is not where it should be' }

    if ($env:YOMNA_NO_OPEN -ne '1') { Start-Process -FilePath $app }
    Write-Host "Yomna is installed in $(Split-Path $app)" -ForegroundColor Green
  } catch {
    Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
