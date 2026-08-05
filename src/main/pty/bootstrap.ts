import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Contenuto dello script di bootstrap eseguito in ogni riquadro.
 *
 * Gli argomenti NON vengono interpolati in questo file: arrivano via variabili
 * d'ambiente (CM_CWD, CM_EXE, CM_CMDLINE), il che elimina in blocco i bug di
 * quoting sui percorsi Windows con spazi, apici o backtick.
 *
 * Il processo viene avviato con .NET e non con `& $exe @args`, perché
 * PowerShell 5.1 costruisce male la riga di comando di un eseguibile nativo:
 * non protegge i doppi apici presenti nel valore, non raddoppia i backslash
 * finali, e decide se avvolgere l'argomento in base alla parità del numero di
 * apici incontrati. Un prompt come `crea il file "README.md"` arrivava
 * troncato e spezzato in due argomenti, senza alcun errore. Ora la riga di
 * comando la compone `winargs.ts` secondo le regole del runtime C, e qui viene
 * consegnata così com'è.
 *
 * Con `-NoExit`, all'uscita di Claude si resta nella shell nella stessa
 * cartella: si possono lanciare git/npm e rilanciare `claude` nello stesso
 * riquadro.
 */
const BOOTSTRAP_PS1 = `# ClaudeManager - script generato automaticamente, le modifiche vanno perse.
$ErrorActionPreference = 'Continue'

$cmCwd     = $env:CM_CWD
$cmExe     = $env:CM_EXE
$cmCmdLine = $env:CM_CMDLINE
$cmLabel   = $env:CM_LABEL

# Non lasciamo le variabili in giro nella shell interattiva né nei processi figli.
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
    Write-Host "  Client ssh non trovato." -ForegroundColor Red
    Write-Host "  Su Windows 10 e 11 si attiva da Impostazioni -> App -> Funzionalita' facoltative." -ForegroundColor DarkGray
  } else {
    Write-Host "  Claude Code non trovato ('$cmExe')." -ForegroundColor Red
    Write-Host "  Installalo oppure aggiungilo al PATH, poi digita 'claude' qui sotto." -ForegroundColor DarkGray
  }
  Write-Host ""
} else {
  if ($cmLabel) { Write-Host "  $cmLabel" -ForegroundColor DarkGray }

  # Riga di comando gia' composta secondo le regole del runtime C: si passa a
  # .NET intatta. Niente redirezione, cosi' il figlio eredita la console del
  # terminale e puo' disegnare la propria interfaccia.
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
    Write-Host "  Impossibile avviare '$cmExe': $($_.Exception.Message)" -ForegroundColor Red
    $codice = -1
  }
  $global:LASTEXITCODE = $codice

  # Con una connessione remota vale la pena dire perche' e' finita: senza
  # questo una caduta di rete lascerebbe solo un prompt locale inspiegabile.
  if ($cmExe -eq 'ssh') {
    Write-Host ""
    Write-Host "  Connessione chiusa (codice $codice). Sei tornato sulla shell locale." -ForegroundColor DarkGray
    Write-Host ""
  }
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
