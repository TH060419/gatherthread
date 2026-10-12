import { z } from "zod";

export const CloudApiProviderIdSchema = z.enum(["openai", "anthropic", "deepseek", "siliconflow-cn", "siliconflow-global", "openrouter"]);
export type CloudApiProviderId = z.infer<typeof CloudApiProviderIdSchema>;
export const CloudApiModelSchema = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u0020\u007f-\u009f]+$/u);
const Label = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
export const CloudApiPutInputSchema = z.object({
  expected_revision: z.string().uuid().nullable(), provider_id: CloudApiProviderIdSchema,
  label: Label, model: CloudApiModelSchema, enabled: z.boolean(),
  api_key: z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/u).optional(),
}).strict();
export type CloudApiPutInput = z.infer<typeof CloudApiPutInputSchema>;
export const CloudApiDeleteInputSchema = z.object({ expected_revision: z.string().uuid() }).strict();
export const CloudApiConfigurationSchema = z.object({
  id: z.string().uuid(), revision: z.string().uuid(), provider_id: CloudApiProviderIdSchema,
  profile_id: z.string().regex(/^api-[0-9a-f-]{36}$/u), label: Label, model: CloudApiModelSchema,
  enabled: z.boolean(), has_key: z.literal(true), updated_at: z.string().datetime(),
}).strict();
export type CloudApiConfiguration = z.infer<typeof CloudApiConfigurationSchema>;
export const CloudApiProviderSchema = z.object({ id: CloudApiProviderIdSchema, label: z.string().max(80),
  transport: z.enum(["openai-chat", "anthropic-messages"]), base_url: z.string().url().max(200), docs_url: z.string().url().max(300),
}).strict();
export const CloudApiStatusSchema = z.object({ enabled: z.boolean(), providers: z.array(CloudApiProviderSchema).max(16),
  configurations: z.array(CloudApiConfigurationSchema).max(8) }).strict();
export const CloudApiSavedSchema = z.object({ configuration: CloudApiConfigurationSchema }).strict();

/** Personal profiles must freeze a configuration revision. Service IDs stay backward compatible. */
export const PersonalCloudRevisionSchema = z.string().uuid().optional();
export function hasValidPersonalCloudRevision(value: { profile_id: string; api_config_revision?: string | undefined }): boolean {
  return value.profile_id.startsWith("api-") ? /^api-[0-9a-f-]{36}$/u.test(value.profile_id) && value.api_config_revision !== undefined
    : value.api_config_revision === undefined;
}
/** Requester-private immutable execution selection; never a shared history field. */
export const HostedAgentSelectionSchema = z.object({
  profile_id: z.string().min(1).max(64), api_config_revision: PersonalCloudRevisionSchema,
}).strict().refine(hasValidPersonalCloudRevision, "Personal Cloud Agent selection requires its exact revision");
export type HostedAgentSelection = z.infer<typeof HostedAgentSelectionSchema>;
