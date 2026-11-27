import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Contents of the bootstrap script run in every pane.
 *
 * Arguments are NOT interpolated into this file: they arrive through
 * environment variables (CM_CWD, CM_EXE, CM_CMDLINE), which rules out, in one
 * go, every quoting bug with Windows paths containing spaces, quotes or
 * backticks.
 *
 * The process is started through .NET and not with `& $exe @args`, because
 * PowerShell 5.1 builds a native executable's command line badly: it does not
 * protect double quotes inside the value, does not double trailing
 * backslashes, and decides whether to wrap an argument by the parity of the
 * quotes it met. A prompt such as `create the file "README.md"` arrived cut
 * short and split in two arguments, with no error at all. The command line is
 * now composed by `winargs.ts` following the C runtime rules, and handed over
 * here as is.
 *
 * With `-NoExit`, when Claude exits you stay in the shell in the same folder:
 * you can run git or npm and start `claude` again in the same pane.
 */
const BOOTSTRAP_PS1 = `# ClaudeManager - automatically generated script; manual changes will be lost.
$ErrorActionPreference = 'Continue'

$cmCwd     = $env:CM_CWD
$cmExe     = $env:CM_EXE
$cmCmdLine = $env:CM_CMDLINE
$cmLabel   = $env:CM_LABEL

# The variables must not linger in the interactive shell or in child processes.
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

  # The command line is already composed following the C runtime rules: it is
  # handed to .NET intact. No redirection, so the child inherits the terminal's
  # console and can draw its own interface.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $resolved.Source
  $psi.Arguments = $cmCmdLine
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = (Get-Location).Path

  $exitCode = 0
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
  } catch {
    Write-Host "  Failed to launch '$cmExe': $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = -1
  }
  $global:LASTEXITCODE = $exitCode

  # For a remote connection it is worth saying why it ended: without this, a
  # network drop would leave only an unexplained local prompt.
  if ($cmExe -eq 'ssh') {
    Write-Host ""
    Write-Host "  Connection closed (code $exitCode). Returned to local shell." -ForegroundColor DarkGray
    Write-Host ""
  }
}
`

let bootstrapPath: string | null = null

/** Writes the bootstrap script (once per launch) and returns its path. */
export function ensureBootstrapScript(): string {
  if (bootstrapPath) return bootstrapPath

  const dir = join(app.getPath('userData'), 'run')
  mkdirSync(dir, { recursive: true })

  const target = join(dir, 'bootstrap.ps1')
  // Written again on every launch: when the app updates, the script follows.
  writeFileSync(target, BOOTSTRAP_PS1, 'utf8')
  bootstrapPath = target
  return target
}

/** powershell.exe arguments to run the bootstrap and stay interactive. */
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
