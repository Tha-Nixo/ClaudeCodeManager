# ClaudeManager

Un desktop per le sessioni di Claude Code su Windows. Una sola finestra a
schermo intero fa da compositor: dentro ci stanno i riquadri delle sessioni,
affiancati in mosaico o staccati come finestre flottanti, ciascuno con il
proprio terminale e il proprio processo `claude`.

![icona](build/icon.png)

## Cosa fa

- **Mosaico e flottanti.** I riquadri si dividono lo spazio automaticamente;
  quello attivo può essere staccato, spostato e ridimensionato col mouse.
- **Riordino col mouse.** L'intestazione di ogni riquadro è una maniglia:
  trascinala su un altro riquadro e rilascia vicino a un bordo per affiancarti,
  al centro per scambiare i due. Un'anteprima mostra dove finirà prima che tu
  molli, ed `Esc` annulla a metà gesto. Trascinando un riquadro flottante su un
  bordo lo si riaggancia al mosaico.
- **Selettore di cartella.** `Alt+N` apre una ricerca fuzzy sui progetti, un
  esplora-cartelle e un campo per incollare un percorso, con badge per ramo
  git, presenza di `CLAUDE.md`, sessioni già esistenti e stato di fiducia.
- **Ripresa delle sessioni.** Le conversazioni passate di una cartella sono
  elencate con la loro etichetta e si riaprono con `--resume`.
- **Stato in tempo reale.** Il pallino di ogni riquadro dice se Claude sta
  lavorando o attende input, letto dal registro che Claude Code stesso
  mantiene in `~/.claude/sessions/`.
- **Statistiche di utilizzo.** Token e costo di listino per giorno, modello e
  cartella, ricavati dai transcript.
- **Ripristino del layout.** Alla riapertura torna lo stesso mosaico, con le
  conversazioni riprese dove erano rimaste.
- **Temi.** Sei temi integrati (Claude Dark e Light, Mezzanotte, Gruvbox, Nord,
  Alto contrasto) piu' i tuoi: basta lasciare un file JSON in
  `%APPDATA%\claudemanager\themes\`. Ogni tema definisce sia l'interfaccia sia
  i 16 colori ANSI del terminale, e si applica subito ai riquadri gia' aperti.
- **Sessioni remote via SSH.** Un riquadro puo' aprire Claude Code *sul tuo
  server*: si salvano le connessioni, si sfogliano le cartelle remote con gli
  stessi badge di quelle locali, e si riprendono le conversazioni gia' presenti
  la'. La cartella remota resta ricordata per la volta dopo.
- **Avvisi quando una sessione ti aspetta.** Con piu' riquadri aperti non si
  possono guardare tutti: quando uno passa ad attendere una risposta arriva una
  notifica di sistema e l'icona nella barra delle applicazioni lampeggia. Il
  clic porta direttamente a quel riquadro, col fuoco gia' nel terminale.
- **Cassetto di monitoraggio.** Una linguetta sul bordo destro apre un
  pannello con costo e token del giorno e, per ogni sessione, quanto e' pieno
  il contesto. Si puo' staccare in una finestra a se', sempre in primo piano e
  spostabile su un altro monitor.
- **Aggiornamenti.** Entrambe le versioni controllano se ne e' uscita una
  nuova. L'installer la scarica da solo e la applica alla chiusura dell'app,
  mai a sorpresa mentre si lavora; il portabile, che non puo' sostituirsi da
  solo, avvisa e basta e offre il collegamento per scaricarla.

## Scorciatoie

Il modificatore è `Alt`. Il compositor intercetta **solo** le combinazioni
elencate qui: tutto il resto arriva intatto al terminale e quindi a Claude.
Su tastiera italiana `AltGr` genera `Ctrl+Alt` insieme, che non è in mappa,
quindi `@`, `#`, `[`, `]`, `{`, `}` continuano a funzionare normalmente.

| Tasti | Azione |
| --- | --- |
| `Alt+N` | Nuova sessione: apre il selettore di cartella |
| `Alt+Invio` | Nuova sessione nella cartella del riquadro attivo |
| `Alt+B` / `Alt+V` | Nuova sessione affiancata / impilata |
| `Alt+W` | Chiude il riquadro attivo |
| `Alt+F` | Stacca o riaggancia il riquadro attivo |
| `Alt+Z` | Ingrandisce il riquadro attivo a tutto lo spazio |
| `Alt+←→↑↓` | Sposta il fuoco |
| `Alt+Shift+←→↑↓` | Sposta il riquadro nel mosaico |
| `Alt+1` … `Alt+9` | Va alla sessione N |
| `Alt+U` | Pannello statistiche |
| `Alt+,` | Impostazioni |
| `F11` | Schermo intero |
| `Ctrl+Shift+Q` | Esce |

Dentro il selettore: `↑↓` scorre, `Invio` apre, `Ctrl+Invio` entra nella
cartella, `Tab` gira fra i tre modi (Ricerca, Esplora, Remoto), `Ctrl+D`
aggiunge ai preferiti, `Esc` annulla.

## Sessioni remote

Nel selettore, il modo **Remoto** elenca i server salvati. Per aggiungerne uno
servono indirizzo, utente e, se non e' quella predefinita, la porta o la chiave
privata. Il pulsante **Prova la connessione** dice subito se si entra, quale
sistema c'e' dall'altra parte e che versione di Claude Code e' installata.

Scelto il server si sfogliano le sue cartelle, con gli stessi badge del locale
(repository git, presenza di `CLAUDE.md`), e sotto compaiono le conversazioni
gia' presenti **su quel server** per la cartella scelta: si riprendono come
quelle locali.

Il riquadro esegue `ssh -t` e avvia `claude` nella cartella remota. Alla
chiusura della sessione si torna alla shell locale, quindi si puo' riconnettere
senza aprire un altro riquadro.

**Autenticazione:** ClaudeManager non chiede né memorizza password. Vale quello
che ssh sa gia' fare da solo: chiavi in `~/.ssh` o un agent. Se il server non e'
ancora fra quelli conosciuti, aprilo una volta a mano con `ssh` per accettarne
la chiave.

**Cosa non funziona da remoto:** il pallino di stato e le statistiche dei token
leggono file locali, mentre una sessione remota li scrive sul server. Per questo
un riquadro remoto mostra `remota` invece di `pronta`/`al lavoro`: dire di
sapere cosa sta facendo Claude sarebbe inventare. La ripresa delle conversazioni
invece funziona, perche' interroga il server quando serve.

## Requisiti

- Windows 10/11 x64
- [Claude Code](https://claude.com/claude-code) installato e raggiungibile
  (`claude` nel PATH, oppure `~/.local/bin/claude.exe`)
- Per le sessioni remote: il client OpenSSH di Windows (Impostazioni → App →
  Funzionalita' facoltative) e Claude Code installato sul server

## Sviluppo

```powershell
npm install
npm run dev          # avvio con hot reload del renderer
npm run typecheck    # controllo dei tipi di main, preload e renderer
npm run build        # compila in out/
npm run dist         # genera installer NSIS ed eseguibile portabile in release/
```

### Rilasciare una versione

```powershell
npm run release -- minor --dry   # mostra cosa farebbe, senza toccare niente
npm run release -- minor         # alza la versione, scrive il changelog, compila, crea il tag
git push; git push origin v1.1.0
```

Con `GH_TOKEN` nell'ambiente lo script carica anche i pacchetti su GitHub, come
**bozza**: va riletta e pubblicata a mano. Finché è bozza nessuno la riceve, ed
è voluto — un aggiornamento automatico raggiunge tutte le installazioni, quindi
il momento in cui diventa visibile dev'essere una decisione e non l'effetto
collaterale di aver lanciato uno script.

Variabili d'ambiente utili durante lo sviluppo:

| Variabile | Effetto |
| --- | --- |
| `CM_WINDOWED=1` | Avvia in finestra invece che a schermo intero |
| `CM_DEV_BRIDGE=1` | Abilita il ponte di sviluppo (vedi sotto) |
| `CM_UPDATE_DEV=1` | Accende gli aggiornamenti in sviluppo, leggendo `dev-app-update.yml` |

`CM_UPDATE_DEV` esiste perché un canale di aggiornamento rotto non se ne accorge
nessuno finché non serve davvero. Con un `dev-app-update.yml` che punta a un
feed locale si può provare l'intero giro — confronto delle versioni,
scaricamento, verifica dello sha512 — senza pubblicare niente.

### Ponte di sviluppo

Con `CM_DEV_BRIDGE=1` l'app legge comandi da
`%APPDATA%\claudemanager\dev-bridge\in.jsonl` (un JSON per riga) e permette di
pilotarla e fotografarla dall'esterno usando le API di Electron, senza rubare
il fuoco al sistema operativo né catturare altro dello schermo. Serve per i
test end-to-end. È disattivato di default e comunque inerte nel pacchetto,
perché il controllo su `app.isPackaged` precede quello sulla variabile.

Comandi accettati: `{"type":"key","key":"b","modifiers":["alt"]}`,
`{"type":"text","text":"..."}`, `{"type":"click","x":0,"y":0}`,
`{"type":"shot","path":"..."}`, `{"type":"eval","js":"...","path":"..."}`.

## Come è fatto

```
src/
  main/          processo principale: possiede i PTY e ogni accesso al disco
    pty/         node-pty, script di bootstrap PowerShell, sanificazione env
    ssh/         costruzione del comando ssh, interrogazioni del server
    claude/      percorsi, argomenti CLI, transcript, registro sessioni vive
    indexer/     sorgenti dell'indice, punteggio fuzzy, scansione del disco
    usage/       contabilità dei token e tariffe
    store/       configurazione, layout, preferiti (scrittura atomica)
  preload/       unica superficie esposta al renderer, tramite contextBridge
  renderer/      compositor, selettore, pannelli
    compositor/  albero di layout, geometria, riquadri
```

Alcune scelte che non si deducono dal codice:

- **I riquadri hanno un id proprio, distinto da quello del PTY.** Il riquadro
  esiste (ed è misurabile) prima del processo, così il PTY nasce già con le
  dimensioni giuste; e spostare un riquadro nel mosaico non ne cambia la
  chiave React, quindi non ne distrugge il buffer.
- **Le sessioni si correlano per `sessionId`, mai per PID.** Su ConPTY
  `node-pty` riporta pid 0, e un PID può essere riusato.
- **L'ambiente passato al PTY viene ripulito.** Avviando ClaudeManager da
  dentro un terminale Claude Code, `CLAUDE_CODE_CHILD_SESSION` verrebbe
  ereditato e disattiverebbe il salvataggio dei transcript in ogni sessione
  figlia, togliendo le fondamenta a ripresa e statistiche.
- **Gli argomenti di `claude` passano per variabili d'ambiente**, non per la
  riga di comando: elimina i bug di quoting sui percorsi Windows.
- **Il menu predefinito di Electron è rimosso.** Portava `Ctrl+R`, che
  ricaricando il renderer avrebbe azzerato tutti i buffer dei terminali.
- **Durante le animazioni di layout la misurazione dei terminali è congelata.**
  Animare larghezza e altezza fa scattare il `ResizeObserver` di xterm a ogni
  frame: sarebbe una dozzina di `pty.resize` per transizione, con Claude Code
  che ridisegna ogni volta. Il contenuto resta fermo mentre la cornice si
  muove, e si rimisura una sola volta alla fine.
- **Le transizioni si accendono solo per i cambi di layout.** Ridimensionando
  la finestra o trascinando, i riquadri devono stare sotto il puntatore, non
  inseguirlo con un ritardo.
- **`prefers-reduced-motion` è rispettato:** chi ha chiesto meno movimento al
  sistema operativo ottiene solo i cambi di colore.
- **Un tema descrive interfaccia e terminale insieme.** Tenerli in due posti
  produrrebbe il caso, molto visibile, di una cornice chiara attorno a un
  terminale scuro. Un tema incompleto viene rifiutato con la ragione precisa
  invece di essere completato con valori di ripiego: mezzo tema applicato
  produce combinazioni illeggibili senza dire perche'.
- **Il tema si applica anche ai terminali gia' aperti.** xterm tiene una
  propria copia della tavolozza e non legge il CSS, quindi va aggiornata
  esplicitamente su ogni istanza viva; quelle nuove nascono gia' col tema
  corrente.
- **Il comando remoto usa solo apici singoli, e c'e' un controllo che lo
  impone.** Fra noi e la shell del server ci sono due livelli di quoting, e
  PowerShell 5.1 non sa consegnare un doppio apice a un eseguibile nativo: lo
  passa senza protezione e la riga di comando si spezza. Finché il comando
  remoto evita i doppi apici il problema non esiste, ma e' un invariante che
  una modifica distratta romperebbe in silenzio, con il sintomo (un errore di
  sintassi della shell remota) lontanissimo dalla causa. Per questo
  `remoteCommand` solleva un'eccezione invece di produrre un comando fragile.
- **Un riquadro remoto passa comunque per PowerShell**, che poi esegue `ssh`.
  Avviare `ssh` direttamente sarebbe piu' corto, ma alla caduta della
  connessione il riquadro si svuoterebbe; cosi' invece resta una shell locale
  nella stessa cartella, con scritto perche' la sessione e' finita.
- **Le interrogazioni del server sono script POSIX, senza `jq` né `python`.**
  L'unica cosa che si puo' dare per scontata su una macchina altrui e' una
  shell. Le etichette delle conversazioni remote si ricavano con `grep` sulla
  coda del transcript: e' approssimativo sulle sequenze di escape, ma non
  richiede di installare niente.
- **Ogni chiamata al server usa `BatchMode=yes`.** Senza, ssh si fermerebbe a
  chiedere una password che nessuno vedrebbe, e l'interfaccia resterebbe
  appesa; con, fallisce subito e l'errore viene tradotto in una frase che dice
  cosa fare.
- **Gli aggiornamenti si scaricano da soli ma non si installano da soli.**
  Installare vuol dire riavviare, e un riavvio a sorpresa ucciderebbe tutte le
  sessioni Claude aperte. L'installazione avviene alla chiusura dell'app,
  oppure quando la si chiede esplicitamente dalle impostazioni.
- **L'eseguibile portabile controlla ma non scarica.** Non può sostituirsi da
  solo — un `.exe` in esecuzione non si può rimpiazzare — e il file pubblicato
  per l'aggiornamento automatico è comunque l'installer, che trasformerebbe a
  sorpresa una copia portabile in una installata. Sapere che esiste una
  versione nuova però serve lo stesso, quindi il controllo si fa e il risultato
  si mostra, col collegamento da cui scaricarla. Lo si riconosce da
  `PORTABLE_EXECUTABLE_DIR`, che electron-builder valorizza solo in quel target.
- **Le note della release attraversano l'IPC come testo semplice.** GitHub le
  restituisce come HTML già reso: passarlo così com'è vorrebbe dire consegnare
  al renderer del markup di provenienza remota, e basterebbe che un giorno
  qualcuno lo mostrasse con `dangerouslySetInnerHTML` perché diventi
  un'iniezione. Vengono ridotte a testo nel main, prima del confine.
- **La sezione della versione sta in cima alle impostazioni**, perché la
  pastiglia della barra porta lì: in fondo, chi la preme troverebbe il pannello
  all'inizio e dovrebbe cercarsi da solo quello che ha appena chiesto.
- **Il riempimento del contesto si misura sommando `input_tokens`,
  `cache_read` e `cache_creation` dell'ultimo turno.** Il solo `input_tokens`
  è la parte *non* servita dalla cache, e in una sessione lunga è quasi zero:
  su una conversazione occupata al 68% valeva 2 token contro 683.052 di
  cache: un indicatore costruito su quel campo mostrerebbe sempre 0%.
- **Il cassetto restringe il palco invece di coprirlo**, con un margine e non
  con un padding: il compositor misura il riquadro di delimitazione, che il
  padding non riduce. La misurazione dei terminali resta congelata per la
  durata dell'animazione, come per i cambi di layout.
- **Il pannello staccato è lo stesso bundle con `#monitor` in coda.** Un
  secondo punto d'ingresso raddoppierebbe la build e obbligherebbe a duplicare
  il montaggio del tema; l'ancora non tocca il percorso del file, quindi
  funziona identica col server di sviluppo e con `file://`. La finestra
  applica il tema da sola: vive in un processo di rendering suo e non eredita
  niente dalla principale.
- **Si avvisa sul PASSAGGIO ad "attende input", non finché ci resta.** Il
  registro delle sessioni viene riscritto spesso, e notificare ad ogni
  riscrittura produrrebbe una raffica per una sola attesa. Il primo
  avvistamento non conta come passaggio: altrimenti all'avvio dell'app tutte
  le sessioni sarebbero "nuove" e arriverebbe una salva di avvisi per stati
  già noti.
- **Solo le sessioni che appartengono a un riquadro.** Il registro contiene
  ogni Claude Code vivo sulla macchina, comprese quelle aperte in un altro
  terminale: avvisare per quelle sarebbe intromettersi.
- **Una finestra ridotta a icona conta come non guardata**, anche se il
  sistema la considera ancora attiva: non mostra niente, quindi il pallino che
  cambia colore non lo vede nessuno.
- **Gli osservatori del pannello sono tenuti per identità, non contati.** Un
  contatore si sbilancia al primo caso storto — finestra chiusa senza
  disiscriversi, renderer ricaricato, crash — e lascia acceso per sempre un
  timer che rilegge i transcript ogni due secondi per nessuno.

## Limiti noti

- Se l'app termina in modo anomalo (crash, `Stop-Process -Force`) le shell dei
  riquadri possono sopravvivere: la pulizia avviene su `before-quit`, che in
  quel caso non viene eseguito. La chiusura normale non lascia processi.
- I costi mostrati sono tariffe API di listino. Con un abbonamento Max o Pro
  non sono spesa reale, ma quanto sarebbe costato lo stesso lavoro via API.
- Gli eseguibili non sono firmati: al primo avvio Windows mostra l'avviso
  SmartScreen.
- Le sessioni remote non hanno stato in tempo reale né conteggio dei token: il
  registro e i transcript da cui si ricavano stanno sul server.
- Alla prima sessione su una cartella remota, Claude Code chiede se ci si fida
  di quella cartella, esattamente come in locale. Va risposto dentro il
  riquadro.

## Licenza

MIT
