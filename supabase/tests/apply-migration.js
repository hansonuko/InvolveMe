#!/usr/bin/env node
// Applies one migration file to the linked dev database, inside a
// transaction, and rolls back if anything in it fails.
//
// Exists because `supabase migration list` reports already-applied
// migrations as pending on this project (tracking desync), so `db push` is
// not a safe way to apply a single new file here — see the repo's session
// handoff for the history. This runs exactly the SQL you point it at and
// nothing else.
//
// Usage:
//   node --env-file=.env supabase/tests/apply-migration.js <path-to.sql>

const { Client } = require('pg');
const fs = require('node:fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node --env-file=.env supabase/tests/apply-migration.js <path-to.sql>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(1);
}

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('SUPABASE_DB_URL is not set. Run with `node --env-file=.env`.');
  process.exit(1);
}

const sql = fs.readFileSync(file, 'utf8');

(async () => {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log(`applied: ${file}`);
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error(`ROLLED BACK — ${file} was not applied:\n  ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
