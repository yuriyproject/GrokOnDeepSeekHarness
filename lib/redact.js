/** Small helpers that keep secrets out of approval cards, errors and logs. */

const MAX_DETAIL = 600

const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const KNOWN_TOKEN = /\b(?:xai-|sk-|gh[pousr]_|AKIA)[A-Za-z0-9_-]{12,}/g
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi

/** Mask credential-shaped text. The result is meant for display, never for execution. */
export function redactSecrets(text) {
  return String(text)
    .replace(URL_CREDENTIALS, '$1***:***@')
    .replace(BEARER, '$1 ***')
    .replace(KNOWN_TOKEN, '***')
    .replace(SECRET_ASSIGNMENT, (_match, name, separator) => `${name}${separator}***`)
}

function clip(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat
}

/**
 * One line that tells the user what a permission request is about: the command line, the file
 * path or the raw input, redacted and shortened. DSH shows only `toolName` and `reason`, so the
 * ACP title alone ("Bash") would be an approval with no command.
 */
export function describeToolInput(toolCall) {
  const input = toolCall?.rawInput
  const parts = []
  if (typeof toolCall?.title === 'string' && toolCall.title.length > 0) parts.push(toolCall.title)
  if (typeof input === 'string') parts.push(input)
  else if (input !== null && typeof input === 'object') {
    const command = input.command ?? input.cmd
    const path = input.path ?? input.file_path ?? input.filePath
    if (Array.isArray(command)) parts.push(command.join(' '))
    else if (typeof command === 'string') parts.push(command)
    if (typeof path === 'string') parts.push(path)
    if (parts.length <= 1) {
      try {
        parts.push(JSON.stringify(input))
      } catch {
        // Not serializable: the title alone remains.
      }
    }
  }
  // The ACP title often already contains the command or path; show each fact once.
  const unique = parts.filter((part, index) => part.length > 0 && !parts.slice(0, index).some(earlier => earlier.includes(part)))
  return redactSecrets(clip(unique.join(' — ')))
}
