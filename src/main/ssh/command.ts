import type { LaunchOptions, SshTarget } from '@shared/types'
import { buildClaudeArgs } from '../claude/cli'

/**
 * Costruzione del comando ssh.
 *
 * Qui si attraversano DUE livelli di quoting: PowerShell, che avvia ssh, e la
 * shell remota, che riceve il comando come stringa unica. Sbagliarne uno
 * rompe ogni percorso con uno spazio, e non se ne accorge nessuno finché non
 * si apre una cartella che ne contiene uno.
 *
 * La regola che tiene insieme tutto: il comando remoto usa SOLO apici
 * singoli. PowerShell avvolge fra doppi apici gli argomenti con spazi, e un
 * argomento che non contiene doppi apici attraversa quel livello intatto.
 */

/**
 * Rende una stringa un letterale sicuro per una shell POSIX.
 *
 * L'apice singolo non si può proteggere dentro apici singoli: si chiude la
 * stringa, si aggiunge un apice protetto, e si riapre. È il modo standard,
 * ed è il motivo per cui il risultato è pieno di `'\''`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Argomenti di ssh, esclusa la destinazione e il comando remoto. */
function connectionArgs(target: SshTarget): string[] {
  const args: string[] = [
    // Senza -t ssh non alloca un terminale, e Claude Code non può disegnare
    // la propria interfaccia: si vedrebbe solo output grezzo senza prompt.
    '-t',
    // Un terminale che si pianta a metà sessione resterebbe appeso per sempre
    // senza che nulla lo segnali.
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=4'
  ]
  if (target.port && target.port !== 22) args.push('-p', String(target.port))
  if (target.identityFile) {
    args.push('-i', target.identityFile)
    // Con una chiave indicata esplicitamente si evita che ssh provi prima
    // tutte le altre e sbatta contro il limite di tentativi del server.
    args.push('-o', 'IdentitiesOnly=yes')
  }
  return args
}

/** Destinazione nella forma utente@host. */
export function sshDestination(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host
}

/**
 * Verifica che un comando remoto sia attraversabile da PowerShell.
 *
 * PowerShell 5.1 non sa passare un doppio apice a un eseguibile nativo: lo
 * consegna senza protezione e la riga di comando si spezza nel punto
 * sbagliato. Finché il comando remoto usa solo apici singoli il problema non
 * esiste, ma è un invariante che una modifica distratta romperebbe in
 * silenzio — e il sintomo sarebbe un errore della shell remota, lontano dalla
 * causa. Meglio fermarsi qui.
 */
function assertNoDoubleQuotes(command: string): string {
  if (command.includes('"')) {
    throw new Error(
      'Comando remoto con doppi apici: PowerShell non li trasmette correttamente. Usa apici singoli.'
    )
  }
  return command
}

/**
 * Entra nella cartella remota e avvia claude.
 *
 * `exec` sostituisce la shell con claude invece di lasciarne una in mezzo:
 * chiudendo claude la connessione cade subito, senza uno strato inerte che
 * tiene aperto il terminale. Se la cartella non esiste il comando dice quale,
 * invece di ripiegare sulla home e far credere che sia andato tutto bene.
 */
export function remoteCommand(opts: LaunchOptions, sessionId: string): string {
  const path = opts.remote?.path?.trim() || '~'
  const args = buildClaudeArgs(opts, sessionId)

  // '~' fra apici non viene espanso dalla shell: resterebbe un nome di
  // cartella letterale. Per i percorsi che iniziano con ~ si quota solo la
  // parte restante.
  const cd =
    path === '~'
      ? 'cd ~'
      : path.startsWith('~/')
        ? `cd ~/${shellQuote(path.slice(2))}`
        : `cd ${shellQuote(path)}`

  const claude = ['claude', ...args].map(shellQuote).join(' ')

  return assertNoDoubleQuotes(
    [
      // L'errore di cd viene zittito: la shell ne stampa uno proprio, e due
      // messaggi per lo stesso problema confondono invece di aiutare.
      `${cd} 2>/dev/null || { echo ${shellQuote(`ClaudeManager: cartella remota non raggiungibile: ${path}`)} >&2; exit 1; }`,
      // Senza claude sul server la connessione cadrebbe subito, lasciando solo
      // un errore lampeggiante. Meglio restare sulla shell remota: da lì lo si
      // può installare senza riaprire un altro terminale.
      `command -v claude >/dev/null 2>&1 || { echo ${shellQuote('ClaudeManager: Claude Code non risulta installato su questo server.')} >&2; exec ${'${SHELL:-sh}'} -l; }`,
      `exec ${claude}`
    ].join('; ')
  )
}

export interface SshInvocation {
  /** Eseguibile: sempre ssh, risolto dal PATH. */
  file: string
  args: string[]
}

/** Comando completo per aprire una sessione Claude remota. */
export function buildSshInvocation(opts: LaunchOptions, sessionId: string): SshInvocation {
  const target = opts.remote
  if (!target) throw new Error('buildSshInvocation richiede opts.remote')

  return {
    file: 'ssh',
    args: [...connectionArgs(target), sshDestination(target), remoteCommand(opts, sessionId)]
  }
}

/** Comando ssh non interattivo, per interrogare il server. */
export function buildSshQuery(target: SshTarget, remoteScript: string): SshInvocation {
  const args: string[] = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    // Senza terminale: l'output va letto, non mostrato.
    '-T'
  ]
  if (target.port && target.port !== 22) args.push('-p', String(target.port))
  if (target.identityFile) args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes')

  args.push(sshDestination(target), remoteScript)
  return { file: 'ssh', args }
}
