import { readFile } from 'node:fs/promises';

export type ParsedCase = {
  name: string;
  role?: string;
  goal?: string;
  preconditions: string[];
  steps: string[];
  sourceMarkdown: string;
};

type Section = 'none' | 'goal' | 'preconditions' | 'steps';

export type ParseCaseOptions = { allowGoalOnly?: boolean };

export async function parseMarkdownCase(casePath: string, options: ParseCaseOptions = {}): Promise<ParsedCase> {
  const sourceMarkdown = await readFile(casePath, 'utf8');
  return parseMarkdownCaseContent(sourceMarkdown, options);
}

export function parseMarkdownCaseContent(sourceMarkdown: string, options: ParseCaseOptions = {}): ParsedCase {
  const lines = sourceMarkdown.split(/\r?\n/);
  const title = lines.find((line) => line.trim().startsWith('# '))?.replace(/^#\s+/, '').trim();
  if (!title) {
    throw new Error('CASE_PARSE_FAILED: case markdown must contain a level-1 title');
  }

  let section: Section = 'none';
  let role: string | undefined;
  const preconditions: string[] = [];
  const steps: string[] = [];
  const goalLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      const label = heading[1]?.replace(/[:：]$/, '').trim();
      section = label === '目标' ? 'goal' : label === '前置条件' ? 'preconditions' : label === '步骤' ? 'steps' : 'none';
      continue;
    }

    const roleMatch = trimmed.match(/^角色[:：]\s*(.+)$/);
    if (roleMatch) {
      role = roleMatch[1]?.trim();
      section = 'none';
      continue;
    }

    const goalMatch = trimmed.match(/^目标[:：]\s*(.*)$/);
    if (goalMatch) {
      section = 'goal';
      if (goalMatch[1]) goalLines.push(goalMatch[1]);
      continue;
    }

    if (/^前置条件[:：]?$/.test(trimmed)) {
      section = 'preconditions';
      continue;
    }

    if (/^步骤[:：]?$/.test(trimmed)) {
      section = 'steps';
      continue;
    }

    if (section === 'goal') {
      goalLines.push(trimmed.replace(/^-\s+/, ''));
      continue;
    }

    if (trimmed.startsWith('- ')) {
      const item = trimmed.slice(2).trim();
      if (!item) {
        continue;
      }

      if (section === 'preconditions') {
        preconditions.push(item);
        continue;
      }

      if (section === 'steps') {
        steps.push(item);
      }
    }
  }

  const goal = goalLines.join('\n').trim();
  if (steps.length === 0 && !(options.allowGoalOnly && goal)) {
    throw new Error(options.allowGoalOnly
      ? 'CASE_PARSE_FAILED: case markdown must contain a goal or at least one step'
      : 'CASE_PARSE_FAILED: case markdown must contain at least one step');
  }

  return {
    name: title,
    role,
    ...(goal ? { goal } : {}),
    preconditions,
    steps,
    sourceMarkdown
  };
}
