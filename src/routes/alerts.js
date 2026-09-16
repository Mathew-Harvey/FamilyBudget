// Stage 5: alert settings, history, and a test send.
import { Router } from 'express';
import { query } from '../db.js';
import { getSettings, updateSettings, evaluateAlerts, runAlerts } from '../alerts.js';
import { emailConfig, sendEmail } from '../email.js';

export const alertsRouter = Router();

alertsRouter.get('/', async (req, res, next) => {
  try {
    const config = emailConfig();
    res.json({
      settings: await getSettings(),
      // Never send the key itself to the browser, only whether one is set.
      email: { configured: config.configured, from: config.from, api_url: config.apiUrl },
    });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (body.email_to && !String(body.email_to).includes('@')) {
      return res.status(400).json({ error: 'That does not look like an email address' });
    }
    res.json({ settings: await updateSettings(body) });
  } catch (err) {
    next(err);
  }
});

// What would be sent right now, without sending anything.
alertsRouter.get('/preview', async (req, res, next) => {
  try {
    res.json({ alerts: await evaluateAlerts() });
  } catch (err) {
    next(err);
  }
});

alertsRouter.get('/log', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select id, kind, subject, status, error, created_at, sent_at
         from alert_log order by created_at desc limit 50`,
    );
    res.json({ log: rows });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/run', async (req, res, next) => {
  try {
    res.json(await runAlerts());
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/test', async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings?.email_to) return res.status(400).json({ error: 'Set an address to send to first' });
    const result = await sendEmail({
      to: settings.email_to,
      subject: 'Test from your household budget',
      text: 'If you are reading this, alerts are wired up correctly.',
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
