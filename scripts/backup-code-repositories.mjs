#!/usr/bin/env node
// Immutable Git objects are packed from SQLite snapshot heads, never live refs.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, writeFile, unlink } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { devNull } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const MAX_REPOSITORIES = 8192
const MAX_BRANCHES = 128
const TIMEOUT_MS = 120_000

export async function assertBackupPath(path, allowMissing = false) {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  const components = absolute.slice(root.length).split(/[\\/]/u).filter(Boolean)
  for (const [index, component] of components.entries()) {
    current = join(current, component)
    let info
    try { info = await lstat(current) } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return absolute
      throw new Error('Backup source or destination is unavailable')
    }
    if (info.isSymbolicLink() || (index < components.length - 1 && !info.isDirectory())) {
      throw new Error('Backup paths and their parents must not contain symbolic links or non-directories')
    }
  }
  return absolute
}

function gitEnvironment() {
  return {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: devNull,
    GIT_CONFIG_KEY_1: 'core.attributesFile', GIT_CONFIG_VALUE_1: devNull,
  }
}

function startGit(directory, args) {
  const child = spawn('git', [`--git-dir=${directory}`, ...args], { env: gitEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let outputBytes = 0
  const timeout = setTimeout(() => child.kill(), TIMEOUT_MS)
  child.stderr.on('data', (data) => { outputBytes += data.length; if (outputBytes > 256 * 1024) child.kill() })
  const completed = new Promise((resolveChild, reject) => {
    child.once('error', () => reject(new Error('Git backup process could not start')))
    child.once('close', (code) => code === 0 ? resolveChild() : reject(new Error('Git backup verification failed; keep the original data and retry')))
  }).finally(() => clearTimeout(timeout))
  // Attach a handler immediately; callers await this promise after stream piping.
  completed.catch(() => {})
  return { child, completed }
}

async function git(directory, args, input = '', expectedOutput) {
  const process = startGit(directory, args)
  let output = ''
  if (expectedOutput !== undefined) process.child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8')
    if (Buffer.byteLength(output) > 128 * 1024) process.child.kill()
  })
  else process.child.stdout.resume()
  process.child.stdin.on('error', () => {})
  process.child.stdin.end(input)
  await process.completed
  if (expectedOutput !== undefined && output.trim() !== expectedOutput.trim()) throw new Error('Backup Git refs do not match the SQLite snapshot')
}

async function rejectRepositoryLinks(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Git backup refuses linked repository files')
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await rejectRepositoryLinks(path)
    else if (!entry.isFile()) throw new Error('Git backup accepts only regular repository files')
  }
  for (const name of ['alternates', 'http-alternates']) {
    try { await lstat(join(directory, 'objects', 'info', name)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error('Git backup refuses external object stores')
  }
}

/** Online-safe while managed storage stays append-only and no external GC runs. */
export async function backupCodeRepositories(sourceDatabase, backupDatabase, sourceCodeDirectory) {
  const original = await assertBackupPath(sourceDatabase)
  const snapshot = await assertBackupPath(backupDatabase)
  if (original === snapshot) throw new Error('Backup must use a distinct SQLite snapshot')
  const db = new DatabaseSync(snapshot, { readOnly: true })
  let repositories
  let branches
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='code_repositories'").get()) return { repositories: 0 }
    repositories = db.prepare('SELECT project_id,main_commit FROM code_repositories ORDER BY project_id').all()
    branches = db.prepare('SELECT project_id,name,head_commit FROM code_branches ORDER BY project_id,name').all()
  } finally { db.close() }
  if (!repositories.length) return { repositories: 0 }
  if (repositories.length > MAX_REPOSITORIES || branches.length > MAX_REPOSITORIES * MAX_BRANCHES) throw new Error('Code backup exceeds the supported repository bounds')
  const source = await assertBackupPath(sourceCodeDirectory || `${original}.code`)
  if (!(await lstat(source)).isDirectory()) throw new Error('Code backup source is not a directory')
  const destination = await assertBackupPath(`${snapshot}.code`, true)
  await mkdir(destination, { mode: 0o700 }) // New destination only; never overwrite.
  await writeFile(join(destination, '.incomplete'), 'Code backup incomplete\n', { flag: 'wx', mode: 0o600 })
  for (const repository of repositories) {
    const heads = [{ name: 'main', commit: repository.main_commit }, ...branches.filter((branch) => branch.project_id === repository.project_id).map((branch) => ({ name: branch.name, commit: branch.head_commit }))]
    if (heads.length > MAX_BRANCHES + 1 || heads.some((head) => !/^[a-f0-9]{40}$/u.test(head.commit) || !/^(?:main|gt\/[a-f0-9]{24})$/u.test(head.name))) throw new Error('SQLite snapshot contains invalid code references')
    const name = `${createHash('sha256').update(repository.project_id).digest('hex')}.git`
    const from = await assertBackupPath(join(source, name))
    await rejectRepositoryLinks(from)
    const to = join(destination, name)
    await mkdir(to, { mode: 0o700 })
    await git(to, ['init', '--bare', '--initial-branch=main', to])
    const pack = startGit(from, ['pack-objects', '--revs', '--stdout'])
    const unpack = startGit(to, ['index-pack', '--stdin', '--strict'])
    unpack.child.stdout.resume()
    pack.child.stdin.on('error', () => {})
    pack.child.stdin.end(`${[...new Set(heads.map((head) => head.commit))].join('\n')}\n`)
    try {
      await Promise.all([pipeline(pack.child.stdout, unpack.child.stdin), pack.completed, unpack.completed])
    } catch {
      pack.child.kill()
      unpack.child.kill()
      throw new Error('Code object backup failed; this backup is incomplete')
    }
    await git(to, ['update-ref', '--stdin'], `${heads.map((head) => `update refs/heads/${head.name} ${head.commit}`).join('\n')}\n`)
    await git(to, ['fsck', '--strict', '--no-dangling'])
  }
  await unlink(join(destination, '.incomplete'))
  return { repositories: repositories.length }
}

export async function verifyCodeBackup(backupDatabase) {
  const snapshot = await assertBackupPath(backupDatabase)
  for (const marker of [`${snapshot}.incomplete`, join(`${snapshot}.code`, '.incomplete')]) {
    try { await lstat(marker) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error('Backup is marked incomplete')
  }
  const db = new DatabaseSync(snapshot, { readOnly: true })
  let repositories
  let branches
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='code_repositories'").get()) return { repositories: 0 }
    repositories = db.prepare('SELECT project_id,main_commit FROM code_repositories ORDER BY project_id').all()
    branches = db.prepare('SELECT project_id,name,head_commit FROM code_branches ORDER BY project_id,name').all()
  } finally { db.close() }
  if (!repositories.length) return { repositories: 0 }
  if (repositories.length > MAX_REPOSITORIES || branches.length > MAX_REPOSITORIES * MAX_BRANCHES) throw new Error('Code backup exceeds supported bounds')
  const directory = await assertBackupPath(`${snapshot}.code`)
  for (const repository of repositories) {
    const heads = [{ name: 'main', commit: repository.main_commit }, ...branches.filter((branch) => branch.project_id === repository.project_id).map((branch) => ({ name: branch.name, commit: branch.head_commit }))]
    if (heads.length > MAX_BRANCHES + 1 || heads.some((head) => !/^[a-f0-9]{40}$/u.test(head.commit) || !/^(?:main|gt\/[a-f0-9]{24})$/u.test(head.name))) throw new Error('SQLite snapshot contains invalid code references')
    const path = await assertBackupPath(join(directory, `${createHash('sha256').update(repository.project_id).digest('hex')}.git`))
    await rejectRepositoryLinks(path)
    const refs = heads.map((head) => `refs/heads/${head.name} ${head.commit}`).sort().join('\n')
    await git(path, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], '', refs)
    await git(path, ['fsck', '--strict', '--no-dangling'])
  }
  return { repositories: repositories.length }
}

async function main() {
  const [mode, source, target, sourceCode] = process.argv.slice(2)
  if (mode === '--verify' && source) return verifyCodeBackup(source)
  if (!source || !target || !['--check-paths', '--copy'].includes(mode)) throw new Error('Usage: backup-code-repositories.mjs --verify BACKUP_DB or --check-paths|--copy SOURCE_DB BACKUP_PATH [SOURCE_CODE_DIRECTORY]')
  if (mode === '--check-paths') {
    await assertBackupPath(source)
    await assertBackupPath(target, true)
    if (sourceCode) await assertBackupPath(sourceCode)
  } else await backupCodeRepositories(source, target, sourceCode)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
