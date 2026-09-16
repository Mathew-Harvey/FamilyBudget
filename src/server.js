#!/usr/bin/env node
// The Express app. Serves the JSON API under /api and the static pages in
// /public, with every page and route except login behind a session check.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSession, gate, createLoginRateLimiter, verifyLogin } from './auth.js';
import { accountsRouter } from './routes/accounts.js';
import { transactionsRouter } from './routes/transactions.js';
import { transfersRouter } from './routes/transfers.js';
import { syncRouter } from './routes/sync.js';
import { categoriesRouter } from './routes/categories.js';
import { rulesRouter } from './routes/rules.js';
import { bucketsRouter } from './routes/buckets.js';
import { forecastRouter } from './routes/forecast.js';
import { alertsRouter } from './routes/alerts.js';
import { analystRouter } from './routes/analyst.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();

  // Render terminates TLS in front of the app, so the secure cookie flag and
  // req.ip only work once the proxy is trusted.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '100kb' }));
  app.use(buildSession());

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', createLoginRateLimiter(), async (req, res, next) => {
    try {
      const user = await verifyLogin(req.body?.email, req.body?.password);
      if (!user) return res.status(401).json({ error: 'Wrong email or password' });
      // A fresh session id on login, so a stolen pre login id is useless.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        req.session.email = user.email;
        res.json({ ok: true, email: user.email });
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('familybudget.sid');
      res.json({ ok: true });
    });
  });

  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

  // Everything below this line needs a session.
  app.use(gate);

  app.get('/api/auth/me', (req, res) => res.json({ email: req.session.email }));
  app.use('/api/accounts', accountsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/transfers', transfersRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/rules', rulesRouter);
  app.use('/api/buckets', bucketsRouter);
  app.use('/api/forecast', forecastRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/analyst', analystRouter);

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'accounts.html')));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'No such route' });
    return res.status(404).send('Not found');
  });

  // Errors are logged without the request body, which would carry descriptions
  // and amounts.
  app.use((err, req, res, _next) => {
    console.error(`${req.method} ${req.path} failed: ${err.message}`);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`familybudget listening on ${port}`);
  });
}
