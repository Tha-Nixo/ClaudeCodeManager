import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { contextWindowFor, costOf, priceFor } from '../src/main/usage/pricing'
import { scan, sessionUsage, summarize } from '../src/main/usage/scanner'

/**
 * Contabilita' dei token: prezzi, finestre di contesto e lettura dei transcript.
 *
 * `projectsDir()` passa per `CLAUDE_CONFIG_DIR`, quindi lo scanner si puo'
 * puntare su una radice temporanea e provare per intero, dal file JSONL fino
 * ai numeri che finiscono nel pannello. Nessun caso legge la cartella
 * ~/.claude reale di chi lancia i test.
 */

// --- Impalcatura ------------------------------------------------------------

/**
 * Radice finta di ~/.claude per un singolo caso.
 *
 * Ogni caso ha la propria cartella: la cache dello scanner e' indicizzata per
 * percorso assoluto e toglie i file che non esistono piu', quindi cambiando
 * radice il contributo del caso precedente sparisce da solo e l'ordine di
 * esecuzione non conta.
 */
function radiceFinta(): string {
  const home = mkdtempSync(join(tmpdir(), 'cm-usage-'))
  const progetto = join(home, 'projects', 'C--finto-progetto')
  mkdirSync(progetto, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = home
  return progetto
}

interface Uso {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}

/** Una riga di transcript nella forma che scrive Claude Code. */
function riga(opts: {
  id?: string
  model?: string
  type?: string
  cwd?: string
  at?: Date | number
  uso?: Uso
}): string {
  const u = opts.uso ?? {}
  const rec: Record<string, unknown> = {
    type: opts.type ?? 'assistant',
    cwd: opts.cwd ?? 'C:\\finto\\progetto',
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-opus-5',
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_read_input_tokens: u.cacheRead ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: u.cacheWrite5m ?? 0,
          ephemeral_1h_input_tokens: u.cacheWrite1h ?? 0
        }
      }
    }
  }
  if (opts.at !== undefined) rec.timestamp = new Date(opts.at).toISOString()
  return JSON.stringify(rec)
}

function scriviTranscript(dir: string, nome: string, righe: string[]): string {
  const file = join(dir, `${nome}.jsonl`)
  writeFileSync(file, `${righe.join('\n')}\n`, 'utf8')
  return file
}

/** Rilettura forzata: `scan()` da solo ha una frequenza minima di 2 secondi,
 *  e fra un caso e l'altro ne passano molti meno. */
function rileggi(): void {
  scan(true)
}

// --- Prezzi e finestra di contesto ------------------------------------------

describe('pricing: finestra di contesto (Regressione della issue #11)', () => {
  it('riconosce un id con suffisso di data senza marcarlo «circa»', () => {
    // Gli id scritti nei transcript hanno SEMPRE il suffisso di data: se solo
    // la corrispondenza esatta contasse, ogni riquadro mostrerebbe «circa»
    // accanto a una percentuale che invece e' esatta, e l'avvertenza
    // smetterebbe di significare qualcosa dove serve davvero.
    assert.deepEqual(contextWindowFor('claude-haiku-4-5-20251001'), {
      window: 200_000,
      approximate: false
    })
    assert.deepEqual(contextWindowFor('claude-sonnet-4-6-20260101'), {
      window: 1_000_000,
      approximate: false
    })
  })

  it('Opus 5 vale un milione di token, esatto', () => {
    assert.deepEqual(contextWindowFor('claude-opus-5'), { window: 1_000_000, approximate: false })
    assert.deepEqual(contextWindowFor('claude-opus-5-20260315'), {
      window: 1_000_000,
      approximate: false
    })
  })

  it('Haiku resta a 200.000 e non eredita il milione degli altri', () => {
    // E' l'unica famiglia con una finestra piu' piccola: sbagliarla farebbe
    // vedere il contesto pieno al 20% quando in realta' e' pieno al 100%.
    assert.equal(contextWindowFor('claude-haiku-4-5').window, 200_000)
  })

  it('un modello sconosciuto non fa inventare una percentuale', () => {
    // Meglio nessun indicatore che un denominatore a caso: la barra di
    // riempimento sarebbe credibile e falsa.
    assert.deepEqual(contextWindowFor('gpt-5-turbo'), { window: 0, approximate: false })
    assert.deepEqual(contextWindowFor(null), { window: 0, approximate: false })
    assert.deepEqual(contextWindowFor(undefined), { window: 0, approximate: false })
    assert.deepEqual(contextWindowFor(''), { window: 0, approximate: false })
  })

  it('«circa» resta per i modelli futuri riconosciuti solo dalla famiglia', () => {
    // Qui la deduzione c'e' davvero, quindi l'avvertenza e' dovuta: e' il caso
    // che distingue una finestra dedotta da una nota.
    assert.deepEqual(contextWindowFor('claude-haiku-9-0-20270101'), {
      window: 200_000,
      approximate: true
    })
    assert.equal(contextWindowFor('claude-opus-42').approximate, true)
  })

  it('maiuscole e minuscole non cambiano il risultato', () => {
    assert.deepEqual(contextWindowFor('CLAUDE-HAIKU-4-5-20251001'), {
      window: 200_000,
      approximate: false
    })
  })
})

describe('pricing: costo dei token', () => {
  const soloInput = (n: number): Parameters<typeof costOf>[1] => ({
    input: n,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0
  })

  it('applica la tariffa del modello, suffisso di data compreso', () => {
    // Un milione di input e un milione di output su Haiku: 1$ + 5$.
    const costo = costOf('claude-haiku-4-5-20251001', {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0
    })
    assert.equal(costo, 6)
  })

  it("la cache costa meno in lettura e piu' in scrittura", () => {
    // Sono i moltiplicatori che fanno la differenza fra una sessione lunga
    // «economica» e una «cara»: in una sessione di ore la cache e' la voce
    // dominante, non l'input.
    const base = costOf('claude-opus-5', soloInput(1_000_000))
    assert.equal(base, 5)
    assert.equal(
      costOf('claude-opus-5', {
        input: 0,
        output: 0,
        cacheRead: 1_000_000,
        cacheWrite5m: 0,
        cacheWrite1h: 0
      }),
      0.5
    )
    assert.equal(
      costOf('claude-opus-5', {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 0
      }),
      6.25
    )
    assert.equal(
      costOf('claude-opus-5', {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 1_000_000
      }),
      10
    )
  })

  it('un modello sconosciuto costa zero invece di un numero inventato', () => {
    assert.equal(costOf('gpt-5-turbo', soloInput(1_000_000)), 0)
    assert.equal(costOf(null, soloInput(1_000_000)), 0)
    assert.equal(priceFor('gpt-5-turbo'), null)
  })

  it('numeri enormi restano numeri: mai Infinity ne NaN', () => {
    // Un transcript corrotto puo' dichiarare cifre assurde. Se il calcolo
    // trabocca, il pannello scrive «$Infinity» o «$NaN» e tutti i totali
    // accanto diventano inservibili.
    const assurdo = {
      input: 1e15,
      output: 1e15,
      cacheRead: 1e15,
      cacheWrite5m: 1e15,
      cacheWrite1h: 1e15
    }
    const costo = costOf('claude-opus-5', assurdo)
    assert.ok(Number.isFinite(costo), `costo non finito: ${costo}`)
    assert.ok(costo > 0)
    // 46,75e15 token-dollari / 1e6 = 4,675e10.
    assert.ok(costo > 4.6e10 && costo < 4.8e10, `ordine di grandezza inatteso: ${costo}`)

    const doppio = costOf('claude-opus-5', {
      input: 2e15,
      output: 2e15,
      cacheRead: 2e15,
      cacheWrite5m: 2e15,
      cacheWrite1h: 2e15
    })
    assert.ok(Number.isFinite(doppio))
    assert.ok(doppio > costo)
  })
})

// --- Lettura dei transcript -------------------------------------------------

describe('scanner: cuore del parser', () => {
  it('conta UNA volta le righe che condividono message.id, con i valori ultimi', () => {
    // Claude Code scrive piu' record per la stessa risposta API e solo
    // l'ultimo porta i totali definitivi. Sommarli tutti gonfiava il costo di
    // ogni sessione lunga; tenere il primo lo sottostimava.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-dedup', [
      riga({ id: 'msg_A', uso: { output: 100 }, at: '2026-01-15T10:00:00.000Z' }),
      riga({ id: 'msg_A', uso: { output: 500 }, at: '2026-01-15T10:00:03.000Z' })
    ])

    rileggi()
    const totali = summarize()
    assert.equal(totali.totalTokens, 500)
    assert.equal(totali.sessions, 1)
    assert.equal(sessionUsage()['sessione-dedup'].turns, 1)
  })

  it('senza message.id i turni restano distinti invece di sovrascriversi', () => {
    // Non potendo deduplicare, l'errore da evitare e' l'opposto: due risposte
    // vere che si annullano a vicenda e spariscono dal conto.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-anonima', [
      riga({ uso: { output: 100 } }),
      riga({ uso: { output: 500 } })
    ])

    rileggi()
    assert.equal(summarize().totalTokens, 600)
    assert.equal(sessionUsage()['sessione-anonima'].turns, 2)
  })

  it('una riga malformata non fa perdere il resto del file', () => {
    // I transcript vengono letti mentre Claude Code li sta scrivendo: l'ultima
    // riga e' spesso troncata a meta'. Se una riga rotta facesse saltare il
    // file, la sessione attiva — quella che l'utente sta guardando — sarebbe
    // proprio quella senza numeri.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-rotta', [
      riga({ id: 'm1', uso: { output: 10 } }),
      '{"type":"assistant","message":{"id":"m2","usage":{"output_toke',
      'questa riga non e\' json, pero\' contiene "usage"',
      '{"type":"assistant","usage":{"output_tokens":9999}}',
      '{}',
      '',
      '   ',
      riga({ id: 'm3', uso: { output: 7 } })
    ])

    rileggi()
    const totali = summarize()
    assert.equal(totali.totalTokens, 17)
    assert.equal(totali.sessions, 1)
    assert.equal(sessionUsage()['sessione-rotta'].turns, 2)
  })

  it('conta solo i record assistant', () => {
    // Il record utente riporta l'usage della richiesta a cui risponde: contarlo
    // raddoppierebbe ogni turno.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-tipi', [
      riga({ id: 'u1', type: 'user', uso: { output: 9000 } }),
      riga({ id: 's1', type: 'summary', uso: { output: 9000 } }),
      riga({ id: 'a1', uso: { output: 42 } })
    ])

    rileggi()
    assert.equal(summarize().totalTokens, 42)
    assert.equal(sessionUsage()['sessione-tipi'].turns, 1)
  })

  it('scarta i turni a somma zero e i modelli non fatturabili', () => {
    // Claude Code emette record di servizio con usage tutto a zero e risposte
    // di modelli interni: contarli riempirebbe l'elenco delle sessioni di voci
    // che non corrispondono a niente che l'utente abbia fatto.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-vuota', [
      riga({ id: 'z1', uso: {} }),
      riga({ id: 'z2', model: '<synthetic>', uso: { output: 5000 } })
    ])

    rileggi()
    const totali = summarize()
    assert.equal(totali.totalTokens, 0)
    assert.equal(totali.sessions, 0, 'una sessione senza turni non va nel conto')
    assert.equal(sessionUsage()['sessione-vuota'].turns, 0)
  })

  it('senza la ripartizione 5m/1h la scrittura in cache va tutta sui 5 minuti', () => {
    // E' il formato piu' vecchio, ancora presente nei transcript archiviati:
    // attribuirla a 1 ora la farebbe costare il 60% in piu'.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-cache', [
      JSON.stringify({
        type: 'assistant',
        cwd: 'C:\\finto\\progetto',
        message: {
          id: 'c1',
          model: 'claude-opus-5',
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }
        }
      })
    ])

    rileggi()
    const totali = summarize()
    assert.equal(totali.totalTokens, 1_000_000)
    // 1M di scrittura 5 minuti su Opus 5: 5$ * 1.25 = 6,25$.
    assert.equal(totali.totalCost, 6.25)
  })

  it('aggrega per modello e per cartella', () => {
    // Sono le due tabelle del pannello: se la chiave sbagliasse, due sessioni
    // nella stessa cartella comparirebbero come due progetti diversi.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-uno', [
      riga({ id: 'a', cwd: 'C:\\lavoro\\alfa', uso: { output: 1000 } })
    ])
    scriviTranscript(progetto, 'sessione-due', [
      riga({ id: 'b', cwd: 'C:\\lavoro\\alfa', model: 'claude-haiku-4-5-20251001', uso: { output: 2000 } })
    ])

    rileggi()
    const totali = summarize()
    assert.equal(totali.sessions, 2)
    assert.equal(totali.byProject.length, 1)
    assert.equal(totali.byProject[0].path, 'C:\\lavoro\\alfa')
    assert.equal(totali.byProject[0].tokens, 3000)

    assert.equal(totali.byModel.length, 2)
    // Ordinati per costo: 1000 token Opus (0,025$) battono 2000 Haiku (0,01$).
    assert.equal(totali.byModel[0].model, 'claude-opus-5')
    assert.equal(totali.byModel[0].tokens, 1000)
    assert.equal(totali.byModel[1].tokens, 2000)
  })
})

describe('scanner: contesto della sessione', () => {
  it("lastContext e' l'ultimo turno, non il massimo ne' la somma", () => {
    // E' l'indicatore di quanto e' pieno il contesto ADESSO. Prendere il
    // massimo lo lascerebbe inchiodato in alto dopo un turno grosso; sommare i
    // turni lo manderebbe oltre il 100% in qualunque sessione lunga, perche'
    // ogni richiesta rimanda l'intera conversazione.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-contesto', [
      riga({ id: 't1', uso: { input: 100, cacheRead: 900, output: 50 } }),
      riga({ id: 't2', uso: { input: 200, cacheRead: 49_800, output: 60 } }),
      riga({ id: 't3', uso: { input: 50, cacheRead: 250, output: 70 } })
    ])

    rileggi()
    const sessione = sessionUsage()['sessione-contesto']
    assert.equal(sessione.contextTokens, 300)
    assert.notEqual(sessione.contextTokens, 50_000, 'non e\' il massimo')
    assert.notEqual(sessione.contextTokens, 51_300, 'non e\' la somma')
    // L'output non fa parte del contesto in ingresso del turno successivo.
    assert.equal(sessione.turns, 3)
    assert.equal(sessione.tokens, 51_480)
  })

  it('la finestra mostrata segue il modello dell\'ultimo turno (issue #11)', () => {
    // Il collegamento fra la tabella dei modelli e il riquadro: e' qui che
    // l'utente vedeva «circa» su una percentuale che era esatta.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-haiku', [
      riga({ id: 'h1', model: 'claude-opus-5', uso: { input: 1000 } }),
      riga({ id: 'h2', model: 'claude-haiku-4-5-20251001', uso: { input: 2000 } })
    ])

    rileggi()
    const sessione = sessionUsage()['sessione-haiku']
    assert.equal(sessione.model, 'claude-haiku-4-5-20251001')
    assert.equal(sessione.contextWindow, 200_000)
    assert.equal(sessione.contextApproximate, false)
  })

  it('un transcript cancellato sparisce dai totali', () => {
    // Claude Code fa pulizia periodica dei transcript vecchi. Continuare a
    // sommarli farebbe crescere per sempre un totale che non corrisponde a
    // nessun file esistente, quindi non verificabile.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-che-resta', [riga({ id: 'r1', uso: { output: 1000 } })])
    const daCancellare = scriviTranscript(progetto, 'sessione-che-sparisce', [
      riga({ id: 'x1', uso: { output: 2000 } })
    ])

    rileggi()
    assert.equal(summarize().totalTokens, 3000)
    assert.equal(summarize().sessions, 2)

    rmSync(daCancellare)
    rileggi()

    const dopo = summarize()
    assert.equal(dopo.totalTokens, 1000)
    assert.equal(dopo.sessions, 1)
    assert.equal(sessionUsage()['sessione-che-sparisce'], undefined)
    assert.ok(sessionUsage()['sessione-che-resta'])
  })

  it('legge anche i transcript dei sotto-agenti nelle sottocartelle', () => {
    const progetto = radiceFinta()
    const sotto = join(progetto, 'subagents')
    mkdirSync(sotto, { recursive: true })
    scriviTranscript(progetto, 'principale', [riga({ id: 'p1', uso: { output: 100 } })])
    scriviTranscript(sotto, 'agente', [riga({ id: 'a1', uso: { output: 400 } })])

    rileggi()
    assert.equal(summarize().totalTokens, 500)
    assert.equal(summarize().sessions, 2)
  })
})

// --- Giorno locale ----------------------------------------------------------

describe('scanner: giorno locale (Regressione della issue #3)', () => {
  it('un turno di oggi finisce in «oggi» anche quando in UTC e\' un altro giorno', () => {
    // Il giorno veniva ricavato da toISOString(), cioe' da Greenwich: in
    // Italia il lavoro fatto fra mezzanotte e le due finiva contato nel giorno
    // prima, e «Oggi» — il numero piu' in vista dell'app — non corrispondeva a
    // quello che l'utente aveva appena fatto.
    //
    // L'istante e' costruito a partire dal giorno locale corrente, non
    // dall'ora in cui il test viene lanciato: alle 03:00 come alle 23:00 il
    // caso e' lo stesso. L'ora scelta e' quella che, nel fuso in vigore,
    // ricade in un giorno UTC diverso: 00:30 a est di Greenwich, 23:30 a ovest.
    const adesso = new Date()
    const aEst = -adesso.getTimezoneOffset() > 0
    const istante = new Date(
      adesso.getFullYear(),
      adesso.getMonth(),
      adesso.getDate(),
      aEst ? 0 : 23,
      30
    )

    const chiaveLocale = [
      istante.getFullYear(),
      String(istante.getMonth() + 1).padStart(2, '0'),
      String(istante.getDate()).padStart(2, '0')
    ].join('-')

    if (adesso.getTimezoneOffset() !== 0) {
      assert.notEqual(
        istante.toISOString().slice(0, 10),
        chiaveLocale,
        'il caso deve cadere a cavallo della mezzanotte UTC, altrimenti non prova nulla'
      )
    }

    // Mezzogiorno locale, cosi' l'ora legale non sposta il giorno.
    const treGiorniFa = new Date(adesso.getFullYear(), adesso.getMonth(), adesso.getDate() - 3, 12)
    const dieciGiorniFa = new Date(
      adesso.getFullYear(),
      adesso.getMonth(),
      adesso.getDate() - 10,
      12
    )

    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-giorni', [
      riga({ id: 'g1', uso: { output: 1000 }, at: istante }),
      riga({ id: 'g2', uso: { output: 200 }, at: treGiorniFa }),
      riga({ id: 'g3', uso: { output: 30 }, at: dieciGiorniFa })
    ])

    rileggi()
    const totali = summarize()

    assert.equal(totali.todayTokens, 1000, 'il turno di stanotte deve stare in «oggi»')
    assert.equal(totali.weekTokens, 1200, 'sette giorni: oggi piu\' tre giorni fa')
    assert.equal(totali.totalTokens, 1230, 'il totale comprende anche dieci giorni fa')

    // I costi seguono gli stessi insiemi: 1000 token di output Opus 5 = 0,025$.
    assert.equal(totali.todayCost, 0.025)
    assert.ok(totali.weekCost > totali.todayCost)
    assert.ok(totali.totalCost > totali.weekCost)
  })

  it('un turno di ieri sera non viene tirato dentro «oggi»', () => {
    // Il rovescio del difetto: spostare la chiave al giorno locale non deve
    // far entrare in «oggi» quello che oggi non e'.
    //
    // Serve anche a coprire il caso precedente nelle ore in cui quello non
    // basta: con la chiave UTC, fra mezzanotte e le due di notte in Italia
    // anche «oggi» diventa il giorno UTC precedente e i due sbagli si
    // compensano. In quella finestra e' questo caso a fallire, perche' le
    // 23:30 di ieri locali sono il giorno UTC che il difetto chiama «oggi».
    const adesso = new Date()
    const ieriSera = new Date(
      adesso.getFullYear(),
      adesso.getMonth(),
      adesso.getDate() - 1,
      23,
      30
    )

    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-ieri', [
      riga({ id: 'i1', uso: { output: 500 }, at: ieriSera })
    ])

    rileggi()
    const totali = summarize()
    assert.equal(totali.todayTokens, 0)
    assert.equal(totali.todayCost, 0)
    assert.equal(totali.weekTokens, 500)
    assert.equal(totali.totalTokens, 500)
  })

  it('un turno senza timestamp resta nel totale ma non in «oggi»', () => {
    // Meglio perderlo dai riquadri a tempo che attribuirlo al giorno sbagliato:
    // il totale generale resta comunque verificabile.
    const progetto = radiceFinta()
    scriviTranscript(progetto, 'sessione-senza-data', [riga({ id: 'n1', uso: { output: 800 } })])

    rileggi()
    const totali = summarize()
    assert.equal(totali.totalTokens, 800)
    assert.equal(totali.todayTokens, 0)
    assert.equal(totali.weekTokens, 0)
    assert.equal(sessionUsage()['sessione-senza-data'].lastAt, 0)
  })
})
