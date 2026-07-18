import type { VoleConfig } from './schema.js';

export const defaultConfig: VoleConfig = {
  projectName: 'admin-e2e',
  baseUrl: 'http://127.0.0.1:4173',
  testDir: 'tests/generated',
  pageObjectDir: 'pages',
  caseDir: 'cases',
  knowledgeBase: '.vole/kb.sqlite',
  artifactsDir: '.vole/artifacts',
  scanPages: [
    { name: '订单管理页面', url: '/orders' },
    { name: '用户管理页面', url: '/users' },
    { name: '商品管理页面', url: '/products' },
    { name: '系统设置页面', url: '/settings' }
  ],
  auth: {
    loginUrl: '/login',
    username: 'admin',
    password: 'admin123',
    usernameSelector: "[data-testid='username']",
    passwordSelector: "[data-testid='password']",
    submitSelector: "[data-testid='login-submit']",
    storageState: '.vole/auth/storage-state.json'
  },
  locatorPreference: ['testId', 'role', 'label', 'placeholder', 'text', 'css', 'xpath'],
  ai: {
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-4.1',
    temperature: 0.1,
    timeoutMs: 30000,
    maxRetries: 2,
    structuredOutputMode: 'auto'
  },
  aiEnhancements: {
    enabled: false,
    failOpen: true,
    timeoutMs: 10000,
    maxRetries: 0,
    pageAnalysis: true,
    locatorRanking: true,
    componentClassification: true,
    kbAudit: true
  },
  runtimeAi: {
    enabled: true,
    timeoutMs: 30000,
    selfHeal: true,
    snapshotMaxChars: 60000,
    cacheDir: '.vole/ai-cache',
    artifactsDir: '.vole/artifacts/ai',
    agent: {
      maxSteps: 8,
      timeoutMs: 120000,
      toolTimeoutMs: 30000,
      sameOriginOnly: true
    }
  },
  playwright: {
    headless: true,
    trace: 'on',
    timeout: 30000,
    ignoreHTTPSErrors: true
  },
  pageReady: {
    waitForNetworkIdle: true,
    networkIdleTimeoutMs: 5000,
    waitAfterLoadMs: 1000,
    domStableMs: 500,
    timeoutMs: 10000,
    waitForSelectors: [],
    loadingSelectors: [
      '.ant-spin',
      '.ant-spin-spinning',
      '.el-loading-mask',
      '.el-loading-spinner',
      '[data-loading="true"]',
      '[aria-busy="true"]'
    ]
  }
};
