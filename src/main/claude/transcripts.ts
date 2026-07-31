import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { TranscriptSession } from '@shared/types'
import { transcriptsFor } from './paths'

/**
 * Sessioni riprendibili per una cartella, con un'etichetta leggibile.
 *
 * I transcript possono pesare megabyte, ma le informazioni che servono stanno
 * agli estremi del file: i record `ai-title` e `last-prompt` vengono riemessi
 * piu' volte e l'ultima occorrenza e' quella valida, quindi si legge la CODA;
 * il primo messaggio dell'utente, che serve solo come ultima spiaggia, sta in
 * TESTA. Non si carica mai il file intero.
 */

const TAIL_BYTES = 192 * 1024
const HEAD_BYTES = 96 * 1024

export function sessionsForFolder(folder: string): TranscriptSession[] {
  const files = transcriptsFor(folder)
  const out: TranscriptSession[] = []

  for (const file of files) {
    try {
      const stat = statSync(file)
      const { aiTitle, lastPrompt } = scanTail(file)
      const firstUser = aiTitle || lastPrompt ? null : scanHeadForFirstUserMessage(file)

      out.push({
        sessionId: basename(file, '.jsonl'),
        file,
        aiTitle,
        lastPrompt,
        label: clean(aiTitle ?? lastPrompt ?? firstUser ?? 'sessione senza titolo'),
        modifiedAt: stat.mtimeMs,
        sizeBytes: stat.size
      })
    } catch {
      // Transcript illeggibile o cancellato nel frattempo: si salta.
    }
  }

  return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function readChunk(file: string, bytes: number, fromEnd: boolean): string {
  let fd: number | null = null
  try {
    const size = statSync(file).size
    const length = Math.min(bytes, size)
    const position = fromEnd ? size - length : 0
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(length)
    const read = readSync(fd, buf, 0, length, position)
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

interface TailScan {
  aiTitle: string | null
  lastPrompt: string | null
}

function scanTail(file: string): TailScan {
  const chunk = readChunk(file, TAIL_BYTES, true)
  if (!chunk) return { aiTitle: null, lastPrompt: null }

  // La prima riga del blocco e' quasi certamente troncata a meta': si scarta.
  const lines = chunk.split('\n').slice(1)

  let aiTitle: string | null = null
  let lastPrompt: string | null = null

  // Dal fondo verso l'alto: la prima occorrenza incontrata e' l'ultima scritta.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (aiTitle && lastPrompt) break

    const line = lines[i].trim()
    if (!line) continue

    // Filtro testuale prima di parsare: le righe interessanti sono poche fra
    // migliaia, e JSON.parse su ognuna costerebbe molto di piu'.
    const maybeTitle = !aiTitle && line.includes('"ai-title"')
    const maybePrompt = !lastPrompt && line.includes('"last-prompt"')
    if (!maybeTitle && !maybePrompt) continue

    try {
      const rec = JSON.parse(line) as {
        type?: string
        aiTitle?: string
        lastPrompt?: string
      }
      if (!aiTitle && rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle
      if (!lastPrompt && rec.type === 'last-prompt' && rec.lastPrompt) lastPrompt = rec.lastPrompt
    } catch {
      // Riga non valida: si prosegue.
    }
  }

  return { aiTitle, lastPrompt }
}

function scanHeadForFirstUserMessage(file: string): string | null {
  const chunk = readChunk(file, HEAD_BYTES, false)
  if (!chunk) return null

  for (const line of chunk.split('\n')) {
    if (!line.trim() || !line.includes('"user"')) continue
    try {
      const rec = JSON.parse(line) as {
        type?: string
        isMeta?: boolean
        message?: { content?: unknown }
      }
      if (rec.type !== 'user' || rec.isMeta === true) continue
      // Il contenuto e' una stringa per i prompt digitati e un array di
      // blocchi per i risultati degli strumenti: qui interessa il primo caso.
      if (typeof rec.message?.content === 'string' && rec.message.content.trim()) {
        return rec.message.content
      }
    } catch {
      // Riga troncata dal limite di lettura: si prosegue.
    }
  }
  return null
}
