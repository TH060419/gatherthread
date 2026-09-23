import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { DatabaseSync, backup } from 'node:sqlite'
import { backupCodeRepositories, verifyCodeBackup, assertBackupPath } from '../backup-code-repositories.mjs'
import { CollaborationDatabase } from '../../apps/server/dist/src/database.js'
import { CollaborationService } from '../../apps/server/dist/src/service.js'
import { CodeRepository } from '../../apps/server/dist/src/code-repository.js'

const pepper = 'code-backup-test-pepper-not-a-credential'
const file = (text) => ({ path: 'src/main.ts', content_base64: Buffer.from(text).toString('base64'), executable: false })
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gatherthread-code-backup-')))
  const databasePath = join(directory, 'source.db')
  const database = new CollaborationDatabase(databasePath, { authTokenPepper: pepper })
  const service = new CollaborationService(database)
  const owner = database.bootstrapIdentity({ display_name: 'Backup owner', device_name: 'Test' }).actor
  const project = service.createProject(owner, { title: 'Backup project', idempotency_key: 'project-backup' })
  const repository = new CodeRepository(database, `${databasePath}.code`)
  const enabled = repository.enable(owner, project.id, { idempotency_key: 'enable-backup' })
  const first = repository.checkpoint(owner, project.id, { base_commit: enabled.commit, files: [file('first checkpoint')], message: 'First', idempotency_key: 'backup-checkpoint' })
  return { directory, databasePath, database, service, owner, project, repository, first,
    close() { database.close(); rmSync(directory, { recursive: true, force: true }) } }
}
async function sqliteSnapshot(source, destination) {
  const sourceDb = new DatabaseSync(source, { readOnly: true })
  try { await backup(sourceDb, destination) }
  finally { sourceDb.close() }
}

test('managed Git backup uses SQLite snapshot heads even when live branches advance before packing', async () => {
  const f = fixture()
  try {
    const snapshot = join(f.directory, 'backup.db')
    await sqliteSnapshot(f.databasePath, snapshot)
    const expected = f.repository.snapshot(f.owner, f.project.id, f.first.status.own_branch_id)
    f.repository.checkpoint(f.owner, f.project.id, { base_commit: f.first.commit, files: [file('newer live change')], message: 'Later', idempotency_key: 'later-checkpoint' })
    assert.deepEqual(await backupCodeRepositories(f.databasePath, snapshot), { repositories: 1 })
    assert.deepEqual(await verifyCodeBackup(snapshot), { repositories: 1 })
    const restoredDb = new CollaborationDatabase(snapshot, { authTokenPepper: pepper })
    try {
      const restored = new CodeRepository(restoredDb, `${snapshot}.code`)
      assert.deepEqual(restored.snapshot(f.owner, f.project.id, f.first.status.own_branch_id), expected)
    } finally { restoredDb.close() }
    await assert.rejects(backupCodeRepositories(f.databasePath, snapshot), /EEXIST/u)
    // The core helper restore/corruption path runs on Windows too, without bash/sqlite3.
    const repository = join(`${snapshot}.code`, `${createHash('sha256').update(f.project.id).digest('hex')}.git`)
    const pack = readdirSync(join(repository, 'objects', 'pack')).find((name) => name.endsWith('.pack'))
    assert.ok(pack)
    unlinkSync(join(repository, 'objects', 'pack', pack))
    await assert.rejects(verifyCodeBackup(snapshot), /Git backup verification failed/u)
  } finally { f.close() }
})

const posixEntryTools = process.platform !== 'win32'
  && spawnSync('bash', ['--version']).status === 0 && spawnSync('sqlite3', ['--version']).status === 0
test('backup and verify POSIX entry scripts create complete companion storage and reject corrupted code', {
  skip: posixEntryTools ? false : 'POSIX entry smoke requires bash and sqlite3; core backup/restore runs independently',
}, async () => {
  const f = fixture()
  try {
    const result = spawnSync('bash', [resolve('scripts/backup-sqlite.sh'), f.databasePath, join(f.directory, 'backups')], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const snapshot = result.stdout.trim()
    assert.ok(existsSync(`${snapshot}.sha256`))
    assert.ok(!existsSync(`${snapshot}.incomplete`))
    assert.equal(spawnSync('bash', [resolve('scripts/verify-sqlite-backup.sh'), snapshot], { encoding: 'utf8' }).status, 0)
    const repository = join(`${snapshot}.code`, `${createHash('sha256').update(f.project.id).digest('hex')}.git`)
    const pack = readdirSync(join(repository, 'objects', 'pack')).find((name) => name.endsWith('.pack'))
    assert.ok(pack)
    unlinkSync(join(repository, 'objects', 'pack', pack))
    await assert.rejects(verifyCodeBackup(snapshot), /Git backup verification failed/u)
    assert.notEqual(spawnSync('bash', [resolve('scripts/verify-sqlite-backup.sh'), snapshot], { encoding: 'utf8' }).status, 0)
    assert.equal(f.repository.snapshot(f.owner, f.project.id, f.first.status.own_branch_id).snapshot.commit, f.first.commit)
  } finally { f.close() }
})

test('backup rejects source and parent symlinks', { skip: process.platform === 'win32' ? 'Creating symlinks requires optional Windows privileges' : false }, async () => {
  const f = fixture()
  try {
    const linked = join(f.directory, 'linked.db')
    symlinkSync(f.databasePath, linked)
    await assert.rejects(assertBackupPath(linked), /symbolic links/u)
    const linkDirectory = join(f.directory, 'linked-directory')
    symlinkSync(f.directory, linkDirectory)
    await assert.rejects(assertBackupPath(join(linkDirectory, 'source.db')), /symbolic links/u)
  } finally { f.close() }
})

test('backup fails closed for missing required code objects', async () => {
  const f = fixture()
  try {
    const snapshot = join(f.directory, 'backup.db')
    await sqliteSnapshot(f.databasePath, snapshot)
    const repository = join(`${f.databasePath}.code`, `${createHash('sha256').update(f.project.id).digest('hex')}.git`)
    const commitObject = join(repository, 'objects', f.first.commit.slice(0, 2), f.first.commit.slice(2))
    unlinkSync(commitObject)
    await assert.rejects(backupCodeRepositories(f.databasePath, snapshot), /Code object backup failed/u)
    assert.ok(existsSync(join(`${snapshot}.code`, '.incomplete')))
    await assert.rejects(verifyCodeBackup(snapshot), /incomplete/u)
  } finally { f.close() }
})

test('legacy database-only backups do not require or create Git companion directories', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gatherthread-legacy-backup-')))
  const path = join(directory, 'legacy.db')
  const database = new CollaborationDatabase(path, { authTokenPepper: pepper })
  try {
    const snapshot = join(directory, 'backup.db')
    await sqliteSnapshot(path, snapshot)
    assert.deepEqual(await backupCodeRepositories(path, snapshot), { repositories: 0 })
    assert.deepEqual(await verifyCodeBackup(snapshot), { repositories: 0 })
    assert.ok(!existsSync(`${snapshot}.code`))
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }) }
})
