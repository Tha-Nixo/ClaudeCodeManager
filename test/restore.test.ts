import { mkdtempSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawnCwd } from '../src/main/pty/cwd'
import { launchErrorMessage } from '../src/renderer/src/util/ipcError'

/**
 * Issue #21: restoring a pane whose folder was renamed or deleted.
 *
 * The transcript survives the folder, so layout:load still finds the session
 * resumable. PtyManager then fell back to %USERPROFILE% without a word and ran
 * `claude --resume`, with every tool call of the session, in the home directory.
 */
describe('restoring a pane whose folder is gone (issue #21 regression)', () => {
  it('a local pane whose folder was renamed does not start anywhere else', () => {
    const folder = mkdtempSync(join(tmpdir(), 'cm-restore-'))
    assert.equal(spawnCwd({ cwd: folder }), folder)

    // The repro from the issue: open a pane, quit, rename the folder, relaunch.
    const renamed = `${folder}-renamed`
    renameSync(folder, renamed)
    assert.throws(
      () => spawnCwd({ cwd: folder }),
      (err: Error) => err.message.includes(folder) && err.message.includes('no longer exists')
    )
    assert.equal(spawnCwd({ cwd: renamed }), renamed)
  })

  it('an empty folder is an error too, not "start in the home directory"', () => {
    assert.throws(() => spawnCwd({ cwd: '' }))
  })

  it('a remote pane still starts: its local folder only hosts ssh', () => {
    const cwd = spawnCwd({
      cwd: join(tmpdir(), 'cm-no-such-folder-for-ssh'),
      remote: { connectionId: 'c1', path: '/srv/app' } as never
    })
    assert.ok(cwd.length > 0)
  })

  it('the pane shows the reason, without the IPC plumbing around it', () => {
    const wrapped = new Error(
      "Error invoking remote method 'pty:create': Error: The folder C:\\work\\app no longer exists. It may have been moved, renamed or deleted."
    )
    assert.equal(
      launchErrorMessage(wrapped),
      'The folder C:\\work\\app no longer exists. It may have been moved, renamed or deleted.'
    )
    assert.equal(launchErrorMessage('plain text'), 'plain text')
    assert.equal(launchErrorMessage(new Error('already clean')), 'already clean')
  })
})
