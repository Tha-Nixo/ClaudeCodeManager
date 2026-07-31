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
