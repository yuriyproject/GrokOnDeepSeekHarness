/** Detect a workspace path that lives inside a cloud-sync client folder. */

const EXACT_SEGMENTS = new Set([
  'onedrive',
  'dropbox',
  'icloud drive',
  'iclouddrive',
  'google drive',
  'googledrive',
  'yandex.disk',
  'yandexdisk',
  'яндекс.диск',
  'nextcloud',
  'box',
  'box sync',
  'mega',
  'pcloud drive',
])

export function isCloudSyncedPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  for (const segment of path.split(/[/\\]/)) {
    const name = segment.toLowerCase()
    if (EXACT_SEGMENTS.has(name)) return true
    if (name.startsWith('onedrive - ') || name.startsWith('onedrive-') || name.startsWith('dropbox (')) return true
  }
  return false
}
