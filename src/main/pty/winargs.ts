/**
 * Command line composition for executables spawned inside a pane.
 *
 * ## The Problem
 *
 * Previously, arguments were serialized to PowerShell as JSON and
 * splatted (`& $exe @args`). PowerShell 5.1 wraps arguments containing
 * spaces in double quotes, but does NOT escape existing double quotes
 * in the value, and does not double trailing backslashes. Worse, its
 * quote-wrapping heuristic depends on the parity of quotes encountered
 * before a space, so a value with an odd number of quotes was not wrapped
 * at all and split:
 *
 *   sent      'write a function "hello world"'
 *   received  ['write a function hello', 'world']
 *
 * No error was raised: Claude received a truncated prompt plus an extra
 * positional argument.
 *
 * ## The Solution
 *
 * We no longer let PowerShell construct the command line. This module
 * composes it according to the standard rules of the Windows C runtime
 * (CommandLineToArgvW), and the bootstrap passes it to
 * `System.Diagnostics.ProcessStartInfo.Arguments`, which forwards it
 * to the process without further mangling. The rules are threefold:
 *
 * - a literal double quote is escaped as `\"`;
 * - backslashes immediately preceding a quote must be doubled;
 * - backslashes at the very end of the argument must be doubled, because
 *   they precede the closing quote.
 *
 * Verified against a suite of hostile cases (nested quotes, unpaired quotes,
 * trailing backslashes, newlines, tabs, Unicode, empty string, sequences of
 * multiple quotes): all arrive intact at the child process.
 */

/** Quotes a single argument according to the Windows C runtime rules. */
export function quoteNativeArg(value: string): string {
  // Without spaces, quotes, or whitespace, no quoting is needed: wrapping always
  // would work, but leaves unreadable command lines in logs.
  if (value !== '' && !/[\s"]/.test(value)) return value

  let out = '"'
  let backslashes = 0

  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1
      continue
    }
    if (ch === '"') {
      // Accumulated backslashes precede a quote: doubled, plus the one
      // escaping the quote itself.
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }

  // At the end, the closing quote follows: without doubling, backslashes would
  // inadvertently escape it, merging the argument with the next.
  out += '\\'.repeat(backslashes * 2) + '"'
  return out
}

/**
 * Complete argument command line, without the executable.
 *
 * .NET prepends FileName itself, so only arguments belong here.
 */
export function buildCommandLine(args: string[]): string {
  return args.map(quoteNativeArg).join(' ')
}
