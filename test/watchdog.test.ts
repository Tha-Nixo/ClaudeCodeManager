import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ensureBootstrapScript, powershellArgs } from '../src/main/pty/bootstrap'
import { buildPtyEnv } from '../src/main/pty/env'
import { buildCommandLine } from '../src/main/pty/winargs'

/**
 * Issue #28: when ClaudeManager dies abnormally (a crash, Stop-Process -Force),
 * cleanup in before-quit never runs and every pane's shell, with the claude
 * inside it, stays alive where no UI can reach it. The bootstrap now watches
 * the app's process and ends its own tree when the app is gone.
 */

describe('watchdog: wiring (issue #28)', () => {
  it('the pane environment carries the owner pid, and the bootstrap clears it', () => {
    const env = buildPtyEnv({ cwd: 'C:\\x', exe: 'claude', commandLine: '', ownerPid: 4242 })
    assert.equal(env.CM_OWNER_PID, '4242')

    const script = readFileSync(ensureBootstrapScript(), 'utf8')
    assert.match(script, /Remove-Item Env:CM_OWNER_PID/)
    // A literal backslash in the template string: a single one would vanish.
    assert.ok(script.includes('$env:SystemRoot\\System32\\taskkill.exe'), 'taskkill path mangled')
    assert.match(script, /\$owner\.WaitForExit\(\)/)
  })

  it('without an owner the variable is empty and the watchdog stays off', () => {
    assert.equal(buildPtyEnv({ cwd: 'C:\\x', exe: 'claude', commandLine: '' }).CM_OWNER_PID, '')
  })
})

/** Is a process still running? Signal 0 checks without touching it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return check()
}

describe('watchdog: the pane dies with the app (issue #28)', { skip: process.platform !== 'win32' }, () => {
  it('kills the shell and its child when the owner process is killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-watchdog-'))

    // Stand-in for ClaudeManager: a process we can kill -9.
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    })
    assert.ok(owner.pid)

    // Stand-in for claude: records its pid, then sleeps for a minute.
    const childPidFile = join(dir, 'child.pid')
    const sleeper = join(dir, 'sleeper.cjs')
    writeFileSync(
      sleeper,
      `require('fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`,
      'utf8'
    )

    const shell = spawn('powershell.exe', powershellArgs(ensureBootstrapScript()), {
      env: buildPtyEnv({
        cwd: dir,
        exe: process.execPath,
        commandLine: buildCommandLine([sleeper]),
        ownerPid: owner.pid
      }),
      stdio: ['pipe', 'ignore', 'ignore']
    })
    assert.ok(shell.pid)
    let shellExited = false
    shell.on('exit', () => {
      shellExited = true
    })

    try {
      assert.ok(await waitFor(() => existsSync(childPidFile), 30_000), 'child never started')
      const childPid = Number(readFileSync(childPidFile, 'utf8'))
      assert.ok(alive(childPid), 'child should be running while the owner lives')
      assert.equal(shellExited, false, 'shell should be running while the owner lives')

      // The crash: no before-quit, no cleanup.
      owner.kill('SIGKILL')

      assert.ok(await waitFor(() => shellExited, 15_000), 'shell survived its owner')
      assert.ok(await waitFor(() => !alive(childPid), 15_000), 'child survived its owner')
    } finally {
      if (!shellExited) shell.kill()
      if (alive(owner.pid)) owner.kill()
    }
  })
})
