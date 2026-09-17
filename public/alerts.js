import { api, el, renderNav, showError, formatWhen, pageIntro } from '/app.js';

renderNav('/alerts');
pageIntro('Email alerts',
  'Checked at the end of every sync. The same warning is not repeated for three '
  + 'days unless it gets worse.');

// On or off, and whether it could send even if it were on. Two separate
// facts, and the page used to make you deduce both: the master switch sat
// unticked in a row of three ticked ones, and whether email was configured at
// all was a grey sentence above a form.
let enabled = false;

function renderHead(settings, email, waiting) {
  enabled = Boolean(settings.enabled);
  const head = document.getElementById('head');
  head.innerHTML = '';

  const toggle = el('input', { type: 'checkbox', class: 'switch',
    'aria-label': 'Turn email alerts on or off' });
  toggle.checked = enabled;
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      await api('/api/alerts', { method: 'POST', body: { enabled: toggle.checked } });
      await load();
      showError('');
    } catch (err) {
      showError(err.message);
      toggle.checked = enabled;
      toggle.disabled = false;
    }
  });

  const blocked = enabled && !email.configured;
  head.append(el('div', { class: 'card' }, [
    el('div', { class: 'row spread' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: `state ${enabled ? (blocked ? 'warn' : 'ok') : ''}` }, [
          el('span', { class: 'dot', style: enabled ? null : 'background:var(--neutral)' }),
          el('span', { text: enabled ? (blocked ? 'On, but nothing can go out' : 'On') : 'Off' }),
        ]),
        el('span', { class: 't', style: 'margin-top:8px', text: enabled
          ? (settings.email_to ? `Emailing ${settings.email_to}` : 'No address set yet')
          : 'Nothing is emailed' }),
        el('span', { class: 's', text: email.configured
          ? `Sending as ${email.from}`
          : 'EMAIL_API_KEY and ALERT_FROM are not set in the environment' }),
      ]),
      toggle,
    ]),
    waiting === 0
      ? el('p', { class: 'muted small', style: 'margin:12px 0 0', text: 'Nothing to report right now.' })
      : null,
  ]));
}

async function load() {
  const { settings, email } = await api('/api/alerts');
  document.getElementById('to').value = settings.email_to ?? '';
  document.getElementById('runway').value = settings.runway_days_threshold;
  document.getElementById('large').value = settings.large_transaction_amount;
  document.getElementById('overspend').checked = settings.notify_bucket_overspend;
  document.getElementById('syncfail').checked = settings.notify_sync_failure;
  document.getElementById('unreviewed').checked = settings.notify_unreviewed;
  document.getElementById('switches').setAttribute('aria-disabled', String(!settings.enabled));

  // What it would say right now. This is the useful half of the page and it
  // used to sit below the form: the settings are read once and the warnings
  // are read every time.
  const { alerts } = await api('/api/alerts/preview');
  renderHead(settings, email, alerts.length);

  const preview = document.getElementById('preview');
  preview.innerHTML = '';
  if (alerts.length) {
    preview.append(el('div', { class: 'sec', text: settings.enabled
      ? 'What would be sent right now'
      : 'What would be sent, if it were on' }));
    for (const alert of alerts) {
      preview.append(
        el('div', { class: 'card stack' }, [
          el('div', { class: 'row spread' }, [
            el('strong', { class: 'grow', text: alert.subject }),
            el('span', { class: 'badge', text: alert.kind.replace(/_/g, ' ') }),
          ]),
          el('pre', {
            class: 'muted',
            style: 'white-space:pre-wrap;margin:0;font:inherit;font-size:0.88rem',
            text: alert.body,
          }),
        ]),
      );
    }
  }

  // Everything considered is logged even when it is not sent, so this says
  // what the app noticed as much as what it posted.
  const { log } = await api('/api/alerts/log');
  const holder = document.getElementById('log');
  holder.innerHTML = '';
  if (log.length) {
    holder.append(
      el('div', { class: 'sec', text: 'Considered recently' }),
      el('div', { class: 'card flush' }, log.map((entry) =>
        el('div', { class: 'item' }, [
          el('span', { class: 'grow' }, [
            el('span', { class: 't truncate', text: entry.subject }),
            el('span', { class: 's', text: `${formatWhen(entry.created_at)}${entry.error ? `, ${entry.error}` : ''}` }),
          ]),
          el('span', { class: `badge ${entry.status === 'sent' ? '' : 'pending'}`, text: entry.status }),
        ]))),
    );
  }
}

document.getElementById('save').addEventListener('click', async () => {
  try {
    await api('/api/alerts', {
      method: 'POST',
      body: {
        email_to: document.getElementById('to').value || null,
        runway_days_threshold: Number(document.getElementById('runway').value) || 21,
        large_transaction_amount: document.getElementById('large').value || '500',
        notify_bucket_overspend: document.getElementById('overspend').checked,
        notify_sync_failure: document.getElementById('syncfail').checked,
        notify_unreviewed: document.getElementById('unreviewed').checked,
      },
    });
    document.getElementById('state').textContent = 'Saved.';
    await load();
    showError('');
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById('test').addEventListener('click', async () => {
  try {
    const result = await api('/api/alerts/test', { method: 'POST' });
    document.getElementById('state').textContent =
      result.status === 'sent' ? 'Test sent.' : `Not sent: ${result.error}`;
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById('run').addEventListener('click', async () => {
  try {
    const result = await api('/api/alerts/run', { method: 'POST' });
    document.getElementById('state').textContent =
      `${result.sent} sent of ${result.considered} considered.`;
    await load();
  } catch (err) {
    showError(err.message);
  }
});

try {
  await load();
} catch (err) {
  showError(err.message);
}
