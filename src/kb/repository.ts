import Database from 'better-sqlite3';
import path from 'node:path';
import { getLogger } from '../logging/context.js';
import { ensureDir } from '../utils/fs.js';
import { stableId } from '../utils/id.js';
import type { TestPlan } from '../cases/test-plan-schema.js';
import { migrateDatabase } from './db.js';
import type { KbDraft } from './draft-schema.js';

export type PageRow = {
  id: string;
  name: string;
  url: string;
  title: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type ElementRow = {
  id: string;
  page_id: string;
  page_name: string;
  semantic_name: string;
  element_type: string | null;
  role: string | null;
  visible_text: string | null;
  label: string | null;
  placeholder: string | null;
  test_id: string | null;
  locator_primary: string;
  locator_fallback?: string | null;
  confidence: number;
  status: string;
  source: string;
};

export type ActionRow = {
  id: string;
  name: string;
  page_name: string | null;
  description: string | null;
  input_schema_json?: string | null;
  steps_json?: string;
};

export type RunResultInput = {
  specPath: string;
  status: string;
  errorType?: string;
  failedStep?: unknown;
  errorMessage?: string;
  tracePath?: string;
  screenshotPath?: string;
  startedAt: string;
  finishedAt?: string;
};

export type RunResultRow = {
  id: string;
  spec_path: string;
  status: string;
  error_type: string | null;
  error_message: string | null;
  trace_path: string | null;
  screenshot_path: string | null;
  started_at: string;
  finished_at: string | null;
};

export function saveTestPlan(
  db: Database.Database,
  input: {
    name: string;
    sourceFile: string;
    plan: TestPlan;
    generatedSpecPath?: string;
  }
): string {
  const now = new Date().toISOString();
  const id = stableId('plan', [input.sourceFile, input.name]);

  db.prepare(
    `INSERT INTO test_plans (
       id, name, source_file, plan_json, generated_spec_path, status, created_at, updated_at
     )
     VALUES (
       @id, @name, @source_file, @plan_json, @generated_spec_path, 'compiled', @created_at, @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       plan_json = excluded.plan_json,
       generated_spec_path = excluded.generated_spec_path,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run({
    id,
    name: input.name,
    source_file: input.sourceFile,
    plan_json: JSON.stringify(input.plan),
    generated_spec_path: input.generatedSpecPath ?? null,
    created_at: now,
    updated_at: now
  });

  return id;
}

export function updateResolvedPlanByName(db: Database.Database, name: string, resolvedPlan: unknown): void {
  db.prepare(
    `UPDATE test_plans
     SET resolved_plan_json = @resolved_plan_json,
         status = @status,
         updated_at = @updated_at
     WHERE id = (
       SELECT id FROM test_plans
       WHERE name = @name
       ORDER BY updated_at DESC
       LIMIT 1
     )`
  ).run({
    name,
    resolved_plan_json: JSON.stringify(resolvedPlan),
    status: 'resolved',
    updated_at: new Date().toISOString()
  });
}

export function saveRunResult(db: Database.Database, input: RunResultInput): string {
  const startedAt = Date.now();
  const id = stableId('run', [input.specPath, input.startedAt]);

  db.prepare(
    `INSERT INTO run_results (
       id, spec_path, status, error_type, failed_step_json, error_message,
       trace_path, screenshot_path, started_at, finished_at
     )
     VALUES (
       @id, @spec_path, @status, @error_type, @failed_step_json, @error_message,
       @trace_path, @screenshot_path, @started_at, @finished_at
     )`
  ).run({
    id,
    spec_path: input.specPath,
    status: input.status,
    error_type: input.errorType ?? null,
    failed_step_json: input.failedStep ? JSON.stringify(input.failedStep) : null,
    error_message: input.errorMessage ?? null,
    trace_path: input.tracePath ?? null,
    screenshot_path: input.screenshotPath ?? null,
    started_at: input.startedAt,
    finished_at: input.finishedAt ?? null
  });

  getLogger().child({ component: 'kb' }).info('kb.run_saved', {
    runId: id,
    status: input.status,
    errorType: input.errorType,
    durationMs: Date.now() - startedAt
  });

  return id;
}

export function listRunResults(db: Database.Database): RunResultRow[] {
  return db
    .prepare<[], RunResultRow>(
      `SELECT id, spec_path, status, error_type, error_message, trace_path, screenshot_path, started_at, finished_at
       FROM run_results
       ORDER BY started_at DESC`
    )
    .all();
}

export function getRunResult(db: Database.Database, id: string): RunResultRow | undefined {
  return db
    .prepare<{ id: string }, RunResultRow>(
      `SELECT id, spec_path, status, error_type, error_message, trace_path, screenshot_path, started_at, finished_at
       FROM run_results
       WHERE id = @id`
    )
    .get({ id });
}

export async function openKb(dbPath: string): Promise<Database.Database> {
  const logger = getLogger().child({ component: 'kb' });
  const startedAt = Date.now();
  await ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  try {
    migrateDatabase(db);
    logger.info('kb.opened', { dbPath, durationMs: Date.now() - startedAt });
    return db;
  } catch (error) {
    db.close();
    logger.error('kb.open_failed', {
      message: 'Failed to open knowledge base',
      dbPath,
      durationMs: Date.now() - startedAt,
      error
    });
    throw error;
  }
}

export function importDraft(db: Database.Database, draft: KbDraft): { pageId: string; importedElements: number; importedActions: number } {
  const startedAt = Date.now();
  const now = new Date().toISOString();
  const pageId = stableId('page', [draft.page.name, draft.page.url]);

  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO pages (id, name, url, title, description, created_at, updated_at)
       VALUES (@id, @name, @url, @title, @description, @created_at, @updated_at)
       ON CONFLICT(name) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         description = excluded.description,
         updated_at = excluded.updated_at`
    ).run({
      id: pageId,
      name: draft.page.name,
      url: draft.page.url,
      title: draft.page.title ?? null,
      description: draft.page.description ?? null,
      created_at: now,
      updated_at: now
    });

    const actualPage = db.prepare<{ name: string }, { id: string }>('SELECT id FROM pages WHERE name = @name').get({ name: draft.page.name });
    if (!actualPage) {
      throw new Error(`Failed to import page: ${draft.page.name}`);
    }

    db.prepare('DELETE FROM elements WHERE page_id = @page_id AND source = @source').run({
      page_id: actualPage.id,
      source: 'scan'
    });

    const insertElement = db.prepare(
      `INSERT INTO elements (
         id, page_id, semantic_name, element_type, role, visible_text, label, placeholder,
         test_id, locator_primary, locator_fallback, context_text, confidence, source, status,
         created_at, updated_at
       )
       VALUES (
         @id, @page_id, @semantic_name, @element_type, @role, @visible_text, @label, @placeholder,
         @test_id, @locator_primary, @locator_fallback, @context_text, @confidence, 'scan', @status,
         @created_at, @updated_at
       )
       ON CONFLICT(page_id, semantic_name) DO UPDATE SET
         element_type = excluded.element_type,
         role = excluded.role,
         visible_text = excluded.visible_text,
         label = excluded.label,
         placeholder = excluded.placeholder,
         test_id = excluded.test_id,
         locator_primary = excluded.locator_primary,
         locator_fallback = excluded.locator_fallback,
         context_text = excluded.context_text,
         confidence = excluded.confidence,
         source = excluded.source,
         status = excluded.status,
         updated_at = excluded.updated_at`
    );

    for (const element of draft.elements) {
      insertElement.run({
        id: stableId('el', [actualPage.id, element.semanticName]),
        page_id: actualPage.id,
        semantic_name: element.semanticName,
        element_type: element.elementType,
        role: element.role ?? null,
        visible_text: element.visibleText ?? null,
        label: element.label ?? null,
        placeholder: element.placeholder ?? null,
        test_id: element.testId ?? null,
        locator_primary: element.locatorPrimary,
        locator_fallback: element.locatorFallback ?? null,
        context_text: element.contextText ?? null,
        confidence: element.confidence,
        status: element.status,
        created_at: now,
        updated_at: now
      });
    }

    const insertAction = db.prepare(
      `INSERT INTO business_actions (id, name, description, page_id, input_schema_json, steps_json, created_at, updated_at)
       VALUES (@id, @name, @description, @page_id, @input_schema_json, @steps_json, @created_at, @updated_at)
       ON CONFLICT(name) DO UPDATE SET
         description = excluded.description,
         page_id = excluded.page_id,
         input_schema_json = excluded.input_schema_json,
         steps_json = excluded.steps_json,
         updated_at = excluded.updated_at`
    );

    for (const action of draft.businessActions) {
      insertAction.run({
        id: stableId('action', [action.name]),
        name: action.name,
        description: action.description ?? null,
        page_id: actualPage.id,
        input_schema_json: action.inputSchema ? JSON.stringify(action.inputSchema) : null,
        steps_json: JSON.stringify(action.steps),
        created_at: now,
        updated_at: now
      });
    }

    return actualPage.id;
  });

  const importedPageId = transaction() as string;
  const result = {
    pageId: importedPageId,
    importedElements: draft.elements.length,
    importedActions: draft.businessActions.length
  };
  getLogger().child({ component: 'kb' }).info('kb.draft_imported', {
    pageId: result.pageId,
    importedElements: result.importedElements,
    importedActions: result.importedActions,
    durationMs: Date.now() - startedAt
  });
  return result;
}

export function listPages(db: Database.Database): PageRow[] {
  return db
    .prepare<[], PageRow>(
      `SELECT id, name, url, title, description, created_at, updated_at
       FROM pages
       ORDER BY updated_at DESC, name ASC`
    )
    .all();
}

export function listElements(db: Database.Database, pageName?: string): ElementRow[] {
  const sql = `SELECT
      elements.id,
      elements.page_id,
      pages.name AS page_name,
      elements.semantic_name,
      elements.element_type,
      elements.role,
      elements.visible_text,
      elements.label,
      elements.placeholder,
      elements.test_id,
      elements.locator_primary,
      elements.locator_fallback,
      elements.confidence,
      elements.status,
      'element' AS source
    FROM elements
    INNER JOIN pages ON pages.id = elements.page_id
    ${pageName ? 'WHERE pages.name = @pageName' : ''}
    ORDER BY page_name ASC, semantic_name ASC`;

  return pageName
    ? db.prepare<{ pageName: string }, ElementRow>(sql).all({ pageName })
    : db.prepare<[], ElementRow>(sql).all();
}

export function listActions(db: Database.Database): ActionRow[] {
  return db
    .prepare<[], ActionRow>(
      `SELECT
         business_actions.id,
         business_actions.name,
         pages.name AS page_name,
         business_actions.description,
         business_actions.input_schema_json,
         business_actions.steps_json
       FROM business_actions
       LEFT JOIN pages ON pages.id = business_actions.page_id
       ORDER BY business_actions.name ASC`
    )
    .all();
}
