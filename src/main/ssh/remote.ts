import { execFile } from 'node:child_process'
import type {
  RemoteDirListing,
  RemoteEntry,
  RemoteProbe,
  RemoteSession,
  SshTarget
} from '@shared/types'
import { buildSshQuery, shellQuote } from './command'
import { ptyEnv } from '../pty/env'

/**
 * Interrogazioni non interattive del server.
 *
 * Tutto passa per `ssh -T -o BatchMode=yes`: se le chiavi non bastano ssh
 * fallisce invece di fermarsi su un prompt di password che nessuno vedrebbe,
 * lasciando l'interfaccia appesa a tempo indeterminato.
 *
 * Gli script remoti sono POSIX puri, senza dipendere da python o jq: l'unica
 * cosa che si può dare per scontata su un server è una shell.
 */

const QUERY_TIMEOUT_MS = 20_000
/** Un elenco di cartelle sterminato non serve a nessuno e satura l'IPC. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export interface SshResult {
  ok: boolean
  stdout: string
  /** Messaggio già leggibile, pronto da mostrare. */
  error?: string
  /**
   * Codice di uscita dello script remoto. Serve a distinguere un fallimento di
   * connessione da un esito previsto: gli script usano codici propri (3, 4)
   * per dire "cartella assente" o "mai usata con Claude", che non sono errori.
   */
  code: number | null
}

/**
 * Traduce i fallimenti di ssh in qualcosa di azionabile.
 *
 * Il testo grezzo di ssh finisce comunque nei dettagli, ma da solo non aiuta:
 * "Permission denied (publickey)" non dice a chi lo legge che deve copiare la
 * propria chiave sul server.
 */
function describeFailure(code: number | null, stderr: string): string {
  const raw = stderr.trim()
  const lower = raw.toLowerCase()

  if (lower.includes('permission denied')) {
    return 'Autenticazione rifiutata. Serve una chiave gia’ autorizzata sul server (ssh-copy-id) oppure un agent con la chiave caricata: ClaudeManager non chiede password.'
  }
  if (lower.includes('host key verification failed') || lower.includes('remote host identification')) {
    return 'Chiave del server non riconosciuta. Apri una volta la connessione a mano con ssh per accettarla, poi riprova.'
  }
  if (lower.includes('could not resolve hostname')) {
    return 'Nome del server non risolto. Controlla l’indirizzo.'
  }
  if (lower.includes('connection refused')) {
    return 'Connessione rifiutata: nessun servizio ssh sulla porta indicata.'
  }
  if (
    lower.includes('connection timed out') ||
    lower.includes('operation timed out') ||
    lower.includes('etimedout')
  ) {
    return 'Il server non ha risposto entro il tempo previsto. Potrebbe essere spento, irraggiungibile dalla rete, o molto lento.'
  }
  if (lower.includes('enoent')) {
    return 'Client ssh non trovato su questo computer. Si attiva da Impostazioni → App → Funzionalita’ facoltative → Client OpenSSH.'
  }
  // Il primo rigo di stderr è quasi sempre quello utile; il resto è rumore.
  const first = raw.split('\n').find((l) => l.trim().length > 0)
  if (first) return first.trim()
  // Senza nessun indizio si dice almeno cosa provare: un codice numerico da
  // solo non suggerisce nessuna azione a chi legge.
  return `Il server non ha risposto in modo comprensibile (codice ${code ?? 'ignoto'}). Prova ad aprire la connessione a mano con ssh per vedere l’errore completo.`
}

/** Codici che gli script remoti usano per esiti previsti, non per errori. */
const EXIT_NO_DIR = 3
const EXIT_NEVER_USED = 4

/** Esegue uno script sul server e ne restituisce l'output. */
export function runRemote(
  target: SshTarget,
  script: string,
  timeoutMs = QUERY_TIMEOUT_MS
): Promise<SshResult> {
  const { file, args } = buildSshQuery(target, script)

  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: ptyEnv()
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout, code: 0 })

        const rawCode = (err as { code?: unknown }).code
        const code = typeof rawCode === 'number' ? rawCode : null

        // Quando l'eseguibile non esiste, stderr e' vuoto e il motivo sta in
        // `err.code` come stringa ('ENOENT'): cercandolo solo nello stderr il
        // messaggio utile — quello che spiega come attivare il client OpenSSH
        // — non compariva mai, proprio nel caso in cui serve. Stessa cosa per
        // il timeout, che arriva come `killed`.
        const indizio =
          typeof rawCode === 'string'
            ? rawCode
            : (err as { killed?: boolean }).killed
              ? 'ETIMEDOUT'
              : ''

        resolve({
          ok: false,
          stdout,
          code,
          error: describeFailure(code, stderr || indizio)
        })
      }
    )
  })
}

/**
 * Separatore fra le colonne dell'output remoto. Esplicito perché dentro le
 * virgolette di una shell `\t` resterebbe letterale: il carattere di
 * tabulazione va incorporato qui.
 */
const TAB = '\t'

/** Righe non vuote dell'output, già divise in colonne. */
function rows(stdout: string): string[][] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
}

// --- Ricognizione ------------------------------------------------------------

const PROBE_SCRIPT = [
  `printf '%s\\n' "HOME${TAB}$HOME"`,
  `printf '%s\\n' "OS${TAB}$(uname -sr 2>/dev/null)"`,
  'if command -v claude >/dev/null 2>&1; then',
  `  printf '%s\\n' "CLAUDE${TAB}$(command -v claude)"`,
  `  printf '%s\\n' "VERSION${TAB}$(claude --version 2>/dev/null | head -n 1)"`,
  'fi'
].join('\n')

/** Verifica raggiungibilità, home e presenza di Claude Code. */
export async function probe(target: SshTarget): Promise<RemoteProbe> {
  const res = await runRemote(target, PROBE_SCRIPT)
  if (!res.ok) return { ok: false, error: res.error, home: '', claudePath: '', claudeVersion: '', os: '' }

  const map = new Map(rows(res.stdout).map((cols) => [cols[0], cols[1] ?? '']))
  return {
    ok: true,
    home: map.get('HOME') ?? '',
    claudePath: map.get('CLAUDE') ?? '',
    claudeVersion: map.get('VERSION') ?? '',
    os: map.get('OS') ?? ''
  }
}

// --- Esplorazione delle cartelle remote --------------------------------------

/**
 * Elenca le sottocartelle, segnalando quali sono repository git e quali hanno
 * istruzioni per Claude. Sono gli stessi due indizi che il selettore mostra in
 * locale, e servono a riconoscere un progetto senza entrarci.
 */
function listScript(path: string): string {
  const target =
    path === '~'
      ? 'cd ~'
      : path.startsWith('~/')
        ? `cd ~/${shellQuote(path.slice(2))}`
        : `cd ${shellQuote(path)}`

  // Le righe sono unite da a capo: un for..do incollato al comando precedente
  // da un semplice spazio è un errore di sintassi per la shell.
  return [
    `${target} 2>/dev/null || exit 3`,
    `printf '%s\\n' "PWD${TAB}$(pwd)"`,
    'for e in * .*; do',
    '  [ "$e" = "." ] && continue',
    '  [ "$e" = ".." ] && continue',
    '  [ -d "$e" ] || continue',
    '  g=0; [ -d "$e/.git" ] && g=1',
    '  m=0; { [ -f "$e/CLAUDE.md" ] || [ -f "$e/AGENTS.md" ]; } && m=1',
    `  printf '%s\\n' "D${TAB}$g${TAB}$m${TAB}$e"`,
    'done'
  ].join('\n')
}

export async function listDir(target: SshTarget, path: string): Promise<RemoteDirListing> {
  const res = await runRemote(target, listScript(path))
  if (!res.ok) {
    const error =
      res.code === EXIT_NO_DIR
        ? 'Cartella inesistente o non accessibile sul server.'
        : (res.error ?? 'Errore sconosciuto')
    return { ok: false, error, path, parent: null, entries: [] }
  }

  let resolved = path
  const entries: RemoteEntry[] = []

  for (const cols of rows(res.stdout)) {
    if (cols[0] === 'PWD') {
      resolved = cols[1] ?? path
    } else if (cols[0] === 'D' && cols[3]) {
      entries.push({
        name: cols[3],
        // pwd non ha lo slash finale salvo che per la radice.
        path: resolved === '/' ? `/${cols[3]}` : `${resolved}/${cols[3]}`,
        isGit: cols[1] === '1',
        hasInstructions: cols[2] === '1'
      })
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  const cut = resolved.lastIndexOf('/')
  const parent = resolved === '/' ? null : cut <= 0 ? '/' : resolved.slice(0, cut)

  return { ok: true, path: resolved, parent, entries }
}

// --- Sessioni remote riprendibili --------------------------------------------

/**
 * Su Linux la codifica cartella -> directory progetto è la stessa di Windows:
 * ogni carattere non alfanumerico diventa '-'. È duplicata qui invece di
 * riusare `encodeProjectDir` perché quella normalizza prima i separatori di
 * Windows, cosa che su un percorso POSIX non va fatta.
 */
function encodeRemoteProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Le etichette si ricavano con grep invece che con un parser JSON: sul server
 * non si può contare su python o jq. `ai-title` e `last-prompt` vengono
 * riemessi più volte nel transcript, quindi vale l'ultima occorrenza.
 */
function sessionsScript(remotePath: string): string {
  // $HOME non va quotato insieme al resto, altrimenti non viene espanso.
  const encoded = shellQuote(encodeRemoteProjectDir(remotePath))
  return [
    `d="$HOME/.claude/projects/"${encoded}`,
    '[ -d "$d" ] || exit 4',
    'for f in "$d"/*.jsonl; do',
    '  [ -f "$f" ] || continue',
    '  id=$(basename "$f" .jsonl)',
    '  mt=$(stat -c %Y "$f" 2>/dev/null || echo 0)',
    '  sz=$(stat -c %s "$f" 2>/dev/null || echo 0)',
    '  tl=$(tail -c 200000 "$f")',
    '  t=$(printf %s "$tl" | grep -o \'"aiTitle":"[^"]*"\' | tail -n 1 | cut -d: -f2-)',
    '  p=$(printf %s "$tl" | grep -o \'"lastPrompt":"[^"]*"\' | tail -n 1 | cut -d: -f2-)',
    `  printf '%s\\n' "S${TAB}$id${TAB}$mt${TAB}$sz${TAB}$t${TAB}$p"`,
    'done'
  ].join('\n')
}

/** Toglie gli apici e le sequenze di escape lasciate dal grep sul JSON. */
function unquote(raw: string | undefined): string | null {
  if (!raw) return null
  const inner = raw.replace(/^"/, '').replace(/"$/, '')
  if (!inner) return null
  const text = inner
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim()
  // Stesso taglio delle etichette locali: un prompt intero come titolo
  // sfonderebbe la riga.
  return text ? text.slice(0, 160) : null
}

/** Conversazioni già presenti sul server per una cartella remota. */
export async function listSessions(
  target: SshTarget,
  remotePath: string
): Promise<{ ok: boolean; error?: string; sessions: RemoteSession[] }> {
  const res = await runRemote(target, sessionsScript(remotePath))

  // Nessuna cartella progetto: non è un errore, è una cartella mai aperta con
  // Claude Code. L'elenco vuoto è la risposta corretta.
  if (res.code === EXIT_NEVER_USED) return { ok: true, sessions: [] }
  if (!res.ok) return { ok: false, error: res.error, sessions: [] }

  const sessions: RemoteSession[] = []
  for (const cols of rows(res.stdout)) {
    if (cols[0] !== 'S' || !cols[1]) continue
    const aiTitle = unquote(cols[4])
    const lastPrompt = unquote(cols[5])
    sessions.push({
      sessionId: cols[1],
      // stat -c %Y ritorna secondi, il resto dell'app ragiona in millisecondi.
      modifiedAt: Number(cols[2] ?? 0) * 1000,
      sizeBytes: Number(cols[3] ?? 0),
      aiTitle,
      lastPrompt,
      label: aiTitle ?? lastPrompt ?? cols[1].slice(0, 8)
    })
  }

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return { ok: true, sessions }
}

/** Tempo massimo concesso alla verifica fatta all'avvio dell'app. */
const RESTORE_TIMEOUT_MS = 6000

/**
 * Dice se una conversazione remota esiste ancora, per il ripristino del layout.
 *
 * Serve una domanda a parte invece di riusare `listSessions`: quella legge la
 * coda di ogni transcript per ricavarne l'etichetta, che all'avvio non serve e
 * su cartelle con decine di sessioni costa secondi. Qui basta l'esistenza di
 * un file.
 *
 * Il tempo è limitato e un fallimento vale "no": con il server spento l'app
 * deve aprirsi lo stesso, e un riquadro remoto senza ripresa è meglio di un
 * avvio che si blocca.
 */
export async function isRemoteResumable(
  target: SshTarget,
  remotePath: string,
  sessionId: string
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false

  const file = `$HOME/.claude/projects/${encodeRemoteProjectDir(remotePath)}/${sessionId}.jsonl`
  const res = await runRemote(
    target,
    `[ -s "${file}" ] && echo SI`,
    RESTORE_TIMEOUT_MS
  )
  return res.ok && res.stdout.includes('SI')
}
