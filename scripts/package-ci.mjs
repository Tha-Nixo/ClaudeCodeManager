#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draftAction, releasePlan } from './release-plan.mjs'
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

// Checked before anything touches GitHub. Elsewhere the installer step needs
// wine, and a run on a developer machine would reach the real draft first.
if (process.platform !== 'win32') {
  console.error('package-ci.mjs packages on Windows only: it is the release workflow\'s step.')
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// The repository the workflow runs in; the fallback is for a run by hand.
const repo = process.env.GITHUB_REPOSITORY || 'Tha-Nixo/ClaudeCodeManager'

let plan
let signing
let action
try {
  plan = releasePlan({
    version: pkg.version,
    ref: process.env.GITHUB_REF_NAME ?? '',
    changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  })
  signing = signingConfig(process.env)
  const releases = JSON.parse(
    execFileSync('gh', ['api', `repos/${repo}/releases?per_page=50`], { cwd: root, encoding: 'utf8' })
  )
  action = draftAction(releases, plan.tag)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

// The draft exists before electron-builder starts (see draftAction), with the
// title and notes of the earlier releases: "ClaudeManager <version>" and the
// changelog section. --verify-tag: never let GitHub make the tag up (#17).
const notesFile = join(root, 'release', 'notes.md')
mkdirSync(dirname(notesFile), { recursive: true })
writeFileSync(notesFile, `${plan.notes}\n`, 'utf8')
const draftArgs =
  action === 'create'
    ? ['release', 'create', plan.tag, '--draft', '--verify-tag']
    : ['release', 'edit', plan.tag]
draftArgs.push('--title', plan.title, '--notes-file', notesFile)
execFileSync('gh', ['-R', repo, ...draftArgs], { cwd: root, stdio: 'inherit' })

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

console.log(`\nDraft ${plan.tag} uploaded. Remaining steps, in this order:`)
console.log('  1. npm run release -- --verify     (checks the draft: tag, assets, latest.yml)')
console.log('  2. publish the draft on GitHub (no clients receive it while in draft)')
console.log('  3. npm run release -- --verify     (again, on the published release)')
