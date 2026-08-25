#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'

const root = process.cwd()
const excludedDirectories = new Set(['.git', '.local', 'coverage', 'dist', 'node_modules', 'playwright-report', 'test-results'])
const excludedFiles = new Set(['scripts/check-secrets.mjs'])
const textExtensions = new Set(['', '.cjs', '.css', '.env', '.example', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.sh', '.ts', '.tsx', '.txt', '.yaml', '.yml'])
const findings = []
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['provider API key', /\bsk-(?:proj|live)-[A-Za-z0-9_-]{16,}\b/],
  ['assigned secret', /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
  ['environment secret', /^\s*[A-Z0-9_]*(?:PASSWORD|PASSWD|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|TOKEN_PEPPER)[A-Z0-9_]*\s*=\s*(?!\s*(?:$|\$\{|<|change|dummy|example|replace|test))\S{12,}/i],
]

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue
    const absolute = resolve(directory, entry.name)
    const name = relative(root, absolute)
    if (entry.isDirectory()) {
      await walk(absolute)
      continue
    }
    if (!entry.isFile() || excludedFiles.has(name) || !textExtensions.has(extname(entry.name))) continue
    if ((await stat(absolute)).size > 1_000_000) continue
    const lines = (await readFile(absolute, 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      for (const [kind, pattern] of patterns) {
        if (pattern.test(line)) findings.push(`${name}:${index + 1}: possible ${kind}`)
      }
    }
  }
}

await walk(root)
for (const finding of findings) process.stderr.write(`ERROR secrets: ${finding}\n`)
if (findings.length) process.exitCode = 1
else process.stdout.write('Secret pattern check passed\n')
