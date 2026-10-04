import { z } from "zod";

/** A test environment admission code is never an account or device credential. */
export const TestGateExchangeInputSchema = z.object({
  admission_code: z.string().regex(/^gte_[A-Za-z0-9_-]{43}$/),
}).strict();
export const TestGateStatusSchema = z.object({
  enabled: z.boolean(), admitted: z.boolean(),
  environment: z.enum(["production", "test"]),
}).strict();
