import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Contenuto dello script di bootstrap eseguito in ogni riquadro.
 *
 * Gli argomenti NON vengono interpolati nella command line né in questo file:
 * arrivano via variabili d'ambiente (CM_CWD, CM_CLAUDE, CM_ARGS_JSON). Questo
 * elimina in blocco i bug di quoting su path con spazi, apici o backtick, che
 * su Windows sono la norma (`C:\Users\...\Saved Games\...`).
 *
 * Con `-NoExit`, all'uscita di Claude si resta nella shell nella stessa
 * cartella: si possono lanciare git/npm e rilanciare `claude` nello stesso
 * riquadro.
 */
const BOOTSTRAP_PS1 = `# ClaudeManager - script generato automaticamente, le modifiche vanno perse.
$ErrorActionPreference = 'Continue'

$cmCwd    = $env:CM_CWD
$cmClaude = $env:CM_CLAUDE
$cmArgs   = $env:CM_ARGS_JSON

# Non lasciamo le variabili in giro nella shell interattiva né nei processi figli.
Remove-Item Env:CM_CWD       -ErrorAction SilentlyContinue
Remove-Item Env:CM_CLAUDE    -ErrorAction SilentlyContinue
Remove-Item Env:CM_ARGS_JSON -ErrorAction SilentlyContinue

if ($cmCwd -and (Test-Path -LiteralPath $cmCwd)) {
  Set-Location -LiteralPath $cmCwd
}

if (-not $cmClaude) { $cmClaude = 'claude' }

$claudeArgs = @()
if ($cmArgs) {
  try {
    $parsed = ConvertFrom-Json $cmArgs
    if ($null -ne $parsed) { $claudeArgs = @($parsed) }
  } catch {
    Write-Host "ClaudeManager: argomenti non validi, avvio claude senza flag." -ForegroundColor DarkYellow
  }
}

$resolved = Get-Command $cmClaude -ErrorAction SilentlyContinue
if (-not $resolved) {
  Write-Host ""
  Write-Host "  Claude Code non trovato ('$cmClaude')." -ForegroundColor Red
  Write-Host "  Installalo oppure aggiungilo al PATH, poi digita 'claude' qui sotto." -ForegroundColor DarkGray
  Write-Host ""
} else {
  & $cmClaude @claudeArgs
}
`

let bootstrapPath: string | null = null

/** Scrive (una sola volta per avvio) lo script di bootstrap e ne ritorna il path. */
export function ensureBootstrapScript(): string {
  if (bootstrapPath) return bootstrapPath

  const dir = join(app.getPath('userData'), 'run')
  mkdirSync(dir, { recursive: true })

  const target = join(dir, 'bootstrap.ps1')
  // Riscritto ad ogni avvio: se l'app si aggiorna, lo script segue.
  writeFileSync(target, BOOTSTRAP_PS1, 'utf8')

  bootstrapPath = target
  return target
}

/** Argomenti di powershell.exe per eseguire il bootstrap e restare interattivi. */
export function powershellArgs(scriptPath: string): string[] {
  return ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
}
