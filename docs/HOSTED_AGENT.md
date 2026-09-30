# Hosted trial Agent

The hosted trial Agent runs [OpenCode](https://github.com/anomalyco/opencode) in a fresh container for each request. OpenCode provides code reading, editing, terminal commands, and local tests. GatherThread keeps the provider credential on the server and exposes only a short-lived, quota-capped model proxy over a Unix socket. The container has no general network interface.

This feature is off by default. When enabled, **Cloud Agent** appears beside Codex and DeepSeek Harness in the project Agent selector. Choose its model there or in **Settings → Default Agent**, then use the existing **Request my agent** action. Existing local selections are preserved. No local connection is required; model credentials and pool capacity are operator settings, not browser settings. GT Cloud code is read only when the user selects **Use GT Cloud code and save changes to my GT Cloud branch**. The project owner must already have enabled GT Cloud file sharing. On success, changed source is checkpointed to the requesting member's own GT Cloud branch; the owner review and merge boundary remains unchanged. The runner does not read GitHub code from the direct local GitHub integration. Without the selection, the Agent works in an empty, disposable project directory and file changes are discarded.

For the separate GitHub + npm development workflow, see [Cloud GitHub tasks](HOSTED_GITHUB.md). It requires its own GitHub App authorization and activation gate; the limits below describe the GT Cloud trial.

## Operator setup

Deploy this preview on a Linux host with Docker and Unix socket support. Windows hosts reject the enabled configuration; the container smoke test is exercised on Linux CI.

1. Build `ops/hosted-agent/Dockerfile` in a reviewed build pipeline or on the deployment host with `docker build -f ops/hosted-agent/Dockerfile -t gt-hosted:reviewed .` and record its immutable local image ID with `docker image inspect --format '{{.Id}}' gt-hosted:reviewed`. Alternatively use a registry image reference pinned as `repository@sha256:<digest>`. The image pins OpenCode 1.18.32 and includes Node.js, Git, and socat. Run an isolated smoke test of `opencode run`, code editing, terminal commands, Unix-socket model access, and container cleanup before setting the feature flag.
2. Select a tool-calling Chat Completions provider. The proxy supports Cloudflare Workers AI, DeepSeek, and operator-configured HTTPS OpenAI-compatible endpoints. Each provider/model requires a live compatibility test before activation. Gemini's native API and Responses-only APIs are not supported by this adapter.
3. Set `GATHERTHREAD_HOSTED_AGENT_ENABLED=true`, `GATHERTHREAD_HOSTED_AGENT_IMAGE=sha256:<local-image-id>` (or `repository@sha256:<registry-digest>`), and `GATHERTHREAD_HOSTED_AGENT_ENDPOINTS` in the private server environment. The JSON example below references secret environment variable **names**, never literal keys.
4. Set `GATHERTHREAD_HOSTED_AGENT_USER_DAILY_RUNS` (default 1), `GATHERTHREAD_HOSTED_AGENT_GLOBAL_DAILY_RUNS` (default 4), and `GATHERTHREAD_HOSTED_AGENT_MAX_CONCURRENT` (default 2, maximum 8). Disable one user's allowance with `hosted-agent:set-user-limit --user-id ID --runs 0`. Increasing API capacity also requires enough host memory and CPU: every concurrent container is capped at 768 MiB and one CPU.

## Multiple APIs and accounts

Example `GATHERTHREAD_HOSTED_AGENT_ENDPOINTS` value (put actual `DEEPSEEK_A` and `DEEPSEEK_B` secrets only in the private environment):

```json
[
  { "id": "ds-a", "profile_id": "coding", "label": "DeepSeek coding", "provider": "deepseek", "model": "deepseek-chat", "token_env": "DEEPSEEK_A", "quota_group": "account-a", "daily_runs": 20, "max_concurrent": 1 },
  { "id": "ds-b", "profile_id": "coding", "label": "DeepSeek coding", "provider": "deepseek", "model": "deepseek-chat", "token_env": "DEEPSEEK_B", "quota_group": "account-b", "daily_runs": 20, "max_concurrent": 1 }
]
```

Replace the example model with a model actually available on the accounts. Up to 32 endpoints may be configured. Entries under one `profile_id` must have the exact same provider, model and display label. A different provider/model needs its own profile and an explicit user selection. The scheduler reserves one available account with the fewest active runs, then the fewest daily reservations. There is no waiting queue or automatic provider/model fallback. If upstream returns 429, 401/403 or 5xx, that account enters a short in-memory cooldown for subsequent tasks; the accepted run is not replayed automatically on another account.

All keys belonging to the same billed account or organization **must use the same `quota_group`**, daily limit and concurrency limit. Shared groups count usage across models. Use only legitimately provisioned capacity in accordance with provider terms; multiple keys on one account do not create extra quota. Group IDs must stay stable across restarts/configuration changes or accounting cannot associate previous usage. The operator is responsible for mapping non-Cloudflare credentials to their real accounts. Browser status exposes only model choices, availability and remaining runs, never account IDs, endpoints or secrets.

For a custom provider use `provider: "openai-compatible"`, `base_url: "https://api.example.com/v1"`, an explicit model and quota group. URLs must be HTTPS without embedded credentials or query parameters. Streaming tool-call compatibility must be tested with the real service.

Cloudflare entries use `provider: "cloudflare-workers-ai"`, `model: "@cf/qwen/qwen3-30b-a3b-fp8"`, `account_id`, `free_plan_confirmed: true`, and at most four daily runs. Their quota group is derived from the account ID, so multiple keys cannot multiply the account allowance. The legacy single-Cloudflare environment variables remain supported when no endpoint JSON is configured: `GATHERTHREAD_HOSTED_AGENT_FREE_PLAN_CONFIRMED`, `GATHERTHREAD_CLOUDFLARE_ACCOUNT_ID`, `GATHERTHREAD_CLOUDFLARE_AI_TOKEN`. Old `*_DAILY_NEURONS` values convert to whole runs by dividing by 2000; new run variables take precedence.

Every run reserves one allowance transactionally before its canonical request is created. The reservation remains consumed after failure or restart. Trial proxies cap eight calls, 64,000 bytes per request and 1024 output tokens per call; [repository tasks](HOSTED_GITHUB.md) have separate bounded allowances. Cloudflare additionally keeps the conservative 2000-Neuron per-run ceiling and cannot run repository tasks. Other providers use bounded runs, **not invoice-accurate token/currency accounting**: set a provider-side spend cap and monitor the actual bill. A successful idempotent replay never launches another container.

The container runs without general network access, host credentials, or writable host directories. Its working directory is a bounded in-memory filesystem; the host supplies only read-only initial code. It is non-root, read-only except for bounded temporary storage, and has CPU, memory, PID, and wall-time limits. A user's code can run terminal commands **inside that container**, so do not mount the Docker socket, server database, deployment files, SSH agent, or host home into it. OpenCode permissions are convenience controls inside the container and are not the isolation boundary.

## Current limits

The preview accepts at most 100 project files and 500 KiB of code, at most 12 KiB of shared conversation context, and a two-minute run. Package downloads and arbitrary web access are unavailable from the container. Commands using dependencies already present in the image or source workspace can run; a project that needs external packages must use a separately approved dependency strategy. New files that exceed the cloud code rules are not checkpointed. These limits keep the trial service bounded; they are not a claim that every project can build inside this runner.

The operator must validate the container path on its deployment host before enabling the flag. Unit tests use a mocked Docker runner and model response; they do not prove that OpenCode can complete a real provider-backed project task. No billable provider request is made by the test suite.

For provider alternatives and the exact operator handoff, see [model API options](HOSTED_AGENT_PROVIDERS.md).

## Upgrade compatibility

Deploy server and Web assets together. The status response now advertises profiles and run counts instead of the earlier preview's single fixed model and Neuron counters. Old requests without `profile_id` use `default` only if that profile exists. Old accepted requests whose payload omitted the profile must not be silently reinterpreted; conflicting reuse returns 409. Browser settings v13 adds the cloud choice while preserving the active local harness and its settings.

SQLite upgrade retains the original preview tables and copies existing reservations, IDs and user limits into `hosted_agent_runs` / `hosted_agent_run_limits` idempotently. Earlier reservations with no account metadata count conservatively against every account for that UTC day. Stop the old process and back up the database before upgrading. Downgrading to the old single-provider runner after accepting pooled runs would undercount usage and is unsupported; restore a pre-upgrade backup only with explicit data-loss review. This is a single active server-process design, not a distributed worker scheduler.
