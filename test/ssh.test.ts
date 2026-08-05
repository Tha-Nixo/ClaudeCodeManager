import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LaunchOptions, SshTarget } from '@shared/types'
import {
  buildSshInvocation,
  buildSshQuery,
  remoteCommand,
  shellQuote,
  sshDestination
} from '../src/main/ssh/command'
import { isRemoteResumable } from '../src/main/ssh/remote'

/**
 * Nessun test qui apre una connessione: si controllano soltanto le stringhe
 * che verrebbero consegnate a ssh e alla shell remota. È il punto in cui i
 * difetti fanno più male, perché il risultato sbagliato non solleva niente:
 * arriva a destinazione e fa una cosa diversa da quella chiesta.
 */

const SID = '11111111-2222-3333-4444-555555555555'

/** Bersaglio minimo; ogni test sovrascrive solo quello che gli interessa. */
function bersaglio(extra: Partial<SshTarget> = {}): SshTarget {
  return { host: 'server.esempio.invalid', user: 'nicola', ...extra }
}

function opzioni(
  path: string,
  extra: Omit<Partial<LaunchOptions>, 'remote'> = {},
  remote: Partial<SshTarget> = {}
): LaunchOptions {
  return {
    cwd: 'C:\\progetti',
    ...extra,
    remote: {
      connectionId: 'c1',
      name: 'Server di prova',
      path,
      ...bersaglio(remote)
    }
  }
}

// --- Strumenti di verifica ---------------------------------------------------

/**
 * Inverso di `shellQuote`: toglie gli apici esterni e riporta ogni `'\''` a un
 * apice singolo. Serve a controllare l'unica cosa che conta davvero, cioè che
 * la shell remota veda la stessa identica stringa che ha scritto l'utente.
 */
function unquote(quotato: string): string {
  assert.ok(
    quotato.startsWith("'") && quotato.endsWith("'") && quotato.length >= 2,
    `non è un letterale fra apici singoli: ${JSON.stringify(quotato)}`
  )
  return quotato
    .slice(1, -1)
    .split("'\\''")
    .join("'")
}

/**
 * Tokenizzatore POSIX ridotto ai costrutti che generiamo: apici singoli,
 * backslash e spazi. Riproduce quello che la shell del server consegnerebbe
 * a `cd` e a `claude` come argomenti separati, che è la cosa che l'utente
 * vede rompersi quando il quoting sbaglia.
 */
function tokenizzaPosix(riga: string): string[] {
  const token: string[] = []
  let corrente = ''
  let iniziato = false
  let inApici = false

  for (let i = 0; i < riga.length; i++) {
    const c = riga[i]
    if (inApici) {
      if (c === "'") inApici = false
      else corrente += c
      continue
    }
    if (c === "'") {
      inApici = true
      iniziato = true
      continue
    }
    if (c === '\\') {
      i++
      if (i < riga.length) {
        corrente += riga[i]
        iniziato = true
      }
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (iniziato) {
        token.push(corrente)
        corrente = ''
        iniziato = false
      }
      continue
    }
    corrente += c
    iniziato = true
  }
  if (iniziato) token.push(corrente)
  return token
}

/** La parte `cd ...` del comando remoto, prima della redirezione. */
function parteCd(comando: string): string {
  return comando.split(' 2>/dev/null')[0]
}

/**
 * La parte `exec claude ...`, in fondo. Si ancora al ramo che rimanda alla
 * shell remota, che è testo fisso: cercare l'ultimo `exec` prenderebbe anche
 * un `exec` scritto dentro il prompt dell'utente.
 */
const SENTINELLA = 'exec ${SHELL:-sh} -l; }; '
function parteClaude(comando: string): string {
  const i = comando.indexOf(SENTINELLA)
  assert.notEqual(i, -1, 'manca il ramo di ripiego sulla shell remota')
  return comando.slice(i + SENTINELLA.length)
}

// --- shellQuote --------------------------------------------------------------

/** Stringhe che una shell POSIX interpreterebbe, se non fossero protette. */
const CORPUS = [
  'semplice',
  'con spazi normali',
  "l'apostrofo",
  "'",
  "''",
  "a'b'c",
  "'\\''",
  'doppi "apici" in mezzo',
  '"',
  'backtick `whoami`',
  'sostituzione $(id)',
  'variabile $HOME e ${HOME}',
  'punto e virgola; ls',
  'a && b',
  'a || b',
  'a | b',
  'ridirezione > file < altro',
  'a capo\nin mezzo',
  '\n',
  'tab\tin mezzo',
  'backslash \\ singolo',
  '\\',
  "\\'",
  'C:\\dir\\file',
  '',
  ' ',
  '   spazi ai bordi   ',
  'unicode 日本語 emoji 🚀 accentate àèìòù',
  '~',
  '~/sotto',
  '-',
  '--sembra-un-flag',
  'jolly * ? [a-z]',
  '#commento',
  '!storia',
  'a'.repeat(300)
]

describe('shellQuote: letterale POSIX per qualunque stringa', () => {
  it('riporta identica ogni stringa del corpus ostile', () => {
    for (const valore of CORPUS) {
      const quotato = shellQuote(valore)
      assert.equal(
        unquote(quotato),
        valore,
        `deformata: ${JSON.stringify(valore)} -> ${JSON.stringify(quotato)}`
      )
    }
  })

  it('la shell vede un argomento solo, qualunque sia il contenuto', () => {
    // Il roundtrip da solo non basta: se il risultato fosse due letterali
    // separati da uno spazio l'inverso tornerebbe uguale lo stesso, ma il
    // comando remoto riceverebbe due argomenti.
    for (const valore of CORPUS) {
      assert.deepEqual(
        tokenizzaPosix(shellQuote(valore)),
        [valore],
        `spezzata in più argomenti: ${JSON.stringify(valore)}`
      )
    }
  })

  it('dentro gli apici non resta nessun apice fuori dalla sequenza di protezione', () => {
    // Un apice non protetto chiuderebbe il letterale e farebbe interpretare
    // dalla shell tutto quello che segue: è così che un prompt diventa un
    // comando.
    for (const valore of CORPUS) {
      const interno = shellQuote(valore).slice(1, -1)
      assert.ok(
        !interno.split("'\\''").join('').includes("'"),
        `apice non protetto in ${JSON.stringify(valore)}`
      )
    }
  })

  it('la stringa vuota resta un argomento presente, non sparisce', () => {
    assert.equal(shellQuote(''), "''")
  })
})

// --- remoteCommand -----------------------------------------------------------

/**
 * Regressione della issue #1, lato remoto.
 *
 * C'era un assert che vietava i doppi apici nel comando remoto: bastava un
 * prompt del tutto normale come `sistema il bug del "login"` perché
 * l'apertura del riquadro fallisse con un'eccezione, senza che l'utente
 * potesse capire cosa avesse fatto di sbagliato. Ora gli argomenti sono
 * protetti a monte e i doppi apici sono legittimi.
 */
describe('remoteCommand: doppi apici nel prompt (regressione della issue #1)', () => {
  const PROMPT = 'sistema il bug del "login"'

  it('non lancia più con un prompt che contiene doppi apici', () => {
    assert.doesNotThrow(() => remoteCommand(opzioni('/srv/app', { initialPrompt: PROMPT }), SID))
  })

  it('consegna il prompt alla shell remota identico, doppi apici compresi', () => {
    const cmd = remoteCommand(opzioni('/srv/app', { initialPrompt: PROMPT }), SID)
    assert.deepEqual(tokenizzaPosix(parteClaude(cmd)), [
      'exec',
      'claude',
      '--session-id',
      SID,
      '--',
      PROMPT
    ])
  })

  it('regge anche i prompt più ostili senza lanciare e senza deformarli', () => {
    const prompt = [
      'usa "questo" e \'quello\'',
      'esegui `whoami` e $(id)',
      'poi ; rm -rf / && echo fatto',
      'su più righe'
    ].join('\n')

    const cmd = remoteCommand(opzioni('/srv/app', { initialPrompt: prompt }), SID)
    const token = tokenizzaPosix(parteClaude(cmd))
    assert.equal(token.at(-1), prompt)
    // Il prompt resta un argomento solo: se si spezzasse, la coda finirebbe
    // alla shell remota come comando da eseguire.
    assert.deepEqual(token, ['exec', 'claude', '--session-id', SID, '--', prompt])
  })
})

/**
 * Correzione collegata alla issue #1.
 *
 * Senza `--`, una cartella il cui nome inizia con un trattino veniva letta da
 * `cd` come opzione: con `-` si finiva in $OLDPWD, cioè in un posto diverso da
 * quello scelto, e senza nessun messaggio. Claude partiva nella cartella
 * sbagliata.
 */
describe('remoteCommand: cd protetto con --', () => {
  it("una cartella chiamata '-' produce cd -- '-'", () => {
    const cd = parteCd(remoteCommand(opzioni('-'), SID))
    assert.equal(cd, "cd -- '-'")
    assert.ok(!cd.includes("cd '-'"), 'il -- è sparito: cd tornerebbe in $OLDPWD')
    assert.deepEqual(tokenizzaPosix(cd), ['cd', '--', '-'])
  })

  it('vale per qualunque nome che sembri un flag', () => {
    for (const nome of ['-', '-P', '--', '-L/tmp', '--help']) {
      assert.deepEqual(
        tokenizzaPosix(parteCd(remoteCommand(opzioni(nome), SID))),
        ['cd', '--', nome],
        `nome letto come opzione: ${nome}`
      )
    }
  })
})

describe('remoteCommand: percorsi remoti', () => {
  it('senza percorso si parte dalla home, con il tilde non protetto', () => {
    for (const path of ['', '   ', undefined as unknown as string]) {
      const cmd = remoteCommand(opzioni(path), SID)
      // Il tilde fra apici resterebbe un nome di cartella letterale: la shell
      // lo espande solo se lo vede nudo.
      assert.equal(parteCd(cmd), 'cd -- ~')
    }
  })

  it('un percorso sotto la home espande il tilde e protegge il resto', () => {
    const cd = parteCd(remoteCommand(opzioni('~/mia cartella'), SID))
    assert.equal(cd, "cd -- ~/'mia cartella'")
    assert.deepEqual(tokenizzaPosix(cd), ['cd', '--', '~/mia cartella'])
  })

  it('gli spazi e gli apici nel percorso arrivano interi', () => {
    const percorsi = ['/srv/mio progetto', "/srv/l'app", '/srv/pro "getto"', "~/l'altro", '/srv/日本']
    for (const path of percorsi) {
      assert.deepEqual(
        tokenizzaPosix(parteCd(remoteCommand(opzioni(path), SID))),
        ['cd', '--', path],
        `percorso deformato: ${path}`
      )
    }
  })

  it('un percorso assoluto non viene scambiato per un sottopercorso della home', () => {
    // '~qualcosa' non è la home di nessuno per noi: va trattato come un nome
    // di cartella letterale, non espanso a caso.
    assert.deepEqual(tokenizzaPosix(parteCd(remoteCommand(opzioni('~strano'), SID))), [
      'cd',
      '--',
      '~strano'
    ])
  })

  it('il messaggio di cartella irraggiungibile nomina la cartella chiesta', () => {
    // È l'unico appiglio che ha chi legge: senza il percorso, l'errore non
    // distingue un refuso da un server con un albero diverso.
    const path = '/srv/mio progetto'
    const cmd = remoteCommand(opzioni(path), SID)
    assert.ok(cmd.includes(shellQuote(`ClaudeManager: cartella remota non raggiungibile: ${path}`)))
  })
})

describe('remoteCommand: struttura del comando', () => {
  it('exec sostituisce la shell, così chiudendo claude la connessione cade', () => {
    const cmd = remoteCommand(opzioni('/srv/app'), SID)
    assert.ok(/(^|; )exec 'claude'/.test(cmd))
  })

  it('senza claude sul server si resta sulla shell remota invece di cadere', () => {
    const cmd = remoteCommand(opzioni('/srv/app'), SID)
    assert.ok(cmd.includes('command -v claude >/dev/null 2>&1 ||'))
    assert.ok(cmd.includes('exec ${SHELL:-sh} -l'))
  })

  it('riprende una conversazione esistente invece di aprirne una nuova', () => {
    const ripresa = '99999999-8888-7777-6666-555555555555'
    const cmd = remoteCommand(opzioni('/srv/app', { resumeSessionId: ripresa }), SID)
    assert.deepEqual(tokenizzaPosix(parteClaude(cmd)), ['exec', 'claude', '--resume', ripresa])
  })

  it('ogni argomento di claude è protetto singolarmente', () => {
    const cmd = remoteCommand(
      opzioni('/srv/app', { model: 'opus', name: 'riquadro "uno"', initialPrompt: '-- non un flag' }),
      SID
    )
    assert.deepEqual(tokenizzaPosix(parteClaude(cmd)), [
      'exec',
      'claude',
      '--session-id',
      SID,
      '--model',
      'opus',
      '--name',
      'riquadro "uno"',
      '--',
      '-- non un flag'
    ])
  })
})

// --- buildSshInvocation ------------------------------------------------------

describe('buildSshInvocation: argomenti di ssh', () => {
  it('senza un bersaglio remoto fallisce subito invece di aprire qualcosa a caso', () => {
    assert.throws(() => buildSshInvocation({ cwd: 'C:\\progetti' }, SID), /remote/)
  })

  it('chiede il terminale, altrimenti Claude non può disegnare la propria interfaccia', () => {
    const { file, args } = buildSshInvocation(opzioni('/srv/app'), SID)
    assert.equal(file, 'ssh')
    assert.ok(args.includes('-t'))
  })

  it('sulla porta 22 non aggiunge -p', () => {
    // La porta esplicita non deve comparire quando è quella predefinita:
    // aggiungerla scavalcherebbe una Port scritta nel ~/.ssh/config dell'utente.
    for (const port of [undefined, 22]) {
      const { args } = buildSshInvocation(opzioni('/srv/app', {}, { port }), SID)
      assert.ok(!args.includes('-p'), `-p aggiunto con porta ${String(port)}`)
    }
  })

  it('su una porta diversa passa -p e il numero come argomenti separati', () => {
    const { args } = buildSshInvocation(opzioni('/srv/app', {}, { port: 2222 }), SID)
    const i = args.indexOf('-p')
    assert.notEqual(i, -1)
    assert.equal(args[i + 1], '2222')
  })

  it('una chiave con spazi nel percorso resta un argomento solo e non viene quotata qui', () => {
    // Il quoting per PowerShell avviene a valle: se lo facesse anche qui, ssh
    // cercherebbe una chiave con gli apici nel nome e non la troverebbe.
    const dir = mkdtempSync(join(tmpdir(), 'cm chiavi '))
    const chiave = join(dir, 'la mia chiave')

    const { args } = buildSshInvocation(
      opzioni('/srv/app', {}, { identityFile: chiave }),
      SID
    )
    const i = args.indexOf('-i')
    assert.notEqual(i, -1)
    assert.equal(args[i + 1], chiave)
    // Con una chiave scelta a mano ssh non deve provarne altre prima, o il
    // server chiude per troppi tentativi.
    assert.ok(args.includes('IdentitiesOnly=yes'))
  })

  it('senza chiave non impone IdentitiesOnly, così vale il ~/.ssh/config', () => {
    const { args } = buildSshInvocation(opzioni('/srv/app'), SID)
    assert.ok(!args.includes('-i'))
    assert.ok(!args.includes('IdentitiesOnly=yes'))
  })

  it('tiene viva la connessione, così un server che sparisce non lascia il riquadro appeso', () => {
    const { args } = buildSshInvocation(opzioni('/srv/app'), SID)
    assert.ok(args.includes('ServerAliveInterval=30'))
    assert.ok(args.includes('ServerAliveCountMax=4'))
  })

  it('destinazione e comando remoto sono gli ultimi due argomenti, in quest\'ordine', () => {
    const { args } = buildSshInvocation(opzioni('/srv/app'), SID)
    assert.equal(args.at(-2), 'nicola@server.esempio.invalid')
    assert.equal(args.at(-1), remoteCommand(opzioni('/srv/app'), SID))
  })

  it('senza utente si lascia decidere a ssh invece di mandare un @ solitario', () => {
    assert.equal(sshDestination({ host: 'macchina.invalid', user: '' }), 'macchina.invalid')
    assert.equal(
      sshDestination({ host: 'macchina.invalid', user: 'nicola' }),
      'nicola@macchina.invalid'
    )
  })
})

// --- buildSshQuery -----------------------------------------------------------

describe('buildSshQuery: interrogazioni non interattive', () => {
  const varianti: SshTarget[] = [
    bersaglio(),
    bersaglio({ port: 22 }),
    bersaglio({ port: 2222 }),
    bersaglio({ user: '' }),
    bersaglio({ identityFile: 'C:\\chiavi\\id_ed25519' }),
    bersaglio({ port: 2222, identityFile: 'C:\\altre chiavi\\id_ed25519' })
  ]

  it('chiede sempre BatchMode: un prompt di password bloccherebbe l’interfaccia per sempre', () => {
    for (const target of varianti) {
      const { args } = buildSshQuery(target, 'echo ciao')
      const i = args.indexOf('BatchMode=yes')
      assert.notEqual(i, -1, `BatchMode assente per ${JSON.stringify(target)}`)
      // Deve restare attaccato al proprio -o: staccato, ssh lo leggerebbe come
      // destinazione e proverebbe a connettersi a un host inesistente.
      assert.equal(args[i - 1], '-o')
      assert.ok(args.includes('ConnectTimeout=10'))
    }
  })

  it('non alloca un terminale: l’output va letto, non mostrato', () => {
    const { args } = buildSshQuery(bersaglio(), 'echo ciao')
    assert.ok(args.includes('-T'))
    assert.ok(!args.includes('-t'))
  })

  it('sulla porta 22 non aggiunge -p, su una diversa sì', () => {
    assert.ok(!buildSshQuery(bersaglio({ port: 22 }), 'x').args.includes('-p'))
    const args = buildSshQuery(bersaglio({ port: 2222 }), 'x').args
    assert.equal(args[args.indexOf('-p') + 1], '2222')
  })

  it('lo script remoto passa in fondo e intatto, a capo compresi', () => {
    // Gli script sono multiriga: se venissero appiattiti o troncati, il for..do
    // diventerebbe un errore di sintassi sul server.
    const script = ["cd 'mia cartella' || exit 3", 'for e in *; do', '  echo "$e"', 'done'].join('\n')
    const { file, args } = buildSshQuery(bersaglio(), script)
    assert.equal(file, 'ssh')
    assert.equal(args.at(-1), script)
    assert.equal(args.at(-2), 'nicola@server.esempio.invalid')
  })
})

// --- remote.ts ---------------------------------------------------------------

/**
 * `describeFailure` non è esportata da src/main/ssh/remote.ts: si può
 * raggiungere solo passando per `runRemote`, che avvia ssh davvero. Qui non si
 * apre nessuna connessione, quindi il caso 'ENOENT' resta scoperto per scelta.
 *
 * Di `remote.ts` resta verificabile senza rete solo il filtro sull'id di
 * sessione, che è anche l'unica difesa: quell'id viene interpolato dentro un
 * percorso fra doppi apici in uno script remoto, senza passare da shellQuote.
 */
describe('isRemoteResumable: filtro sull’id di sessione', () => {
  it('rifiuta senza contattare il server tutto ciò che non è un id di sessione', async () => {
    const malformati = [
      '',
      'non-un-id',
      'zzzzzzzz-2222-3333-4444-555555555555',
      '11111111-2222-3333-4444-55555555555', // 35 caratteri
      '11111111-2222-3333-4444-5555555555555', // 37 caratteri
      '$(touch /tmp/preso)',
      '"; touch /tmp/preso; "',
      '../../../etc/passwd',
      '11111111-2222-3333-4444-555555555555 ' // spazio in coda
    ]

    for (const id of malformati) {
      assert.equal(
        await isRemoteResumable(bersaglio(), '/srv/app', id),
        false,
        `id accettato: ${JSON.stringify(id)}`
      )
    }
  })
})
