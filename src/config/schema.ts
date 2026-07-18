import { z } from 'zod';

const pageReadySchema = z.object({
  waitForNetworkIdle: z.boolean().default(true),
  networkIdleTimeoutMs: z.number().int().positive().default(5000),
  waitAfterLoadMs: z.number().int().min(0).default(1000),
  domStableMs: z.number().int().min(0).default(500),
  timeoutMs: z.number().int().positive().default(10000),
  waitForSelectors: z.array(z.string().min(1)).default([]),
  loadingSelectors: z.array(z.string().min(1)).default([
    '.ant-spin',
    '.ant-spin-spinning',
    '.el-loading-mask',
    '.el-loading-spinner',
    '[data-loading="true"]',
    '[aria-busy="true"]'
  ])
});

const aiEnhancementsSchema = z.object({
  enabled: z.boolean().default(false),
  failOpen: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(10000),
  maxRetries: z.number().int().min(0).default(0),
  pageAnalysis: z.boolean().default(true),
  locatorRanking: z.boolean().default(true),
  componentClassification: z.boolean().default(true),
  kbAudit: z.boolean().default(true)
});

const runtimeAiSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(30000),
  selfHeal: z.boolean().default(true),
  snapshotMaxChars: z.number().int().min(5000).default(60000),
  cacheDir: z.string().min(1).default('.ai-pw/ai-cache'),
  artifactsDir: z.string().min(1).default('.ai-pw/artifacts/ai'),
  agent: z.object({
    maxSteps: z.number().int().min(1).max(50).default(8),
    timeoutMs: z.number().int().positive().default(120000),
    toolTimeoutMs: z.number().int().positive().default(30000),
    sameOriginOnly: z.boolean().default(true)
  }).default({})
});

export const aiPwConfigSchema = z.object({
  projectName: z.string().min(1),
  baseUrl: z.string().min(1),
  testDir: z.string().min(1),
  pageObjectDir: z.string().min(1),
  caseDir: z.string().min(1),
  knowledgeBase: z.string().min(1),
  artifactsDir: z.string().min(1),
  scanPages: z.array(
    z.object({
      name: z.string().min(1),
      url: z.string().min(1)
    })
  ).default([]),
  auth: z.object({
    loginUrl: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    usernameSelector: z.string().min(1),
    passwordSelector: z.string().min(1),
    submitSelector: z.string().min(1),
    storageState: z.string().min(1)
  }),
  locatorPreference: z.array(z.enum(['testId', 'role', 'label', 'placeholder', 'text', 'css', 'xpath'])),
  ai: z.object({
    provider: z.literal('openai-compatible'),
    baseURL: z.string().url(),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().min(0),
    structuredOutputMode: z.enum(['auto', 'native', 'prompt']).default('auto')
  }).refine((value) => value.apiKey || value.apiKeyEnv, {
    message: 'ai.apiKey or ai.apiKeyEnv is required'
  }),
  aiEnhancements: aiEnhancementsSchema.default({}),
  runtimeAi: runtimeAiSchema.default({}),
  playwright: z.object({
    headless: z.boolean(),
    trace: z.enum(['on', 'off', 'retain-on-failure']),
    timeout: z.number().int().positive(),
    ignoreHTTPSErrors: z.boolean().default(true)
  }),
  pageReady: pageReadySchema.default({})
});

export type AiPwConfig = z.infer<typeof aiPwConfigSchema>;
