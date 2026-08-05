#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Esecutore dei test.
 *
 * I moduli del prodotto usano l'alias `@shared` e importano `electron`, che in
 * Node puro non esiste: nessuno dei due sopravvive a una semplice esecuzione
 * del sorgente. Ogni file di test viene quindi impacchettato con esbuild —
 * risolvendo l'alias e sostituendo `electron` con lo stub — e poi eseguito dal
 * runner incorporato di Node.
 *
 * Impacchettare ha anche un effetto utile: ogni file di test riceve la propria
 * copia dei moduli, quindi le cache di modulo (config, cartelle, connessioni)
 * ripartono pulite ad ogni file invece di sporcarsi a vicenda.
 *
 *   npm test                 tutti i file
 *   npm test -- fuzzy layout solo quelli il cui nome contiene fuzzy o layout
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'test')
const outDir = join(root, '.test-out')

const filtri = process.argv.slice(2).filter((a) => !a.startsWith('-'))

function raccogli(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...raccogli(full))
    else if (entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files = raccogli(testDir).filter(
  (f) => filtri.length === 0 || filtri.some((q) => f.toLowerCase().includes(q.toLowerCase()))
)

if (files.length === 0) {
  console.error(filtri.length ? `Nessun test corrisponde a: ${filtri.join(', ')}` : 'Nessun test.')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const risultato = await build({
  entryPoints: files,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // I test si chiamano *.test.ts e devono restare *.test.cjs, altrimenti il
  // runner di Node non li riconosce.
  outExtension: { '.js': '.cjs' },
  sourcemap: 'inline',
  logLevel: 'warning',
  metafile: true,
  alias: {
    '@shared': join(root, 'src/shared'),
    // Lo stub va risolto qui: e' l'unica ragione per cui i moduli del main
    // possono girare fuori da Electron.
    electron: join(root, 'test/helpers/electron.ts')
  }
})

// I file da eseguire si prendono dal metafile invece di ricostruirne il nome:
// esbuild sceglie la radice comune degli entry point, e indovinarla a mano si
// romperebbe alla prima sottocartella.
const compilati = Object.keys(risultato.metafile.outputs)
  .filter((p) => p.endsWith('.cjs'))
  .map((p) => join(root, p))

console.log(`${compilati.length} file di test:`)
for (const f of files) console.log(`  ${relative(root, f)}`)
console.log('')

const res = spawnSync(process.execPath, ['--test', ...compilati], { stdio: 'inherit', cwd: root })
process.exit(res.status ?? 1)
