import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildCommandLine, quoteNativeArg } from '../src/main/pty/winargs'

/**
 * Regressione della issue #1.
 *
 * PowerShell 5.1 costruiva male la riga di comando degli eseguibili nativi:
 * cancellava i doppi apici e spezzava l'argomento sullo spazio successivo, in
 * silenzio. Un prompt come `crea il file "README.md"` arrivava a Claude
 * troncato e con un argomento posizionale in piu'.
 */

/** Casi che hanno rotto qualcosa almeno una volta, piu' i loro vicini. */
const CORPUS = [
  'semplice',
  'con spazi normali',
  'crea il file "README.md"',
  'scrivi una funzione "ciao mondo"',
  'a"b',
  '"',
  '""',
  'fine"',
  '"inizio',
  "apostrofo l'altro",
  'backslash C:\\dir\\file',
  'C:\\dir\\',
  'C:\\mia cartella\\',
  'C:\\\\',
  'backslash poi apice C:\\dir\\"x"',
  '\\"gia protetto\\"',
  'punto e virgola; pipe | ampersand &&',
  'dollaro $HOME backtick `whoami`',
  'parentesi $(id) graffe ${x}',
  'unicode 日本語 emoji 🚀',
  'percentuale %PATH% caret ^',
  'newline\nin mezzo',
  'tab\tin mezzo',
  '   spazi ai bordi   ',
  '-inizia-con-trattino',
  '--sembra-un-flag',
  '',
  'a'.repeat(500),
  '"'.repeat(10),
  '\\'.repeat(10),
  'mix\\"\\"mix',
  '\\',
  ' '
]

describe('winargs: composizione della riga di comando', () => {
  it('lascia intatto un argomento senza caratteri speciali', () => {
    assert.equal(quoteNativeArg('semplice'), 'semplice')
    assert.equal(quoteNativeArg('--flag'), '--flag')
  })

  it('avvolge fra apici quando ci sono spazi', () => {
    assert.equal(quoteNativeArg('con spazi'), '"con spazi"')
  })

  it('protegge i doppi apici', () => {
    assert.equal(quoteNativeArg('dice "ciao"'), '"dice \\"ciao\\""')
  })

  it('raddoppia i backslash finali solo quando segue un apice di chiusura', () => {
    // Senza spazi non viene avvolto: il backslash finale non precede nulla.
    assert.equal(quoteNativeArg('C:\\dir\\'), 'C:\\dir\\')
    // Con spazi viene avvolto, e il backslash proteggerebbe l'apice.
    assert.equal(quoteNativeArg('C:\\mia dir\\'), '"C:\\mia dir\\\\"')
  })

  it('la stringa vuota diventa una coppia di apici', () => {
    assert.equal(quoteNativeArg(''), '""')
  })

  it('unisce gli argomenti con uno spazio', () => {
    assert.equal(buildCommandLine(['-n', 'due parole']), '-n "due parole"')
  })
})

/**
 * La prova che conta: la riga passa davvero per PowerShell e .NET, e il
 * processo figlio riceve esattamente quello che si voleva mandare.
 *
 * Solo su Windows: altrove non c'e' ne' PowerShell 5.1 ne' il runtime C con
 * queste regole, e il difetto non puo' presentarsi.
 */
describe('winargs: giro completo attraverso PowerShell e .NET', { skip: process.platform !== 'win32' }, () => {
  it('consegna ogni argomento identico al processo figlio', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-args-'))

    const echo = join(dir, 'echo.cjs')
    writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)))', 'utf8')

    const cmdline = join(dir, 'cmdline.txt')
    writeFileSync(cmdline, buildCommandLine([echo, ...CORPUS]), 'utf8')

    // Stesso percorso del bootstrap: la riga arriva da una variabile, e viene
    // consegnata a ProcessStartInfo senza che PowerShell la rielabori.
    const ps1 = join(dir, 'run.ps1')
    writeFileSync(
      ps1,
      [
        `$cmdline = [System.IO.File]::ReadAllText('${cmdline.replace(/\\/g, '\\\\')}')`,
        '$psi = New-Object System.Diagnostics.ProcessStartInfo',
        '$psi.FileName = "node"',
        '$psi.Arguments = $cmdline',
        '$psi.UseShellExecute = $false',
        '$psi.RedirectStandardOutput = $true',
        '$p = [System.Diagnostics.Process]::Start($psi)',
        '$out = $p.StandardOutput.ReadToEnd()',
        '$p.WaitForExit()',
        '[Console]::Out.Write($out)'
      ].join('\n'),
      'utf8'
    )

    const stdout = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { encoding: 'utf8', timeout: 60_000 }
    )

    const ricevuti = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as string[]

    assert.equal(
      ricevuti.length,
      CORPUS.length,
      `numero di argomenti diverso: attesi ${CORPUS.length}, ricevuti ${ricevuti.length}`
    )
    for (let i = 0; i < CORPUS.length; i++) {
      assert.equal(
        ricevuti[i],
        CORPUS[i],
        `argomento ${i} deformato: inviato ${JSON.stringify(CORPUS[i])}, ricevuto ${JSON.stringify(ricevuti[i])}`
      )
    }
  })
})
