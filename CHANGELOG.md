# Changelog

Le versioni seguono [SemVer](https://semver.org/lang/it/): il primo numero
cambia quando qualcosa smette di funzionare come prima, il secondo quando
arrivano funzioni nuove, il terzo per le correzioni.

<!-- nuove versioni qui sotto -->

## 1.1.1 — 2026-08-05

Solo correzioni: ventiquattro difetti, quindici trovati da una campagna di test
sistematica e nove dalla suite scritta subito dopo. Niente di nuovo da imparare.

- **Le virgolette nel prompt iniziale non vengono più mangiate.** Gli argomenti
  per `claude` passavano attraverso PowerShell, che ogni `"` lo perdeva per
  strada: un prompt iniziale veniva troncato al primo apice, e un riquadro
  remoto con virgolette nel percorso non si apriva affatto. Ora arrivano al
  processo figlio esattamente come sono stati scritti.
- **Statistiche allineate al tuo giorno.** «Oggi» e «ultimi sette giorni»
  tagliavano a mezzanotte UTC: fino alle due del mattino il lavoro di ieri
  risultava di oggi.
- **Il riempimento del contesto non dice più «circa».** Gli identificativi di
  modello con la data in coda non venivano riconosciuti, e la percentuale
  restava perennemente approssimata.
- **Notifiche più affidabili.** Se una sessione spariva per un giro dal registro
  di Claude Code, il suo passaggio ad «attende input» non veniva annunciato.
- **File di configurazione modificati a mano.** Salvarne uno con il Blocco note
  ci mette in testa un BOM, e la lettura falliva: tutte le impostazioni
  tornavano ai valori predefiniti, in silenzio. Un `folders.json` corrotto
  rendeva il selettore di cartelle inutilizzabile per sempre invece che per un
  avvio. I valori di tipo sbagliato ora si scartano uno a uno, e non fanno più
  fallire il pannello Impostazioni.
- **Ricerca cartelle.** Cercando «cm», ClaudeManager finiva dietro Musica e
  Modelli: ora il nome della cartella pesa più del percorso che la contiene.
- **Scorciatoie.** Assegnare `+` o la barra spaziatrice cancellava la
  combinazione vecchia senza crearne una nuova; le azioni `Alt+1`…`Alt+9` non
  comparivano nell'elenco, quindi non c'era modo di rimapparle.
- **Riquadri.** Dall'ottava divisione consecutiva il nuovo riquadro nasceva
  largo zero pixel: ora la divisione si rifiuta quando lo spazio non basta. E un
  `layout.json` con valori impossibili non fa più sparire dallo schermo i due
  riquadri di una divisione.
- **Cassetto di monitoraggio.** Chiudendo la finestra staccata, la linguetta
  restava convinta che fosse ancora fuori.
- **Temi.** Nel tema «Alto contrasto» il nero ANSI coincideva con lo sfondo del
  terminale: cornici, barre di avanzamento e diff sparivano del tutto, proprio
  nel tema che promette la massima leggibilità. Un tema con un colore mancante,
  o con `dark` di tipo sbagliato, ora viene rifiutato invece di applicarsi a
  metà.
- **Sessioni.** Le etichette nell'elenco di ripresa mostravano il markup grezzo
  dei comandi slash; una porta SSH con i decimali veniva accettata e salvata, e
  poi rifiutata da ssh; un nome con un'emoji al sessantaquattresimo carattere
  veniva spezzato a metà.

Sotto il cofano: 376 test automatici che girano a ogni modifica, su Windows,
perché una parte verifica proprio come arrivano gli argomenti a un eseguibile
nativo — dove il difetto più grave si nascondeva.

## 1.1.0 — 2026-08-02

- **Avvisi quando una sessione ti aspetta.** Con più riquadri aperti non si
  possono guardare tutti: quando uno passa ad attendere una risposta arriva una
  notifica di sistema e l'icona nella barra delle applicazioni lampeggia. Il
  clic porta a quel riquadro, col fuoco già nel terminale. Si avvisa sul
  *passaggio*, non finché ci resta, e mai mentre stai guardando l'app.
- **Cassetto di monitoraggio.** Una linguetta sul bordo destro apre un pannello
  con costo e token del giorno e, per ogni sessione, **quanto è pieno il
  contesto**. Si stacca in una finestra a sé, sempre in primo piano e
  spostabile su un altro monitor.
- **Scorciatoie rimappabili.** Si preme la riga nelle impostazioni e poi la
  combinazione voluta. Le personalizzazioni si sovrappongono alle predefinite,
  e assegnando la stringa vuota si libera una combinazione senza rimpiazzarla —
  per restituire `Alt+B` a readline, ad esempio.
- **Ricerca nel terminale.** `Alt+S` cerca nello scrollback del riquadro
  attivo, con evidenziazione delle occorrenze e spostamento avanti e indietro.

## 1.0.1 — 2026-08-02

- Anche la copia portabile controlla se è uscita una versione nuova e lo dice,
  con il collegamento per scaricarla. Non può sostituirsi da sola, ma non
  saperlo nemmeno non serviva a nessuno.

## 1.0.0 — 2026-08-02

Prima versione pubblica.

### Il desktop

- Una sola finestra a schermo intero fa da compositor: i riquadri delle
  sessioni si dividono lo spazio in mosaico, e quello attivo può essere
  staccato come finestra flottante, spostato e ridimensionato.
- Riordino col mouse: l'intestazione di ogni riquadro è una maniglia, e
  rilasciando vicino a un bordo ci si affianca, al centro ci si scambia.
  Un'anteprima mostra dove finirà prima di mollare, ed `Esc` annulla a metà.
- Scorciatoie con `Alt`, su una lista chiusa: tutto il resto arriva intatto al
  terminale e quindi a Claude.
- Animazioni sui cambi di layout, con `prefers-reduced-motion` rispettato.

### Le sessioni

- Ogni riquadro apre PowerShell nella cartella scelta e vi avvia `claude`.
  Uscendo da Claude si resta nella shell, nella stessa cartella.
- Selettore di cartella con ricerca fuzzy, esplora-cartelle e campo per
  incollare un percorso, con badge per ramo git, presenza di `CLAUDE.md`,
  sessioni già esistenti e stato di fiducia.
- Ripresa delle conversazioni passate di una cartella, elencate con la loro
  etichetta, con l'opzione di duplicarle invece di continuarle.
- Stato in tempo reale letto dal registro che Claude Code mantiene in
  `~/.claude/sessions/`, senza interpretare l'output del terminale.
- Opzioni di lancio per riquadro: modello, impegno, modalità permessi e prompt
  iniziale.

### Sessioni remote

- Un riquadro può aprire Claude Code su un server via SSH: connessioni
  salvate, esplorazione delle cartelle remote con gli stessi badge del locale,
  e ripresa delle conversazioni già presenti là.
- Nessuna password viene chiesta o memorizzata: vale l'autenticazione che ssh
  sa già fare da sola.

### Il resto

- Statistiche di utilizzo: token e costo di listino per giorno, modello e
  cartella, ricavati dai transcript.
- Ripristino del layout alla riapertura, con le conversazioni riprese dove
  erano rimaste.
- Sei temi integrati più i tuoi, come file JSON in
  `%APPDATA%\claudemanager\themes\`. Ogni tema definisce interfaccia e i 16
  colori ANSI del terminale insieme.
- Indice del selettore da quattro sorgenti componibili, inclusa la scansione
  completa delle unità.
- Aggiornamenti automatici dalle release di GitHub: si scaricano da soli e si
  installano alla chiusura dell'app, mai a sorpresa mentre si lavora.
