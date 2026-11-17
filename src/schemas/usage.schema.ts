import { z } from "zod";

export const usageParamsSchema = z.object({
  apiKey: z.string().trim().min(1).max(256),
});

export type UsageParams = z.infer<typeof usageParamsSchema>;
