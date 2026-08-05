/**
 * Composizione della riga di comando per l'eseguibile avviato in un riquadro.
 *
 * ## Il problema
 *
 * Per molto tempo gli argomenti venivano passati a PowerShell come JSON e
 * poi splattati (`& $exe @args`). Misurato: PowerShell 5.1 avvolge fra doppi
 * apici gli argomenti che contengono spazi, ma NON protegge i doppi apici
 * gia' presenti nel valore, e non raddoppia i backslash finali. Peggio, la
 * decisione di avvolgere dipende dalla parita' del numero di apici incontrati
 * prima dello spazio, quindi un valore con un numero dispari di apici non
 * viene avvolto affatto e si spezza:
 *
 *   inviato   'scrivi una funzione "ciao mondo"'
 *   ricevuto  ['scrivi una funzione ciao', 'mondo']
 *
 * Nessun errore: Claude riceveva un prompt troncato piu' un argomento
 * posizionale in piu'.
 *
 * ## La soluzione
 *
 * Non si lascia piu' costruire la riga di comando a PowerShell. La compone
 * questo modulo secondo le regole documentate del runtime C di Windows
 * (CommandLineToArgvW), e il bootstrap la passa a
 * `System.Diagnostics.ProcessStartInfo.Arguments`, che la consegna al
 * processo senza rielaborarla. Le regole sono tre:
 *
 * - un doppio apice letterale si scrive `\"`;
 * - i backslash che precedono un apice vanno raddoppiati;
 * - i backslash in fondo all'argomento vanno raddoppiati, perche' subito dopo
 *   arriva l'apice di chiusura.
 *
 * Verificato su un corpus di 35 casi ostili (apici annidati, apici isolati,
 * backslash finali, a capo, tabulazioni, unicode, stringa vuota, sequenze di
 * dieci apici): tutti e 35 arrivano identici al processo figlio.
 */

/** Rende un singolo argomento secondo le regole del runtime C di Windows. */
export function quoteNativeArg(value: string): string {
  // Senza spazi, apici o spazi bianchi non serve niente: avvolgere sempre
  // funzionerebbe comunque, ma lascia righe di comando illeggibili nei log.
  if (value !== '' && !/[\s"]/.test(value)) return value

  let out = '"'
  let backslashes = 0

  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1
      continue
    }
    if (ch === '"') {
      // I backslash accumulati precedono un apice: raddoppiati, piu' quello
      // che protegge l'apice stesso.
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }

  // In fondo segue l'apice di chiusura: senza raddoppio lo proteggerebbero
  // per sbaglio, e l'argomento si fonderebbe con il successivo.
  out += '\\'.repeat(backslashes * 2) + '"'
  return out
}

/**
 * Riga di comando completa per gli argomenti, senza l'eseguibile.
 *
 * .NET antepone da solo il FileName, quindi qui ci vanno solo gli argomenti.
 */
export function buildCommandLine(args: string[]): string {
  return args.map(quoteNativeArg).join(' ')
}
