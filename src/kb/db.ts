import Database from 'better-sqlite3';
import path from 'node:path';
import { ensureDir } from '../utils/fs.js';
import { schemaSql } from './schema.js';

export async function initializeDatabase(dbPath: string): Promise<void> {
  await ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);

  try {
    migrateDatabase(db);
  } finally {
    db.close();
  }
}

export function migrateDatabase(db: Database.Database): void {
  db.exec(schemaSql);
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
     VALUES (1, 'initial_schema', ?)`
  ).run(new Date().toISOString());

  const alreadyApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 2').get();
  if (alreadyApplied) {
    return;
  }

  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS dynamic_elements;
      DROP TABLE IF EXISTS page_states;
      DROP TABLE IF EXISTS kb_patches;
      DROP TABLE IF EXISTS locator_stability;
      DROP TABLE IF EXISTS element_scopes;
    `);
    db.prepare(
      `INSERT INTO schema_migrations (version, name, applied_at)
       VALUES (2, 'remove_retired_runtime_tables', ?)`
    ).run(new Date().toISOString());
  })();
}
