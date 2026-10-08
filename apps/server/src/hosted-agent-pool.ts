import { z } from "zod";

export const HOSTED_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
// Reviewed on 2026-10-08 against SiliconFlow's zero input/output pricing and
// Tools capability labels. Pricing/availability must be reconfirmed before use.
// Existing endpoint/profile IDs and the default first model remain stable.
const SILICONFLOW_FREE_CATALOG = [
  { id: "sf-free-1", profileId: "sf-qwen35-4b", label: "Qwen3.5-4B", model: "Qwen/Qwen3.5-4B" },
  { id: "sf-free-2", profileId: "sf-qwen3-8b", label: "Qwen3-8B", model: "Qwen/Qwen3-8B" },
  { id: "sf-free-3", profileId: "sf-qwen25-7b", label: "Qwen2.5-7B-Instruct", model: "Qwen/Qwen2.5-7B-Instruct" },
  { id: "sf-free-4", profileId: "sf-glm4-9b-0414", label: "GLM-4-9B-0414", model: "THUDM/GLM-4-9B-0414" },
  { id: "sf-free-5", profileId: "sf-glmz1-9b-0414", label: "GLM-Z1-9B-0414", model: "THUDM/GLM-Z1-9B-0414" },
  { id: "sf-free-6", profileId: "sf-xing40-29b", label: "Xing4.0-29B", model: "XingChenAGI/Xing4.0-29B" },
] as const;
export const SILICONFLOW_FREE_MODELS = SILICONFLOW_FREE_CATALOG.map((entry) => entry.model);
export const HOSTED_USER_MIN_INTERVAL_SECONDS = 30;
export const HOSTED_USER_MAX_CONCURRENT = 1;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u);
const line = z.string().trim().min(1).max(160).regex(/^[^\r\n\u0000]+$/u);
const endpointSchema = z.object({
  id, profile_id: id, label: line,
  provider: z.enum(["cloudflare-workers-ai", "deepseek", "openai-compatible"]),
  model: line, token_env: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/u),
  account_id: z.string().regex(/^[a-f0-9]{32}$/iu).optional(),
  base_url: z.string().url().optional(), quota_group: id.optional(),
  daily_runs: z.number().int().min(1).max(10_000).nullable(),
  max_concurrent: z.number().int().min(1).max(8),
  free_plan_confirmed: z.boolean().optional(),
}).strict();

export interface HostedEndpoint {
  id: string; profileId: string; label: string;
  provider: "cloudflare-workers-ai" | "deepseek" | "openai-compatible";
  model: string; baseUrl: string; apiToken: string; quotaGroup: string;
  dailyRuns: number | null; maxConcurrent: number;
}

export function isSiliconFlowFreeEndpoint(endpoint: Pick<HostedEndpoint, "provider" | "baseUrl" | "model">): boolean {
  return endpoint.provider === "openai-compatible" && endpoint.baseUrl === "https://api.siliconflow.cn/v1"
    && SILICONFLOW_FREE_MODELS.some((model) => model === endpoint.model);
}

/** Private reviewed-model selection; never accepts provider URLs or paid IDs. */
function siliconFlowFreeSelection(raw: string | undefined): typeof SILICONFLOW_FREE_CATALOG[number][] {
  if (raw === undefined) return [...SILICONFLOW_FREE_CATALOG];
  if (Buffer.byteLength(raw, "utf8") > 1024) throw new Error("invalid free-model selection");
  const input: unknown = JSON.parse(raw);
  if (!Array.isArray(input) || input.length < 1 || input.length > SILICONFLOW_FREE_CATALOG.length
    || input.some((model) => typeof model !== "string" || !SILICONFLOW_FREE_MODELS.some((known) => known === model))
    || new Set(input).size !== input.length) throw new Error("invalid free-model selection");
  // Operator input order cannot accidentally change the established default.
  return SILICONFLOW_FREE_CATALOG.filter((entry) => input.includes(entry.model));
}

/** Reviewed zero-price candidates only; activation still requires a real provider test. */
export function siliconFlowFreePreset(maxConcurrent: number, freePlanConfirmed: boolean, selectedModelsRaw?: string): string {
  return JSON.stringify(siliconFlowFreeSelection(selectedModelsRaw).map((entry) => ({
    id: entry.id, profile_id: entry.profileId,
    label: entry.label, provider: "openai-compatible", model: entry.model,
    base_url: "https://api.siliconflow.cn/v1", token_env: "GATHERTHREAD_SILICONFLOW_API_KEY",
    quota_group: "siliconflow-primary", daily_runs: null, max_concurrent: maxConcurrent,
    free_plan_confirmed: freePlanConfirmed,
  })));
}

/** Operator configuration only. Never return these records over HTTP. */
export function parseHostedEndpoints(raw: string, env: NodeJS.ProcessEnv): HostedEndpoint[] {
  const inputs = z.array(endpointSchema).min(1).max(32).parse(JSON.parse(raw));
  const endpoints: HostedEndpoint[] = inputs.map((item) => {
    const apiToken = env[item.token_env]?.trim();
    if (!apiToken || /[\r\n]/u.test(apiToken)) throw new Error("missing provider credential");
    if (item.provider === "cloudflare-workers-ai" && (!item.account_id || !item.free_plan_confirmed
      || item.model !== HOSTED_MODEL || item.daily_runs === null || item.daily_runs > 4 || item.base_url || item.quota_group)) {
      throw new Error("invalid Cloudflare Free endpoint");
    }
    if (item.provider === "deepseek" && (item.base_url || item.account_id)) throw new Error("invalid DeepSeek endpoint");
    if (item.provider !== "cloudflare-workers-ai" && !item.quota_group) throw new Error("quota group required");
    const baseUrl = item.provider === "cloudflare-workers-ai"
      ? `https://api.cloudflare.com/client/v4/accounts/${item.account_id!.toLowerCase()}/ai/v1`
      : item.provider === "deepseek" ? "https://api.deepseek.com/v1" : item.base_url;
    if (!baseUrl) throw new Error("base URL required");
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("provider URL must be credential-free HTTPS");
    }
    if (item.daily_runs === null && (!item.free_plan_confirmed || !isSiliconFlowFreeEndpoint({
      provider: item.provider, model: item.model, baseUrl: baseUrl.replace(/\/+$/u, ""),
    }))) throw new Error("unlimited runs require a confirmed zero-price model");
    return { id: item.id, profileId: item.profile_id, label: item.label, provider: item.provider,
      model: item.model, baseUrl: baseUrl.replace(/\/+$/u, ""), apiToken,
      quotaGroup: item.provider === "cloudflare-workers-ai" ? `cf-${item.account_id!.toLowerCase()}` : item.quota_group!,
      dailyRuns: item.daily_runs, maxConcurrent: item.max_concurrent };
  });
  validateHostedEndpoints(endpoints);
  return endpoints;
}

export function validateHostedEndpoints(endpoints: HostedEndpoint[]): void {
  if (!endpoints.length || endpoints.length > 32 || new Set(endpoints.map((e) => e.id)).size !== endpoints.length) {
    throw new Error("invalid or duplicate endpoint IDs");
  }
  for (const endpoint of endpoints) {
    if (endpoint.dailyRuns === null && !isSiliconFlowFreeEndpoint(endpoint)) {
      throw new Error("unlimited runs require a zero-price model");
    }
    for (const other of endpoints) {
      if (endpoint.profileId === other.profileId && (endpoint.provider !== other.provider
        || endpoint.model !== other.model || endpoint.label !== other.label)) throw new Error("profile must name one provider and model");
      if (endpoint.quotaGroup === other.quotaGroup && (endpoint.dailyRuns !== other.dailyRuns
        || endpoint.maxConcurrent !== other.maxConcurrent || endpoint.provider !== other.provider)) {
        throw new Error("shared account quotas must agree");
      }
      if (endpoint.apiToken === other.apiToken && endpoint.baseUrl === other.baseUrl
        && endpoint.quotaGroup !== other.quotaGroup) throw new Error("one credential cannot multiply its quota");
    }
  }
}

export interface HostedAllocation {
  blocked?: boolean;
  id: string; profileId: string; provider: string; model: string; quotaGroup: string;
  dailyRuns: number | null; maxConcurrent: number;
}

export interface HostedRunLimits {
  userDailyRuns: number | null; globalDailyRuns: number | null; maxConcurrent: number;
  userMinIntervalSeconds?: number; userMaxConcurrent?: number;
}
