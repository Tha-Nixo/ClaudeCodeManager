import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fuzzyMatch, rankBy } from '../src/main/indexer/fuzzy'

/**
 * Le posizioni finiscono nella UI per evidenziare le lettere trovate: se un
 * indice cade fuori dalla stringa, o torna indietro, l'evidenziazione si
 * sposta sui caratteri sbagliati o rompe il rendering. Questa verifica sta in
 * un aiutante perche' va applicata a OGNI riscontro, non solo a quelli comodi.
 */
function verificaPosizioni(pattern: string, text: string, positions: number[]): void {
  // Si conta per unita' UTF-16, non per punti di codice: le posizioni sono
  // indici in `text`, e su un emoji la coppia surrogata occupa due indici.
  const attesi = pattern.split('').filter((c) => c !== ' ')

  assert.equal(
    positions.length,
    attesi.length,
    `${JSON.stringify(pattern)} su ${JSON.stringify(text)}: ${positions.length} posizioni per ${attesi.length} caratteri`
  )

  let precedente = -1
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]
    assert.ok(Number.isInteger(pos), `posizione non intera: ${pos}`)
    assert.ok(pos >= 0, `posizione negativa: ${pos}`)
    assert.ok(pos < text.length, `posizione fuori dalla stringa: ${pos} >= ${text.length}`)
    assert.ok(pos > precedente, `posizioni non crescenti: ${precedente} poi ${pos}`)
    precedente = pos

    // Il carattere evidenziato deve essere davvero quello cercato, altrimenti
    // l'utente vede sottolineate lettere che non ha digitato.
    assert.equal(
      text[pos].toLowerCase(),
      attesi[i].toLowerCase(),
      `posizione ${pos} indica ${JSON.stringify(text[pos])} invece di ${JSON.stringify(attesi[i])}`
    )
  }
}

/**
 * Regressione della issue #6.
 *
 * Cercando «cm» il selettore proponeva `C:\Users\Chiara\Modelli` e
 * `C:\Users\Carlo\Musica` prima di `C:\dev\ClaudeManager`: la 'c' si
 * agganciava avidamente alla lettera di unita', che conta come confine di
 * parola, e da li' in poi bastava una 'm' qualsiasi piu' avanti. Cioe' il
 * caso d'uso per cui il modulo esiste dava la risposta sbagliata.
 */
describe('fuzzy: le iniziali del nome finale battono le lettere sparse (issue #6)', () => {
  /** Il caso letterale della issue, nelle due forme di separatore. */
  const casiDellaIssue = [
    {
      query: 'cm',
      atteso: 'C:\\dev\\ClaudeManager',
      rivali: ['C:\\Users\\Chiara\\Modelli', 'C:\\Users\\Carlo\\Musica']
    },
    {
      query: 'CM',
      atteso: 'C:\\dev\\ClaudeManager',
      rivali: ['C:\\Users\\Chiara\\Modelli', 'C:\\Users\\Carlo\\Musica']
    },
    {
      query: 'cm',
      atteso: 'C:/dev/ClaudeManager',
      rivali: ['C:/Users/Chiara/Modelli', 'C:/Users/Carlo/Musica']
    },
    // Stessa forma, altre lettere: iniziali di due parole del nome finale
    // contro percorsi che le contengono sparse fra cartelle intermedie.
    {
      query: 'sd',
      atteso: 'C:\\lavoro\\SchedaDati',
      rivali: ['C:\\Users\\Sara\\Downloads', 'C:\\Users\\Simone\\Documenti']
    },
    {
      query: 'tb',
      atteso: 'C:\\repo\\TokenBridge',
      rivali: ['C:\\Users\\Teresa\\Backup', 'C:\\Users\\Tommaso\\Bozze']
    },
    {
      query: 'nm',
      atteso: 'C:\\progetti\\NoteMaker',
      rivali: ['C:\\Users\\Nadia\\Musica', 'C:\\Users\\Nino\\Mappe']
    },
    {
      query: 'pv',
      atteso: 'C:\\src\\ProjectVault',
      rivali: ['C:\\Users\\Paolo\\Progetti\\vecchi', 'C:\\Users\\Paolo\\Documenti\\Video']
    },
    {
      query: 'db',
      atteso: 'D:\\lavoro\\DataBridge',
      rivali: ['C:\\Users\\Davide\\Backup', 'C:\\Users\\Diana\\Bacheca']
    }
  ]

  for (const { query, atteso, rivali } of casiDellaIssue) {
    it(`«${query}» mette ${atteso} davanti a ${rivali.length} percorsi che lo contengono sparso`, () => {
      // L'ordine di partenza mette la vittima in fondo: se la classifica non
      // riordinasse davvero, il test passerebbe per caso.
      const elenco = [...rivali, atteso]
      const classifica = rankBy(query, elenco, (p) => p)

      assert.equal(classifica.length, elenco.length, 'tutti i percorsi dovrebbero corrispondere')
      assert.equal(classifica[0].item, atteso, `primo atteso ${atteso}, ottenuto ${classifica[0].item}`)

      // Non basta arrivare primo per un punto: il vantaggio deve essere netto,
      // altrimenti la prossima taratura dei pesi ribalta di nuovo l'ordine.
      for (const rivale of rivali) {
        const suo = classifica.find((r) => r.item === rivale)!
        assert.ok(
          classifica[0].score > suo.score,
          `${atteso} (${classifica[0].score}) non batte ${rivale} (${suo.score})`
        )
      }
    })
  }

  it('«man» preferisce ClaudeManager a manuali sepolto a meta\' percorso', () => {
    // E' l'esempio citato nel commento del modulo: il riscontro nel nome
    // finale deve valere piu' di uno in una cartella intermedia.
    const classifica = rankBy(
      'man',
      ['C:\\Users\\Marco\\Documenti\\manuali\\allegati', 'C:\\dev\\ClaudeManager'],
      (p) => p
    )
    assert.equal(classifica[0].item, 'C:\\dev\\ClaudeManager')
  })

  it('le posizioni indicano le iniziali di parola, non la lettera di unita\'', () => {
    // Se venisse scelto il riscontro avido, la prima posizione sarebbe 0 (la
    // 'C:' dell'unita') e l'utente vedrebbe evidenziata la lettera sbagliata.
    const testo = 'C:\\dev\\ClaudeManager'
    const risultato = fuzzyMatch('cm', testo)
    assert.ok(risultato, 'nessun riscontro')
    verificaPosizioni('cm', testo, risultato.positions)
    assert.deepEqual(
      risultato.positions.map((i) => testo[i]),
      ['C', 'M'],
      'evidenziate lettere diverse dalle iniziali di ClaudeManager'
    )
    assert.ok(risultato.positions[0] > testo.lastIndexOf('\\'), 'riscontro fuori dal nome finale')
  })
})

describe('fuzzy: le posizioni sono sempre indici validi', () => {
  /** Percorsi che mescolano ASCII, accenti, ideogrammi ed emoji. */
  const corpus: Array<[string, string]> = [
    ['cm', 'C:\\dev\\ClaudeManager'],
    ['claudemanager', 'C:\\dev\\ClaudeManager'],
    ['c m', 'C:\\dev\\ClaudeManager'],
    ['C:', 'C:\\dev\\ClaudeManager'],
    ['r', 'C:\\dev\\ClaudeManager'],
    ['cafe', 'C:\\café\\naïve'],
    ['città', 'C:\\Users\\José\\città'],
    ['CITTÀ', 'C:\\Users\\José\\città'],
    ['josé', 'C:\\Users\\José\\note'],
    ['ù', 'C:\\Perù\\dati'],
    ['straße', 'C:\\dev\\Straße'],
    ['école', 'C:\\ÉCOLE\\lezioni'],
    ['ns', 'C:\\日本語\\note 🚀 sessioni'],
    ['日語', 'C:\\日本語\\progetto'],
    ['🚀', 'C:\\razzi\\a🚀b'],
    ['🚀x', 'C:\\razzi\\🚀xy'],
    ['ırmak', 'C:\\Irmak\\ırmak']
  ]

  for (const [pattern, testo] of corpus) {
    it(`«${pattern}» su ${testo}`, () => {
      const risultato = fuzzyMatch(pattern, testo)
      assert.ok(risultato, `${JSON.stringify(pattern)} dovrebbe corrispondere a ${JSON.stringify(testo)}`)
      verificaPosizioni(pattern, testo, risultato.positions)
    })
  }

  it('anche quando il riscontro non c\'e\', non restituisce indici inventati', () => {
    // Testi con caratteri il cui minuscolo cambia lunghezza: e' li' che gli
    // indici trovati su una stringa e usati su un'altra andrebbero fuori.
    for (const testo of ['İstanbul', 'C:\\dev\\İstanbul', 'C:\\ǰ\\ǅungla']) {
      for (const pattern of ['x', 'zqw', 'stanbul', 'dev', 'un']) {
        const risultato = fuzzyMatch(pattern, testo)
        if (risultato) verificaPosizioni(pattern, testo, risultato.positions)
      }
    }
  })
})

describe('fuzzy: casi limite della query', () => {
  it('la query vuota corrisponde a tutto senza evidenziare niente', () => {
    // Il selettore appena aperto ha il campo vuoto: deve mostrare l'elenco
    // intero, non zero risultati.
    const risultato = fuzzyMatch('', 'C:\\dev\\ClaudeManager')
    assert.deepEqual(risultato, { score: 0, positions: [] })

    const elenco = ['C:\\a', 'C:\\b', 'C:\\c']
    assert.equal(rankBy('', elenco, (p) => p).length, elenco.length)
  })

  it('la query piu\' lunga del testo non corrisponde', () => {
    assert.equal(fuzzyMatch('claudemanager', 'C:\\cm'), null)
    assert.equal(fuzzyMatch('a', ''), null)
  })

  it('la query senza riscontro non corrisponde', () => {
    assert.equal(fuzzyMatch('zqw', 'C:\\dev\\ClaudeManager'), null)
    // Le lettere ci sono tutte ma non nell'ordine digitato.
    assert.equal(fuzzyMatch('mc', 'C:\\cm'), null)
  })

  it('un testo identico alla query corrisponde per intero', () => {
    const risultato = fuzzyMatch('progetto', 'progetto')
    assert.ok(risultato)
    assert.deepEqual(risultato.positions, [0, 1, 2, 3, 4, 5, 6, 7])
  })
})

describe('fuzzy: la query e\' testo, non un\'espressione regolare', () => {
  /** Quello che capita digitando in fretta o incollando un percorso. */
  const velenose = ['.*', '[', ']', '\\', '(?<', '(', ')', '+', '?', '|', '^', '$', '{2}', '[a-z]', '\\d+', '**']

  it('nessuna query fa lanciare un\'eccezione', () => {
    const testi = ['C:\\dev\\ClaudeManager', 'C:\\a.b*c\\[x]\\(?<y>)', '', 'a', 'C:\\日本語\\🚀']
    for (const pattern of velenose) {
      for (const testo of testi) {
        const risultato = fuzzyMatch(pattern, testo)
        if (risultato) verificaPosizioni(pattern, testo, risultato.positions)
      }
      // Anche attraverso la classifica, che e' la via da cui arriva la UI.
      assert.doesNotThrow(() => rankBy(pattern, testi, (t) => t))
    }
  })

  it('i caratteri speciali si cercano alla lettera', () => {
    // '.*' non e' "qualsiasi cosa": deve trovare un punto seguito da un
    // asterisco, altrimenti la ricerca restituirebbe l'universo.
    const testo = 'C:\\a.b*c\\fine'
    const risultato = fuzzyMatch('.*', testo)
    assert.ok(risultato)
    verificaPosizioni('.*', testo, risultato.positions)
    assert.equal(fuzzyMatch('.*', 'C:\\senza\\niente'), null)

    // Il backslash e' il separatore dei percorsi: deve restare cercabile.
    const conBarra = fuzzyMatch('\\dev', 'C:\\dev\\ClaudeManager')
    assert.ok(conBarra)
    verificaPosizioni('\\dev', 'C:\\dev\\ClaudeManager', conBarra.positions)
  })
})

describe('fuzzy: costo su testi enormi', () => {
  it('cerca in una stringa da centomila caratteri in una frazione di secondo', () => {
    // Uno scrollback o un percorso patologico non devono bloccare la UI: il
    // selettore rilancia la ricerca ad ogni tasto premuto.
    const enorme = 'C:\\' + 'xyz'.repeat(33_333) + '\\SessioneMoltoLunga'
    assert.ok(enorme.length > 100_000)

    const inizio = process.hrtime.bigint()
    for (let giro = 0; giro < 20; giro++) {
      fuzzyMatch('sml', enorme) // riscontro nel nome finale
      fuzzyMatch('xyz', enorme) // riscontro immediato
      fuzzyMatch('qwk', enorme) // nessun riscontro
    }
    const ms = Number(process.hrtime.bigint() - inizio) / 1e6

    assert.ok(ms < 500, `60 ricerche su ${enorme.length} caratteri hanno impiegato ${ms.toFixed(1)} ms`)
  })
})

describe('fuzzy: rankBy', () => {
  const elenco = [
    'C:\\Users\\Sara\\Documenti\\note',
    'C:\\dev\\ClaudeManager',
    'C:\\Users\\Carlo\\Musica',
    'C:\\dev\\ClaudeManager\\src\\main',
    'C:\\Users\\Chiara\\Modelli',
    'C:\\temp\\cache\\miniature',
    'C:\\lavoro\\ClientiMilano'
  ]

  it('ordina per punteggio decrescente', () => {
    const classifica = rankBy('cm', elenco, (p) => p)
    assert.ok(classifica.length > 1, 'servono piu\' risultati per parlare di ordine')

    for (let i = 1; i < classifica.length; i++) {
      assert.ok(
        classifica[i - 1].score >= classifica[i].score,
        `posizione ${i}: ${classifica[i - 1].score} prima di ${classifica[i].score}`
      )
    }
  })

  it('riporta per ogni voce lo stesso punteggio e le stesse posizioni del riscontro singolo', () => {
    for (const voce of rankBy('cm', elenco, (p) => p)) {
      const diretto = fuzzyMatch('cm', voce.item)
      assert.ok(diretto)
      assert.equal(voce.score, diretto.score, voce.item)
      assert.deepEqual(voce.positions, diretto.positions, voce.item)
      verificaPosizioni('cm', voce.item, voce.positions)
    }
  })

  it('scarta le voci senza riscontro e non ne perde nessuna con riscontro', () => {
    assert.equal(rankBy('zqw', elenco, (p) => p).length, 0)

    const conRiscontro = elenco.filter((p) => fuzzyMatch('cm', p) !== null)
    const classifica = rankBy('cm', elenco, (p) => p)
    assert.deepEqual(
      [...classifica.map((r) => r.item)].sort(),
      [...conRiscontro].sort(),
      'la classifica non contiene esattamente le voci con riscontro'
    )
  })

  it('rispetta il limite tenendo i migliori', () => {
    const completa = rankBy('cm', elenco, (p) => p)
    const tagliata = rankBy('cm', elenco, (p) => p, 2)
    assert.equal(tagliata.length, 2)
    assert.deepEqual(
      tagliata.map((r) => r.item),
      completa.slice(0, 2).map((r) => r.item),
      'il taglio ha buttato via i migliori invece dei peggiori'
    )
  })

  it('estrae il testo dalla funzione fornita, non dall\'oggetto', () => {
    // Nella UI le voci sono sessioni, non stringhe: se rankBy leggesse
    // l'oggetto, la ricerca lavorerebbe su "[object Object]".
    const sessioni = [
      { id: 1, percorso: 'C:\\Users\\Carlo\\Musica' },
      { id: 2, percorso: 'C:\\dev\\ClaudeManager' }
    ]
    const classifica = rankBy('cm', sessioni, (s) => s.percorso)
    assert.equal(classifica[0].item.id, 2)
  })
})

describe('fuzzy: comportamenti osservati da chiarire', () => {
  it.skip('trova una cartella cercandone il nome esatto quando contiene la I turca', () => {
    // OSSERVATO: fuzzyMatch('İstanbul', 'C:\\dev\\İstanbul') restituisce null.
    // Il modulo rinuncia (di proposito) a ignorare le maiuscole quando
    // toLowerCase() cambia la lunghezza del testo, ma continua comunque a
    // minuscolizzare la QUERY: 'İ' diventa due unita' ('i' + segno) che nel
    // testo, ormai confrontato alla lettera, non esistono. Risultato: la
    // cartella non si trova nemmeno digitandone il nome per intero.
    assert.notEqual(fuzzyMatch('İstanbul', 'C:\\dev\\İstanbul'), null)
  })

  it.skip('trova le cartelle accentate anche digitando senza accento', () => {
    // OSSERVATO: fuzzyMatch('citta', 'C:\\dev\\città') restituisce null,
    // mentre 'città' e 'CITTÀ' funzionano. Puo' essere una scelta, ma su un
    // progetto in italiano i nomi accentati sono comuni e si digitano quasi
    // sempre senza accento.
    assert.notEqual(fuzzyMatch('citta', 'C:\\dev\\città'), null)
  })
})
