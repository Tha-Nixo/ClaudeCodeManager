import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildClaudeArgs, expectedClaudeSessionId } from '../src/main/claude/cli'
import { encodeProjectDir, normalizePath } from '../src/main/claude/paths'
import type { LaunchOptions } from '../src/shared/types'

/**
 * Le opzioni di lancio arrivano dal renderer, che non e' una fonte fidata:
 * qualunque valore che sopravvive alla convalida finisce nella riga di comando
 * di `claude`. Una convalida debole qui non e' un difetto cosmetico, e' un
 * modo per far eseguire flag che l'utente non ha mai scelto (per esempio
 * `--dangerously-skip-permissions`). Questi test fissano il contratto:
 * si passa solo cio' che e' in elenco, tutto il resto sparisce.
 */

const NUOVO_ID = '11111111-2222-4333-8444-555555555555'
const RIPRESO_ID = '550e8400-e29b-41d4-a716-446655440000'
/** Cartella temporanea: nessun test deve dipendere da percorsi personali. */
const CWD = mkdtempSync(join(tmpdir(), 'cm-cli-'))

/** Argomenti prodotti quando non si chiede niente di speciale. */
const BASE = ['--session-id', NUOVO_ID]

function costruisci(opts: Partial<LaunchOptions>): string[] {
  return buildClaudeArgs({ cwd: CWD, ...opts } as LaunchOptions, NUOVO_ID)
}

/** Il valore che segue un flag, o undefined se il flag non c'e'. */
function valoreDi(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

/**
 * Valori che nessuna interfaccia produce ma che un renderer compromesso, una
 * configurazione scritta a mano o un layout salvato da una versione futura
 * possono benissimo contenere.
 */
const VALORI_OSTILI: unknown[] = [
  // Tentativi di iniezione: il flag piu' pericoloso della CLI, da solo e
  // agganciato a un valore per il resto legittimo.
  '--dangerously-skip-permissions',
  'opus --dangerously-skip-permissions',
  '--permission-mode bypassPermissions',
  '-p',
  // Separatori di comando: contano solo se qualcuno reintroduce una shell.
  'opus; --dangerously-skip-permissions',
  'opus && whoami',
  'opus | tee /tmp/x',
  'opus`whoami`',
  'opus$(whoami)',
  // Spazi e a capo: spezzerebbero l'argomento in piu' argomenti.
  'opus sonnet',
  ' opus',
  'opus ',
  'opus\nhaiku',
  'opus\r\n--continue',
  'opus\thaiku',
  // Cugini stretti di un valore valido: la convalida deve essere esatta.
  'OPUS',
  'Opus',
  'opus2',
  'op',
  'default ',
  // Chiavi che su un oggetto semplice risponderebbero "presente".
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  // Tipi sbagliati: JSON malformato o campo dimenticato.
  42,
  0,
  -1,
  true,
  false,
  null,
  undefined,
  {},
  { toString: () => 'opus' },
  [],
  ['opus'],
  ''
]

describe('buildClaudeArgs: i valori ammessi diventano i flag giusti', () => {
  it('ogni alias di modello produce --model con quell\'alias', () => {
    for (const model of ['fable', 'opus', 'sonnet', 'haiku'] as const) {
      const args = costruisci({ model })
      assert.equal(valoreDi(args, '--model'), model, `modello ${model}`)
    }
  })

  it('ogni livello di effort produce --effort con quel livello', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const args = costruisci({ effort })
      assert.equal(valoreDi(args, '--effort'), effort, `effort ${effort}`)
    }
  })

  it('ogni modalita\' di permessi produce --permission-mode con quella modalita\'', () => {
    const modi = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const
    for (const permissionMode of modi) {
      const args = costruisci({ permissionMode })
      assert.equal(valoreDi(args, '--permission-mode'), permissionMode, `modalita' ${permissionMode}`)
    }
  })

  it("'default' significa NON passare il flag, non passare la parola 'default'", () => {
    // Se 'default' passasse, claude userebbe un modello inesistente e la
    // sessione non partirebbe affatto.
    const args = costruisci({ model: 'default', effort: 'default', permissionMode: 'default' })
    assert.deepEqual(args, BASE)
  })

  it('le tre scelte convivono nella stessa riga', () => {
    const args = costruisci({ model: 'sonnet', effort: 'high', permissionMode: 'plan' })
    assert.deepEqual(args, [
      ...BASE,
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--permission-mode',
      'plan'
    ])
  })
})

describe('buildClaudeArgs: i valori non ammessi vengono scartati, non passati', () => {
  const campi = ['model', 'effort', 'permissionMode'] as const

  for (const campo of campi) {
    it(`${campo}: nessun valore ostile arriva alla riga di comando`, () => {
      for (const valore of VALORI_OSTILI) {
        const args = costruisci({ [campo]: valore } as unknown as Partial<LaunchOptions>)
        assert.deepEqual(
          args,
          BASE,
          `${campo} = ${JSON.stringify(valore)} ha lasciato una traccia: ${JSON.stringify(args)}`
        )
      }
    })
  }

  it('nessuna combinazione ostile fa comparire --dangerously-skip-permissions', () => {
    // L'unico modo per attivarlo sarebbe una convalida che lascia passare la
    // stringa: qui si prova su tutti e tre i campi insieme.
    for (const valore of VALORI_OSTILI) {
      const args = costruisci({
        model: valore,
        effort: valore,
        permissionMode: valore,
        name: 'sessione',
        initialPrompt: 'ciao'
      } as unknown as Partial<LaunchOptions>)
      assert.equal(
        args.some((a) => a.includes('dangerously')),
        false,
        `valore ${JSON.stringify(valore)} -> ${JSON.stringify(args)}`
      )
      assert.equal(args.includes('--model'), false)
      assert.equal(args.includes('--effort'), false)
      assert.equal(args.includes('--permission-mode'), false)
    }
  })

  it('un valore scartato non lascia mai un flag senza valore o un argomento vuoto', () => {
    // Un `--model` seguito da niente farebbe mangiare a claude l'argomento
    // successivo (il prompt) come se fosse il nome del modello.
    for (const valore of VALORI_OSTILI) {
      const args = costruisci({
        model: valore as never,
        initialPrompt: 'un prompt qualsiasi'
      })
      assert.deepEqual(args, [...BASE, '--', 'un prompt qualsiasi'])
    }
  })
})

describe('buildClaudeArgs: resumeSessionId accetta solo UUID veri', () => {
  it('accetta un UUID, in minuscolo e in maiuscolo', () => {
    for (const id of [RIPRESO_ID, RIPRESO_ID.toUpperCase()]) {
      const args = costruisci({ resumeSessionId: id })
      assert.deepEqual(args, ['--resume', id])
    }
  })

  const NON_UUID: unknown[] = [
    '',
    '   ',
    'non-un-uuid',
    'ultima',
    RIPRESO_ID.slice(0, -1),
    RIPRESO_ID + '0',
    RIPRESO_ID.replace(/-/g, ''),
    `{${RIPRESO_ID}}`,
    ` ${RIPRESO_ID}`,
    `${RIPRESO_ID} `,
    // Un a capo finale: in altri linguaggi '$' lo tollererebbe, e l'id
    // scivolerebbe dentro la riga di comando spezzato in due.
    `${RIPRESO_ID}\n`,
    `${RIPRESO_ID}\r\n`,
    `${RIPRESO_ID} --dangerously-skip-permissions`,
    `${RIPRESO_ID};whoami`,
    '550e8400-e29b-41d4-a716-44665544000g',
    '../../../etc/passwd',
    '..\\..\\altro',
    '--continue',
    '__proto__',
    12345,
    true,
    {},
    []
  ]

  it('scarta tutto il resto e riparte da una sessione nuova', () => {
    for (const id of NON_UUID) {
      const args = costruisci({ resumeSessionId: id as never })
      assert.deepEqual(
        args,
        BASE,
        `id rifiutato ${JSON.stringify(id)} ha prodotto ${JSON.stringify(args)}`
      )
    }
  })

  it("l'id atteso su disco coincide sempre con quello passato a claude", () => {
    // Se i due divergessero, il riquadro resterebbe scollegato dal registro
    // delle sessioni vive: nessun titolo, nessuna notifica.
    for (const id of [RIPRESO_ID, ...NON_UUID]) {
      const opts = { cwd: CWD, resumeSessionId: id as never }
      const args = buildClaudeArgs(opts, NUOVO_ID)
      const atteso = expectedClaudeSessionId(opts, NUOVO_ID)
      const nellaRiga = valoreDi(args, '--resume') ?? valoreDi(args, '--session-id')
      assert.equal(atteso, nellaRiga, `id ${JSON.stringify(id)}`)
    }
  })

  it('con --fork-session l\'id finale e\' imprevedibile e viene dichiarato ignoto', () => {
    const opts = { cwd: CWD, resumeSessionId: RIPRESO_ID, forkSession: true }
    assert.equal(expectedClaudeSessionId(opts, NUOVO_ID), null)
  })
})

describe('buildClaudeArgs: --session-id e --resume non compaiono mai insieme', () => {
  /** Tutte le combinazioni delle opzioni che scelgono come parte la sessione. */
  const COMBINAZIONI: Partial<LaunchOptions>[] = []
  for (const continueLast of [undefined, false, true]) {
    for (const forkSession of [undefined, false, true]) {
      for (const resumeSessionId of [undefined, RIPRESO_ID, 'non-un-uuid', '']) {
        for (const model of [undefined, 'opus', 'default'] as const) {
          for (const initialPrompt of [undefined, 'prompt']) {
            COMBINAZIONI.push({
              continueLast,
              forkSession,
              resumeSessionId,
              model,
              initialPrompt
            } as Partial<LaunchOptions>)
          }
        }
      }
    }
  }

  it('in nessuna delle combinazioni convivono i due flag', () => {
    for (const opts of COMBINAZIONI) {
      const args = costruisci(opts)
      const insieme = args.includes('--session-id') && args.includes('--resume')
      assert.equal(insieme, false, `combinazione ${JSON.stringify(opts)} -> ${JSON.stringify(args)}`)
      // Esattamente una delle due strade viene sempre imboccata, altrimenti
      // claude aprirebbe una sessione con un id che non conosciamo.
      const scelte = ['--session-id', '--resume', '--continue'].filter((f) => args.includes(f))
      assert.equal(scelte.length, 1, `combinazione ${JSON.stringify(opts)}`)
    }
  })

  it('--continue ha la precedenza e non porta con se\' nessun id', () => {
    const args = costruisci({ continueLast: true, resumeSessionId: RIPRESO_ID })
    assert.deepEqual(args, ['--continue'])
  })

  it('--fork-session compare solo insieme a --continue o --resume', () => {
    // Da solo claude lo rifiuta e la sessione non parte.
    for (const opts of COMBINAZIONI) {
      const args = costruisci(opts)
      if (!args.includes('--fork-session')) continue
      assert.equal(
        args.includes('--continue') || args.includes('--resume'),
        true,
        `fork orfano in ${JSON.stringify(opts)} -> ${JSON.stringify(args)}`
      )
    }
    assert.deepEqual(costruisci({ forkSession: true }), BASE)
  })

  it("un id non valido non trascina l'app in --resume", () => {
    const args = costruisci({ resumeSessionId: 'non-un-uuid', forkSession: true })
    assert.deepEqual(args, BASE)
  })
})

describe('buildClaudeArgs: il prompt iniziale sta in fondo, dopo --', () => {
  const PROMPT_OSTILI = [
    'ciao',
    '--dangerously-skip-permissions',
    '--model opus',
    '-p',
    'testo con spazi e "apici"',
    'prima riga\nseconda riga',
    'punto e virgola; pipe |',
    'unicode 日本語 🚀',
    '--',
    'a'.repeat(300)
  ]

  it('il prompt e\' sempre l\'ultimo argomento, preceduto da --', () => {
    for (const initialPrompt of PROMPT_OSTILI) {
      for (const extra of [
        {},
        { model: 'opus' as const, effort: 'max' as const, permissionMode: 'plan' as const },
        { continueLast: true, forkSession: true },
        { resumeSessionId: RIPRESO_ID },
        { name: 'una sessione' }
      ]) {
        const args = costruisci({ ...extra, initialPrompt })
        assert.equal(args[args.length - 1], initialPrompt, `prompt ${JSON.stringify(initialPrompt)}`)
        assert.equal(args[args.length - 2], '--', `separatore per ${JSON.stringify(initialPrompt)}`)
      }
    }
  })

  it("il separatore -- compare una volta sola, cosi' il prompt resta un solo argomento", () => {
    // Un secondo '--' prima del prompt farebbe leggere a claude due argomenti
    // posizionali invece di uno. Il prompt stesso e' escluso dal conteggio:
    // se l'utente scrive proprio '--', quello e' testo, non un separatore.
    for (const initialPrompt of PROMPT_OSTILI) {
      const args = costruisci({ initialPrompt, model: 'opus', name: 'nome' })
      const primaDelPrompt = args.slice(0, -1)
      assert.equal(
        primaDelPrompt.filter((a) => a === '--').length,
        1,
        JSON.stringify(initialPrompt)
      )
    }
  })

  it('gli spazi ai bordi del prompt vengono tolti', () => {
    assert.deepEqual(costruisci({ initialPrompt: '   ciao   ' }), [...BASE, '--', 'ciao'])
  })

  it('un prompt vuoto o di soli spazi non produce ne\' -- ne\' un argomento vuoto', () => {
    for (const initialPrompt of ['', '   ', '\t', '\n', ' \r\n \t ']) {
      const args = costruisci({ initialPrompt })
      assert.deepEqual(
        args,
        BASE,
        `prompt ${JSON.stringify(initialPrompt)} -> ${JSON.stringify(args)}`
      )
    }
  })

  it('nessun argomento e\' mai la stringa vuota', () => {
    // Un argomento vuoto slitta la posizione di tutti gli altri.
    for (const initialPrompt of ['', '  ', ...PROMPT_OSTILI]) {
      for (const name of ['', '  ', 'nome', '\u0000']) {
        const args = costruisci({ initialPrompt, name, model: 'opus' })
        assert.equal(
          args.some((a) => a === ''),
          false,
          `${JSON.stringify({ initialPrompt, name })} -> ${JSON.stringify(args)}`
        )
      }
    }
  })
})

describe('buildClaudeArgs: il nome della sessione', () => {
  it('toglie i caratteri di controllo e resta su una riga sola', () => {
    // Il nome finisce nel titolo del riquadro e nel prompt box: un a capo o una
    // sequenza ANSI ci sporcherebbe il terminale.
    const args = costruisci({ name: 'riga uno\nriga due\r\tfine' })
    const nome = valoreDi(args, '--name')
    assert.equal(nome, 'riga unoriga duefine')
    assert.equal(/[\p{Cc}\p{Cf}]/u.test(nome ?? ''), false)
  })

  it('toglie anche le sequenze di escape ANSI carattere per carattere', () => {
    const nome = valoreDi(costruisci({ name: 'ciao\u001b[31m mondo\u0000' }), '--name')
    assert.equal(nome?.includes('\u001b'), false)
    assert.equal(nome?.includes('\u0000'), false)
  })

  it('resta un argomento solo anche con spazi e apici', () => {
    const args = costruisci({ name: 'il mio "progetto" con spazi' })
    assert.deepEqual(args, [...BASE, '--name', 'il mio "progetto" con spazi'])
  })

  it('un nome vuoto, di soli spazi o di soli caratteri invisibili non produce --name', () => {
    for (const name of ['', '   ', '\t\n', '\u0000', '\u0000\u200d ', '\u007f']) {
      const args = costruisci({ name })
      assert.deepEqual(args, BASE, `nome ${JSON.stringify(name)} -> ${JSON.stringify(args)}`)
    }
  })

  it('un nome lunghissimo viene accorciato invece di gonfiare la riga di comando', () => {
    const nome = valoreDi(costruisci({ name: 'a'.repeat(500) }), '--name')
    assert.equal(nome?.length, 64)
  })

  /**
   * DIFETTO OSSERVATO, non corretto qui.
   *
   * Il taglio a 64 usa slice(), che conta unita' UTF-16: se il 64esimo posto
   * cade in mezzo a un carattere fuori dal piano base (emoji, ideogrammi rari)
   * il nome finisce con meta' surrogato. Osservato con 63 lettere piu' una
   * emoji: il valore di --name termina con '\uD83D' isolato, che non e' testo
   * valido e si vede come carattere sostitutivo nel titolo del riquadro e nel
   * registro di Claude Code.
   *
   * Atteso: il troncamento si ferma al carattere intero precedente.
   */
  it("il taglio a 64 non spezza a meta' un carattere fuori dal piano base", () => {
    // Si cerca un surrogato SPAIATO, non un surrogato qualsiasi: un'emoji
    // integra ne contiene due per costruzione, quindi cercarli tutti darebbe
    // un test che non puo' passare in nessun caso.
    const nome = valoreDi(costruisci({ name: 'a'.repeat(63) + '🚀' }), '--name') ?? ''
    assert.equal(nome.isWellFormed(), true, `nome troncato a meta': ${JSON.stringify(nome)}`)
    assert.equal(nome, 'a'.repeat(63) + '🚀', 'il carattere intero doveva restare')

    // E il taglio deve comunque avvenire quando il nome e' davvero troppo lungo.
    const lungo = valoreDi(costruisci({ name: '🚀'.repeat(100) }), '--name') ?? ''
    assert.equal(lungo.isWellFormed(), true, 'nessun mezzo carattere nemmeno tagliando')
    assert.equal(Array.from(lungo).length, 64, 'tagliato a 64 caratteri veri')
  })

  /**
   * DIFETTO OSSERVATO, non corretto qui.
   *
   * `name` e `initialPrompt` sono gli unici campi di LaunchOptions senza
   * controllo di tipo: model, effort e permissionMode passano da un elenco di
   * valori ammessi e sopravvivono a qualunque tipo, l'id di ripresa passa da
   * una regex. Con un valore non testuale buildClaudeArgs solleva
   *   TypeError: opts.name.replace is not a function
   *   TypeError: opts.initialPrompt.trim is not a function
   * e il riquadro non si apre.
   *
   * Non e' un caso teorico: layout.json e' dichiaratamente modificabile a mano
   * e store/layout.ts controlla solo che `launch` sia un oggetto, senza
   * guardare dentro; anche ipc.ts passa al gestore le opzioni del renderer cosi'
   * come arrivano. Un `"name": 123` scritto per sbaglio nel layout salvato fa
   * fallire il ripristino di quel riquadro ad ogni avvio.
   *
   * Atteso: il campo non testuale viene ignorato come tutti gli altri valori
   * non validi, e la sessione parte lo stesso.
   */
  it('un nome o un prompt non testuali vengono ignorati invece di far fallire il lancio', () => {
    for (const name of [42, true, {}, []] as unknown[]) {
      const args = costruisci({ name } as unknown as Partial<LaunchOptions>)
      assert.deepEqual(args, BASE, `nome ${JSON.stringify(name)}`)
    }
    for (const initialPrompt of [42, true, {}, []] as unknown[]) {
      const args = costruisci({ initialPrompt } as unknown as Partial<LaunchOptions>)
      assert.deepEqual(args, BASE, `prompt ${JSON.stringify(initialPrompt)}`)
    }
  })

  it('un nome assente o nullo non produce --name', () => {
    // Questi due casi il prodotto li gestisce: sono falsy e vengono saltati.
    for (const name of [null, undefined] as unknown[]) {
      const args = costruisci({ name } as unknown as Partial<LaunchOptions>)
      assert.deepEqual(args, BASE, `nome ${JSON.stringify(name)}`)
    }
  })
})

describe('encodeProjectDir: dal percorso al nome della cartella dei transcript', () => {
  it('sostituisce ogni carattere non alfanumerico con un trattino', () => {
    assert.equal(encodeProjectDir('C:\\Users\\Tha_Nixo\\Desktop\\ClaudeManager'), 'C--Users-Tha-Nixo-Desktop-ClaudeManager')
  })

  it('barre miste danno lo stesso nome delle sole barre rovesciate', () => {
    // I percorsi arrivano da file di configurazione scritti a mano e da
    // history.jsonl, dove le due forme convivono.
    assert.equal(encodeProjectDir('C:/Users/Tizio/Progetti'), encodeProjectDir('C:\\Users\\Tizio\\Progetti'))
    assert.equal(encodeProjectDir('C:/Users\\Tizio//Progetti'), 'C--Users-Tizio-Progetti')
  })

  it('la barra finale non conta: e\' la stessa cartella', () => {
    // Senza questa normalizzazione i transcript della cartella non si
    // troverebbero, perche' Claude Code scrive la forma senza barra finale.
    for (const base of ['C:\\Progetti\\App', 'D:/lavoro/mio progetto', 'C:\\a']) {
      const atteso = encodeProjectDir(base)
      for (const coda of ['\\', '/', '\\\\', '//', '\\/']) {
        assert.equal(encodeProjectDir(base + coda), atteso, `${base} + ${JSON.stringify(coda)}`)
      }
    }
  })

  it("nella radice di un'unita' il separatore invece conta", () => {
    // 'C:\' e' una cartella vera, 'C:' e' l'unita': Claude Code le scrive diverse.
    assert.equal(encodeProjectDir('C:\\'), 'C--')
    assert.equal(encodeProjectDir('C:'), 'C-')
    assert.equal(encodeProjectDir('C:\\\\'), 'C--')
  })

  it('spazi, apici e unicode diventano trattini', () => {
    assert.equal(encodeProjectDir('C:\\mia cartella'), 'C--mia-cartella')
    assert.equal(encodeProjectDir("C:\\l'archivio"), 'C--l-archivio')
    assert.equal(encodeProjectDir('C:\\progetti\\città'), 'C--progetti-citt-')
    assert.equal(encodeProjectDir('C:\\日本語'), 'C--' + '-'.repeat(3))
    assert.equal(encodeProjectDir('C:\\emoji 🚀'), 'C--emoji--' + '-')
  })

  it('la lettera di unita\' conserva le maiuscole: due grafie danno due nomi', () => {
    // Non e' un dettaglio estetico: il nome deve combaciare carattere per
    // carattere con quello che scrive Claude Code, che non normalizza il caso.
    assert.equal(encodeProjectDir('C:\\Progetti'), 'C--Progetti')
    assert.equal(encodeProjectDir('c:\\Progetti'), 'c--Progetti')
    assert.notEqual(encodeProjectDir('C:\\Progetti'), encodeProjectDir('c:\\Progetti'))
  })

  it('un percorso vuoto da un nome vuoto', () => {
    // Chi chiama non deve passarlo: il nome vuoto punterebbe alla cartella
    // projects/ stessa invece che a un progetto.
    assert.equal(encodeProjectDir(''), '')
  })

  it('il risultato e\' sempre un nome di cartella innocuo', () => {
    // encodeProjectDir viene unita a projects/ con join: se sopravvivesse un
    // separatore o un '..', un percorso ostile uscirebbe da quella cartella.
    const ostili = [
      'C:\\..\\..\\Windows\\System32',
      'C:/../..',
      '..',
      '.',
      'C:\\progetti\\..\\..\\altro',
      '\\\\server\\condivisione\\prog',
      'C:\\nul',
      'C:\\a\0b',
      "C:\\dir\\; rm -rf",
      'C:\\dir\\$(whoami)',
      'C:\\dir\\%PATH%',
      ''
    ]
    for (const p of ostili) {
      const nome = encodeProjectDir(p)
      assert.match(nome, /^[A-Za-z0-9-]*$/, `${JSON.stringify(p)} -> ${JSON.stringify(nome)}`)
      // Prova diretta: unito a una radice, il risultato non ne esce mai.
      assert.equal(
        resolve(join(CWD, nome)).startsWith(resolve(CWD)),
        true,
        `${JSON.stringify(p)} -> ${JSON.stringify(nome)}`
      )
    }
  })

  it('la codifica e\' stabile: lo stesso percorso da sempre lo stesso nome', () => {
    const p = 'C:\\Users\\Tizio\\Progetti\\App'
    assert.equal(encodeProjectDir(p), encodeProjectDir(p))
    assert.equal(encodeProjectDir(encodeProjectDir(p)), encodeProjectDir(p).replace(/[^a-zA-Z0-9]/g, '-'))
  })
})

describe('normalizePath: la chiave con cui si deduplicano le cartelle', () => {
  it('due grafie della stessa cartella danno la stessa chiave', () => {
    // knownFolders unisce history.jsonl e le directory dei progetti: se le due
    // grafie non collassassero, la stessa cartella comparirebbe due volte nel
    // selettore, con conteggi dimezzati.
    const forme = [
      'C:\\Users\\Tizio\\Progetti',
      'C:/Users/Tizio/Progetti',
      'C:\\Users\\Tizio\\Progetti\\',
      'C:/Users/Tizio/Progetti/',
      'c:\\users\\tizio\\progetti',
      'C:\\Users/Tizio\\\\Progetti//',
      'C:\\USERS\\TIZIO\\PROGETTI'
    ]
    const chiavi = new Set(forme.map(normalizePath))
    assert.equal(chiavi.size, 1, `chiavi diverse: ${[...chiavi].join(' | ')}`)
    assert.equal([...chiavi][0], 'c:\\users\\tizio\\progetti')
  })

  it('la deduplicazione funziona davvero su una mappa', () => {
    const mappa = new Map<string, number>()
    for (const p of ['C:/Lavoro/App', 'C:\\Lavoro\\App\\', 'c:\\lavoro\\app']) {
      const k = normalizePath(p)
      mappa.set(k, (mappa.get(k) ?? 0) + 1)
    }
    assert.equal(mappa.size, 1)
    assert.equal([...mappa.values()][0], 3)
  })

  it('cartelle diverse restano diverse', () => {
    // Il rovescio della medaglia: una normalizzazione troppo aggressiva
    // farebbe sparire cartelle vere dall'elenco.
    const diverse = ['C:\\a', 'C:\\ab', 'C:\\a\\b', 'C:\\a-b', 'C:\\a b', 'D:\\a']
    assert.equal(new Set(diverse.map(normalizePath)).size, diverse.length)
  })

  it('e\' proprio per questo che non si deduplica con encodeProjectDir', () => {
    // La codifica e' lossy: 'a b', 'a_b' e 'a-b' finiscono tutti su 'a-b'.
    // Usarla come chiave fonderebbe cartelle distinte in una sola voce.
    const diverse = ['C:\\a b', 'C:\\a_b', 'C:\\a-b']
    assert.equal(new Set(diverse.map(encodeProjectDir)).size, 1)
    assert.equal(new Set(diverse.map(normalizePath)).size, 3)
  })

  it('applicarla due volte non cambia il risultato', () => {
    for (const p of ['C:/a/b/', 'C:\\', 'C:', '', 'D:/x']) {
      assert.equal(normalizePath(normalizePath(p)), normalizePath(p), JSON.stringify(p))
    }
  })
})
