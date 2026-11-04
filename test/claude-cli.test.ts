import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildClaudeArgs, expectedClaudeSessionId } from '../src/main/claude/cli'
import { encodeProjectDir, normalizePath } from '../src/main/claude/paths'
import type { LaunchOptions } from '../src/shared/types'

/**
 * Launch options arrive from renderer (untrusted source):
 * any value surviving validation reaches the `claude` command line.
 * Weak validation would allow unintended flags to execute (e.g.
 * `--dangerously-skip-permissions`). These tests verify the contract:
 * only allowed values pass, everything else is discarded.
 */

const NEW_ID = '11111111-2222-4333-8444-555555555555'
const RESUMED_ID = '550e8400-e29b-41d4-a716-446655440000'
/** Temp directory: no tests depend on personal paths. */
const CWD = mkdtempSync(join(tmpdir(), 'cm-cli-'))

/** Default arguments produced without special options. */
const BASE = ['--session-id', NEW_ID]

function build(opts: Partial<LaunchOptions>): string[] {
  return buildClaudeArgs({ cwd: CWD, ...opts } as LaunchOptions, NEW_ID)
}

/** Value following a flag, or undefined if flag is not present. */
function valueOfFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

/**
 * Hostile or malformed values from compromised renderer, manual config,
 * or incompatible future layout files.
 */
const HOSTILE_VALUES: unknown[] = [
  // Injection attempts
  '--dangerously-skip-permissions',
  'opus --dangerously-skip-permissions',
  '--permission-mode bypassPermissions',
  '-p',
  // Shell command separators
  'opus; --dangerously-skip-permissions',
  'opus && whoami',
  'opus | tee /tmp/x',
  'opus`whoami`',
  'opus$(whoami)',
  // Spaces and newlines
  'opus sonnet',
  ' opus',
  'opus ',
  'opus\nhaiku',
  'opus\r\n--continue',
  'opus\thaiku',
  // Near-miss variations
  'OPUS',
  'Opus',
  'opus2',
  'op',
  'default ',
  // Object prototype keys
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  // Invalid types
  42,
  0,
  -1,
  true,
  false,
  null,
  undefined,
  {},
  { toString: () => 'opus' },
  [],
  ['opus'],
  ''
]

describe('buildClaudeArgs: allowed values become expected flags', () => {
  it('every model alias produces --model with that alias', () => {
    for (const model of ['fable', 'opus', 'sonnet', 'haiku'] as const) {
      const args = build({ model })
      assert.equal(valueOfFlag(args, '--model'), model, `model ${model}`)
    }
  })

  it('every effort level produces --effort with that level', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const args = build({ effort })
      assert.equal(valueOfFlag(args, '--effort'), effort, `effort ${effort}`)
    }
  })

  it('every permission mode produces --permission-mode with that mode', () => {
    const modes = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const
    for (const permissionMode of modes) {
      const args = build({ permissionMode })
      assert.equal(valueOfFlag(args, '--permission-mode'), permissionMode, `mode ${permissionMode}`)
    }
  })

  it("'default' means DO NOT pass flag, not passing the literal 'default'", () => {
    const args = build({ model: 'default', effort: 'default', permissionMode: 'default' })
    assert.deepEqual(args, BASE)
  })

  it('all three choices coexist in the same command line', () => {
    const args = build({ model: 'sonnet', effort: 'high', permissionMode: 'plan' })
    assert.deepEqual(args, [
      ...BASE,
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--permission-mode',
      'plan'
    ])
  })
})

describe('buildClaudeArgs: disallowed values are rejected, not passed', () => {
  const fields = ['model', 'effort', 'permissionMode'] as const

  for (const field of fields) {
    it(`${field}: no hostile value reaches command line`, () => {
      for (const val of HOSTILE_VALUES) {
        const args = build({ [field]: val } as unknown as Partial<LaunchOptions>)
        assert.deepEqual(
          args,
          BASE,
          `${field} = ${JSON.stringify(val)} left trace: ${JSON.stringify(args)}`
        )
      }
    })
  }

  it('no hostile combination triggers --dangerously-skip-permissions', () => {
    for (const val of HOSTILE_VALUES) {
      const args = build({
        model: val,
        effort: val,
        permissionMode: val,
        name: 'session',
        initialPrompt: 'hello'
      } as unknown as Partial<LaunchOptions>)
      assert.equal(
        args.some((a) => a.includes('dangerously')),
        false,
        `value ${JSON.stringify(val)} -> ${JSON.stringify(args)}`
      )
      assert.equal(args.includes('--model'), false)
      assert.equal(args.includes('--effort'), false)
      assert.equal(args.includes('--permission-mode'), false)
    }
  })

  it('rejected values never leave a flag without value or an empty argument', () => {
    for (const val of HOSTILE_VALUES) {
      const args = build({
        model: val as never,
        initialPrompt: 'arbitrary prompt'
      })
      assert.deepEqual(args, [...BASE, '--', 'arbitrary prompt'])
    }
  })
})

describe('buildClaudeArgs: resumeSessionId accepts only valid UUIDs', () => {
  it('accepts UUID in lowercase and uppercase', () => {
    for (const id of [RESUMED_ID, RESUMED_ID.toUpperCase()]) {
      const args = build({ resumeSessionId: id })
      assert.deepEqual(args, ['--resume', id])
    }
  })

  const NON_UUID: unknown[] = [
    '',
    '   ',
    'not-a-uuid',
    'latest',
    RESUMED_ID.slice(0, -1),
    RESUMED_ID + '0',
    RESUMED_ID.replace(/-/g, ''),
    `{${RESUMED_ID}}`,
    ` ${RESUMED_ID}`,
    `${RESUMED_ID} `,
    `${RESUMED_ID}\n`,
    `${RESUMED_ID}\r\n`,
    `${RESUMED_ID} --dangerously-skip-permissions`,
    `${RESUMED_ID};whoami`,
    '550e8400-e29b-41d4-a716-44665544000g',
    '../../../etc/passwd',
    '..\\..\\other',
    '--continue',
    '__proto__',
    12345,
    true,
    {},
    []
  ]

  it('rejects everything else and falls back to new session', () => {
    for (const id of NON_UUID) {
      const args = build({ resumeSessionId: id as never })
      assert.deepEqual(
        args,
        BASE,
        `rejected id ${JSON.stringify(id)} produced ${JSON.stringify(args)}`
      )
    }
  })

  it('expected disk session id always matches id passed to claude', () => {
    for (const id of [RESUMED_ID, ...NON_UUID]) {
      const opts = { cwd: CWD, resumeSessionId: id as never }
      const args = buildClaudeArgs(opts, NEW_ID)
      const expected = expectedClaudeSessionId(opts, NEW_ID)
      const inArgs = valueOfFlag(args, '--resume') ?? valueOfFlag(args, '--session-id')
      assert.equal(expected, inArgs, `id ${JSON.stringify(id)}`)
    }
  })

  it('with --fork-session final id is unpredictable and declared unknown (null)', () => {
    const opts = { cwd: CWD, resumeSessionId: RESUMED_ID, forkSession: true }
    assert.equal(expectedClaudeSessionId(opts, NEW_ID), null)
  })
})

describe('buildClaudeArgs: --session-id and --resume never appear together', () => {
  const COMBINATIONS: Partial<LaunchOptions>[] = []
  for (const continueLast of [undefined, false, true]) {
    for (const forkSession of [undefined, false, true]) {
      for (const resumeSessionId of [undefined, RESUMED_ID, 'not-a-uuid', '']) {
        for (const model of [undefined, 'opus', 'default'] as const) {
          for (const initialPrompt of [undefined, 'prompt']) {
            COMBINATIONS.push({
              continueLast,
              forkSession,
              resumeSessionId,
              model,
              initialPrompt
            } as Partial<LaunchOptions>)
          }
        }
      }
    }
  }

  it('in no combination do both flags coexist', () => {
    for (const opts of COMBINATIONS) {
      const args = build(opts)
      const both = args.includes('--session-id') && args.includes('--resume')
      assert.equal(both, false, `combination ${JSON.stringify(opts)} -> ${JSON.stringify(args)}`)
      const chosen = ['--session-id', '--resume', '--continue'].filter((f) => args.includes(f))
      assert.equal(chosen.length, 1, `combination ${JSON.stringify(opts)}`)
    }
  })

  it('--continue takes precedence and carries no session id', () => {
    const args = build({ continueLast: true, resumeSessionId: RESUMED_ID })
    assert.deepEqual(args, ['--continue'])
  })

  it('--fork-session appears only together with --continue or --resume', () => {
    for (const opts of COMBINATIONS) {
      const args = build(opts)
      if (!args.includes('--fork-session')) continue
      assert.equal(
        args.includes('--continue') || args.includes('--resume'),
        true,
        `orphan fork in ${JSON.stringify(opts)} -> ${JSON.stringify(args)}`
      )
    }
    assert.deepEqual(build({ forkSession: true }), BASE)
  })

  it('an invalid id does not pull app into --resume', () => {
    const args = build({ resumeSessionId: 'not-a-uuid', forkSession: true })
    assert.deepEqual(args, BASE)
  })
})

describe('buildClaudeArgs: initial prompt sits at end after --', () => {
  const HOSTILE_PROMPTS = [
    'hello',
    '--dangerously-skip-permissions',
    '--model opus',
    '-p',
    'text with spaces and "quotes"',
    'first line\nsecond line',
    'semicolon; pipe |',
    'unicode 日本語 🚀',
    '--',
    'a'.repeat(300)
  ]

  it('prompt is always last argument, preceded by --', () => {
    for (const initialPrompt of HOSTILE_PROMPTS) {
      for (const extra of [
        {},
        { model: 'opus' as const, effort: 'max' as const, permissionMode: 'plan' as const },
        { continueLast: true, forkSession: true },
        { resumeSessionId: RESUMED_ID },
        { name: 'a session' }
      ]) {
        const args = build({ ...extra, initialPrompt })
        assert.equal(args[args.length - 1], initialPrompt, `prompt ${JSON.stringify(initialPrompt)}`)
        assert.equal(args[args.length - 2], '--', `separator for ${JSON.stringify(initialPrompt)}`)
      }
    }
  })

  it('separator -- appears exactly once, keeping prompt as single argument', () => {
    for (const initialPrompt of HOSTILE_PROMPTS) {
      const args = build({ initialPrompt, model: 'opus', name: 'name' })
      const beforePrompt = args.slice(0, -1)
      assert.equal(
        beforePrompt.filter((a) => a === '--').length,
        1,
        JSON.stringify(initialPrompt)
      )
    }
  })

  it('trims leading and trailing whitespace from prompt', () => {
    assert.deepEqual(build({ initialPrompt: '   hello   ' }), [...BASE, '--', 'hello'])
  })

  it('empty prompt or whitespace-only produces neither -- nor empty argument', () => {
    for (const initialPrompt of ['', '   ', '\t', '\n', ' \r\n \t ']) {
      const args = build({ initialPrompt })
      assert.deepEqual(
        args,
        BASE,
        `prompt ${JSON.stringify(initialPrompt)} -> ${JSON.stringify(args)}`
      )
    }
  })

  it('no argument is ever an empty string', () => {
    for (const initialPrompt of ['', '  ', ...HOSTILE_PROMPTS]) {
      for (const name of ['', '  ', 'name', '\u0000']) {
        const args = build({ initialPrompt, name, model: 'opus' })
        assert.equal(
          args.some((a) => a === ''),
          false,
          `${JSON.stringify({ initialPrompt, name })} -> ${JSON.stringify(args)}`
        )
      }
    }
  })
})

describe('buildClaudeArgs: session name', () => {
  it('strips control characters and stays on single line', () => {
    const args = build({ name: 'line one\nline two\r\tend' })
    const name = valueOfFlag(args, '--name')
    assert.equal(name, 'line oneline twoend')
    assert.equal(/[\p{Cc}\p{Cf}]/u.test(name ?? ''), false)
  })

  it('strips ANSI escape sequences character by character', () => {
    const name = valueOfFlag(build({ name: 'hello\u001b[31m world\u0000' }), '--name')
    assert.equal(name?.includes('\u001b'), false)
    assert.equal(name?.includes('\u0000'), false)
  })

  it('remains single argument even with spaces and quotes', () => {
    const args = build({ name: 'my "project" with spaces' })
    assert.deepEqual(args, [...BASE, '--name', 'my "project" with spaces'])
  })

  it('empty name or whitespace/invisible-only produces no --name', () => {
    for (const name of ['', '   ', '\t\n', '\u0000', '\u0000\u200d ', '\u007f']) {
      const args = build({ name })
      assert.deepEqual(args, BASE, `name ${JSON.stringify(name)} -> ${JSON.stringify(args)}`)
    }
  })

  it('very long name is clamped to 64 characters', () => {
    const name = valueOfFlag(build({ name: 'a'.repeat(500) }), '--name')
    assert.equal(name?.length, 64)
  })

  it('clamping at 64 does not split multi-byte characters', () => {
    const name = valueOfFlag(build({ name: 'a'.repeat(63) + '🚀' }), '--name') ?? ''
    assert.equal(name.isWellFormed(), true, `name truncated in middle: ${JSON.stringify(name)}`)
    assert.equal(name, 'a'.repeat(63) + '🚀', 'whole character should remain')

    const long = valueOfFlag(build({ name: '🚀'.repeat(100) }), '--name') ?? ''
    assert.equal(long.isWellFormed(), true, 'no broken surrogate pairs')
    assert.equal(Array.from(long).length, 64, 'clamped to 64 characters')
  })

  it('non-string name or prompt is ignored gracefully without failing launch', () => {
    for (const name of [42, true, {}, []] as unknown[]) {
      const args = build({ name } as unknown as Partial<LaunchOptions>)
      assert.deepEqual(args, BASE, `name ${JSON.stringify(name)}`)
    }
    for (const initialPrompt of [42, true, {}, []] as unknown[]) {
      const args = build({ initialPrompt } as unknown as Partial<LaunchOptions>)
      assert.deepEqual(args, BASE, `prompt ${JSON.stringify(initialPrompt)}`)
    }
  })

  it('missing or null name produces no --name', () => {
    for (const name of [null, undefined] as unknown[]) {
      const args = build({ name } as unknown as Partial<LaunchOptions>)
      assert.deepEqual(args, BASE, `name ${JSON.stringify(name)}`)
    }
  })
})

describe('encodeProjectDir: path to transcript folder name', () => {
  it('replaces every non-alphanumeric character with hyphen', () => {
    assert.equal(encodeProjectDir('C:\\Users\\Tha_Nixo\\Desktop\\ClaudeManager'), 'C--Users-Tha-Nixo-Desktop-ClaudeManager')
  })

  it('mixed slashes yield same name as backslashes', () => {
    assert.equal(encodeProjectDir('C:/Users/User/Projects'), encodeProjectDir('C:\\Users\\User\\Projects'))
    assert.equal(encodeProjectDir('C:/Users\\User//Projects'), 'C--Users-User-Projects')
  })

  it('trailing slash is ignored: resolves to same folder', () => {
    for (const base of ['C:\\Projects\\App', 'D:/work/my project', 'C:\\a']) {
      const expected = encodeProjectDir(base)
      for (const trailing of ['\\', '/', '\\\\', '//', '\\/']) {
        assert.equal(encodeProjectDir(base + trailing), expected, `${base} + ${JSON.stringify(trailing)}`)
      }
    }
  })

  it('at drive root the separator counts', () => {
    assert.equal(encodeProjectDir('C:\\'), 'C--')
    assert.equal(encodeProjectDir('C:'), 'C-')
    assert.equal(encodeProjectDir('C:\\\\'), 'C--')
  })

  it('spaces, quotes, and unicode become hyphens', () => {
    assert.equal(encodeProjectDir('C:\\my folder'), 'C--my-folder')
    assert.equal(encodeProjectDir("C:\\the'archive"), 'C--the-archive')
    assert.equal(encodeProjectDir('C:\\projects\\city'), 'C--projects-city')
    assert.equal(encodeProjectDir('C:\\日本語'), 'C--' + '-'.repeat(3))
    assert.equal(encodeProjectDir('C:\\emoji 🚀'), 'C--emoji--' + '-')
  })

  it('drive letter preserves case: distinct casing yields distinct names', () => {
    assert.equal(encodeProjectDir('C:\\Projects'), 'C--Projects')
    assert.equal(encodeProjectDir('c:\\Projects'), 'c--Projects')
    assert.notEqual(encodeProjectDir('C:\\Projects'), encodeProjectDir('c:\\Projects'))
  })

  it('empty path produces empty name', () => {
    assert.equal(encodeProjectDir(''), '')
  })

  it('result is always a safe folder name', () => {
    const hostile = [
      'C:\\..\\..\\Windows\\System32',
      'C:/../..',
      '..',
      '.',
      'C:\\projects\\..\\..\\other',
      '\\\\server\\share\\prog',
      'C:\\nul',
      'C:\\a\0b',
      "C:\\dir\\; rm -rf",
      'C:\\dir\\$(whoami)',
      'C:\\dir\\%PATH%',
      ''
    ]
    for (const p of hostile) {
      const name = encodeProjectDir(p)
      assert.match(name, /^[A-Za-z0-9-]*$/, `${JSON.stringify(p)} -> ${JSON.stringify(name)}`)
      assert.equal(
        resolve(join(CWD, name)).startsWith(resolve(CWD)),
        true,
        `${JSON.stringify(p)} -> ${JSON.stringify(name)}`
      )
    }
  })

  it('encoding is stable: identical path always gives identical name', () => {
    const p = 'C:\\Users\\User\\Projects\\App'
    assert.equal(encodeProjectDir(p), encodeProjectDir(p))
    assert.equal(encodeProjectDir(encodeProjectDir(p)), encodeProjectDir(p).replace(/[^a-zA-Z0-9]/g, '-'))
  })
})

describe('normalizePath: key for folder deduplication', () => {
  it('different spellings of same folder produce same key', () => {
    const forms = [
      'C:\\Users\\User\\Projects',
      'C:/Users/User/Projects',
      'C:\\Users\\User\\Projects\\',
      'C:/Users/User/Projects/',
      'c:\\users\\user\\projects',
      'C:\\Users/User\\\\Projects//',
      'C:\\USERS\\USER\\PROJECTS'
    ]
    const keys = new Set(forms.map(normalizePath))
    assert.equal(keys.size, 1, `differing keys: ${[...keys].join(' | ')}`)
    assert.equal([...keys][0], 'c:\\users\\user\\projects')
  })

  it('deduplication works in a Map', () => {
    const map = new Map<string, number>()
    for (const p of ['C:/Work/App', 'C:\\Work\\App\\', 'c:\\work\\app']) {
      const k = normalizePath(p)
      map.set(k, (map.get(k) ?? 0) + 1)
    }
    assert.equal(map.size, 1)
    assert.equal([...map.values()][0], 3)
  })

  it('distinct folders remain distinct', () => {
    const distinct = ['C:\\a', 'C:\\ab', 'C:\\a\\b', 'C:\\a-b', 'C:\\a b', 'D:\\a']
    assert.equal(new Set(distinct.map(normalizePath)).size, distinct.length)
  })

  it('encodeProjectDir is not used for deduplication because it is lossy', () => {
    const distinct = ['C:\\a b', 'C:\\a_b', 'C:\\a-b']
    assert.equal(new Set(distinct.map(encodeProjectDir)).size, 1)
    assert.equal(new Set(distinct.map(normalizePath)).size, 3)
  })

  it('applying normalization twice is idempotent', () => {
    for (const p of ['C:/a/b/', 'C:\\', 'C:', '', 'D:/x']) {
      assert.equal(normalizePath(normalizePath(p)), normalizePath(p), JSON.stringify(p))
    }
  })
})
