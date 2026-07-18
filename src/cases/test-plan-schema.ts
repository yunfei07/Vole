import { z } from 'zod';

const baseStepSchema = z.object({
  id: z.string().min(1),
  rawText: z.string().min(1),
  page: z.string().optional(),
  state: z.string().optional(),
  target: z.string().optional(),
  confidence: z.number().min(0).max(1).optional()
});

export const gotoStepSchema = baseStepSchema.extend({
  action: z.literal('goto'),
  target: z.string().min(1)
});

export const clickStepSchema = baseStepSchema.extend({
  action: z.literal('click'),
  target: z.string().min(1)
});

export const fillStepSchema = baseStepSchema.extend({
  action: z.literal('fill'),
  target: z.string().min(1),
  value: z.string()
});

export const selectStepSchema = baseStepSchema.extend({
  action: z.literal('select'),
  target: z.string().min(1),
  value: z.string()
});

export const uploadStepSchema = baseStepSchema.extend({
  action: z.literal('upload'),
  target: z.string().min(1),
  filePath: z.string().min(1)
});

export const assertTextStepSchema = baseStepSchema.extend({
  action: z.literal('assertText'),
  target: z.string().min(1),
  value: z.string()
});

export const assertVisibleStepSchema = baseStepSchema.extend({
  action: z.literal('assertVisible'),
  target: z.string().min(1)
});

export const businessActionStepSchema = baseStepSchema.extend({
  action: z.literal('businessAction'),
  target: z.string().min(1),
  inputs: z.record(z.string()).optional()
});

export const testStepSchema = z.discriminatedUnion('action', [
  gotoStepSchema,
  clickStepSchema,
  fillStepSchema,
  selectStepSchema,
  uploadStepSchema,
  assertTextStepSchema,
  assertVisibleStepSchema,
  businessActionStepSchema
]);

export const testPlanSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  preconditions: z.array(z.string()).optional(),
  steps: z.array(testStepSchema).min(1)
});

export type TestPlan = z.infer<typeof testPlanSchema>;
export type TestStep = z.infer<typeof testStepSchema>;
