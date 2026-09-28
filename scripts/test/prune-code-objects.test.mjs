import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CollaborationDatabase } from '../../apps/server/dist/src/database.js'
import { CollaborationService } from '../../apps/server/dist/src/service.js'
import { CodeRepository } from '../../apps/server/dist/src/code-repository.js'
import { pruneCodeObjects } from '../prune-code-objects.mjs'

test('code retention keeps authoritative heads, prunes old loose garbage, and retires expired deleted projects', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gatherthread-code-retention-')))
  const databasePath = join(directory, 'server.sqlite')
  const codeRoot = `${databasePath}.code`
  const database = new CollaborationDatabase(databasePath, {
    authTokenPepper: 'code-retention-test-pepper-not-a-credential',
  })
  try {
    const service = new CollaborationService(database)
    const owner = database.bootstrapIdentity({ display_name: 'Owner', device_name: 'Laptop' }).actor
    const repository = new CodeRepository(database, codeRoot)
    const live = service.createProject(owner, { title: 'Live', idempotency_key: 'retention-live-project' })
    const deleted = service.createProject(owner, { title: 'Deleted', idempotency_key: 'retention-deleted-project' })
    repository.enable(owner, live.id, { idempotency_key: 'retention-live-enable' })
    repository.enable(owner, deleted.id, { idempotency_key: 'retention-deleted-enable' })
    const livePath = join(codeRoot, `${createHash('sha256').update(live.id).digest('hex')}.git`)
    const deletedHash = createHash('sha256').update(deleted.id).digest('hex')
    const deletedPath = join(codeRoot, `${deletedHash}.git`)
    const extra = spawnSync('git', [`--git-dir=${livePath}`, 'hash-object', '-w', '--stdin'], {
      input: 'old unreachable object', encoding: 'utf8',
    })
    assert.equal(extra.status, 0, extra.stderr)
    const hash = extra.stdout.trim()
    const object = join(livePath, 'objects', hash.slice(0, 2), hash.slice(2))
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    utimesSync(object, old, old)
    service.deleteProject(owner, deleted.id)
    database.sqlite.prepare('UPDATE code_repository_deletions SET deleted_at=? WHERE repository_hash=?')
      .run(old.toISOString(), deletedHash)
    const crashedIndex = mkdtempSync(join(codeRoot, '.index-'))
    writeFileSync(join(crashedIndex, 'blob-0'), 'abandoned private source')
    utimesSync(crashedIndex, old, old)
    database.sqlite.exec('BEGIN IMMEDIATE')
    try {
      assert.deepEqual(await pruneCodeObjects(databasePath), { compacted: 1, removed: 2 })
      assert.equal(existsSync(crashedIndex), false, 'abandoned plaintext index is retired')
    } finally { database.sqlite.exec('ROLLBACK') }
    assert.deepEqual(await pruneCodeObjects(databasePath), { compacted: 1, removed: 0 })
    assert.equal(existsSync(livePath), true)
    assert.equal(existsSync(deletedPath), false)
    assert.equal(spawnSync('git', [`--git-dir=${livePath}`, 'cat-file', '-e', hash]).status, 1)
    const head = database.sqlite.prepare('SELECT main_commit FROM code_repositories WHERE project_id=?')
      .get(live.id).main_commit
    assert.equal(spawnSync('git', [`--git-dir=${livePath}`, 'cat-file', '-e', `${head}^{commit}`]).status, 0)
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
