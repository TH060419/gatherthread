import { z } from "zod";

// Deliberately supports conventional ASCII, case-insensitive mailboxes only.
// Never strip dots or +suffixes or apply provider-specific account merging.
export const RegistrationEmailSchema = z.string().max(254).trim().toLowerCase()
  .regex(/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/)
  .refine((value) => value.split("@")[0]!.length <= 64 && value.split("@")[1]!.split(".").every((part) => part.length <= 63));
const Label = z.string().regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u).trim().min(1).max(120);
export const SendRegistrationInputSchema = z.object({
  email: RegistrationEmailSchema,
  challenge_token: z.string().min(1).max(2048),
  idempotency_key: z.string().uuid(),
  locale: z.enum(["en", "zh-CN"]),
}).strict();
export const AccountPasswordSchema = z.string().min(8).max(128)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 512);
export const EmailLoginInputSchema = z.object({
  email: RegistrationEmailSchema, password: AccountPasswordSchema, device_name: Label,
  remember_device: z.boolean().default(false),
}).strict();
export type EmailLoginInput = z.infer<typeof EmailLoginInputSchema>;
export const VerifyRegistrationInputSchema = z.object({
  registration_id: z.string().uuid(),
  code: z.string().regex(/^\d{8}$/),
  display_name: Label,
  device_name: Label,
  remember_device: z.boolean().default(false),
  privacy_acknowledged: z.literal(true),
  password: AccountPasswordSchema,
}).strict();
export const RegistrationStatusSchema = z.object({
  enabled: z.boolean(),
  site_key: z.string().nullable(),
  challenge_binding: z.string().nullable(),
}).strict();
export const RegistrationSentSchema = z.object({
  registration_id: z.string().uuid(), expires_in_seconds: z.literal(600), resend_after_seconds: z.literal(60),
}).strict();
export type SendRegistrationInput = z.infer<typeof SendRegistrationInputSchema>;
export type VerifyRegistrationInput = z.infer<typeof VerifyRegistrationInputSchema>;

export const SendPasswordResetInputSchema = SendRegistrationInputSchema;
export const PasswordResetSentSchema = z.object({
  reset_id: z.string().uuid(), expires_in_seconds: z.literal(600), resend_after_seconds: z.literal(60),
}).strict();
export const VerifyPasswordResetInputSchema = z.object({
  reset_id: z.string().uuid(), email: RegistrationEmailSchema, code: z.string().regex(/^\d{8}$/),
  password: AccountPasswordSchema, password_confirmation: AccountPasswordSchema,
  locale: z.enum(["en", "zh-CN"]),
}).strict().refine((value) => value.password === value.password_confirmation);
export type VerifyPasswordResetInput = z.infer<typeof VerifyPasswordResetInputSchema>;

export const EmailAccountSessionSchema = z.object({
  actor: z.object({ user_id: z.string(), display_name: z.string(), device_id: z.string(), can_create_projects: z.literal(true) }).strict(),
  expires_at: z.string().datetime(),
}).strict();
