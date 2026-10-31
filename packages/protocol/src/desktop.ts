import { z } from "zod";

// Local-only desktop IPC. No arbitrary URLs, command lines, filesystem paths,
// credentials from the Web workspace, or automatic execution on a deep link.
export const DesktopEnvironmentSchema = z.enum(["production", "test", "demo"]);
export const DesktopHarnessSchema = z.enum(["codex", "claude-code"]);
const id = z.string().uuid();
export const DesktopActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("discover"), harness: DesktopHarnessSchema.optional(), force: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("select_cli"), harness: DesktopHarnessSchema }).strict(),
  z.object({ action: z.literal("select_workspace") }).strict(),
  z.object({ action: z.literal("start"), handoff_id: id, executable_id: id, workspace_id: id,
    password: z.string().min(8).max(128).refine(v => new TextEncoder().encode(v).byteLength <= 512),
    code_sync: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal("stop"), connection_id: id }).strict(),
  z.object({ action: z.literal("open_workspace"), workspace_id: id }).strict(),
  z.object({ action: z.literal("open_dsh") }).strict(),
  z.object({ action: z.literal("show_workspace") }).strict(),
  z.object({ action: z.literal("demo_handoff") }).strict(),
]);
export const DesktopConnectionStateSchema = z.enum([
  "authorizing", "starting", "connected", "stopping", "cleanup_pending", "stopped", "failed",
]);
export const DesktopErrorCodeSchema = z.enum([
  "invalid_request", "not_available", "invalid_handoff", "handoff_used", "wrong_environment",
  "authorization_failed", "authorization_uncertain", "rate_limited", "cancelled",
  "invalid_executable", "invalid_workspace", "duplicate_connection", "connection_limit",
  "executable_signature_invalid", "executable_terminated", "executable_probe_timeout", "executable_probe_failed",
  "executable_detection_busy",
  "connector_failed", "startup_timeout", "cleanup_pending", "unknown_error",
]);
export const DesktopStatusSchema = z.object({
  version: z.literal(1), environment: DesktopEnvironmentSchema, demo: z.boolean(),
  detection: z.array(z.object({ harness: DesktopHarnessSchema,
    state: z.enum(["idle", "searching", "ready", "missing", "failed"]),
    error: DesktopErrorCodeSchema.nullable(), remembered: z.boolean() }).strict()).max(2),
  handoff: z.object({ id, origin: z.string().max(100), project: z.string().max(128),
    harness: DesktopHarnessSchema, model: z.string().max(200), email: z.string().max(254),
    expires_at: z.number().int().nonnegative() }).strict().nullable(),
  executables: z.array(z.object({ id, harness: DesktopHarnessSchema, label: z.string().max(4096),
    version: z.string().max(120) }).strict()).max(16),
  workspace: z.object({ id, label: z.string().max(4096) }).strict().nullable(),
  connections: z.array(z.object({ id, origin: z.string().max(100), project: z.string().max(128),
    harness: DesktopHarnessSchema, model: z.string().max(200), state: DesktopConnectionStateSchema,
    error: DesktopErrorCodeSchema.nullable(), workspace_id: id, started_at: z.number().int().nonnegative(),
    exit_code: z.number().int().nullable() }).strict()).max(8),
}).strict();
export const DesktopResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: DesktopStatusSchema }).strict(),
  z.object({ ok: z.literal(false), error: DesktopErrorCodeSchema }).strict(),
]);
export type DesktopAction = z.infer<typeof DesktopActionSchema>;
export type DesktopStatus = z.infer<typeof DesktopStatusSchema>;
