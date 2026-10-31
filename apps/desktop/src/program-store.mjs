import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeProgramPath } from './program-discovery.mjs';

// Native preferences contain only up to two CLI locations, never credentials.
export class ProgramStore {
  constructor(file) { this.file = file; this.pending = Promise.resolve(); }
  async read() {
    let file;
    try {
      file = await open(this.file, 'r');
      if ((await file.stat()).size > 16_384) return {};
      const body = JSON.parse(await file.readFile('utf8'));
      if (body?.version !== 1 || !body.programs || typeof body.programs !== 'object' || Array.isArray(body.programs)
        || Object.keys(body).some(key => !['version', 'programs'].includes(key))) return {};
      for (const [key, value] of Object.entries(body.programs))
        if (!['codex', 'claude-code'].includes(key) || !safeProgramPath(value)) return {};
      return body.programs;
    } catch { return {}; } finally { await file?.close(); }
  }
  async get(harness) { await this.pending; return (await this.read())[harness]; }
  set(harness, selected) {
    if (!['codex', 'claude-code'].includes(harness) || !safeProgramPath(selected)) return Promise.resolve(false);
    const operation = this.pending.then(async () => {
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const programs = { ...await this.read(), [harness]: selected };
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, programs })); } finally { await file.close(); }
        await rename(temp, this.file); return true;
      } catch { return false; } finally { await unlink(temp).catch(() => {}); }
    });
    this.pending = operation.catch(() => false); return operation;
  }
}
