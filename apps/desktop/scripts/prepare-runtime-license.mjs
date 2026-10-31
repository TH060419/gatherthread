import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = new URL('../../../.local/desktop-build/', import.meta.url);
if (!/^v24\./u.test(process.version)) throw new Error('Use Node 24 to prepare the bundled runtime license.');
const source = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`Cannot retrieve the official matching Node license: HTTP ${response.status}`);
const license = await response.text();
if (license.length > 500_000 || !license.startsWith('Node.js is licensed for use as follows:')) throw new Error('Invalid Node license');
await mkdir(directory, { recursive: true });
await writeFile(new URL('Node-LICENSE.txt', directory), license);
await writeFile(new URL('runtime-license.json', directory), JSON.stringify({ version: process.version, source,
  sha256: createHash('sha256').update(license).digest('hex') }, null, 2));
console.log(`Prepared official license for ${process.version}; no executable downloaded.`);
