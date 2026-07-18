import { z } from 'zod';

export const kbDraftElementSchema = z.object({
  semanticName: z.string().min(1),
  elementType: z.string().min(1),
  role: z.string().optional(),
  visibleText: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testId: z.string().optional(),
  locatorPrimary: z.string().min(1),
  locatorFallback: z.string().optional(),
  contextText: z.string().optional(),
  confidence: z.number().min(0).max(1),
  status: z.enum(['candidate', 'approved', 'rejected']).default('candidate')
});

export const kbDraftActionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string()).optional(),
  steps: z.array(z.record(z.unknown())).min(1)
});

export const kbDraftSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().min(1),
  page: z.object({
    name: z.string().min(1),
    url: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional()
  }),
  elements: z.array(kbDraftElementSchema),
  businessActions: z.array(kbDraftActionSchema).default([])
});

export type KbDraft = z.infer<typeof kbDraftSchema>;
export type KbDraftElement = z.infer<typeof kbDraftElementSchema>;
