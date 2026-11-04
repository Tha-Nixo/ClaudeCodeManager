/**
 * Shortens a path for a pane's titlebar, preserving trailing components:
 * these identify the project.
 * `C:\Users\x\Desktop\ClaudeManager` -> `…\Desktop\ClaudeManager`
 *
 * The separator is inferred from the path itself, because remote connections
 * can pass POSIX paths: recomposing `/home/nixo/app` with backslashes
 * would make it look like a non-existent Windows path.
 */
export function shortenPath(fullPath: string, maxLength = 48): string {
  if (fullPath.length <= maxLength) return fullPath

  const sep = fullPath.includes('\\') ? '\\' : '/'
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  let out = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = `${sep}${parts[i]}${out}`
    if (next.length + 1 > maxLength) break
    out = next
  }
  return out ? `…${out}` : `…${fullPath.slice(-(maxLength - 1))}`
}

/** Last path component, used as the short session name. */
export function basename(fullPath: string): string {
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? fullPath
}

/**
 * Filters titles received by the terminal via OSC sequences.
 *
 * Claude Code sets a helpful title ("✳ ClaudeManager"), but upon exit
 * PowerShell reclaims control and sets its full executable path:
 * without this filter, the pane would be titled
 * "Administrator: C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe".
 */
export function isUsefulTitle(title: string): boolean {
  const trimmed = title.trim()
  if (trimmed.length === 0) return false
  if (/\.(exe|cmd|bat|ps1)\b/i.test(trimmed)) return false
  // An absolute path as title is always the shell, not the application.
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return false
  return true
}
