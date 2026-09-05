#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile, lstat, readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = process.cwd()
const execFileAsync = promisify(execFile)
const excludedDirectories = new Set(['.git', '.local', 'coverage', 'dist', 'node_modules', 'playwright-report', 'release-artifacts', 'test-results'])
const excludedFiles = new Set(['scripts/check-secrets.mjs'])
const textExtensions = new Set(['', '.cjs', '.css', '.env', '.example', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.sh', '.ts', '.tsx', '.txt', '.yaml', '.yml'])
const findings = []
const unexpectedTextControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['provider API key', /\bsk-(?:proj|live)-[A-Za-z0-9_-]{16,}\b/],
  ['assigned secret', /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
  ['environment secret', /^\s*[A-Z0-9_]*(?:PASSWORD|PASSWD|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|TOKEN_PEPPER)[A-Z0-9_]*\s*=\s*(?!\s*(?:$|\$\{|<|change|dummy|example|replace|test))\S{12,}/i],
]

async function gitVisibleFiles() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
  )
  return stdout.toString('utf8').split('\0').filter(Boolean)
}

async function archiveFiles(directory = root, prefix = '') {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (isExcluded(name) || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) files.push(...await archiveFiles(resolve(directory, entry.name), name))
    else if (entry.isFile()) files.push(name)
    if (files.length > 100_000) throw new Error('release archive contains too many files')
  }
  return files
}

function isExcluded(name) {
  return excludedFiles.has(name) || name.split(/[\\/]/).some((part) => excludedDirectories.has(part))
}

async function scanFile(name) {
  if (isExcluded(name) || !textExtensions.has(extname(name))) return
  const absolute = resolve(root, name)
  const info = await lstat(absolute)
  if (!info.isFile() || info.size > 1_000_000) return
  const bytes = await readFile(absolute)
  const text = bytes.toString('utf8')
  if (!bytes.equals(Buffer.from(text, 'utf8'))) {
    findings.push(`${name}: invalid UTF-8 in text source`)
    return
  }
  if (unexpectedTextControl.test(text)) {
    findings.push(`${name}: unexpected control byte in text source`)
    return
  }
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const [kind, pattern] of patterns) {
      if (pattern.test(line)) findings.push(`${name}:${index + 1}: possible ${kind}`)
    }
  }
}

let files
try {
  const gitMetadata = await lstat(resolve(root, '.git')).catch(() => null)
  files = gitMetadata ? await gitVisibleFiles() : await archiveFiles()
} catch {
  process.stderr.write('ERROR secrets: unable to enumerate files\n')
  process.exit(2)
}
await Promise.all(files.map(scanFile))
for (const finding of findings) process.stderr.write(`ERROR secrets: ${finding}\n`)
if (findings.length) process.exitCode = 1
else process.stdout.write('Secret pattern check passed\n')
