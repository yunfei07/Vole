import { createHash } from 'node:crypto';

export function stableId(prefix: string, parts: Array<string | undefined | null>): string {
  const input = parts.filter(Boolean).join('|');
  const hash = createHash('sha1').update(input).digest('hex').slice(0, 12);
  return `${prefix}_${hash}`;
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
