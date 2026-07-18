import { readFile } from 'node:fs/promises';

export type ParsedCase = {
  name: string;
  role?: string;
  preconditions: string[];
  steps: string[];
  sourceMarkdown: string;
};

type Section = 'none' | 'preconditions' | 'steps';

export async function parseMarkdownCase(casePath: string): Promise<ParsedCase> {
  const sourceMarkdown = await readFile(casePath, 'utf8');
  return parseMarkdownCaseContent(sourceMarkdown);
}

export function parseMarkdownCaseContent(sourceMarkdown: string): ParsedCase {
  const lines = sourceMarkdown.split(/\r?\n/);
  const title = lines.find((line) => line.trim().startsWith('# '))?.replace(/^#\s+/, '').trim();
  if (!title) {
    throw new Error('CASE_PARSE_FAILED: case markdown must contain a level-1 title');
  }

  let section: Section = 'none';
  let role: string | undefined;
  const preconditions: string[] = [];
  const steps: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const roleMatch = trimmed.match(/^角色[:：]\s*(.+)$/);
    if (roleMatch) {
      role = roleMatch[1]?.trim();
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

  if (steps.length === 0) {
    throw new Error('CASE_PARSE_FAILED: case markdown must contain at least one step');
  }

  return {
    name: title,
    role,
    preconditions,
    steps,
    sourceMarkdown
  };
}
