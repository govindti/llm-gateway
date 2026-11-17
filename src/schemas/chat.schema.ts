import { z } from "zod";
import { PROVIDER_NAMES } from "@/services/providers/types";

export const chatRequestSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, "prompt must not be empty")
    .max(32_000, "prompt must be at most 32000 characters"),
  provider: z.enum(PROVIDER_NAMES).describe("Primary LLM provider"),
  model: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional model override; defaults to the provider's configured model"),
});

export type ChatRequestBody = z.infer<typeof chatRequestSchema>;
