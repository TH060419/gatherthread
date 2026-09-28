#!/usr/bin/env node
// Linux ECS runs this under the shared Git maintenance flock. SQLite heads,
// not derived refs, decide reachability. Test on a disposable backup first.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, readdir, rm } from 'node:fs/promises'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { assertBackupPath } from './backup-code-repositories.mjs'

const MAX_REPOSITORIES = 8192
const MAX_BRANCHES = 128
const MAX_ENTRIES = 100_000
const RETENTION_MS = 13 * 24 * 60 * 60 * 1000
const REPOSITORY_NAME = /^[a-f0-9]{64}\.git$/u
const COMMIT = /^[a-f0-9]{40}$/u
const BRANCH = /^gt\/[a-f0-9]{24}$/u
const TEMPORARY_INDEX = /^\.index-[A-Za-z0-9]+$/u

function git(directory, args, input) {
  const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: process.platform === 'win32' ? 'NUL' : devNull,
    GIT_CONFIG_KEY_1: 'core.attributesFile', GIT_CONFIG_VALUE_1: process.platform === 'win32' ? 'NUL' : devNull }
  const result = spawnSync('git', [`--git-dir=${directory}`, ...args], {
    env, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
  })
  if (result.error || result.status !== 0) throw new Error(`Git maintenance failed: ${args[0]}`)
  return result.stdout.trim()
}

async function rejectUnsafeEntries(directory) {
  const pending = [directory]
  let count = 0
  while (pending.length) {
    const path = pending.pop()
    const info = await lstat(path)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || ++count > MAX_ENTRIES) {
      throw new Error('Code repository contains an unsafe or oversized entry tree')
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) pending.push(join(path, entry))
    }
  }
  for (const name of ['alternates', 'http-alternates']) {
    try { await lstat(join(directory, 'objects', 'info', name)) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error('External Git object stores are not supported')
  }
}

export async function pruneCodeObjects(databasePath, codeRoot = `${databasePath}.code`, now = Date.now()) {
  const database = await assertBackupPath(databasePath)
  const root = await assertBackupPath(codeRoot)
  // The caller holds the shared Git maintenance flock. Read one consistent
  // SQLite snapshot, then release the transaction before filesystem scans and
  // Git GC. A concurrent mutation cannot write Git objects while we hold the
  // flock; a metadata-only deletion may leave extra objects until next run.
  const sql = new DatabaseSync(database)
  sql.exec('PRAGMA busy_timeout=1000')
  let repositories
  let branches
  let deletions
  try {
    sql.exec('BEGIN')
    repositories = sql.prepare('SELECT project_id,main_commit FROM code_repositories ORDER BY project_id').all()
    branches = sql.prepare('SELECT project_id,name,head_commit FROM code_branches ORDER BY project_id,name').all()
    deletions = sql.prepare('SELECT repository_hash,deleted_at FROM code_repository_deletions').all()
    sql.exec('COMMIT')
  } catch (error) {
    if (sql.isTransaction) sql.exec('ROLLBACK')
    sql.close()
    throw error
  }
  try {
  if (repositories.length > MAX_REPOSITORIES || branches.length > MAX_REPOSITORIES * MAX_BRANCHES) {
    throw new Error('Code repository maintenance exceeds supported bounds')
  }
  const live = new Map(repositories.map((repository) => [
    `${createHash('sha256').update(repository.project_id).digest('hex')}.git`, repository,
  ]))
  const deletedAt = new Map(deletions.map((row) => [row.repository_hash, Date.parse(row.deleted_at)]))
  let compacted = 0
  let removed = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.maintenance.lock') continue
    if (TEMPORARY_INDEX.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe temporary code index')
      const temporary = await assertBackupPath(join(root, entry.name))
      await rejectUnsafeEntries(temporary)
      if (now - (await lstat(temporary)).mtimeMs >= RETENTION_MS) {
        await rm(temporary, { recursive: true, force: false })
        removed += 1
      }
      continue
    }
    if (!REPOSITORY_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Unexpected entry in private code repository storage')
    }
    const directory = await assertBackupPath(join(root, entry.name))
    await rejectUnsafeEntries(directory)
    const repository = live.get(entry.name)
    if (!repository) {
      const tombstoneTime = deletedAt.get(entry.name.slice(0, -4))
      const lastChange = (await lstat(directory)).mtimeMs
      const deadlineBase = tombstoneTime ?? lastChange
      if (!Number.isFinite(deadlineBase)) throw new Error('Invalid deleted repository timestamp')
      if (now - deadlineBase >= RETENTION_MS) {
        // A project ID may be reused after deletion. Recheck the live DB
        // before removal; the caller's flock prevents a new Git enable from
        // completing between this check and the filesystem operation.
        const currentlyLive = sql.prepare('SELECT project_id FROM code_repositories').all()
          .some((row) => `${createHash('sha256').update(row.project_id).digest('hex')}.git` === entry.name)
        if (currentlyLive) continue
        await rm(directory, { recursive: true, force: false })
        removed += 1
      }
      continue
    }
    const heads = [{ name: 'main', commit: repository.main_commit },
      ...branches.filter((branch) => branch.project_id === repository.project_id)
        .map((branch) => ({ name: branch.name, commit: branch.head_commit }))]
    if (heads.length > MAX_BRANCHES + 1 || heads.some((head) => !COMMIT.test(head.commit)
      || (head.name !== 'main' && !BRANCH.test(head.name)))) {
      throw new Error('Invalid authoritative SQLite code head')
    }
    for (const head of heads) git(directory, ['cat-file', '-e', `${head.commit}^{commit}`])
    const current = git(directory, ['for-each-ref', '--format=%(refname)'])
      .split('\n').filter(Boolean)
    if (current.some((ref) => !/^refs\/heads\/(?:main|gt\/[a-f0-9]{24})$/u.test(ref))) {
      throw new Error('Unknown Git ref; refusing to prune')
    }
    const desired = new Set(heads.map((head) => `refs/heads/${head.name}`))
    git(directory, ['update-ref', '--stdin'], `${[
      ...heads.map((head) => `update refs/heads/${head.name} ${head.commit}`),
      ...current.filter((ref) => !desired.has(ref)).map((ref) => `delete ${ref}`),
    ].join('\n')}\n`)
    git(directory, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])
    git(directory, ['gc', '--prune=13.days.ago'])
    for (const head of heads) git(directory, ['cat-file', '-e', `${head.commit}^{commit}`])
    compacted += 1
  }
  return { compacted, removed }
  } catch (error) {
    if (sql.isTransaction) sql.exec('ROLLBACK')
    throw error
  } finally { sql.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    process.stderr.write('usage: prune-code-objects.mjs DATABASE_PATH\n')
    process.exitCode = 64
  } else {
    pruneCodeObjects(process.argv[2]).then((result) => {
      process.stdout.write(`code maintenance: ${result.compacted} live repositories, ${result.removed} expired deleted repositories\n`)
    }).catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
  }
}
