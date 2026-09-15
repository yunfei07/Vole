#!/usr/bin/env node
import { Command } from 'commander';
import { runLoggedCommand, wasErrorLogged } from '../logging/cli.js';
import { authLoginCommand } from './commands/auth-login.js';
import { caseBuildCommand } from './commands/case-build.js';
import { caseCompileCommand } from './commands/case-compile.js';
import { caseGenerateCommand } from './commands/case-generate.js';
import { caseResolveCommand } from './commands/case-resolve.js';
import { diagnoseCommand } from './commands/diagnose.js';
import { initCommand } from './commands/init.js';
import { kbAuditCommand } from './commands/kb-audit.js';
import { kbImportCommand } from './commands/kb-import.js';
import { kbListCommand } from './commands/kb-list.js';
import { kbScanCommand } from './commands/kb-scan.js';
import { runCommand } from './commands/run.js';
import { actCommand, agentCommand } from './commands/runtime-ai.js';

const program = new Command();

program
  .name('vole')
  .description('Vole CLI automation test generator')
  .version('0.1.0');

program.command('init').description('Initialize vole project files').action(async () => {
  await runLoggedCommand('init', () => initCommand());
});

const auth = program.command('auth').description('Authentication commands');

auth.command('login').description('Login with configured username/password and save storage state').action(async () => {
  await runLoggedCommand('auth.login', () => authLoginCommand());
});

const kb = program.command('kb').description('Knowledge base commands');

kb.command('audit')
  .description('Audit knowledge-base quality and semantic consistency')
  .option('--page <name>', 'filter elements by page name')
  .action(async (options: { page?: string }) => {
    await runLoggedCommand('kb.audit', () => kbAuditCommand(options));
  });

kb.command('scan')
  .description('Scan page(s) and generate editable knowledge-base draft(s)')
  .option('--name <name>', 'page semantic name')
  .option('--url <url>', 'page URL or path')
  .option('--all', 'scan all pages configured in .vole/vole.config.json scanPages')
  .option('--import', 'import scanned draft(s) into knowledge base')
  .option('--out <path>', 'draft output path')
  .option('--headed', 'run browser headed')
  .option('--wait <ms>', 'override pageReady.waitAfterLoadMs for this scan')
  .action(async (options: { name?: string; url?: string; all?: boolean; import?: boolean; out?: string; headed?: boolean; wait?: string }) => {
    await runLoggedCommand('kb.scan', () => kbScanCommand(options));
  });

kb.command('import')
  .description('Import a knowledge-base draft')
  .argument('<draftPath>', 'draft JSON path')
  .action(async (draftPath: string) => {
    await runLoggedCommand('kb.import', () => kbImportCommand(draftPath));
  });

kb.command('list')
  .description('List knowledge-base records')
  .argument('<target>', 'pages | elements | actions | runs')
  .option('--page <name>', 'filter elements by page name')
  .action(async (target: string, options: { page?: string }) => {
    await runLoggedCommand('kb.list', () => kbListCommand(target, options));
  });

const caseCommand = program.command('case').description('Case commands');

caseCommand
  .command('compile')
  .description('Compile a markdown case into a structured Test Plan')
  .argument('<casePath>', 'case markdown path')
  .option('--parser <parser>', 'ai | rules', 'ai')
  .option('--out <path>', 'plan output path')
  .action(async (casePath: string, options: { parser?: string; out?: string }) => {
    await runLoggedCommand('case.compile', async () => {
      if (options.parser !== undefined && !['ai', 'rules'].includes(options.parser)) {
        throw new Error('--parser must be one of: ai, rules');
      }
      await caseCompileCommand(casePath, {
        parser: options.parser as 'ai' | 'rules' | undefined,
        out: options.out
      });
    });
  });

caseCommand
  .command('resolve')
  .description('Resolve a Test Plan against the knowledge base')
  .argument('<planPath>', 'plan JSON path')
  .option('--out <path>', 'resolved plan output path')
  .action(async (planPath: string, options: { out?: string }) => {
    await runLoggedCommand('case.resolve', () => caseResolveCommand(planPath, options));
  });

caseCommand
  .command('generate')
  .description('Generate Playwright Page Object and spec from a resolved plan')
  .argument('<resolvedPlanPath>', 'resolved plan JSON path')
  .option('--out <path>', 'spec output path')
  .option('--page-object-out <path>', 'page object output path')
  .option('--overwrite', 'overwrite existing generated files')
  .action(async (resolvedPlanPath: string, options: { out?: string; pageObjectOut?: string; overwrite?: boolean }) => {
    await runLoggedCommand('case.generate', () => caseGenerateCommand(resolvedPlanPath, options));
  });

caseCommand
  .command('build')
  .description('Understand the case goal, plan steps with buildAgent, resolve, generate code, and validate it')
  .argument('[casePath]', 'case markdown path')
  .option('--parser <parser>', 'ai (two-stage buildAgent, supports goal-only cases) | rules (requires steps)', 'ai')
  .option('--all', 'build all markdown cases configured by caseDir')
  .option('--out <path>', 'spec output path')
  .option('--page-object-out <path>', 'page object output path')
  .option('--overwrite', 'overwrite existing generated files')
  .action(
    async (
      casePath: string | undefined,
      options: {
        parser?: string;
        all?: boolean;
        out?: string;
        pageObjectOut?: string;
        overwrite?: boolean;
      }
    ) => {
      await runLoggedCommand('case.build', async () => {
        if (options.parser !== undefined && !['ai', 'rules'].includes(options.parser)) {
          throw new Error('--parser must be one of: ai, rules');
        }
        await caseBuildCommand(casePath, {
          parser: options.parser as 'ai' | 'rules' | undefined,
          all: options.all,
          out: options.out,
          pageObjectOut: options.pageObjectOut,
          overwrite: options.overwrite
        });
      });
    }
  );

program
  .command('act')
  .description('Perform one AI-guided browser action')
  .argument('<instruction>', 'natural-language browser action')
  .option('--url <url>', 'page URL or path; defaults to configured baseUrl')
  .option('--headed', 'run browser headed')
  .option('--model <model>', 'override the configured model')
  .option('--timeout <ms>', 'override the AI action timeout')
  .action(async (instruction: string, options: {
    url?: string;
    headed?: boolean;
    model?: string;
    timeout?: string;
  }) => {
    await runLoggedCommand('act', () => actCommand(instruction, options));
  });

program
  .command('agent')
  .description('Run a multi-step AI browser task')
  .argument('<instruction>', 'natural-language browser task')
  .option('--url <url>', 'page URL or path; defaults to configured baseUrl')
  .option('--headed', 'run browser headed')
  .option('--model <model>', 'override the configured model')
  .option('--timeout <ms>', 'override the agent timeout')
  .option('--max-steps <count>', 'override the maximum agent steps')
  .action(async (instruction: string, options: {
    url?: string;
    headed?: boolean;
    model?: string;
    timeout?: string;
    maxSteps?: string;
  }) => {
    await runLoggedCommand('agent', () => agentCommand(instruction, options));
  });

program
  .command('run')
  .description('Run a generated Playwright spec and save run result')
  .argument('<specPath>', 'generated spec path')
  .action(async (specPath: string) => {
    await runLoggedCommand('run', () => runCommand(specPath));
  });

program
  .command('diagnose')
  .description('Diagnose a run id or Playwright JSON report')
  .argument('<target>', 'run id or report path')
  .action(async (target: string) => {
    await runLoggedCommand('diagnose', () => diagnoseCommand(target));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  if (!wasErrorLogged(error)) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
  }
  process.exitCode = 1;
});
