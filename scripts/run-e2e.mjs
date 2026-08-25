#!/usr/bin/env node
import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const specs = (await readdir(resolve(root, 'tests/e2e')))
  .filter((name) => name.endsWith('.spec.mjs'))
  .sort()
  .map((name) => resolve(root, 'tests/e2e', name))

if (!specs.length) throw new Error('No E2E spec files found')

let server

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = new Error(`health endpoint returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Server did not become healthy: ${lastError?.message ?? 'timeout'}`)
}

async function stopServer() {
  if (!server || server.exitCode !== null) return
  server.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveExit) => server.once('exit', resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
}

try {
  if (process.env.E2E_SERVER_COMMAND) {
    const shell = process.env.SHELL || '/bin/sh'
    server = spawn(shell, ['-lc', process.env.E2E_SERVER_COMMAND], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })
    server.once('exit', (code) => {
      if (code && code !== 0) process.stderr.write(`E2E server exited with code ${code}\n`)
    })
    if (!process.env.E2E_HEALTH_URL) {
      throw new Error('E2E_HEALTH_URL is required when E2E_SERVER_COMMAND is set')
    }
    await waitForHealth(process.env.E2E_HEALTH_URL, Number(process.env.E2E_STARTUP_TIMEOUT_MS || 60_000))
  }

  const testProcess = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...specs], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  const exitCode = await new Promise((resolveExit, reject) => {
    testProcess.once('error', reject)
    testProcess.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
  })
  process.exitCode = exitCode
} finally {
  await stopServer()
}
