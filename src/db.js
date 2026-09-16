// One shared connection pool for the whole app. Every other module imports
// from here so there is a single place that knows how to talk to Postgres.
import pg from 'pg';

const { Pool, types } = pg;

// Postgres numeric would otherwise arrive as a JavaScript float, which loses
// exact cents. Keep it as the string Postgres sent and convert deliberately in
// money.js. 1700 is the numeric type oid.
types.setTypeParser(1700, (value) => value);

// int8 (bigint) also arrives as a string by default. Counts we select are small
// and we want numbers, so parse those.
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

// A date column would otherwise become a JavaScript Date built in the server's
// local timezone, which can move a transaction a day either way. Keep the
// YYYY-MM-DD string the database sent. 1082 is the date type oid.
types.setTypeParser(1082, (value) => value);

// Render gives two urls for the same database. The internal one is a bare
// hostname on the private network (dpg-xxxx-a), the external one is a fully
// qualified name (dpg-xxxx-a.region-postgres.render.com) reached over the
// public internet, which requires SSL. Turning SSL on for anything that is not
// localhost covers both, because the internal host accepts SSL too. That way
// one code path works unchanged wherever it runs.
export function sslConfigFor(connectionString) {
  if (process.env.DATABASE_SSL === 'false') return false;

  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch {
    // A url we cannot parse is most likely a local socket or key=value string.
    return false;
  }

  const isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '';
  if (isLocal) return false;

  // Render manages the certificate and does not publish a CA we can pin, so we
  // encrypt the connection without verifying the chain.
  return { rejectUnauthorized: false };
}

export function createPool(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  return new Pool({
    connectionString,
    ssl: sslConfigFor(connectionString),
    // The free Render Postgres plans cap connections, and a web service plus a
    // cron job share them. Stay modest.
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
}

let pool;

// Lazily built so that importing this module does not require DATABASE_URL.
// Tests build their own pool against TEST_DATABASE_URL and never touch this.
export function getPool() {
  if (!pool) pool = createPool(process.env.DATABASE_URL);
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

// Runs fn inside a transaction, rolling back if it throws.
export async function withTransaction(fn, existingPool) {
  const client = await (existingPool || getPool()).connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The rollback failing tells us nothing useful beyond the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
