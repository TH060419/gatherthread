#!/usr/bin/env node
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const installedRoot = resolve(root, 'node_modules')
const visited = new Set()
const packages = new Map()
const warnings = []
const errors = []

const allowed = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Python-2.0',
  'Unlicense',
  ...String(process.env.LICENSE_ALLOW || '').split(',').map((item) => item.trim()).filter(Boolean),
])
const denied = new Set([
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'BUSL-1.1',
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'SSPL-1.0',
  ...String(process.env.LICENSE_DENY || '').split(',').map((item) => item.trim()).filter(Boolean),
])

function licenseTokens(expression) {
  return String(expression || '')
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/i)
    .map((item) => item.trim())
    .filter(Boolean)
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function inspectPackage(packagePath) {
  let canonical
  try {
    canonical = await realpath(packagePath)
  } catch {
    return
  }
  if (visited.has(canonical)) return
  visited.add(canonical)

  try {
    const manifest = JSON.parse(await readFile(resolve(canonical, 'package.json'), 'utf8'))
    if (!manifest.private) {
      const key = `${manifest.name ?? canonical}@${manifest.version ?? 'unknown'}`
      packages.set(key, manifest.license ?? manifest.licenses ?? '')
    }
  } catch {
    // A pnpm wrapper or non-package directory; nested node_modules may still contain packages.
  }
  await scanNodeModules(resolve(canonical, 'node_modules'))
}

async function scanNodeModules(nodeModulesPath) {
  let entries
  try {
    entries = await readdir(nodeModulesPath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.bin') continue
    const entryPath = resolve(nodeModulesPath, entry.name)
    if (entry.name === '.pnpm') {
      for (const wrapper of await readdir(entryPath, { withFileTypes: true })) {
        if (wrapper.isDirectory()) await scanNodeModules(resolve(entryPath, wrapper.name, 'node_modules'))
      }
    } else if (entry.name.startsWith('@') && await isDirectory(entryPath)) {
      for (const scoped of await readdir(entryPath, { withFileTypes: true })) {
        if (scoped.isDirectory() || scoped.isSymbolicLink()) await inspectPackage(resolve(entryPath, scoped.name))
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      await inspectPackage(entryPath)
    }
  }
}

await scanNodeModules(installedRoot)

for (const [name, expression] of [...packages].sort(([left], [right]) => left.localeCompare(right))) {
  const tokens = licenseTokens(expression)
  if (!tokens.length) {
    warnings.push(`${name}: license metadata missing`)
  } else if (tokens.some((token) => denied.has(token))) {
    errors.push(`${name}: denied license ${expression}`)
  } else if (!tokens.every((token) => allowed.has(token) || token.endsWith('-exception'))) {
    warnings.push(`${name}: manual review required for ${expression}`)
  }
}

for (const message of warnings) process.stderr.write(`WARN licenses: ${message}\n`)
for (const message of errors) process.stderr.write(`ERROR licenses: ${message}\n`)

if (errors.length || (warnings.length && process.env.LICENSE_STRICT === '1')) {
  process.exitCode = 1
} else {
  process.stdout.write(`Dependency license check passed: ${packages.size} installed package(s), ${warnings.length} review item(s)\n`)
}
