import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { TranscriptSession } from '@shared/types'
import { transcriptsFor } from './paths'

/**
 * Resumable sessions for a folder, with a human-readable label.
 *
 * Transcripts can be megabytes in size, but the information needed is at the
 * ends of the file: `ai-title` and `last-prompt` records are re-emitted
 * multiple times and the last occurrence is the valid one, so we read the TAIL;
 * the first user message, used only as a last resort, is at the HEAD.
 * The full file is never loaded into memory.
 */

const TAIL_BYTES = 192 * 1024
const HEAD_BYTES = 96 * 1024

/**
 * A session is resumable only if it actually has a transcript on disk.
 *
 * This is needed because the id is assigned with --session-id at spawn time,
 * but Claude Code writes the file only when the session receives content.
 * A pane opened and never used leaves an id that exists for us but not
 * for Claude: resuming it would fail with "No conversation found".
 */
export function isResumable(folder: string, sessionId: string): boolean {
  if (!sessionId) return false
  return transcriptsFor(folder).some((file) => basename(file, '.jsonl') === sessionId)
}

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
        label: clean(aiTitle ?? lastPrompt ?? firstUser ?? 'untitled session'),
        modifiedAt: stat.mtimeMs,
        sizeBytes: stat.size
      })
    } catch {
      // Unreadable or deleted transcript in the meantime: skip.
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

  // The first line of the chunk is almost certainly truncated: discard it.
  const lines = chunk.split('\n').slice(1)

  let aiTitle: string | null = null
  let lastPrompt: string | null = null

  // From bottom to top: the first occurrence encountered is the last one written.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (aiTitle && lastPrompt) break

    const line = lines[i].trim()
    if (!line) continue

    // Text filter before parsing: interesting lines are few among
    // thousands, and JSON.parse on each would be much slower.
    const maybeTitle = !aiTitle && (line.includes('"ai-title"') || line.includes('"custom-title"'))
    const maybePrompt = !lastPrompt && line.includes('"last-prompt"')
    if (!maybeTitle && !maybePrompt) continue

    try {
      const rec = JSON.parse(line) as {
        type?: string
        aiTitle?: string
        customTitle?: string
        title?: string
        lastPrompt?: string
      }
      if (!aiTitle && rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle
      // A user-chosen title is as good as a generated one: in fact, it is the only
      // label available when the last turn is a slash command, in which case the
      // last-prompt record does not carry text.
      if (!aiTitle && rec.type === 'custom-title') aiTitle = rec.customTitle ?? rec.title ?? null
      if (!lastPrompt && rec.type === 'last-prompt' && rec.lastPrompt) lastPrompt = rec.lastPrompt
    } catch {
      // Invalid line: continue.
    }
  }

  return { aiTitle, lastPrompt }
}

/**
 * Detects messages that wrap a slash command instead of being text
 * written by a human.
 *
 * Claude Code writes them as user messages, but the content is internal
 * markup (`<command-name>`, `<local-command-stdout>`, `<command-message>`).
 * Used as a label, it produced unreadable lines in the session resume list.
 */
function isCommandWrapper(text: string): boolean {
  return /<\/?(command-(name|message|args|contents)|local-command-(stdout|stderr)|command-stdout)\b/i.test(
    text
  )
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
      // Content is a string for typed prompts and an array of blocks for tool results:
      // here we care about the former.
      if (typeof rec.message?.content === 'string' && rec.message.content.trim()) {
        // Messages that wrap a slash command are not user-written prompts:
        // they are internal markers. Used as labels, confusing markup would appear
        // in the resume list, making it impossible to identify the session.
        if (isCommandWrapper(rec.message.content)) continue
        return rec.message.content
      }
    } catch {
      // Line truncated by read chunk boundary: continue.
    }
  }
  return null
}
