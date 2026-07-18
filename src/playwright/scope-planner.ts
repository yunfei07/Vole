export type PlannedScope = {
  kind: 'row' | 'dialog' | 'testId' | 'role' | 'selector';
  rowText?: string;
  role?: string;
  name?: string;
  testId?: string;
  selector?: string;
  text?: string;
};

export type ScopeChild = {
  locator: string;
  strategy: string;
};

export type ScopedLocatorPlan = {
  locator: string;
  concreteLocator: string;
  strategy: string;
};

export function scopedLocatorPlans(scopes: PlannedScope[] | undefined, children: ScopeChild[]): ScopedLocatorPlan[] {
  if (!scopes?.length || !children.length) {
    return [];
  }

  const plans: ScopedLocatorPlan[] = [];
  for (const scope of scopes) {
    for (const child of children) {
      const scoped = scopedLocator(scope, child);
      if (scoped) {
        plans.push(scoped);
      }
    }
  }

  return plans;
}

function scopedLocator(scope: PlannedScope, child: ScopeChild): ScopedLocatorPlan | undefined {
  const childChain = childLocatorChain(child.locator);
  if (!childChain) {
    return undefined;
  }

  if (scope.kind === 'row' && scope.rowText) {
    return {
      locator: `page.getByRole("row").filter({ hasText: "\${rowText}" }).${childChain}`,
      concreteLocator: `page.getByRole("row").filter({ hasText: ${quote(scope.rowText)} }).${childChain}`,
      strategy: `row-scope+${child.strategy}`
    };
  }

  if (scope.kind === 'dialog') {
    const scopeLocator = scope.name ? `page.getByRole("dialog", { name: ${quote(scope.name)} })` : 'page.getByRole("dialog")';
    return {
      locator: `${scopeLocator}.${childChain}`,
      concreteLocator: `${scopeLocator}.${childChain}`,
      strategy: `dialog-scope+${child.strategy}`
    };
  }

  if (scope.kind === 'testId' && scope.testId) {
    return {
      locator: `page.getByTestId(${quote(scope.testId)}).${childChain}`,
      concreteLocator: `page.getByTestId(${quote(scope.testId)}).${childChain}`,
      strategy: `testId-scope+${child.strategy}`
    };
  }

  if (scope.kind === 'role' && scope.role) {
    const scopeLocator = scope.name
      ? `page.getByRole(${quote(scope.role)}, { name: ${quote(scope.name)} })`
      : `page.getByRole(${quote(scope.role)})`;
    return {
      locator: `${scopeLocator}.${childChain}`,
      concreteLocator: `${scopeLocator}.${childChain}`,
      strategy: `role-scope+${child.strategy}`
    };
  }

  if (scope.kind === 'selector' && scope.selector && scope.text) {
    const scopeLocator = `page.locator(${quote(scope.selector)}).filter({ hasText: ${quote(scope.text)} })`;
    return {
      locator: `${scopeLocator}.${childChain}`,
      concreteLocator: `${scopeLocator}.${childChain}`,
      strategy: `selector-scope+${child.strategy}`
    };
  }

  return undefined;
}

function childLocatorChain(locator: string): string | undefined {
  const testId = locator.match(/^page\.getByTestId\((.*)\)$/);
  if (testId?.[1]) {
    return `getByTestId(${testId[1]})`;
  }

  const role = locator.match(/^page\.getByRole\((.*)\)$/);
  if (role?.[1]) {
    return `getByRole(${role[1]})`;
  }

  const label = locator.match(/^page\.getByLabel\((.*)\)$/);
  if (label?.[1]) {
    return `getByLabel(${label[1]})`;
  }

  const placeholder = locator.match(/^page\.getByPlaceholder\((.*)\)$/);
  if (placeholder?.[1]) {
    return `getByPlaceholder(${placeholder[1]})`;
  }

  const text = locator.match(/^page\.getByText\((.*)\)$/);
  if (text?.[1]) {
    return `getByText(${text[1]})`;
  }

  return undefined;
}

function quote(input: string): string {
  return JSON.stringify(input);
}
