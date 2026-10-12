import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CloudApiPutInputSchema, CloudApiConfigurationSchema, type CloudApiConfiguration, type CloudApiPutInput,
  type CloudApiProviderId } from "@gatherthread/protocol";
import type { Actor, CollaborationDatabase } from "./database.js";
import { ApiError } from "./errors.js";
import type { HostedEndpoint } from "./hosted-agent-pool.js";

// Official fixed credential-free HTTPS APIs, verified 2026-10-12. User input
// cannot supply a URL, port, header, redirect, proxy or cloud IAM credential.
export const CLOUD_API_PROVIDERS = [
  { id: "openai", label: "OpenAI", transport: "openai-chat", base_url: "https://api.openai.com/v1", docs_url: "https://developers.openai.com/api/reference/resources/chat" },
  { id: "anthropic", label: "Anthropic", transport: "anthropic-messages", base_url: "https://api.anthropic.com/v1", docs_url: "https://platform.claude.com/docs/en/api/overview" },
  { id: "deepseek", label: "DeepSeek", transport: "openai-chat", base_url: "https://api.deepseek.com/v1", docs_url: "https://api-docs.deepseek.com/" },
  { id: "siliconflow-cn", label: "SiliconFlow CN", transport: "openai-chat", base_url: "https://api.siliconflow.cn/v1", docs_url: "https://docs.siliconflow.cn/docs/userguide/quickstart" },
  { id: "siliconflow-global", label: "SiliconFlow Global", transport: "openai-chat", base_url: "https://api.siliconflow.com/v1", docs_url: "https://docs.siliconflow.com/en/userguide/quickstart" },
  { id: "openrouter", label: "OpenRouter", transport: "openai-chat", base_url: "https://openrouter.ai/api/v1", docs_url: "https://openrouter.ai/docs/api_reference/overview" },
] as const;
export const PERSONAL_CLOUD_DAILY_RUNS = 100;
export const PERSONAL_CLOUD_GLOBAL_DAILY_RUNS = 1000;
const unavailable = () => new ApiError(400, "cloud_api_unavailable", "Personal API configuration is unavailable");
const changed = () => new ApiError(409, "cloud_api_changed", "Personal API configuration changed; select its latest version");
interface Row {
  id: string; user_id: string; revision: string; provider_id: CloudApiProviderId; label: string; model: string;
  enabled: number; key_ciphertext: string; updated_at: string;
}
export function isPersonalCloudProfile(id: string): boolean { return id.startsWith("api-"); }
export function cloudApiRunIsCurrent(database: CollaborationDatabase, requestId: string): boolean {
  const binding = database.sqlite.prepare("SELECT * FROM cloud_api_run_bindings WHERE request_event_id=?")
    .get(requestId) as { user_id: string; config_id: string; config_revision: string } | undefined;
  if (!binding) return true;
  return Boolean(database.sqlite.prepare("SELECT 1 FROM cloud_api_configs WHERE id=? AND user_id=? AND revision=? AND enabled=1")
    .get(binding.config_id, binding.user_id, binding.config_revision));
}

/** Account-owned write-only credentials. The operator key is independent of
 * identity pepper/GitHub keys and never enters API responses or executor files. */
export class CloudApiStore {
  private readonly key: Buffer | undefined;
  constructor(private readonly database: CollaborationDatabase, encryptionKey?: string) {
    if (encryptionKey !== undefined) {
      const key = Buffer.from(encryptionKey, "base64");
      if (key.length !== 32 || key.toString("base64") !== encryptionKey) throw new Error("Invalid personal API encryption configuration");
      this.key = key;
    }
  }
  status(actor: Actor) {
    this.database.assertActiveDevice(actor);
    const rows = this.database.sqlite.prepare("SELECT * FROM cloud_api_configs WHERE user_id=? ORDER BY updated_at DESC,id LIMIT 8")
      .all(actor.user_id) as unknown as Row[];
    return { enabled: this.key !== undefined, providers: [...CLOUD_API_PROVIDERS], configurations: rows.map(row => this.metadata(row)) };
  }
  private metadata(row: Row): CloudApiConfiguration {
    return CloudApiConfigurationSchema.parse({ id: row.id, revision: row.revision, provider_id: row.provider_id,
      profile_id: `api-${row.id}`, label: row.label, model: row.model, enabled: Boolean(row.enabled), has_key: true, updated_at: row.updated_at });
  }
  private aad(row: Omit<Row, "key_ciphertext">): Buffer {
    return Buffer.from(JSON.stringify(["gatherthread-personal-api-v1", row.user_id, row.id, row.revision,
      row.provider_id, row.model, row.label, row.enabled, row.updated_at]));
  }
  private seal(key: string, row: Omit<Row, "key_ciphertext">): string {
    if (!this.key) throw unavailable();
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad(row));
    return Buffer.concat([nonce, cipher.update(key, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
  }
  private open(row: Row): string {
    if (!this.key) throw unavailable();
    try {
      const bytes = Buffer.from(row.key_ciphertext, "base64"), decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAAD(this.aad(row)); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
    } catch { throw unavailable(); }
  }
  put(actor: Actor, id: string, raw: CloudApiPutInput): CloudApiConfiguration {
    const parsed = CloudApiPutInputSchema.safeParse(raw);
    if (!parsed.success || !z.string().uuid().safeParse(id).success) {
      throw new ApiError(400, "cloud_api_invalid", "Invalid personal API configuration");
    }
    const input = parsed.data;
    if (!this.key) throw unavailable();
    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.database.assertActiveDevice(actor);
      const old = this.database.sqlite.prepare("SELECT * FROM cloud_api_configs WHERE id=?").get(id) as unknown as Row | undefined;
      if (old && old.user_id !== actor.user_id) throw unavailable();
      if (old && old.provider_id !== input.provider_id && input.api_key === undefined) {
        throw new ApiError(400, "cloud_api_invalid", "Changing provider requires a new API key");
      }
      const oldKey = old ? this.open(old) : undefined;
      const apiKey = input.api_key ?? oldKey;
      if (!apiKey) throw new ApiError(400, "cloud_api_invalid", "A new personal API configuration requires an API key");
      // Labels/model IDs are returned to the browser and may appear in shared
      // provenance. Catch accidental key pastes without ever reflecting them.
      const visible = `${input.label}\n${input.model}`;
      if (visible.includes(apiKey) || oldKey !== undefined && visible.includes(oldKey)
        || /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+\S{8,})/iu.test(visible)) {
        throw new ApiError(400, "cloud_api_invalid", "Use a display label and model ID, not credentials");
      }
      const same = old && old.provider_id === input.provider_id && old.label === input.label && old.model === input.model
        && Boolean(old.enabled) === input.enabled && (() => { const a = Buffer.from(oldKey!), b = Buffer.from(apiKey);
          return a.length === b.length && timingSafeEqual(a, b); })();
      if (same && (input.expected_revision === old.revision || input.expected_revision === null)) {
        this.database.sqlite.exec("COMMIT"); return this.metadata(old);
      }
      if (old ? old.revision !== input.expected_revision : input.expected_revision !== null) throw changed();
      if (!old) {
        const count = this.database.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_api_configs WHERE user_id=?").get(actor.user_id)!;
        if (Number(count.count) >= 8) throw new ApiError(429, "cloud_api_limit", "Personal API configuration limit reached");
      }
      const row = { id, user_id: actor.user_id, revision: randomUUID(), provider_id: input.provider_id, label: input.label,
        model: input.model, enabled: input.enabled ? 1 : 0, updated_at: new Date().toISOString() };
      const ciphertext = this.seal(apiKey, row);
      this.database.sqlite.prepare(`INSERT INTO cloud_api_configs(id,user_id,revision,provider_id,label,model,enabled,key_ciphertext,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,provider_id=excluded.provider_id,
        label=excluded.label,model=excluded.model,enabled=excluded.enabled,key_ciphertext=excluded.key_ciphertext,updated_at=excluded.updated_at`)
        .run(id, actor.user_id, row.revision, row.provider_id, row.label, row.model, row.enabled, ciphertext, row.updated_at);
      this.database.sqlite.exec("COMMIT"); return this.metadata({ ...row, key_ciphertext: ciphertext });
    } catch (error) { this.database.sqlite.exec("ROLLBACK"); throw error; }
  }
  remove(actor: Actor, id: string, revision: string): void {
    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.database.assertActiveDevice(actor);
      const row = this.database.sqlite.prepare("SELECT revision FROM cloud_api_configs WHERE id=? AND user_id=?")
        .get(id, actor.user_id) as { revision: string } | undefined;
      if (!row) throw unavailable();
      if (row.revision !== revision) throw changed();
      this.database.sqlite.prepare("DELETE FROM cloud_api_configs WHERE id=? AND user_id=? AND revision=?").run(id, actor.user_id, revision);
      this.database.sqlite.exec("COMMIT");
    } catch (error) { this.database.sqlite.exec("ROLLBACK"); throw error; }
  }
  resolve(actor: Actor, profileId: string, revision: string | undefined): HostedEndpoint {
    this.database.assertActiveDevice(actor);
    if (!/^api-[0-9a-f-]{36}$/u.test(profileId)) throw unavailable();
    const row = this.database.sqlite.prepare("SELECT * FROM cloud_api_configs WHERE id=? AND user_id=? AND enabled=1")
      .get(profileId.slice(4), actor.user_id) as unknown as Row | undefined;
    if (!row || !this.key) throw unavailable();
    if (!revision || row.revision !== revision) throw changed();
    const preset = CLOUD_API_PROVIDERS.find(p => p.id === row.provider_id);
    if (!preset) throw unavailable();
    return { id: profileId, profileId, label: row.label, model: row.model, apiToken: this.open(row), baseUrl: preset.base_url,
      provider: preset.transport === "anthropic-messages" ? "anthropic" : row.provider_id === "deepseek" ? "deepseek" : "openai-compatible",
      transport: preset.transport, personal: { configId: row.id, configRevision: row.revision, userId: actor.user_id },
      quotaGroup: `personal-${createHmac("sha256", this.key).update(actor.user_id).digest("hex")}`,
      dailyRuns: PERSONAL_CLOUD_DAILY_RUNS, maxConcurrent: 1 };
  }
}
