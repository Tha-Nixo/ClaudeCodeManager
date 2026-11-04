import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Bootstrap script executed in each terminal pane.
 *
 * Parameters arrive via environment variables (CM_CWD, CM_EXE, CM_CMDLINE),
 * avoiding PowerShell quote-escaping bugs.
 */
const BOOTSTRAP_PS1 = `# ClaudeManager - automatically generated script; manual changes will be lost.
$ErrorActionPreference = 'Continue'

$cmCwd     = $env:CM_CWD
$cmExe     = $env:CM_EXE
$cmCmdLine = $env:CM_CMDLINE
$cmLabel   = $env:CM_LABEL

Remove-Item Env:CM_CWD     -ErrorAction SilentlyContinue
Remove-Item Env:CM_EXE     -ErrorAction SilentlyContinue
Remove-Item Env:CM_CMDLINE -ErrorAction SilentlyContinue
Remove-Item Env:CM_LABEL   -ErrorAction SilentlyContinue

if ($cmCwd -and (Test-Path -LiteralPath $cmCwd)) {
  Set-Location -LiteralPath $cmCwd
}

if (-not $cmExe) { $cmExe = 'claude' }

$resolved = Get-Command $cmExe -ErrorAction SilentlyContinue
if (-not $resolved) {
  Write-Host ""
  if ($cmExe -eq 'ssh') {
    Write-Host "  SSH client not found." -ForegroundColor Red
    Write-Host "  On Windows 10 and 11, enable it in Settings -> Apps -> Optional features." -ForegroundColor DarkGray
  } else {
    Write-Host "  Claude Code not found ('$cmExe')." -ForegroundColor Red
    Write-Host "  Install it or add it to PATH, then run 'claude' below." -ForegroundColor DarkGray
  }
  Write-Host ""
} else {
  if ($cmLabel) { Write-Host "  $cmLabel" -ForegroundColor DarkGray }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $resolved.Source
  $psi.Arguments = $cmCmdLine
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = (Get-Location).Path

  $codice = 0
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    $codice = $proc.ExitCode
  } catch {
    Write-Host "  Failed to launch '$cmExe': $($_.Exception.Message)" -ForegroundColor Red
    $codice = -1
  }
  $global:LASTEXITCODE = $codice

  if ($cmExe -eq 'ssh') {
    Write-Host ""
    Write-Host "  Connection closed (code $codice). Returned to local shell." -ForegroundColor DarkGray
    Write-Host ""
  }
}
`

let bootstrapPath: string | null = null

export function ensureBootstrapScript(): string {
  if (bootstrapPath) return bootstrapPath

  const dir = join(app.getPath('userData'), 'run')
  mkdirSync(dir, { recursive: true })

  const target = join(dir, 'bootstrap.ps1')
  writeFileSync(target, BOOTSTRAP_PS1, 'utf8')
  bootstrapPath = target
  return target
}

export function powershellArgs(scriptPath: string): string[] {
  return [
    '-NoLogo',
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath
  ]
}
