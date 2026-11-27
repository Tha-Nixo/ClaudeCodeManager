import type { LiveSession } from '@shared/types'

/**
 * The stream that tells the app what remote sessions are doing (#26).
 *
 * Claude Code on a server writes the same files as locally: the registry in
 * ~/.claude/sessions/<pid>.json and the transcripts in ~/.claude/projects/.
 * Reading them needs one ssh connection per server, kept open, not one per
 * poll: Windows OpenSSH has no ControlMaster, so a fresh connection every few
 * seconds would cost a full handshake each time.
 *
 * The script below runs on the server for as long as the connection lives. In
 * a loop it prints the registry when it changes, and the lines appended to
 * each live session's transcript since the last round, so the app can price
 * them with the same parser as local transcripts. On first sight of a session
 * it sends the transcript from its last cost-state record (#25), or from the
 * last turn if that comes earlier, since the context fill needs the last turn:
 * the snapshot carries the cost of everything before it. It wakes on registry changes
 * when inotifywait exists, and every 2 seconds anyway: transcripts grow
 * without touching the registry.
 *
 * Only POSIX sh and coreutils, like the other remote scripts: python or jq
 * cannot be counted on on a server. How much of each transcript was already
 * sent is kept in a shell variable (";<sid>=<bytes>;..."), so the script
 * writes no file on the server and has nothing to clean up.
 *
 * Output, one record per line:
 *
 *   @@S                 registry snapshot follows, one JSON object per line
 *   @@E                 end of snapshot
 *   @@T <sid> <reset>   transcript lines of a session follow; reset=1 means
 *                       "start over" (first sight, or the file shrank)
 *   @@TE                end of transcript lines
 */
export const WATCH_SCRIPT = String.raw`base="${'$'}{CLAUDE_CONFIG_DIR:-$HOME/.claude}"
dir="$base/sessions"
prev=''
offs=';'
while :; do
  snap=''
  for f in "$dir"/*.json; do
    [ -f "$f" ] || continue
    pid=$(basename "$f" .json)
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null || continue
    line=$(tr -d '\n' < "$f")
    case "$line" in *'"sessionId"'*) ;; *) continue ;; esac
    snap="$snap$line
"
    sid=$(printf '%s' "$line" | sed -n 's/.*"sessionId":"\([0-9a-fA-F-]*\)".*/\1/p')
    cwd=$(printf '%s' "$line" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p')
    [ -n "$sid" ] && [ -n "$cwd" ] || continue
    t="$base/projects/$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9]/-/g')/$sid.jsonl"
    [ -f "$t" ] || continue
    size=$(wc -c < "$t" | tr -d ' ')
    old=$(printf '%s' "$offs" | sed -n "s/.*;$sid=\([0-9]*\);.*/\1/p")
    [ "$size" = "$old" ] && continue
    if [ -z "$old" ] || [ "$size" -lt "$old" ]; then
      n=$(grep -n '"type":"cost-state"' "$t" | tail -n 1 | cut -d: -f1)
      a=$(grep -n '"type":"assistant"' "$t" | tail -n 1 | cut -d: -f1)
      [ -n "$a" ] && [ -n "$n" ] && [ "$a" -lt "$n" ] && n=$a
      printf '@@T %s 1\n' "$sid"
      tail -n "+${'$'}{n:-1}" "$t" | grep -E '"type":"(assistant|cost-state)"' | tail -n 3000
    else
      printf '@@T %s 0\n' "$sid"
      tail -c "+$((old + 1))" "$t" | grep -E '"type":"(assistant|cost-state)"'
    fi
    printf '@@TE\n'
    offs="$(printf '%s' "$offs" | sed "s/;$sid=[0-9]*;/;/")$sid=$size;"
  done
  if [ "$snap" != "$prev" ]; then
    printf '@@S\n%s@@E\n' "$snap"
    prev=$snap
  fi
  if command -v inotifywait >/dev/null 2>&1 && [ -d "$dir" ]; then
    inotifywait -qq -t 2 -e close_write -e create -e delete -e moved_to "$dir" >/dev/null 2>&1
  else
    sleep 2
  fi
done`

export type WatchEvent =
  | { kind: 'sessions'; sessions: LiveSession[] }
  | { kind: 'transcript'; sessionId: string; reset: boolean; lines: string[] }

/**
 * Turns the script's output, in chunks as they arrive from ssh, into events.
 * A chunk can end in the middle of a line: the tail waits for the next chunk.
 */
export class WatchParser {
  private pending = ''
  private block: { kind: 'S' } | { kind: 'T'; sessionId: string; reset: boolean } | null = null
  private lines: string[] = []

  feed(chunk: string): WatchEvent[] {
    const events: WatchEvent[] = []
    const text = this.pending + chunk
    const parts = text.split('\n')
    this.pending = parts.pop() ?? ''

    for (const raw of parts) {
      const line = raw.replace(/\r$/, '')
      if (line === '@@S') {
        this.block = { kind: 'S' }
        this.lines = []
      } else if (line === '@@E' && this.block?.kind === 'S') {
        events.push({ kind: 'sessions', sessions: parseRegistry(this.lines) })
        this.block = null
      } else if (line.startsWith('@@T ')) {
        const [, sessionId, reset] = line.split(' ')
        this.block = { kind: 'T', sessionId, reset: reset === '1' }
        this.lines = []
      } else if (line === '@@TE' && this.block?.kind === 'T') {
        const { sessionId, reset } = this.block
        events.push({ kind: 'transcript', sessionId, reset, lines: this.lines })
        this.block = null
      } else if (this.block) {
        this.lines.push(line)
      }
      // Anything outside a block (a login banner, a motd) is ignored.
    }
    return events
  }
}

/** Registry records, kept by the same rule as the local ones. */
function parseRegistry(lines: string[]): LiveSession[] {
  const out: LiveSession[] = []
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as LiveSession
      if (!rec?.sessionId || typeof rec.pid !== 'number') continue
      out.push(rec)
    } catch {
      // Half-written while the server read it: complete on the next round.
    }
  }
  return out
}
