#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prepara una release: alza la versione, scrive il changelog dai commit,
 * costruisce i pacchetti e crea il tag.
 *
 *   npm run release -- patch|minor|major|<versione>
 *   npm run release -- minor --dry      solo mostrare cosa farebbe
 *
 * La pubblicazione su GitHub avviene solo con GH_TOKEN nell'ambiente, e la
 * release nasce come BOZZA: va riletta e pubblicata a mano. Un aggiornamento
 * automatico arriva su tutte le installazioni, quindi il momento in cui
 * diventa visibile deve essere una decisione, non un effetto collaterale
 * dell'aver lanciato uno script.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry')
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch'

function git(...params) {
  return execFileSync('git', params, { cwd: root, encoding: 'utf8' }).trim()
}

/**
 * Esegue un comando mostrandolo.
 *
 * `shell` serve solo per npm e npx, che su Windows sono file .cmd e non si
 * possono avviare direttamente. Va acceso il meno possibile: con la shell di
 * mezzo gli argomenti vengono concatenati invece che passati uno per uno, e un
 * messaggio di commit con dentro un apice basterebbe a rompere il comando.
 */
function run(command, params, needsShell = false) {
  console.log(`  $ ${command} ${params.join(' ')}`)
  if (dryRun) return
  execFileSync(command, params, { cwd: root, stdio: 'inherit', shell: needsShell })
}

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  const [major, minor, patch] = current.split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`Incremento non riconosciuto: ${kind}`)
}

/**
 * Righe di changelog dai commit dopo l'ultimo tag.
 *
 * Si prende solo la prima riga di ogni commit: il corpo di questo progetto
 * contiene il ragionamento, che sta bene nella cronologia ma non in un elenco
 * di novità.
 */
function changesSinceLastTag() {
  let range = ''
  try {
    range = `${git('describe', '--tags', '--abbrev=0')}..HEAD`
  } catch {
    // Nessun tag ancora: si prende tutta la cronologia.
  }

  const log = git('log', '--no-merges', '--format=%s', ...(range ? [range] : []))
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
}

/** Sezione del changelog di una versione, per riusarla come note di release. */
function changelogEntryFor(version) {
  const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const righe = md.split('\n')
  const inizio = righe.findIndex((l) => l.startsWith(`## ${version} `))
  if (inizio === -1) return ''
  const resto = righe.slice(inizio + 1)
  const fine = resto.findIndex((l) => l.startsWith('## '))
  return [righe[inizio], ...(fine === -1 ? resto : resto.slice(0, fine))].join('\n').trim()
}

// Riordina soltanto, senza toccare versione né tag: serve dopo un
// `npm run dist` fatto a mano, o per rigenerare le istruzioni.
if (args.includes('--tidy')) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const esito = riordina(join(root, 'release', `v${version}`), version, changelogEntryFor(version))
  if (!esito) {
    console.error(`Nessuna cartella release/v${version}: prima costruisci i pacchetti.`)
    process.exit(1)
  }
  console.log(`release/v${version} — ${esito.coerenza}`)
  for (const f of esito.daPubblicare) console.log(`  ${f}`)
  console.log(`  (istruzioni: release/v${version}/DA-CARICARE.md)`)
  process.exit(0)
}

// --- Controlli preliminari ---------------------------------------------------

const status = git('status', '--porcelain')
if (status && !dryRun) {
  console.error('Ci sono modifiche non committate. Chiudile prima di fare una release:\n' + status)
  process.exit(1)
}

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const version = nextVersion(pkg.version, bump)
const tag = `v${version}`

const existing = git('tag', '--list', tag)
if (existing) {
  console.error(`Il tag ${tag} esiste già.`)
  process.exit(1)
}

console.log(`\n${pkg.version} → ${version}${dryRun ? '  (prova a vuoto)' : ''}\n`)

// --- Changelog ---------------------------------------------------------------

const changes = changesSinceLastTag()
if (changes.length === 0) {
  console.error('Nessun commit dopo l’ultimo tag: non c’è niente da rilasciare.')
  process.exit(1)
}

const today = new Date().toISOString().slice(0, 10)
const entry = `## ${version} — ${today}\n\n${changes.join('\n')}\n`

const changelogPath = join(root, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')
// La voce nuova va sotto l'intestazione, non in fondo: si legge dall'alto.
const marker = '<!-- nuove versioni qui sotto -->'
const updated = changelog.includes(marker)
  ? changelog.replace(`${marker}\n`, `${marker}\n\n${entry}`)
  : `${changelog}\n${entry}`

console.log(entry)

if (!dryRun) {
  pkg.version = version
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  writeFileSync(changelogPath, updated, 'utf8')
}

/**
 * Riordina la cartella della versione appena costruita.
 *
 * electron-builder mette nella stessa cartella i file da pubblicare e quelli
 * di lavorazione — `win-unpacked` da trecento megabyte, il registro di
 * diagnostica. Al momento di trascinare gli allegati su GitHub bisogna
 * riconoscere gli uni dagli altri leggendo i nomi, ed è esattamente lì che si
 * sbaglia file. Gli intermedi finiscono in una sottocartella, e accanto ai
 * quattro che restano si scrive l'elenco di cosa fare.
 */

/** Estensioni e nomi che vanno pubblicati; tutto il resto è lavorazione. */
function isPubblicabile(name) {
  return name.endsWith('.exe') || name.endsWith('.blockmap') || name === 'latest.yml'
}

function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function riordina(outDir, version, entry) {
  if (!existsSync(outDir)) return null

  const intermedi = join(outDir, 'intermedi')
  const daPubblicare = []

  for (const name of readdirSync(outDir)) {
    if (name === 'intermedi' || name === 'DA-CARICARE.md') continue
    if (isPubblicabile(name)) {
      daPubblicare.push(name)
      continue
    }
    mkdirSync(intermedi, { recursive: true })
    try {
      renameSync(join(outDir, name), join(intermedi, name))
    } catch {
      // Un file ancora in uso (l'eseguibile portabile in esecuzione) resta
      // dov'è: spostarlo non vale il rischio di rompere la build.
    }
  }

  daPubblicare.sort()

  // Il controllo che romperebbe gli aggiornamenti in silenzio: se lo sha512
  // dentro latest.yml non è quello dell'installer, electron-updater scarica e
  // scarta, senza dire perché.
  let coerenza = 'latest.yml assente'
  const latest = join(outDir, 'latest.yml')
  if (existsSync(latest)) {
    const atteso = (readFileSync(latest, 'utf8').match(/^sha512: (.+)$/m) ?? [])[1]?.trim()
    const installer = daPubblicare.find((f) => f.includes('Setup'))
    if (atteso && installer) {
      const vero = sha512Base64(join(outDir, installer))
      coerenza = atteso === vero ? 'sha512 coerente con l’installer' : '⚠ SHA512 NON COERENTE'
    }
  }

  const elenco = daPubblicare.map((f) => `- \`${f}\``).join('\n')
  writeFileSync(
    join(outDir, 'DA-CARICARE.md'),
    `# Release ${version}

Su https://github.com/Tha-Nixo/ClaudeCodeManager/releases/new

1. In *Choose a tag* scegli **\`v${version}\`** (esiste già, non crearne uno nuovo).
2. Titolo: \`ClaudeManager ${version}\`
3. Descrizione: il testo qui sotto.
4. Trascina questi file — sono tutti e soli quelli in questa cartella:

${elenco}

   \`latest.yml\` è indispensabile: senza, l'aggiornamento automatico non
   funziona. Il \`.blockmap\` fa scaricare solo le parti cambiate agli
   aggiornamenti futuri.

5. **Publish release.**

Controllo automatico: ${coerenza}

La sottocartella \`intermedi/\` non va caricata: è materiale di lavorazione.

---

${entry}`,
    'utf8'
  )

  return { outDir, daPubblicare, coerenza }
}

// --- Build e tag -------------------------------------------------------------

const publish = process.env.GH_TOKEN ? 'always' : 'never'
if (publish === 'never') {
  console.log('\nGH_TOKEN assente: i pacchetti vengono costruiti ma non caricati su GitHub.\n')
}

run('npm', ['run', 'typecheck'], true)
run('npx', ['electron-vite', 'build'], true)
run('npx', ['electron-builder', '--publish', publish], true)

// Deve combaciare con directories.output in electron-builder.yml.
const outDir = join(root, 'release', tag)
const riordinato = dryRun ? null : riordina(outDir, version, entry)

// git si avvia direttamente: niente shell, quindi niente virgolette a mano.
run('git', ['add', 'package.json', 'CHANGELOG.md'])
run('git', ['commit', '-m', tag])
run('git', ['tag', '-a', tag, '-m', tag])

if (riordinato) {
  console.log(`\nArtefatti in release/${tag}/ — ${riordinato.coerenza}`)
  for (const f of riordinato.daPubblicare) console.log(`  ${f}`)
  console.log(`  (istruzioni e testo della release: release/${tag}/DA-CARICARE.md)`)
}

console.log(`\nFatto. Restano da fare a mano:`)
console.log(`  git push && git push origin ${tag}`)
if (publish === 'always') {
  console.log('  pubblicare la bozza di release su GitHub (finché è bozza, nessuno la riceve)')
} else {
  console.log(`  caricare i file da release/${tag}/ sulla release di GitHub`)
}
