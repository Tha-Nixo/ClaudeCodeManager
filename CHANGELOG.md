# Changelog

All versions follow [SemVer](https://semver.org/): the first number changes when breaking changes occur, the second for new features, and the third for bug fixes.

<!-- new versions below -->

## 1.2.0 — 2026-11-27

Remote panes come alive, costs match what Claude Code itself reports, and a crash no longer leaves sessions running where nothing can reach them.

- **A notification when a session finishes.** Besides "waiting for your input", a session that ends its turn now raises a notification too, so a long task can run in a pane you are not watching. Several sessions finishing together make one notification, not a burst. It can be turned off in Settings.
- **Live status for remote panes.** A pane running Claude Code on a server used to say "remote" and nothing else. It now shows the session's status, cost and context usage like a local pane, through one ssh connection per server. When the network drops, the status clears instead of freezing on the last value, and the connection comes back on its own.
- **Attach to tmux on a server.** For a remote connection, the session picker lists the server's tmux panes and marks those running Claude Code. Choosing one opens that exact pane, so work started on the server, or left running there, continues in ClaudeManager.
- **Costs match `/cost`.** The price table was out of date and overstated every current model, while presenting the result as exact. It now covers the current models, the Haiku long-prompt rate, fast mode, US-only inference and web searches. Where Claude Code records its own totals, those are used, including background calls that never appear in the transcript. Figures that are still estimates are marked `≈` or `~`.
- **No orphaned sessions after a crash.** If ClaudeManager was killed or crashed, every pane's shell and the Claude Code inside it kept running with no window to reach them. They now end together with the app.
- **Restoring a pane whose folder is gone.** A saved layout pointing at a deleted or renamed folder could resume the session in a different folder. The pane now says the folder no longer exists and offers to choose another.
- **Folder search ignores accents.** "citta" finds "città", and Turkish dotted capitals match too.
- **Readable dim text.** Secondary text was below the WCAG AA contrast minimum in five of the six built-in themes. It now meets it in all of them.
- **Folder trust follows `CLAUDE_CONFIG_DIR`.** The trust badge read the default configuration file even when Claude Code was set to use another one.
- **Security.** Electron 45 with its security fixes, and updated build tools and terminal library. DevTools (`F12`) no longer open in the installed app: set `CM_DEVTOOLS=1` to enable them for troubleshooting.

Under the hood: over 450 automated tests run on Windows for every change; releases are packaged on a GitHub Windows runner and checked against their tag before going live; the executables can be code-signed once a signing identity is configured.

## 1.1.1 — 2026-08-05

Bug fixes only: 24 issues resolved, 15 found during a systematic test campaign and 9 by the regression suite written immediately afterward. Nothing new to learn.

- **Quotes in the initial prompt are no longer lost.** Arguments passed to `claude` went through PowerShell, which dropped `"` characters along the way: initial prompts were truncated at the first quote, and remote panes with quotes in their path failed to open entirely. They now reach the child process exactly as written.
- **Statistics aligned to your local day.** "Today" and "last 7 days" used to cut off at midnight UTC: until 2:00 AM, yesterday's work was counted toward today.
- **Context saturation no longer says "approx."** Model identifiers with a trailing date suffix were not matched, leaving the percentage permanently labeled as approximate.
- **More reliable notifications.** If a session briefly disappeared from the Claude Code registry for a single cycle, its transition to "waiting for input" was missed.
- **Hand-edited configuration files.** Saving a config file in Notepad prepends a UTF-8 BOM, causing file parsing to fail and silently resetting all settings to defaults. A corrupt `folders.json` rendered the folder selector permanently unusable across restarts. Invalid types are now discarded on a per-field basis and no longer crash the Settings panel.
- **Folder search.** Searching for "cm" placed ClaudeManager below Music and Models: the folder name now weighs higher than its parent directory path.
- **Keybindings.** Binding `+` or the Spacebar cleared the old combination without creating a new one; actions `Alt+1`…`Alt+9` were omitted from the settings list, making them unmappable.
- **Panes.** Starting from the eighth consecutive split, new panes spawned with zero width: splits are now rejected when insufficient space remains. Additionally, an invalid `layout.json` no longer causes split panes to vanish.
- **Monitoring drawer.** Closing the detached window left the drawer handle in an inconsistent state, assuming it was still popped out.
- **Themes.** In the High Contrast theme, ANSI black matched the terminal background: borders, progress bars, and diffs were rendered invisible. Themes with missing color fields or invalid `dark` types are now rejected upfront rather than partially applied.
- **Sessions.** Labels in the resume list displayed raw slash-command markup; SSH ports with decimals were parsed and saved, subsequently failing during ssh execution; session names containing emojis at the 64th character boundary were sliced improperly.

Under the hood: 376 automated tests run on every commit on Windows, verifying child-process argument marshaling into native executables where the subtlest edge cases resided.

## 1.1.0 — 2026-08-02

- **Alerts when a session awaits your input.** With multiple panes open, you cannot monitor all of them: when a session transitions to waiting for user input, a native system notification is dispatched and the taskbar icon flashes. Clicking the notification focuses the terminal in that specific pane. Notifications trigger on *state transitions*, never spamming while the app is in focus.
- **Monitoring drawer.** A tab on the right edge opens a drawer displaying today's token usage, costs, and **context window saturation** for each active session. Can be detached into an independent, always-on-top floating window movable to a secondary monitor.
- **Remappable shortcuts.** Click any entry in Settings and press your desired key combination. Custom mappings override defaults, and assigning an empty combination frees the shortcut without a replacement (e.g., returning `Alt+B` to readline).
- **Terminal search.** `Alt+S` searches the scrollback buffer of the active pane, with match highlighting and forward/backward navigation.

## 1.0.1 — 2026-08-02

- The portable release checks for newer versions on startup and displays an update prompt with a direct download link.

## 1.0.0 — 2026-08-02

Initial public release.

### Desktop Compositor

- A single fullscreen window acts as a compositor: session panes tile space automatically, while active panes can be detached into floating windows, moved, and resized.
- Mouse reordering: pane headers act as drag handles. Dropping near an edge tiles beside adjacent panes, while dropping in the center swaps positions. A live preview displays placement, and `Esc` cancels the drag gesture.
- `Alt`-based shortcut map: all other keyboard input passes untouched to the terminal and Claude.
- Smooth transitions for layout changes, respecting `prefers-reduced-motion`.

### Sessions

- Each pane opens PowerShell in the selected directory and launches `claude`. Exiting Claude drops back to the shell in that directory.
- Folder picker with fuzzy search, filesystem explorer, and path paste, complete with badges for git branch, `CLAUDE.md` presence, existing sessions, and folder trust state.
- Resume previous conversations in a directory with labeled history, with an option to fork rather than continue.
- Real-time status read directly from Claude Code's session registry in `~/.claude/sessions/` without scraping terminal stdout.
- Per-pane launch flags: model alias, effort level, permission mode, and initial prompt.

### Remote Sessions

- Panes can launch Claude Code on remote servers via SSH: saved connection profiles, remote directory browsing with local-equivalent badges, and remote session resuming.
- No passwords requested or stored: leverages existing system SSH authentication and agent keys.

### Additional Features

- Usage statistics: token consumption and list pricing calculated per day, model, and directory parsed from local transcripts.
- State restoration on launch, resuming active panes where they left off.
- Six built-in themes plus custom themes via JSON in `%APPDATA%\claudemanager\themes\`. Each theme configures the UI and 16 ANSI terminal colors concurrently.
- Configurable folder index supporting up to four composable sources, including full-drive sweeps.
- Automated background updates via GitHub releases: downloaded silently and applied on application exit.
