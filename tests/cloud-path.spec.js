import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isCloudSyncedPath } from '../lib/cloud-path.js'
import { snapshotFor } from '../lib/web-route.js'

function snapshot(cwd, preset = 'grok-build') {
  return snapshotFor(
    {},
    { id: 's', header: cwd === undefined ? undefined : { cwd }, snapshotEvents: () => [] },
    { recordFor: () => undefined, lastDsh: () => 'standard' },
    { config: { command: 'grok' }, models: [] },
    () => preset,
  )
}

describe('cloud-synced workspace paths', () => {
  it('matches a cloud client folder as its own path segment', () => {
    assert.equal(isCloudSyncedPath('C:\\Users\\me\\OneDrive\\Документы\\x'), true)
    assert.equal(isCloudSyncedPath('C:\\Users\\me\\OneDrive - Contoso\\p'), true)
    assert.equal(isCloudSyncedPath('C:/Users/me/OneDrive-Personal/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/Dropbox/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/Dropbox (Personal)/p'), true)
    assert.equal(isCloudSyncedPath('D:\\Яндекс.Диск\\docs'), true)
    assert.equal(isCloudSyncedPath('/home/me/Yandex.Disk/docs'), true)
    assert.equal(isCloudSyncedPath('/home/me/YandexDisk/docs'), true)
    assert.equal(isCloudSyncedPath('/home/me/Google Drive/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/GoogleDrive/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/iCloud Drive/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/iCloudDrive/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/Nextcloud/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/box/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/Box Sync/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/MEGA/p'), true)
    assert.equal(isCloudSyncedPath('/home/me/pCloud Drive/p'), true)
  })

  it('ignores names that only contain a cloud folder, and Apple container paths', () => {
    assert.equal(isCloudSyncedPath('C:\\Users\\me\\mybox\\x'), false)
    assert.equal(isCloudSyncedPath('/home/me/dropbox-notes/p'), false)
    assert.equal(isCloudSyncedPath('/home/me/my-onedrive-backup/p'), false)
    assert.equal(isCloudSyncedPath('/home/me/Documents/project'), false)
    assert.equal(isCloudSyncedPath('/Users/me/Library/Mobile Documents/com~apple~CloudDocs'), false)
    assert.equal(isCloudSyncedPath('C:\\Users\\me\\boxes\\x'), false)
    assert.equal(isCloudSyncedPath('/home/me/megaupload/p'), false)
    assert.equal(isCloudSyncedPath('/home/me/nextcloud-client/p'), false)
  })

  it('returns false for empty and non-string input', () => {
    assert.equal(isCloudSyncedPath(''), false)
    assert.equal(isCloudSyncedPath(undefined), false)
    assert.equal(isCloudSyncedPath(null), false)
    assert.equal(isCloudSyncedPath(0), false)
    assert.equal(isCloudSyncedPath({}), false)
  })
})

describe('snapshot workspaceSynced', () => {
  it('reports a cloud-synced cwd on the grok object', () => {
    assert.equal(snapshot('C:\\Users\\me\\OneDrive\\Документы\\x').grok.workspaceSynced, true)
    assert.equal(snapshot('/home/me/src').grok.workspaceSynced, false)
    assert.equal(snapshot(undefined).grok.workspaceSynced, false)
    assert.equal(snapshot('/home/me/Dropbox/p', 'standard').grok.workspaceSynced, true)
  })
})
