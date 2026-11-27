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
  sshDestination,
  tmuxAttachCommand
} from '../src/main/ssh/command'
import { isRemoteResumable, parseTmuxListing } from '../src/main/ssh/remote'
import { liveFor } from '../src/renderer/src/state/live'

/**
 * No test here opens a connection: they only check the strings that would be
 * handed to ssh and to the remote shell. This is where defects hurt most,
 * because a wrong result raises nothing: it reaches its destination and does
 * something other than what was asked.
 */
const SID = '11111111-2222-3333-4444-555555555555'

/** Minimal target; each test overrides only what it cares about. */
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

// --- Verification helpers ----------------------------------------------------

/**
 * Inverse of `shellQuote`: strips the outer quotes and turns every `'\''` back
 * into a single quote. It checks the only thing that really matters: that the
 * remote shell sees exactly the string the user wrote.
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
 * POSIX tokenizer reduced to the constructs we generate: single quotes,
 * backslashes and spaces. It reproduces what the server's shell would hand to
 * `cd` and to `claude` as separate arguments, which is what the user sees
 * break when quoting goes wrong.
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

/**
 * The `exec claude ...` part, at the end. It anchors on the branch that falls
 * back to the remote shell, which is fixed text: looking for the last `exec`
 * would also catch an `exec` written inside the user's prompt.
 */
const FALLBACK_SENTINEL = 'exec ${SHELL:-sh} -l; }; '
function claudePart(command: string): string {
  const i = command.indexOf(FALLBACK_SENTINEL)
  assert.notEqual(i, -1, 'missing shell fallback sentinel')
  return command.slice(i + FALLBACK_SENTINEL.length)
}

// --- shellQuote --------------------------------------------------------------

/** Strings a POSIX shell would interpret, if they were not protected. */
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
    // The roundtrip alone is not enough: if the result were two literals
    // separated by a space, the inverse would still come back equal, but the
    // remote command would receive two arguments.
    for (const val of CORPUS) {
      assert.deepEqual(
        tokenizePosix(shellQuote(val)),
        [val],
        `split into multiple arguments: ${JSON.stringify(val)}`
      )
    }
  })

  it('no unprotected single quotes remain within quotes', () => {
    // An unprotected quote would close the literal and let the shell interpret
    // everything after it: that is how a prompt becomes a command.
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

/**
 * Regression of issue #1, remote side.
 *
 * An assert forbade double quotes in the remote command: a perfectly normal
 * prompt such as `fix the "login" bug` was enough to make opening the pane
 * fail with an exception, and the user could not tell what they had done
 * wrong. Arguments are now protected upstream, and double quotes are fine.
 */
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
    // The prompt stays a single argument: if it split, the tail would reach the
    // remote shell as a command to run.
    assert.deepEqual(tokens, ['exec', 'claude', '--session-id', SID, '--', prompt])
  })
})

/**
 * Fix related to issue #1.
 *
 * Without `--`, a folder whose name starts with a dash was read by `cd` as an
 * option: with `-` you ended up in $OLDPWD, a place other than the one chosen,
 * with no message at all. Claude started in the wrong folder.
 */
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
      // A quoted tilde would stay a literal folder name: the shell only expands it
      // when it sees it bare.
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
    // '~something' is nobody's home for us: it is treated as a literal folder
    // name, not expanded at random.
    assert.deepEqual(tokenizePosix(cdPart(remoteCommand(dummyOptions('~weird'), SID))), [
      'cd',
      '--',
      '~weird'
    ])
  })

  it('unreachable directory error message names the requested path', () => {
    // It is the only clue the reader has: without the path, the error does not
    // tell a typo from a server with a different tree.
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
    // An explicit port must not appear when it is the default one: adding it
    // would override a Port written in the user's ~/.ssh/config.
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
    // Quoting for PowerShell happens downstream: if it also happened here, ssh
    // would look for a key with quotes in its name and not find it.
    const dir = mkdtempSync(join(tmpdir(), 'cm keys '))
    const key = join(dir, 'my key')

    const { args } = buildSshInvocation(
      dummyOptions('/srv/app', {}, { identityFile: key }),
      SID
    )
    const i = args.indexOf('-i')
    assert.notEqual(i, -1)
    assert.equal(args[i + 1], key)
    // With a hand-picked key ssh must not try others first, or the server closes
    // the connection for too many attempts.
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
      // It must stay attached to its own -o: detached, ssh would read it as the
      // destination and try to connect to a host that does not exist.
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
    // Scripts span several lines: if they were flattened or truncated, the
    // for..do would become a syntax error on the server.
    const script = ["cd 'my folder' || exit 3", 'for e in *; do', '  echo "$e"', 'done'].join('\n')
    const { file, args } = buildSshQuery(dummyTarget(), script)
    assert.equal(file, 'ssh')
    assert.equal(args.at(-1), script)
    assert.equal(args.at(-2), 'nicola@server.example.invalid')
  })
})

// --- remote.ts ---------------------------------------------------------------

/**
 * `describeFailure` is not exported from src/main/ssh/remote.ts: it can only
 * be reached through `runRemote`, which really starts ssh. No connection is
 * opened here, so the 'ENOENT' case stays uncovered on purpose.
 *
 * The only part of `remote.ts` that can be checked without a network is the
 * session id filter, which is also the only defense: that id is interpolated
 * into a double-quoted path inside a remote script, without going through
 * shellQuote.
 */
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

// --- tmux (issue #27) ---------------------------------------------------------

/**
 * Issue #27: on a server, Claude Code often lives inside tmux so that it
 * survives disconnects. A remote pane can now attach to such a pane instead of
 * starting a new claude, and follow the Claude session running in it.
 */
describe('tmux: attach command (issue #27)', () => {
  const target = { session: 'my work', windowId: '@3', paneId: '%7' }

  it('checks the session, then attaches and brings up the picked pane', () => {
    const [check, attach] = tmuxAttachCommand(target).split('\n')
    assert.match(check, /^tmux has-session -t '=my work' 2>\/dev\/null \|\| \{/)
    assert.deepEqual(tokenizePosix(attach), [
      'exec', 'tmux', 'attach-session', '-t', '=my work',
      ';', 'select-window', '-t', '@3',
      ';', 'select-pane', '-t', '%7'
    ])
  })

  it('ids from a tampered layout are left out, the session name stays quoted', () => {
    const attach = tmuxAttachCommand({
      session: "x'; rm -rf ~; '",
      windowId: '@1; reboot',
      paneId: '$(id)'
    }).split('\n')[1]
    assert.deepEqual(tokenizePosix(attach), ['exec', 'tmux', 'attach-session', '-t', "=x'; rm -rf ~; '"])
  })

  it('a tmux pane runs tmux, not claude', () => {
    const opts = dummyOptions('/srv/app')
    opts.remote!.tmux = target
    const { args } = buildSshInvocation(opts, SID)
    const command = args[args.length - 1]
    assert.ok(command.includes('attach-session'))
    assert.ok(!command.includes('claude'))
    // Detaching must return to the local shell: exec replaces the remote shell.
    assert.match(command, /\nexec 'tmux' /)
  })
})

describe('tmux: listing panes (issue #27)', () => {
  it('matches each pane with the Claude session the registry puts in it', () => {
    const T = '\t'
    const stdout = [
      ['P', 'work', '@1', '%1', 'claude', 'claude', '/srv/app', '1'].join(T),
      ['P', 'work', '@2', '%2', 'bash', 'bash', '/srv', '1'].join(T),
      ['P', 'logs', '@3', '%3', 'tail', 'tail', '/var/log', '0'].join(T),
      `R${T}${JSON.stringify({ sessionId: 's-1', tmux: 'work:@1.%1', status: 'busy', name: 'api' })}`,
      `R${T}${JSON.stringify({ sessionId: 's-2', status: 'idle' })}`,
      `R${T}{"broken`
    ].join('\n')

    const panes = parseTmuxListing(stdout)
    assert.equal(panes.length, 3)
    assert.deepEqual(panes[0].claude, { sessionId: 's-1', status: 'busy', name: 'api' })
    assert.equal(panes[1].claude, null)
    assert.equal(panes[0].attached, true)
    assert.equal(panes[2].attached, false)
  })
})

describe('tmux: a pane follows whoever runs in its tmux pane (issue #27)', () => {
  const tmuxMeta = {
    claudeSessionId: 'old-session',
    launch: {
      cwd: 'C:\\x',
      remote: {
        connectionId: 'c1',
        name: 'srv',
        host: 'h',
        user: 'u',
        path: '/srv',
        tmux: { session: 'work', windowId: '@1', paneId: '%1' }
      }
    }
  }

  it('by tmux target and server, not by the id it started with', () => {
    const sessions = [
      { pid: 1, sessionId: 'old-session', cwd: '/srv', status: 'idle' },
      // The same tmux name on another server must not match.
      { pid: 2, sessionId: 'elsewhere', cwd: '/srv', status: 'busy', tmux: 'work:@1.%1', remote: 'c2' },
      { pid: 3, sessionId: 'new-session', cwd: '/srv', status: 'waiting', tmux: 'work:@1.%1', remote: 'c1' }
    ]
    assert.equal(liveFor(tmuxMeta, sessions)?.sessionId, 'new-session')
    assert.equal(liveFor(tmuxMeta, sessions.slice(0, 2)), undefined)
  })

  it('a normal pane still follows its own id', () => {
    const meta = { claudeSessionId: 's-9', launch: { cwd: 'C:\\x' } }
    assert.equal(liveFor(meta, [{ pid: 1, sessionId: 's-9', cwd: 'C:\\x' }])?.sessionId, 's-9')
    assert.equal(liveFor({ claudeSessionId: null, launch: { cwd: 'C:\\x' } }, []), undefined)
  })
})
