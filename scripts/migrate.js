#!/usr/bin/env node
// Applies every .sql file in /migrations that has not been applied yet, in
// filename order, recording each one in schema_migrations. Safe to re-run.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool } from '../src/db.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function runMigrations(pool, { log = console.log } = {}) {
  await pool.query(`
    create table if not exists schema_migrations (
      filename    text primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('select filename from schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const pending = files.filter((f) => !applied.has(f));
  if (!pending.length) {
    log(`No pending migrations. ${files.length} already applied.`);
    return [];
  }

  for (const filename of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    const client = await pool.connect();
    try {
      // Each migration is one transaction, so a failure leaves nothing behind.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [filename]);
      await client.query('COMMIT');
      log(`applied ${filename}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${filename} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return pending;
}

// Only run when invoked directly, so tests can import runMigrations.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await runMigrations(pool);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
