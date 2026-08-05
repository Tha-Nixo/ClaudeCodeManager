import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideNotices } from '../src/main/notify/notifier'
import type { LiveSession, MonitorPane } from '@shared/types'

/**
 * `decideNotices` e' il cuore di M11: decide se l'utente viene interrotto o no.
 *
 * Tutto quello che puo' andare storto sta qui — riconoscere il passaggio,
 * tacere al primo avvistamento, non insistere, non intromettersi nelle sessioni
 * altrui — mentre mostrare la notifica e' una riga sola. Se questa funzione
 * sbaglia, o l'avviso non arriva quando serve (e la funzione non esiste), o
 * arriva a raffica (e l'utente la spegne).
 */

/** Ricordo per sessione: stesso contenuto della memoria interna del notifier. */
interface Ricordo {
  status: string
  missing: number
}

function sessione(sessionId: string, status?: string): LiveSession {
  return { pid: 1000, sessionId, cwd: 'C:\\progetto', status }
}

function riquadro(claudeSessionId: string | null, label = 'riquadro'): MonitorPane {
  return {
    paneId: `pane-${claudeSessionId ?? 'vuoto'}`,
    index: 0,
    label,
    where: 'C:\\progetto',
    status: 'idle',
    remote: false,
    claudeSessionId
  }
}

/** Etichette dei riquadri avvisati: l'unica cosa che l'utente vede davvero. */
function avvisati(notices: { pane: MonitorPane }[]): string[] {
  return notices.map((n) => n.pane.label)
}

describe('notifier: memoria fra un giro e l\'altro — Regressione della issue #2', () => {
  it('avvisa al ritorno dopo un giro di assenza dal registro', () => {
    // Il registro viene RISCRITTO proprio quando lo stato cambia, quindi per un
    // giro la sessione puo' mancare. Dimenticandola subito, il ritorno con
    // 'waiting' sembrava un primo avvistamento e nessun avviso partiva: la
    // funzione falliva nel caso piu' probabile, cioe' sempre.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'busy')], panes, memoria)
    assert.deepEqual(avvisati(decideNotices([], panes, memoria)), [], 'un giro vuoto non avvisa')

    const dopo = decideNotices([sessione('s1', 'waiting')], panes, memoria)
    assert.deepEqual(avvisati(dopo), ['API'], 'il ritorno a waiting dopo un buco deve avvisare')
  })

  it('sopravvive anche a quattro giri di assenza consecutivi', () => {
    // Il margine non e' di un giro solo: piu' riscritture ravvicinate del
    // registro non devono bastare a perdere il filo.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'busy')], panes, memoria)
    for (let i = 0; i < 4; i++) decideNotices([], panes, memoria)

    assert.deepEqual(avvisati(decideNotices([sessione('s1', 'waiting')], panes, memoria)), ['API'])
  })

  it('dimentica davvero una sessione sparita per sempre', () => {
    // L'altra meta' della issue: se il ricordo non scadesse mai, la mappa
    // crescerebbe ad ogni sessione chiusa finche' l'app resta accesa.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'busy')], panes, memoria)
    assert.equal(memoria.size, 1)

    for (let i = 0; i < 20; i++) decideNotices([], panes, memoria)
    assert.equal(memoria.size, 0, 'la memoria di una sessione sparita deve liberarsi')
  })

  it('non accumula ricordi di sessioni che vanno e vengono', () => {
    // Trenta sessioni brevi, una alla volta: se ognuna lasciasse traccia, la
    // memoria crescerebbe senza limite in una giornata di lavoro normale.
    const memoria = new Map<string, Ricordo>()
    for (let i = 0; i < 30; i++) {
      decideNotices([sessione(`s${i}`, 'busy')], [], memoria)
      for (let giro = 0; giro < 5; giro++) decideNotices([], [], memoria)
    }
    assert.equal(memoria.size, 0)
  })

  it('l\'assenza si conta dall\'ultimo avvistamento, non dal primo', () => {
    // Una sessione lunga che sfarfalla piu' volte non deve essere dimenticata
    // sommando assenze lontane fra loro.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'busy')], panes, memoria)
    for (let ciclo = 0; ciclo < 3; ciclo++) {
      for (let i = 0; i < 4; i++) decideNotices([], panes, memoria)
      decideNotices([sessione('s1', 'busy')], panes, memoria)
    }

    for (let i = 0; i < 4; i++) decideNotices([], panes, memoria)
    assert.deepEqual(avvisati(decideNotices([sessione('s1', 'waiting')], panes, memoria)), ['API'])
  })
})

describe('notifier: quando avvisare', () => {
  it('avvisa sul passaggio diretto da busy ad attesa', () => {
    // Il caso base che giustifica l'intera funzione.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'busy')], panes, memoria)
    const notices = decideNotices([sessione('s1', 'waiting')], panes, memoria)

    assert.equal(notices.length, 1)
    assert.equal(notices[0].pane.label, 'API')
    assert.equal(notices[0].live.sessionId, 's1', 'l\'avviso deve portarsi dietro la sessione giusta')
  })

  it('non riavvisa finche\' la sessione resta in attesa', () => {
    // Il registro viene riscritto spesso: una raffica di notifiche per una sola
    // attesa e' il modo piu' rapido per far spegnere la funzione all'utente.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'busy')], panes, memoria)
    assert.equal(decideNotices([sessione('s1', 'waiting')], panes, memoria).length, 1)

    for (let i = 0; i < 5; i++) {
      assert.equal(
        decideNotices([sessione('s1', 'waiting')], panes, memoria).length,
        0,
        'restare in attesa non e\' un passaggio'
      )
    }
  })

  it('riavvisa se l\'attesa riprende dopo che la sessione e\' ripartita', () => {
    // Rispondere e poi essere richiamati e' un evento nuovo: qui l'avviso serve
    // di nuovo, altrimenti la seconda attesa passerebbe inosservata.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'busy')], panes, memoria)
    decideNotices([sessione('s1', 'waiting')], panes, memoria)
    decideNotices([sessione('s1', 'busy')], panes, memoria)

    assert.deepEqual(avvisati(decideNotices([sessione('s1', 'waiting')], panes, memoria)), ['API'])
  })

  it('tace al primo avvistamento, anche se la sessione attende gia\'', () => {
    // All'avvio dell'app tutte le sessioni vive sono "nuove": avvisare sul
    // primo giro produrrebbe una raffica per attese che l'utente conosce gia'.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API'), riquadro('s2', 'Web')]

    const notices = decideNotices(
      [sessione('s1', 'waiting'), sessione('s2', 'waiting')],
      panes,
      memoria
    )

    assert.deepEqual(avvisati(notices), [])
  })

  it('non avvisa per passaggi verso stati diversi dall\'attesa', () => {
    // Solo l'attesa richiede l'utente: idle o busy sono affari dell'app.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'waiting')], panes, memoria)
    assert.deepEqual(avvisati(decideNotices([sessione('s1', 'busy')], panes, memoria)), [])
    assert.deepEqual(avvisati(decideNotices([sessione('s1', 'idle')], panes, memoria)), [])
  })

  it('avvisa per ogni sessione che passa in attesa nello stesso giro', () => {
    // Tre riquadri che si fermano insieme sono tre cose da fare: perderne due
    // sarebbe peggio che non avvisare affatto.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API'), riquadro('s2', 'Web'), riquadro('s3', 'Docs')]
    const busy = [sessione('s1', 'busy'), sessione('s2', 'busy'), sessione('s3', 'busy')]

    decideNotices(busy, panes, memoria)
    const notices = decideNotices(
      [sessione('s1', 'waiting'), sessione('s2', 'waiting'), sessione('s3', 'waiting')],
      panes,
      memoria
    )

    assert.deepEqual(avvisati(notices).sort(), ['API', 'Docs', 'Web'])
  })

  it('avvisa solo chi e\' passato, non i vicini gia\' in attesa', () => {
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API'), riquadro('s2', 'Web')]

    decideNotices([sessione('s1', 'waiting'), sessione('s2', 'busy')], panes, memoria)
    const notices = decideNotices(
      [sessione('s1', 'waiting'), sessione('s2', 'waiting')],
      panes,
      memoria
    )

    assert.deepEqual(avvisati(notices), ['Web'])
  })
})

describe('notifier: sessioni che non ci riguardano', () => {
  it('non avvisa per una sessione che non appartiene a nessun riquadro', () => {
    // Il registro elenca ogni Claude Code vivo sulla macchina, comprese quelle
    // aperte in un altro terminale: interromperne l'utente sarebbe intromettersi
    // in un lavoro che l'app non mostra e non controlla.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'busy'), sessione('estranea', 'busy')], panes, memoria)
    const notices = decideNotices(
      [sessione('s1', 'busy'), sessione('estranea', 'waiting')],
      panes,
      memoria
    )

    assert.deepEqual(avvisati(notices), [])
  })

  it('non avvisa quando non c\'e\' nessun riquadro aperto', () => {
    const memoria = new Map<string, Ricordo>()

    decideNotices([sessione('s1', 'busy')], [], memoria)
    assert.deepEqual(avvisati(decideNotices([sessione('s1', 'waiting')], [], memoria)), [])
  })

  it('ignora i riquadri senza sessione agganciata', () => {
    // Un riquadro con `claudeSessionId` nullo e' un terminale senza Claude:
    // non deve agganciarsi alla prima sessione che passa.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro(null, 'Terminale')]

    decideNotices([sessione('s1', 'busy')], panes, memoria)
    assert.deepEqual(avvisati(decideNotices([sessione('s1', 'waiting')], panes, memoria)), [])
  })

  it('avvisa la sessione estranea appena entra in un riquadro', () => {
    // L'appartenenza si valuta ad ogni giro: agganciare un riquadro a una
    // sessione gia' vista non deve escluderla per sempre dagli avvisi.
    const memoria = new Map<string, Ricordo>()

    decideNotices([sessione('s1', 'busy')], [], memoria)
    const notices = decideNotices([sessione('s1', 'waiting')], [riquadro('s1', 'API')], memoria)

    assert.deepEqual(avvisati(notices), ['API'])
  })
})

describe('notifier: sessioni senza stato', () => {
  it('non avvisa per una sessione priva di status', () => {
    // Un registro incompleto o di una versione diversa non deve produrre
    // avvisi: uno stato sconosciuto non e' un'attesa.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1', 'busy')], panes, memoria)
    const notices = decideNotices([sessione('s1')], panes, memoria)

    assert.deepEqual(avvisati(notices), [])
  })

  it('avvisa quando una sessione senza status arriva ad attendere', () => {
    // Il passaggio conta anche partendo da uno stato sconosciuto, altrimenti
    // una sessione vista prima che il registro fosse completo resterebbe muta.
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1')], panes, memoria)
    assert.deepEqual(avvisati(decideNotices([sessione('s1', 'waiting')], panes, memoria)), ['API'])
  })

  it('due giri senza status non producono niente', () => {
    const memoria = new Map<string, Ricordo>()
    const panes = [riquadro('s1', 'API')]

    decideNotices([sessione('s1')], panes, memoria)
    assert.deepEqual(avvisati(decideNotices([sessione('s1')], panes, memoria)), [])
  })
})

describe('notifier: la memoria passata viene aggiornata', () => {
  it('scrive nella mappa ricevuta invece di tenersi uno stato suo', () => {
    // Il chiamante possiede la memoria: se la funzione non la aggiornasse, ogni
    // giro sarebbe un primo avvistamento e nessun avviso partirebbe mai.
    const memoria = new Map<string, Ricordo>()

    decideNotices([sessione('s1', 'busy'), sessione('s2')], [], memoria)

    assert.deepEqual([...memoria.keys()].sort(), ['s1', 's2'])
    assert.deepEqual(memoria.get('s1'), { status: 'busy', missing: 0 })
    assert.deepEqual(memoria.get('s2'), { status: 'unknown', missing: 0 })

    decideNotices([sessione('s1', 'waiting')], [], memoria)
    assert.deepEqual(memoria.get('s1'), { status: 'waiting', missing: 0 })
    assert.equal(memoria.get('s2')?.missing, 1, 'chi manca accumula assenze invece di sparire')
  })

  it('parte da zero con una mappa nuova, senza ricordi condivisi fra chiamate', () => {
    // Due mappe diverse sono due storie diverse: nessuno stato globale nascosto.
    const panes = [riquadro('s1', 'API')]
    const prima = new Map<string, Ricordo>()

    decideNotices([sessione('s1', 'busy')], panes, prima)
    assert.deepEqual(avvisati(decideNotices([sessione('s1', 'waiting')], panes, new Map())), [])
  })
})
