/**
 * Accorcia un percorso Windows per la barra del titolo di un riquadro,
 * tenendo le ultime componenti: sono quelle che identificano il progetto.
 * `C:\Users\x\Desktop\ClaudeManager` -> `…\Desktop\ClaudeManager`
 */
export function shortenPath(fullPath: string, maxLength = 48): string {
  if (fullPath.length <= maxLength) return fullPath

  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  let out = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = `\\${parts[i]}${out}`
    if (next.length + 1 > maxLength) break
    out = next
  }
  return out ? `…${out}` : `…${fullPath.slice(-(maxLength - 1))}`
}

/** Ultima componente del percorso, usata come nome breve della sessione. */
export function basename(fullPath: string): string {
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? fullPath
}

/**
 * Filtra i titoli che il terminale riceve via sequenza OSC.
 *
 * Claude Code imposta un titolo utile ("✳ ClaudeManager"), ma quando esce è
 * PowerShell a riprendersi il controllo e a scrivere il proprio percorso
 * completo: senza questo filtro il riquadro finirebbe per intitolarsi
 * "Administrator: C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe".
 */
export function isUsefulTitle(title: string): boolean {
  const trimmed = title.trim()
  if (trimmed.length === 0) return false
  if (/\.(exe|cmd|bat|ps1)\b/i.test(trimmed)) return false
  // Un percorso assoluto come titolo è sempre la shell, non l'applicazione.
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return false
  return true
}
