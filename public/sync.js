import { api, el, renderNav, showError } from '/app.js';

renderNav('/sync');

let pollTimer = null;

function duration(run) {
  if (!run.finished_at) return 'running';
  const seconds = Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function runRow(run) {
  return el('tr', {}, [
    el('td', {}, [
      el('div', { text: new Date(run.started_at).toLocaleString() }),
      el('span', { class: `badge ${run.status === 'success' ? '' : 'pending'}`, text: run.status }),
      el('span', { class: 'muted', text: ` ${duration(run)}` }),
      run.error_message
        ? el('div', { class: 'muted', style: 'white-space:pre-wrap', text: run.error_message })
        : null,
    ]),
    el('td', { class: 'right muted' }, [
      el('div', { text: `${run.accounts_synced} accounts` }),
      el('div', { text: `${run.txns_inserted} new, ${run.txns_updated} updated` }),
      el('div', { text: `${run.pending_resolved} pending resolved, ${run.pending_expired} expired` }),
      el('div', { text: `${run.transfers_detected} transfers` }),
    ]),
  ]);
}

async function refresh() {
  try {
    const { runs, running } = await api('/api/sync/runs');
    const holder = document.getElementById('runs');
    holder.innerHTML = '';
    if (!runs.length) {
      holder.append(el('p', { class: 'empty', text: 'No runs yet.' }));
    } else {
      holder.append(
        el('table', { class: 'table-responsive' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Run' }), el('th', { class: 'right', text: 'Counts' })])]),
          el('tbody', {}, runs.map(runRow)),
        ]),
      );
    }

    const button = document.getElementById('run');
    button.disabled = running;
    document.getElementById('state').textContent = running ? 'A sync is running...' : '';

    // Poll while a run is in flight, then stop.
    if (running && !pollTimer) pollTimer = setInterval(refresh, 3000);
    if (!running && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById('run').addEventListener('click', async () => {
  const button = document.getElementById('run');
  button.disabled = true;
  try {
    await api('/api/sync/run', { method: 'POST' });
    document.getElementById('state').textContent = 'Started...';
    await refresh();
  } catch (err) {
    showError(err.message);
    button.disabled = false;
  }
});

await refresh();
