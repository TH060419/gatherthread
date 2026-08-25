#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const referencesPath = resolve(process.cwd(), 'docs/REFERENCES.md')
const source = await readFile(referencesPath, 'utf8')
const rows = source.split('\n').filter((line) => /^\| \[[^\]]+\]\(/.test(line))
const errors = []
const warnings = []
const projects = new Set()
const acceptedLicenseFormats = [
  /^(?:MIT|ISC|Apache-2\.0|BSD-[23]-Clause|MPL-2\.0|CC-BY-4\.0)$/,
  /^Apache-2\.0 code \/ CC-BY-4\.0 specification$/,
]

if (!rows.length) errors.push('No attribution table rows were found')

for (const [index, row] of rows.entries()) {
  const cells = row.split('|').slice(1, -1).map((cell) => cell.trim())
  if (cells.length !== 3) {
    errors.push(`row ${index + 1}: expected Project, What we study, License`)
    continue
  }
  const [projectCell, studied, license] = cells
  const project = projectCell.match(/^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/)
  if (!project) {
    errors.push(`row ${index + 1}: project must be a named HTTPS Markdown link`)
    continue
  }
  if (projects.has(project[1])) errors.push(`duplicate project: ${project[1]}`)
  projects.add(project[1])
  if (studied.length < 12) errors.push(`${project[1]}: study description is too vague`)
  if (!license) errors.push(`${project[1]}: license is missing`)
  else if (!acceptedLicenseFormats.some((pattern) => pattern.test(license))) {
    warnings.push(`${project[1]}: license needs an exact SPDX identifier or documented composite (${license})`)
  }
}

const adaptationFields = ['exact upstream path', 'commit', 'applicable license', 'modifications']
for (const field of adaptationFields) {
  if (!source.toLowerCase().includes(field)) errors.push(`adaptation policy is missing required field: ${field}`)
}

for (const message of warnings) process.stderr.write(`WARN references: ${message}\n`)
for (const message of errors) process.stderr.write(`ERROR references: ${message}\n`)

if (errors.length || (warnings.length && process.env.LICENSE_STRICT === '1')) {
  process.exitCode = 1
} else {
  process.stdout.write(`References check passed: ${rows.length} projects, ${warnings.length} review item(s)\n`)
}
