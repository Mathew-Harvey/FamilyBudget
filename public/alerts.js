import { api, el, renderNav, showError } from '/app.js';

renderNav('/alerts');

async function load() {
  const { settings, email } = await api('/api/alerts');
  document.getElementById('to').value = settings.email_to ?? '';
  document.getElementById('runway').value = settings.runway_days_threshold;
  document.getElementById('large').value = settings.large_transaction_amount;
  document.getElementById('enabled').checked = settings.enabled;
  document.getElementById('overspend').checked = settings.notify_bucket_overspend;
  document.getElementById('syncfail').checked = settings.notify_sync_failure;
  document.getElementById('unreviewed').checked = settings.notify_unreviewed;

  document.getElementById('emailState').textContent = email.configured
    ? `Sending as ${email.from} through ${email.api_url}.`
    : 'Email is not configured yet. Set EMAIL_API_KEY and ALERT_FROM in the environment, then alerts can go out.';

  const { alerts } = await api('/api/alerts/preview');
  const preview = document.getElementById('preview');
  preview.innerHTML = '';
  if (!alerts.length) {
    preview.append(el('p', { class: 'empty', text: 'Nothing to report. All quiet.' }));
  } else {
    for (const alert of alerts) {
      preview.append(
        el('div', { class: 'card stack' }, [
          el('div', { class: 'spread' }, [
            el('strong', { text: alert.subject }),
            el('span', { class: 'badge', text: alert.kind.replace(/_/g, ' ') }),
          ]),
          el('pre', {
            class: 'muted',
            style: 'white-space:pre-wrap;margin:0;font:inherit',
            text: alert.body,
          }),
        ]),
      );
    }
  }

  const { log } = await api('/api/alerts/log');
  const holder = document.getElementById('log');
  holder.innerHTML = '';
  if (!log.length) {
    holder.append(el('p', { class: 'muted', text: 'Nothing sent yet.' }));
  } else {
    holder.append(
      el('table', { class: 'table-responsive' }, [
        el('tbody', {}, log.map((entry) =>
          el('tr', {}, [
            el('td', { 'data-col': 'description', class: 'truncate', text: entry.subject }),
            el('td', { 'data-col': 'amount', class: 'right' }, [
              el('span', { class: `badge ${entry.status === 'sent' ? '' : 'pending'}`, text: entry.status }),
            ]),
            el('td', { 'data-col': 'meta', class: 'muted', text: `${new Date(entry.created_at).toLocaleString()}${entry.error ? ` . ${entry.error}` : ''}` }),
          ]),
        )),
      ]),
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
        enabled: document.getElementById('enabled').checked,
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
