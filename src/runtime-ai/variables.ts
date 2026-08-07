import type { AiVariableValue, AiVariables } from './types.js';

export function resolveVariableValue(value: AiVariableValue): string {
  if (typeof value === 'object' && value !== null) {
    return String(value.value);
  }
  return String(value);
}

export function variablePromptEntries(
  variables?: AiVariables
): Array<{ name: string; description?: string }> {
  return Object.entries(variables ?? {}).map(([name, value]) => ({
    name,
    description: typeof value === 'object' && value !== null
      ? value.description
      : undefined
  }));
}

export function substituteVariables(value: string, variables?: AiVariables): string {
  let result = value;
  for (const [name, variable] of Object.entries(variables ?? {})) {
    const resolved = resolveVariableValue(variable);
    result = result
      .split(`%${name}%`).join(resolved)
      .split(`\${${name}}`).join(resolved);
  }
  return result;
}

export function redactVariables(value: string, variables?: AiVariables): string {
  return Object.entries(variables ?? {})
    .map(([name, variable]) => [name, resolveVariableValue(variable)] as const)
    .filter(([, resolved]) => resolved.length > 0)
    .sort((left, right) => right[1].length - left[1].length)
    .reduce(
      (result, [name, resolved]) => result.split(resolved).join(`%${name}%`),
      value
    );
}
