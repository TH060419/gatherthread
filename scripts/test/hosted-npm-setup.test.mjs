import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { prepareNpm } from '../../ops/hosted-agent/npm-setup.mjs';
import { HostedNpmProxy } from '../../apps/server/dist/src/hosted-npm-proxy.js';
const socketTest = process.platform === 'win32' ? test.skip : test;
socketTest('production npm setup installs a verified lockfile tarball, suppresses lifecycle scripts and restores original lock', async () => {
 const root = mkdtempSync(join(tmpdir(), 'gt-npm-real-test-')), workspace = join(root, 'workspace');
 const packageDir = join(root, 'package'); mkdirSync(packageDir); mkdirSync(workspace);
 const packageJson = JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'fixture-dependency': '1.0.0' }, scripts: { preinstall: "node -e \"require('fs').writeFileSync('unexpected-script', 'BAD')\"" } });
 writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', main: 'index.cjs' }));
 writeFileSync(join(packageDir, 'index.cjs'), 'module.exports = 17;\n');
 const tarPath = join(root, 'dependency.tgz'); assert.equal(spawnSync('tar', ['-czf', tarPath, '-C', root, 'package']).status, 0);
 const tarball = readFileSync(tarPath), integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
 const lock = JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0', dependencies: { 'fixture-dependency': '1.0.0' } },
   'node_modules/fixture-dependency': { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture-dependency/-/fixture-dependency-1.0.0.tgz', integrity } } });
 writeFileSync(join(workspace, 'package.json'), packageJson); writeFileSync(join(workspace, 'package-lock.json'), lock);
 const file = (path, content) => ({ path, content_base64: Buffer.from(content).toString('base64'), executable: false });
 let calls = 0;
 const proxy = new HostedNpmProxy([file('package.json', packageJson), file('package-lock.json', lock)], async (url) => {
   assert.equal(String(url), 'https://registry.npmjs.org/fixture-dependency/-/fixture-dependency-1.0.0.tgz'); calls++; return new Response(tarball);
 });
 const socketPath = join(root, 'npm.sock');
 // Local transport adapter exercises the production Unix proxy. No external registry request.
 const bridge = createServer((req, res) => { const upstream = request({ socketPath, path: req.url, method: req.method }, (response) => {
   res.writeHead(response.statusCode, response.headers); response.pipe(res);
 }); upstream.on('error', () => res.writeHead(502).end()); req.pipe(upstream); });
 try {
   await proxy.listen(socketPath); await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
   const address = bridge.address();
   const run = (command, args) => new Promise((resolve, reject) => {
     const child = spawn(command, args, { cwd: workspace, env: { PATH: process.env.PATH, HOME: root, CI: '1' } });
     let output = ''; child.stdout.on('data', (b) => { output += b.toString(); }); child.stderr.on('data', (b) => { output += b.toString(); });
     child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output)));
   });
   await prepareNpm(workspace, run, `http://127.0.0.1:${address.port}`, join(root, 'cache'));
   assert.ok(calls > 0); assert.equal(readFileSync(join(workspace, 'package-lock.json'), 'utf8'), lock);
   assert.equal(existsSync(join(workspace, 'unexpected-script')), false);
   const check = spawnSync(process.execPath, ['-e', "require('assert/strict').equal(require('fixture-dependency'), 17)"], { cwd: workspace });
   assert.equal(check.status, 0);
 } finally { bridge.closeAllConnections(); await new Promise((resolve) => bridge.close(resolve)); await proxy.close(); rmSync(root, { recursive: true, force: true }); }
});
