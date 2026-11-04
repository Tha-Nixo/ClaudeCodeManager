import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildCommandLine, quoteNativeArg } from '../src/main/pty/winargs'

/**
 * Regression test for issue #1.
 *
 * PowerShell 5.1 incorrectly formatted native executable command lines:
 * it stripped double quotes and split arguments on the following whitespace
 * silently. A prompt like `create file "README.md"` arrived at Claude
 * truncated with an unintended extra positional argument.
 */

/** Cases that caused breakage at least once, plus neighboring variations. */
const CORPUS = [
  'simple',
  'with standard spaces',
  'create file "README.md"',
  'write function "hello world"',
  'a"b',
  '"',
  '""',
  'end"',
  '"start',
  "apostrophe the'other",
  'backslash C:\\dir\\file',
  'C:\\dir\\',
  'C:\\my folder\\',
  'C:\\\\',
  'backslash then quote C:\\dir\\"x"',
  '\\"already escaped\\"',
  'semicolon; pipe | ampersand &&',
  'dollar $HOME backtick `whoami`',
  'parentheses $(id) braces ${x}',
  'unicode 日本語 emoji 🚀',
  'percent %PATH% caret ^',
  'newline\nin middle',
  'tab\tin middle',
  '   surrounding spaces   ',
  '-starts-with-hyphen',
  '--looks-like-flag',
  '',
  'a'.repeat(500),
  '"'.repeat(10),
  '\\'.repeat(10),
  'mix\\"\\"mix',
  '\\',
  ' '
]

describe('winargs: command line composition', () => {
  it('leaves an argument without special characters untouched', () => {
    assert.equal(quoteNativeArg('simple'), 'simple')
    assert.equal(quoteNativeArg('--flag'), '--flag')
  })

  it('wraps with quotes when spaces are present', () => {
    assert.equal(quoteNativeArg('with spaces'), '"with spaces"')
  })

  it('escapes double quotes', () => {
    assert.equal(quoteNativeArg('says "hello"'), '"says \\"hello\\""')
  })

  it('doubles trailing backslashes only when followed by a closing quote', () => {
    // Without spaces it is not wrapped: trailing backslash precedes nothing.
    assert.equal(quoteNativeArg('C:\\dir\\'), 'C:\\dir\\')
    // With spaces it is wrapped, so backslash would escape the quote if not doubled.
    assert.equal(quoteNativeArg('C:\\my dir\\'), '"C:\\my dir\\\\"')
  })

  it('empty string becomes a pair of quotes', () => {
    assert.equal(quoteNativeArg(''), '""')
  })

  it('joins arguments with a space', () => {
    assert.equal(buildCommandLine(['-n', 'two words']), '-n "two words"')
  })
})

/**
 * End-to-end check: line passes through PowerShell and .NET,
 * ensuring the child process receives the exact arguments intended.
 *
 * Windows only: PowerShell 5.1 and C runtime rules only exist on Windows.
 */
describe('winargs: roundtrip through PowerShell and .NET', { skip: process.platform !== 'win32' }, () => {
  it('delivers every argument identically to child process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-args-'))

    const echo = join(dir, 'echo.cjs')
    writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)))', 'utf8')

    const cmdline = join(dir, 'cmdline.txt')
    writeFileSync(cmdline, buildCommandLine([echo, ...CORPUS]), 'utf8')

    // Same path as bootstrap: string comes from a variable and is delivered
    // to ProcessStartInfo without PowerShell re-parsing it.
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

    const received = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as string[]

    assert.equal(
      received.length,
      CORPUS.length,
      `different argument count: expected ${CORPUS.length}, received ${received.length}`
    )
    for (let i = 0; i < CORPUS.length; i++) {
      assert.equal(
        received[i],
        CORPUS[i],
        `argument ${i} deformed: sent ${JSON.stringify(CORPUS[i])}, received ${JSON.stringify(received[i])}`
      )
    }
  })
})
