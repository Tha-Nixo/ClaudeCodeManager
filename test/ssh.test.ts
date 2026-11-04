import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LaunchOptions, SshTarget } from '@shared/types'
import {
  buildSshInvocation,
  buildSshQuery,
  remoteCommand,
  shellQuote,
  sshDestination
} from '../src/main/ssh/command'
import { isRemoteResumable } from '../src/main/ssh/remote'

/**
 * None of these tests open real network connections: they verify the command
 * strings and arguments delivered to ssh and the remote shell.
 */

const SID = '11111111-2222-3333-4444-555555555555'

function dummyTarget(extra: Partial<SshTarget> = {}): SshTarget {
  return { host: 'server.example.invalid', user: 'nicola', ...extra }
}

function dummyOptions(
  path: string,
  extra: Omit<Partial<LaunchOptions>, 'remote'> = {},
  remote: Partial<SshTarget> = {}
): LaunchOptions {
  return {
    cwd: 'C:\\projects',
    ...extra,
    remote: {
      connectionId: 'c1',
      name: 'Test Server',
      path,
      ...dummyTarget(remote)
    }
  }
}

// --- Verification helpers ----------------------------------------------------

/**
 * Inverse of `shellQuote`: strips outer quotes and replaces `'\''` with `'`.
 * Checks that the remote shell receives the exact string intended.
 */
function unquote(quoted: string): string {
  assert.ok(
    quoted.startsWith("'") && quoted.endsWith("'") && quoted.length >= 2,
    `not a single-quoted literal: ${JSON.stringify(quoted)}`
  )
  return quoted
    .slice(1, -1)
    .split("'\\''")
    .join("'")
}

/**
 * Minimal POSIX tokenizer handling single quotes, backslashes, and spaces.
 * Simulates what the remote server shell hands to `cd` and `claude`.
 */
function tokenizePosix(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === "'") inQuotes = false
      else current += c
      continue
    }
    if (c === "'") {
      inQuotes = true
      started = true
      continue
    }
    if (c === '\\') {
      i++
      if (i < line.length) {
        current += line[i]
        started = true
      }
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += c
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/** The `cd ...` portion of the remote command, before redirection. */
function cdPart(command: string): string {
  return command.split(' 2>/dev/null')[0]
}

/** The `exec claude ...` portion at the end. */
const FALLBACK_SENTINEL = 'exec ${SHELL:-sh} -l; }; '
function claudePart(command: string): string {
  const i = command.indexOf(FALLBACK_SENTINEL)
  assert.notEqual(i, -1, 'missing shell fallback sentinel')
  return command.slice(i + FALLBACK_SENTINEL.length)
}

// --- shellQuote --------------------------------------------------------------

const CORPUS = [
  'simple',
  'with regular spaces',
  "the'apostrophe",
  "'",
  "''",
  "a'b'c",
  "'\\''",
  'double "quotes" in middle',
  '"',
  'backtick `whoami`',
  'substitution $(id)',
  'variable $HOME and ${HOME}',
  'semicolon; ls',
  'a && b',
  'a || b',
  'a | b',
  'redirection > file < other',
  'newline\nin middle',
  '\n',
  'tab\tin middle',
  'single \\ backslash',
  '\\',
  "\\'",
  'C:\\dir\\file',
  '',
  ' ',
  '   surrounding spaces   ',
  'unicode 日本語 emoji 🚀 accented àèìòù',
  '~',
  '~/sub',
  '-',
  '--looks-like-flag',
  'wildcard * ? [a-z]',
  '#comment',
  '!history',
  'a'.repeat(300)
]

describe('shellQuote: POSIX literal for any string', () => {
  it('preserves every string in hostile corpus identically', () => {
    for (const val of CORPUS) {
      const quoted = shellQuote(val)
      assert.equal(
        unquote(quoted),
        val,
        `deformed: ${JSON.stringify(val)} -> ${JSON.stringify(quoted)}`
      )
    }
  })

  it('shell sees a single argument regardless of content', () => {
    for (const val of CORPUS) {
      assert.deepEqual(
        tokenizePosix(shellQuote(val)),
        [val],
        `split into multiple arguments: ${JSON.stringify(val)}`
      )
    }
  })

  it('no unprotected single quotes remain within quotes', () => {
    for (const val of CORPUS) {
      const inner = shellQuote(val).slice(1, -1)
      assert.ok(
        !inner.split("'\\''").join('').includes("'"),
        `unprotected quote in ${JSON.stringify(val)}`
      )
    }
  })

  it('empty string remains a present argument', () => {
    assert.equal(shellQuote(''), "''")
  })
})

// --- remoteCommand -----------------------------------------------------------

describe('remoteCommand: double quotes in prompt (regression for issue #1)', () => {
  const PROMPT = 'fix bug with "login"'

  it('does not throw on prompts containing double quotes', () => {
    assert.doesNotThrow(() => remoteCommand(dummyOptions('/srv/app', { initialPrompt: PROMPT }), SID))
  })

  it('delivers prompt to remote shell identically including double quotes', () => {
    const cmd = remoteCommand(dummyOptions('/srv/app', { initialPrompt: PROMPT }), SID)
    assert.deepEqual(tokenizePosix(claudePart(cmd)), [
      'exec',
      'claude',
      '--session-id',
      SID,
      '--',
      PROMPT
    ])
  })

  it('handles complex hostile prompts without throwing or deforming', () => {
    const prompt = [
      'use "this" and \'that\'',
      'run `whoami` and $(id)',
      'then ; rm -rf / && echo done',
      'across multiple lines'
    ].join('\n')

    const cmd = remoteCommand(dummyOptions('/srv/app', { initialPrompt: prompt }), SID)
    const tokens = tokenizePosix(claudePart(cmd))
    assert.equal(tokens.at(-1), prompt)
    assert.deepEqual(tokens, ['exec', 'claude', '--session-id', SID, '--', prompt])
  })
})

describe('remoteCommand: cd guarded with --', () => {
  it("directory named '-' produces cd -- '-'", () => {
    const cd = cdPart(remoteCommand(dummyOptions('-'), SID))
    assert.equal(cd, "cd -- '-'")
    assert.ok(!cd.includes("cd '-'"), 'missing --: cd would jump to $OLDPWD')
    assert.deepEqual(tokenizePosix(cd), ['cd', '--', '-'])
  })

  it('applies to any directory name resembling a command line flag', () => {
    for (const name of ['-', '-P', '--', '-L/tmp', '--help']) {
      assert.deepEqual(
        tokenizePosix(cdPart(remoteCommand(dummyOptions(name), SID))),
        ['cd', '--', name],
        `name parsed as option: ${name}`
      )
    }
  })
})

describe('remoteCommand: remote paths', () => {
  it('defaults to home when path is empty, leaving tilde unquoted', () => {
    for (const path of ['', '   ', undefined as unknown as string]) {
      const cmd = remoteCommand(dummyOptions(path), SID)
      assert.equal(cdPart(cmd), 'cd -- ~')
    }
  })

  it('path under home expands tilde and escapes remainder', () => {
    const cd = cdPart(remoteCommand(dummyOptions('~/my folder'), SID))
    assert.equal(cd, "cd -- ~/'my folder'")
    assert.deepEqual(tokenizePosix(cd), ['cd', '--', '~/my folder'])
  })

  it('spaces and quotes in path arrive intact', () => {
    const paths = ['/srv/my project', "/srv/the'app", '/srv/pro "ject"', "~/the'other", '/srv/日本']
    for (const path of paths) {
      assert.deepEqual(
        tokenizePosix(cdPart(remoteCommand(dummyOptions(path), SID))),
        ['cd', '--', path],
        `deformed path: ${path}`
      )
    }
  })

  it('absolute path is not mistaken for home subpath', () => {
    assert.deepEqual(tokenizePosix(cdPart(remoteCommand(dummyOptions('~weird'), SID))), [
      'cd',
      '--',
      '~weird'
    ])
  })

  it('unreachable directory error message names the requested path', () => {
    const path = '/srv/my project'
    const cmd = remoteCommand(dummyOptions(path), SID)
    assert.ok(cmd.includes(shellQuote(`ClaudeManager: remote directory unreachable: ${path}`)))
  })
})

describe('remoteCommand: command structure', () => {
  it('exec replaces shell so closing claude closes session cleanly', () => {
    const cmd = remoteCommand(dummyOptions('/srv/app'), SID)
    assert.ok(/(^|; )exec 'claude'/.test(cmd))
  })

  it('falls back to remote shell if claude is missing on server', () => {
    const cmd = remoteCommand(dummyOptions('/srv/app'), SID)
    assert.ok(cmd.includes('command -v claude >/dev/null 2>&1 ||'))
    assert.ok(cmd.includes('exec ${SHELL:-sh} -l'))
  })

  it('resumes existing conversation instead of opening a new one', () => {
    const resumeId = '99999999-8888-7777-6666-555555555555'
    const cmd = remoteCommand(dummyOptions('/srv/app', { resumeSessionId: resumeId }), SID)
    assert.deepEqual(tokenizePosix(claudePart(cmd)), ['exec', 'claude', '--resume', resumeId])
  })

  it('every claude argument is individually escaped', () => {
    const cmd = remoteCommand(
      dummyOptions('/srv/app', { model: 'opus', name: 'pane "one"', initialPrompt: '-- not a flag' }),
      SID
    )
    assert.deepEqual(tokenizePosix(claudePart(cmd)), [
      'exec',
      'claude',
      '--session-id',
      SID,
      '--model',
      'opus',
      '--name',
      'pane "one"',
      '--',
      '-- not a flag'
    ])
  })
})

// --- buildSshInvocation ------------------------------------------------------

describe('buildSshInvocation: ssh arguments', () => {
  it('throws immediately when remote target is missing', () => {
    assert.throws(() => buildSshInvocation({ cwd: 'C:\\projects' }, SID), /remote/)
  })

  it('requests pseudo-terminal allocation with -t', () => {
    const { file, args } = buildSshInvocation(dummyOptions('/srv/app'), SID)
    assert.equal(file, 'ssh')
    assert.ok(args.includes('-t'))
  })

  it('omits -p on default port 22', () => {
    for (const port of [undefined, 22]) {
      const { args } = buildSshInvocation(dummyOptions('/srv/app', {}, { port }), SID)
      assert.ok(!args.includes('-p'), `-p added for port ${String(port)}`)
    }
  })

  it('passes -p and port number as separate arguments for non-standard ports', () => {
    const { args } = buildSshInvocation(dummyOptions('/srv/app', {}, { port: 2222 }), SID)
    const i = args.indexOf('-p')
    assert.notEqual(i, -1)
    assert.equal(args[i + 1], '2222')
  })

  it('identity file with spaces in path remains single argument unquoted here', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm keys '))
    const key = join(dir, 'my key')

    const { args } = buildSshInvocation(
      dummyOptions('/srv/app', {}, { identityFile: key }),
      SID
    )
    const i = args.indexOf('-i')
    assert.notEqual(i, -1)
    assert.equal(args[i + 1], key)
    assert.ok(args.includes('IdentitiesOnly=yes'))
  })

  it('without identity file does not enforce IdentitiesOnly', () => {
    const { args } = buildSshInvocation(dummyOptions('/srv/app'), SID)
    assert.ok(!args.includes('-i'))
    assert.ok(!args.includes('IdentitiesOnly=yes'))
  })

  it('configures keep-alive intervals', () => {
    const { args } = buildSshInvocation(dummyOptions('/srv/app'), SID)
    assert.ok(args.includes('ServerAliveInterval=30'))
    assert.ok(args.includes('ServerAliveCountMax=4'))
  })

  it('destination and remote command are the final two arguments in order', () => {
    const { args } = buildSshInvocation(dummyOptions('/srv/app'), SID)
    assert.equal(args.at(-2), 'nicola@server.example.invalid')
    assert.equal(args.at(-1), remoteCommand(dummyOptions('/srv/app'), SID))
  })

  it('omits @ when username is empty', () => {
    assert.equal(sshDestination({ host: 'machine.invalid', user: '' }), 'machine.invalid')
    assert.equal(
      sshDestination({ host: 'machine.invalid', user: 'nicola' }),
      'nicola@machine.invalid'
    )
  })
})

// --- buildSshQuery -----------------------------------------------------------

describe('buildSshQuery: non-interactive queries', () => {
  const variations: SshTarget[] = [
    dummyTarget(),
    dummyTarget({ port: 22 }),
    dummyTarget({ port: 2222 }),
    dummyTarget({ user: '' }),
    dummyTarget({ identityFile: 'C:\\keys\\id_ed25519' }),
    dummyTarget({ port: 2222, identityFile: 'C:\\other keys\\id_ed25519' })
  ]

  it('always requests BatchMode to avoid password prompts blocking UI', () => {
    for (const target of variations) {
      const { args } = buildSshQuery(target, 'echo hello')
      const i = args.indexOf('BatchMode=yes')
      assert.notEqual(i, -1, `BatchMode missing for ${JSON.stringify(target)}`)
      assert.equal(args[i - 1], '-o')
      assert.ok(args.includes('ConnectTimeout=10'))
    }
  })

  it('disables pseudo-terminal allocation with -T', () => {
    const { args } = buildSshQuery(dummyTarget(), 'echo hello')
    assert.ok(args.includes('-T'))
    assert.ok(!args.includes('-t'))
  })

  it('port flag behavior is consistent with invocation', () => {
    assert.ok(!buildSshQuery(dummyTarget({ port: 22 }), 'x').args.includes('-p'))
    const args = buildSshQuery(dummyTarget({ port: 2222 }), 'x').args
    assert.equal(args[args.indexOf('-p') + 1], '2222')
  })

  it('passes remote script intact at end including newlines', () => {
    const script = ["cd 'my folder' || exit 3", 'for e in *; do', '  echo "$e"', 'done'].join('\n')
    const { file, args } = buildSshQuery(dummyTarget(), script)
    assert.equal(file, 'ssh')
    assert.equal(args.at(-1), script)
    assert.equal(args.at(-2), 'nicola@server.example.invalid')
  })
})

// --- remote.ts ---------------------------------------------------------------

describe('isRemoteResumable: session ID validation', () => {
  it('rejects invalid session IDs without contacting server', async () => {
    const malformed = [
      '',
      'not-a-valid-uuid',
      'zzzzzzzz-2222-3333-4444-555555555555',
      '11111111-2222-3333-4444-55555555555', // 35 chars
      '11111111-2222-3333-4444-5555555555555', // 37 chars
      '$(touch /tmp/pwned)',
      '"; touch /tmp/pwned; "',
      '../../../etc/passwd',
      '11111111-2222-3333-4444-555555555555 ' // trailing space
    ]

    for (const id of malformed) {
      assert.equal(
        await isRemoteResumable(dummyTarget(), '/srv/app', id),
        false,
        `id accepted: ${JSON.stringify(id)}`
      )
    }
  })
})
