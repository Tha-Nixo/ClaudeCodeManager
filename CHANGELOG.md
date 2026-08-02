# Changelog

Le versioni seguono [SemVer](https://semver.org/lang/it/): il primo numero
cambia quando qualcosa smette di funzionare come prima, il secondo quando
arrivano funzioni nuove, il terzo per le correzioni.

<!-- nuove versioni qui sotto -->

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
