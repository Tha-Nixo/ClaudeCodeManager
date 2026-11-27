/**
 * Message of an error thrown by a main-process handler.
 *
 * ipcRenderer.invoke rejects with "Error invoking remote method 'pty:create':
 * Error: <message>". The prefix is plumbing, not something a user can act on,
 * and the pane shows the message as is.
 */
export function launchErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}
