import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunResultRow } from '../kb/repository.js';
import { pathExists } from '../utils/fs.js';

export type DiagnoseInput =
  | {
      kind: 'run';
      run: RunResultRow;
    }
  | {
      kind: 'report';
      reportPath: string;
      report: PlaywrightJsonReport;
    };

export type PlaywrightJsonReport = {
  suites?: Array<{
    specs?: Array<{
      title?: string;
      file?: string;
      tests?: Array<{
        title?: string;
        results?: Array<{
          status?: string;
          error?: {
            message?: string;
          };
          errors?: Array<{ message?: string }>;
          attachments?: Array<{
            name?: string;
            path?: string;
            contentType?: string;
          }>;
        }>;
      }>;
    }>;
  }>;
};

export async function readPlaywrightReport(reportPath: string): Promise<PlaywrightJsonReport> {
  return JSON.parse(await readFile(reportPath, 'utf8')) as PlaywrightJsonReport;
}

export async function generateDiagnosis(cwd: string, input: DiagnoseInput): Promise<string> {
  if (input.kind === 'run') {
    return diagnoseRunRow(cwd, input.run);
  }

  return diagnoseReport(cwd, input.reportPath, input.report);
}

function diagnoseRunRow(cwd: string, run: RunResultRow): string {
  const lines = [
    `运行：${run.id}`,
    `Spec：${run.spec_path}`,
    `状态：${run.status}`,
    `开始时间：${run.started_at}`,
    run.finished_at ? `结束时间：${run.finished_at}` : undefined
  ];

  if (run.status === 'passed') {
    lines.push('', '诊断：测试已通过，无需处理。');
    return compact(lines).join('\n');
  }

  lines.push(
    '',
    `错误类型：${run.error_type ?? classifyError(run.error_message ?? '')}`,
    run.error_message ? `错误信息：${trimMessage(run.error_message)}` : undefined,
    run.trace_path ? `Trace：${run.trace_path}` : undefined,
    run.screenshot_path ? `Screenshot：${run.screenshot_path}` : undefined,
    '',
    '建议：',
    ...suggestions(run.error_type ?? classifyError(run.error_message ?? ''))
  );

  return compact(lines).join('\n');
}

async function diagnoseReport(cwd: string, reportPath: string, report: PlaywrightJsonReport): Promise<string> {
  const failed = firstFailed(report);
  const relativeReportPath = path.isAbsolute(reportPath) ? path.relative(cwd, reportPath) : reportPath;

  if (!failed) {
    return [`报告：${relativeReportPath}`, '状态：passed', '', '诊断：测试已通过，无需处理。'].join('\n');
  }

  const message = failed.result.error?.message ?? failed.result.errors?.[0]?.message ?? '';
  const errorType = classifyError(message);
  const tracePath = failed.result.attachments?.find((item) => item.name === 'trace')?.path;
  const screenshotPath = failed.result.attachments?.find((item) => item.name === 'screenshot')?.path;

  const lines = [
    `报告：${relativeReportPath}`,
    `测试：${failed.testTitle}`,
    `Spec：${failed.specFile ?? ''}`,
    '状态：failed',
    `错误类型：${errorType}`,
    message ? `错误信息：${trimMessage(message)}` : undefined,
    tracePath ? `Trace：${path.relative(cwd, tracePath)}` : undefined,
    screenshotPath ? `Screenshot：${path.relative(cwd, screenshotPath)}` : undefined,
    '',
    '建议：',
    ...suggestions(errorType)
  ];

  if (tracePath && !(await pathExists(tracePath))) {
    lines.push('', '注意：报告中的 trace 文件不存在，可能已被清理或路径来自其他工作目录。');
  }

  return compact(lines).join('\n');
}

function firstFailed(report: PlaywrightJsonReport):
  | {
      specFile?: string;
      testTitle?: string;
      result: NonNullable<
        NonNullable<NonNullable<NonNullable<PlaywrightJsonReport['suites']>[number]['specs']>[number]['tests']>[number]['results']
      >[number];
    }
  | undefined {
  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (result.status && result.status !== 'passed') {
            return {
              specFile: spec.file,
              testTitle: test.title ?? spec.title,
              result
            };
          }
        }
      }
    }
  }

  return undefined;
}

function classifyError(message: string): string {
  if (/AI_ASSERT_FAILED/i.test(message)) return 'AI_ASSERT_FAILED';
  if (/AI_ACT_FAILED/i.test(message)) return 'AI_ACT_FAILED';
  if (/AI_AGENT_FAILED/i.test(message)) return 'AI_AGENT_FAILED';
  if (/AI_MODEL_|AI_RUNTIME_/i.test(message)) return 'AI_RUNTIME_FAILED';
  if (/toHaveText|expect/i.test(message)) return 'ASSERTION_FAILED';
  if (/locator|strict mode|waiting for .*locator/i.test(message)) return 'LOCATOR_NOT_FOUND';
  if (/Timeout/i.test(message)) return 'TIMEOUT';
  if (/net::|navigation|goto/i.test(message)) return 'NAVIGATION_FAILED';
  if (/storageState|auth|login/i.test(message)) return 'AUTH_FAILED';
  return 'UNKNOWN';
}

function suggestions(errorType: string): string[] {
  const map: Record<string, string[]> = {
    AI_ACT_FAILED: [
      '- 查看 AI artifact 中的目标、候选元素和自愈结果。',
      '- 检查页面是否已加载完成，以及目标是否位于受支持的 DOM/frame 中。',
      '- 对关键路径执行 `kb scan/import`，优先转为静态 locator。'
    ],
    AI_ASSERT_FAILED: [
      '- 查看错误中的 actual、evidence 和 AI artifact。',
      '- 确认断言目标已出现且页面状态稳定。',
      '- 对精确文本断言补充静态知识库元素。'
    ],
    AI_AGENT_FAILED: [
      '- 查看 Agent artifact 中的工具调用历史。',
      '- 将过大的业务目标拆成更小步骤，或补充 business action。',
      '- 检查是否达到 Agent 步数、超时或同源导航限制。'
    ],
    AI_RUNTIME_FAILED: [
      '- 检查 runtimeAi 配置、API Key 环境变量和模型可用性。',
      '- 确认模型支持结构化 JSON；Agent 还要求 tool calling。',
      '- 检查当前测试是否使用 Chromium CDP。'
    ],
    LOCATOR_NOT_FOUND: [
      '- 重新执行 `case resolve` 检查目标是否仍命中知识库。',
      '- 执行 `kb scan/import` 补全或更新静态知识库。',
      '- 检查页面是否缺少稳定的 data-testid。'
    ],
    ASSERTION_FAILED: [
      '- 检查测试数据和前置条件是否满足。',
      '- 查看失败截图确认页面实际文案。',
      '- 如果业务状态未更新，检查前一步点击或提交是否成功。'
    ],
    TIMEOUT: [
      '- 检查页面加载速度和异步请求是否异常。',
      '- 增加明确等待条件，避免固定等待。',
      '- 查看 trace 定位卡住的步骤。'
    ],
    NAVIGATION_FAILED: [
      '- 检查 baseUrl 和目标 URL 是否可访问。',
      '- 确认 demo server 或测试系统正在运行。',
      '- 检查登录态是否过期。'
    ],
    AUTH_FAILED: [
      '- 重新执行 `auth login` 生成 storage state。',
      '- 检查用户名、密码和登录选择器配置。',
      '- 确认目标页面没有被重定向到登录页。'
    ],
    UNKNOWN: [
      '- 查看 Playwright JSON report 获取原始错误。',
      '- 使用 trace viewer 查看失败前后的页面状态。',
      '- 重新执行 `case build --overwrite` 更新生成脚本。'
    ]
  };

  return map[errorType] ?? map.UNKNOWN;
}

function trimMessage(message: string): string {
  return stripAnsi(message).split('\n').slice(0, 8).join('\n');
}

function compact(lines: Array<string | undefined>): string[] {
  return lines.filter((line): line is string => line !== undefined);
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}
