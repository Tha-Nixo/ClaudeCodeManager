# Roadmap

What comes next for ClaudeManager, and in which order. Each item is a GitHub
issue, and the issue is the source of truth: details, acceptance criteria and
progress live there. This file is the overview. Update it when a milestone
closes or the plan changes.

*Last updated: 2026-11-27. Current release: 1.1.1; everything below is merged
in `main` and waits for the next release.*

| Milestone | Theme | Issues | Status |
| --- | --- | --- | --- |
| [v1.1.2](https://github.com/Tha-Nixo/ClaudeCodeManager/milestone/1) | Correctness and security | 8 | Done (PR #33, #34) |
| [v1.2.0](https://github.com/Tha-Nixo/ClaudeCodeManager/milestone/2) | Know what every session is doing | 5 | Done (PR #35) |
| [Later](https://github.com/Tha-Nixo/ClaudeCodeManager/milestone/3) | Accepted, not scheduled | 4 | Done (PR #36) |

### What is left

- **Signing identity:** #32 is closed with signing ready: the release script
  signs as soon as an Azure Trusted Signing identity is configured (see the
  README, Development). Until then the published executables stay unsigned.
- **Checks only a Windows machine can do:** start a packaged build, open and
  restore panes, see a toast, detach the monitor window, run auto-update
  against a local feed (`CM_UPDATE_DEV=1`), and attach a remote pane over
  real ssh, tmux included. CI covers the tests and the build.
- **Releasing:** `npm run release` on Windows, then
  `npm run release -- --verify` before and after publishing the draft.

## Where this list comes from

A checkup on 2026-11-27, after three months without changes. During that time
Claude Code moved on (new models, new transcript records) and the project was
translated into English. The checkup covered:

- the test suite and typecheck, before and after the translation (375 tests
  on Linux, identical results);
- the session registry and transcript formats written by Claude Code 2.1.332,
  compared with what the parsers expect (still compatible);
- the CLI flags passed to `claude` (still valid);
- the app's cost figures compared with the costs Claude Code records itself;
- `npm audit` and `npm outdated`;
- the four tests that are skipped on purpose, and the README's known
  limitations.

## v1.1.2: correctness and security (done)

A patch release: no new features, so a user who updates notices only that the
numbers are right.

Suggested order:

1. [#16](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/16) **Costs are
   overstated for every current model and reported as exact.** Opus 5.5 is
   +54 %, Fable 5.2 +115 %, Haiku 5.5 +150 %, Sonnet 5.5 +22 %, and Haiku
   5.5's context fill shows five times too high. This is the most visible bug,
   because the drawer is wrong every day.
2. [#18](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/18) **Security
   updates.** Electron 43.x patch, `js-yaml` (the only runtime advisory),
   electron-builder 26, node-pty.
3. [#19](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/19) F12 opens
   DevTools in packaged builds.
4. [#20](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/20) The folder
   trust badge ignores `CLAUDE_CONFIG_DIR`.
5. [#21](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/21) Restoring a
   pane whose folder was deleted. Suspected from code reading: reproduce it on
   Windows first.
6. [#23](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/23) Remove the
   unused scrollback buffer and three dead IPC channels.
7. [#22](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/22) Restore the
   rationale comments that the translation dropped. Comments only, so it can
   run in parallel with everything else.
8. [#17](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/17) **Before
   tagging 1.1.2:** re-attach release 1.1.1 to `v1.1.1` and add a post-publish
   check to the release script, so that this release does not repeat the
   problem.

## v1.2.0: know what every session is doing (done)

The point of a multi-session manager is that you do not have to watch every
pane. Today that holds only for local sessions, and only for the permission
dialog. This milestone extends it to the end of a turn, to remote and tmux
sessions, and to costs that no longer depend on a hand-maintained table.

1. [#24](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/24) **Notify
   when a session finishes its turn** (`busy` → `idle`). This is the most
   frequent reason to look at a pane, and today it produces no alert.
2. [#25](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/25) **Calibrate
   costs with Claude Code's own `cost-state` records**, so a new model no
   longer means wrong numbers until the next release.
3. [#26](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/26) **Live status
   and usage for remote sessions**, through one long-lived ssh stream per
   server. This removes the largest known limitation.
4. [#27](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/27) **Attach a
   pane to an existing tmux session** on a remote server. It builds on #26:
   the registry's `tmux` field maps a tmux pane to its Claude session.
5. [#28](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/28) **No orphaned
   shells or `claude` processes after a crash.** The recommended approach is a
   watchdog in the PowerShell bootstrap, which needs no native code.

#26 and #27 share the remote plumbing. #24 and #26 share the notification
path, so a remote session gets end-of-turn alerts as soon as both are done.

## Later

Accepted, but not scheduled. All four are done; #32's signing turns on when a
signing identity is configured.

- [#31](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/31) Upgrade
  Electron 43 → 45. **Deadline:** before Electron 46 ships, when 43 leaves the
  supported window. Move it into a milestone as soon as 46 is announced.
- [#29](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/29)
  Accent-insensitive folder search (`citta` → `città`, Turkish İ).
- [#30](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/30) Dim text below
  WCAG AA in 5 of 6 built-in themes. A palette decision, to be reviewed with
  screenshots.
- [#32](https://github.com/Tha-Nixo/ClaudeCodeManager/issues/32) Sign the
  Windows executables. It costs money and adds no functionality.

## Working rules

These come from how the project has been built so far:

- **A bug fix comes with a regression test** that cites its issue number. The
  suite in `test/` is organized that way, and #22 restores the comments that
  make it readable.
- **Windows is the platform of record.** CI runs on `windows-latest`, because
  the subtlest bugs (argument passing through PowerShell 5.1) only exist there.
  A change that touches process spawning or quoting is not done until it is
  green on Windows CI.
- **Releases go through `npm run release`**, are published as drafts, and are
  made public by hand. Auto-update reaches every install, so going live has to
  be a deliberate decision.
- **Prices and model facts come from Anthropic's documentation on the day of
  the change**, never from memory: that is how #16 happened.
