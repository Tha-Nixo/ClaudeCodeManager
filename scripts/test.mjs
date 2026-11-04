#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Test runner.
 *
 * Application modules use the `@shared` alias and import `electron`, which
 * does not exist in standalone Node: neither survives direct execution of raw
 * sources. Each test file is therefore bundled using esbuild — resolving the
 * alias and substituting `electron` with an in-memory stub — and then executed
 * by Node's built-in test runner.
 *
 * Bundling also guarantees test isolation: each test bundle gets fresh module
 * closures, ensuring module-level caches (config, folders, connections) start clean.
 *
 *   npm test                 run all test suites
 *   npm test -- fuzzy layout run only suites matching 'fuzzy' or 'layout'
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'test')
const outDir = join(root, '.test-out')

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'))

function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(full))
    else if (entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files = collect(testDir).filter(
  (f) => filters.length === 0 || filters.some((q) => f.toLowerCase().includes(q.toLowerCase()))
)

if (files.length === 0) {
  console.error(filters.length ? `No tests matched: ${filters.join(', ')}` : 'No tests found.')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const result = await build({
  entryPoints: files,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Test files must be named *.test.cjs for Node's runner to discover them.
  outExtension: { '.js': '.cjs' },
  sourcemap: 'inline',
  logLevel: 'warning',
  metafile: true,
  alias: {
    '@shared': join(root, 'src/shared'),
    // Stub resolution: allows main process modules to execute outside Electron.
    electron: join(root, 'test/helpers/electron.ts')
  }
})

// Compiled outputs are taken from the esbuild metafile rather than predicted,
// avoiding path-resolution divergence across subdirectories.
const compiled = Object.keys(result.metafile.outputs)
  .filter((p) => p.endsWith('.cjs'))
  .map((p) => join(root, p))

console.log(`${compiled.length} test files:`)
for (const f of files) console.log(`  ${relative(root, f)}`)
console.log('')

const res = spawnSync(process.execPath, ['--test', ...compiled], { stdio: 'inherit', cwd: root })
process.exit(res.status ?? 1)
