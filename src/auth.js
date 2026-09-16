// Sessions, login and the gate that every page and API route sits behind.
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import { getPool, query } from './db.js';

// Paths reachable without a session. Everything else needs one.
// /app.js is here because login.js imports it, so the login page cannot load
// without it.
const PUBLIC_PATHS = new Set([
  '/login', '/login.html', '/login.js', '/app.js', '/styles.css',
  '/api/auth/login', '/healthz', '/favicon.svg',
]);

export function buildSession() {
  const PgStore = connectPgSimple(session);
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set. Copy .env.example to .env and fill it in.');

  const isProduction = process.env.NODE_ENV === 'production';
  return session({
    store: new PgStore({
      pool: getPool(),
      tableName: 'session',
      // The table is created by migration 002, not by the library at boot.
      createTableIfMissing: false,
    }),
    name: 'familybudget.sid',
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  });
}

// Small fixed window limiter for the login route. One web service, so keeping
// the counters in memory is enough and avoids a dependency.
export function createLoginRateLimiter({ windowMs = 15 * 60 * 1000, maxAttempts = 10 } = {}) {
  const hits = new Map();
  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      // Opportunistic cleanup so the map cannot grow without bound.
      if (hits.size > 1000) {
        for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
      }
      return next();
    }

    entry.count++;
    if (entry.count > maxAttempts) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
    return next();
  };
}

export function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  return res.redirect('/login');
}

export function gate(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  return requireAuth(req, res, next);
}

export async function verifyLogin(email, password) {
  const { rows } = await query('select id, email, password_hash from users where email = $1', [
    String(email || '').trim().toLowerCase(),
  ]);
  const user = rows[0];
  // Compare against a dummy hash when there is no such user, so a missing
  // account and a wrong password take the same time to answer.
  const hash = user?.password_hash || '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(String(password || ''), hash);
  return ok && user ? { id: user.id, email: user.email } : null;
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}
