#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releasePlan } from './changelog.mjs'
import { signingConfig } from './signing.mjs'

/**
 * Packaging step of the release workflow (.github/workflows/release.yml).
 *
 * `npm run release` packages on the machine it runs on, which has to be
 * Windows: the installer embeds the Windows build of node-pty and the
 * executable's icon and version resources. The workflow does the same on a
 * GitHub Windows runner, from the pushed tag, so a release can be cut from any
 * machine. The packages go to a DRAFT release attached to that tag; making it
 * live stays a manual step, since an auto-update reaches every installed copy.
 *
 * Expects the app already built (`npm run build`) and, in the environment,
 * GITHUB_REF_NAME and GH_TOKEN, plus the CM_SIGN_* and AZURE_* secrets when
 * signing is configured (see signing.mjs).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let plan
let signing
try {
  plan = releasePlan({
    version: pkg.version,
    ref: process.env.GITHUB_REF_NAME ?? '',
    changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  })
  signing = signingConfig(process.env)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const builderArgs = ['electron-builder', '--win', '--publish', 'always']
if (signing) {
  const signingFile = join(root, 'release', 'signing.yml')
  mkdirSync(dirname(signingFile), { recursive: true })
  writeFileSync(signingFile, signing, 'utf8')
  builderArgs.push('--config', 'release/signing.yml')
  console.log(`Signing with Azure Trusted Signing as ${process.env.CM_SIGN_PUBLISHER}`)
} else {
  console.log('Unsigned build: no CM_SIGN_* secrets (see scripts/signing.mjs, #32)')
}

// npx is a .cmd wrapper on Windows: it only starts through a shell. The
// arguments are fixed words, so the shell has nothing to mangle.
execFileSync('npx', builderArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })

// Title and notes as on the earlier releases: "ClaudeManager <version>" and
// the changelog section. gh finds a draft by its tag too.
const notesFile = join(root, 'release', 'notes.md')
writeFileSync(notesFile, `${plan.notes}\n`, 'utf8')
execFileSync('gh', ['release', 'edit', plan.tag, '--title', plan.title, '--notes-file', notesFile], {
  cwd: root,
  stdio: 'inherit'
})

console.log(`\nDraft ${plan.tag} uploaded. Remaining steps, in this order:`)
console.log('  1. npm run release -- --verify     (checks the draft: tag, assets, latest.yml)')
console.log('  2. publish the draft on GitHub (no clients receive it while in draft)')
console.log('  3. npm run release -- --verify     (again, on the published release)')
