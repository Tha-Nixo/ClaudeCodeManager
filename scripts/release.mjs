#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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

function run(command, params) {
  console.log(`  $ ${command} ${params.join(' ')}`)
  if (dryRun) return
  execFileSync(command, params, { cwd: root, stdio: 'inherit', shell: true })
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
  ? changelog.replace(marker, `${marker}\n\n${entry}`)
  : `${changelog}\n${entry}`

console.log(entry)

if (!dryRun) {
  pkg.version = version
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  writeFileSync(changelogPath, updated, 'utf8')
}

// --- Build e tag -------------------------------------------------------------

const publish = process.env.GH_TOKEN ? 'always' : 'never'
if (publish === 'never') {
  console.log('\nGH_TOKEN assente: i pacchetti vengono costruiti ma non caricati su GitHub.\n')
}

run('npm', ['run', 'typecheck'])
run('npx', ['electron-vite', 'build'])
run('npx', ['electron-builder', '--publish', publish])

run('git', ['add', 'package.json', 'CHANGELOG.md'])
run('git', ['commit', '-m', `"${tag}"`])
run('git', ['tag', '-a', tag, '-m', `"${tag}"`])

console.log(`\nFatto. Restano da fare a mano:`)
console.log(`  git push && git push origin ${tag}`)
if (publish === 'always') {
  console.log('  pubblicare la bozza di release su GitHub (finché è bozza, nessuno la riceve)')
} else {
  console.log('  caricare i file da release/ sulla release di GitHub')
}
