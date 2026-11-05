/** Resolve ACP file requests without escaping the session workspace by default. */

import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const DEVICE_NAME = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i

/**
 * Reject path spellings that Node and the Windows file API read differently.
 *
 * Win32 drops trailing dots and spaces from every segment, so `.. ` or `...` can mean `..` to the
 * file system while Node treats it as an ordinary name and the prefix check passes. DOS device
 * names and `:` (alternate data streams) can redirect a write outside the file tree as well.
 * These checks run on every platform for the segment forms that are ambiguous anywhere, and for
 * the Windows-only forms when the host is Windows.
 */
export function assertUnambiguousPath(requestedPath, platform = process.platform) {
  const windows = platform === 'win32'
  const segments = requestedPath.split(/[\\/]+/)
  segments.forEach((segment, index) => {
    if (segment === '' || segment === '.' || segment === '..') return
    if (segment.includes('\0')) throw new Error(`ACP file path contains a NUL byte: ${JSON.stringify(requestedPath)}`)
    if (!windows) return
    const stripped = segment.replace(/[. ]+$/, '')
    if (stripped !== segment && (stripped === '' || stripped === '.' || stripped === '..')) {
      throw new Error(`ACP file path has an ambiguous segment ${JSON.stringify(segment)}`)
    }
    const drive = index === 0 && /^[A-Za-z]:$/.test(segment)
    if (!drive && segment.includes(':')) {
      throw new Error(`ACP file path uses a stream or device syntax: ${JSON.stringify(segment)}`)
    }
    const stem = stripped.split('.')[0].trimEnd()
    if (DEVICE_NAME.test(stem)) {
      throw new Error(`ACP file path names a reserved device: ${JSON.stringify(segment)}`)
    }
  })
}

/**
 * Resolve a requested path and reject lexical or symlink traversal outside the workspace.
 *
 * @param {string} requestedPath ACP file path.
 * @param {string} cwd Absolute session workspace.
 * @param {'read' | 'write'} operation File operation.
 * @param {boolean} allowOutsideWorkspace Whether the caller explicitly permits host-wide access.
 * @returns {Promise<string>} Canonical path for the file operation.
 */
export async function resolveWorkspacePath(requestedPath, cwd, operation, allowOutsideWorkspace) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new Error('ACP file path is missing')
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('ACP session workspace is not absolute')
  }
  if (allowOutsideWorkspace) return resolve(cwd, requestedPath)
  assertUnambiguousPath(requestedPath)
  const candidate = resolve(cwd, requestedPath)

  const workspace = await realpath(cwd)
  if (operation === 'read') {
    const target = await realpath(candidate)
    assertInside(workspace, target)
    return target
  }

  try {
    const target = await realpath(candidate)
    assertInside(workspace, target)
    return target
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const missing = [basename(candidate)]
  let ancestor = dirname(candidate)
  while (true) {
    try {
      const existing = await realpath(ancestor)
      assertInside(workspace, existing)
      const target = join(existing, ...missing)
      assertInside(workspace, target)
      return target
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

/** Containment by `path.relative`, which is case-insensitive on Windows. */
export function assertInside(workspace, target) {
  const rel = relative(workspace, target)
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (outside) {
    throw new Error(`ACP file path escapes the session workspace: ${target}`)
  }
}
