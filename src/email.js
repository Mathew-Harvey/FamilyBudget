// Sending email, with no dependency.
//
// Providers like Resend and Postmark take a plain JSON POST, so fetch is enough
// and there is no package to add. Point EMAIL_API_URL at whichever one you use.
//
// Nothing is sent unless it is configured. An unconfigured app reports that it
// skipped, rather than failing a sync over it.

const DEFAULT_API_URL = 'https://api.resend.com/emails';

export function emailConfig(env = process.env) {
  return {
    apiUrl: env.EMAIL_API_URL || DEFAULT_API_URL,
    apiKey: env.EMAIL_API_KEY || null,
    from: env.ALERT_FROM || null,
    configured: Boolean(env.EMAIL_API_KEY && env.ALERT_FROM),
  };
}

// Returns { status, error }. Never throws, because a failed alert must not take
// a sync down with it.
export async function sendEmail({ to, subject, text }, options = {}) {
  const config = options.config ?? emailConfig();
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (!config.configured) {
    return { status: 'skipped', error: 'Email is not configured. Set EMAIL_API_KEY and ALERT_FROM.' };
  }
  if (!to) {
    return { status: 'skipped', error: 'No address to send to. Set one on the Alerts page.' };
  }

  try {
    const response = await fetchImpl(config.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.from, to: [to], subject, text }),
    });

    if (!response.ok) {
      // The provider's message can carry back what we sent, so only the status
      // is kept. Transaction descriptions and amounts must not reach the logs.
      return { status: 'failed', error: `The email provider returned ${response.status}` };
    }
    return { status: 'sent', error: null };
  } catch (err) {
    return { status: 'failed', error: `Could not reach the email provider: ${err.message}` };
  }
}
