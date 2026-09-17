import { api, el, renderNav, showError, formatWhen, pageIntro } from '/app.js';

renderNav('/sync');
pageIntro('Bank sync',
  'Reads the banks through Redbark and updates this database. The cron job does '
  + 'this at 6am and 6pm Perth time. The button does it now.');

let pollTimer = null;

function duration(run) {
  if (!run.finished_at) return 'running';
  const seconds = Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// What a run did, in the order anyone cares: did it work, when, what came in.
// The old row printed four lines of counts on every run including the zeros,
// so twenty runs of nothing filled the page with "0 updated, 0 expired".
function runRow(run) {
  const counts = [
    run.txns_inserted ? `${run.txns_inserted} new` : null,
    run.txns_updated ? `${run.txns_updated} updated` : null,
    run.pending_resolved ? `${run.pending_resolved} settled` : null,
    run.transfers_detected ? `${run.transfers_detected} transfers` : null,
  ].filter(Boolean);
  const ok = run.status === 'success';
  return el('div', { class: 'item' }, [
    el('span', { class: `state ${ok ? 'ok' : 'bad'}`, style: 'flex:none' }, [
      el('span', { class: 'dot' }),
    ]),
    el('span', { class: 'grow' }, [
      el('span', { class: 't', text: counts.length ? counts.join(', ') : 'nothing new' }),
      el('span', { class: 's', text: `${formatWhen(run.started_at)}, took ${duration(run)}`
        + `${run.accounts_synced ? `, ${run.accounts_synced} accounts` : ''}` }),
      run.error_message
        ? el('span', { class: 's warn', style: 'white-space:pre-wrap', text: run.error_message })
        : null,
    ]),
  ]);
}

// How current the data is. That is the question this page is opened to answer
// and it used to be a US formatted timestamp in the first cell of a table.
function renderHead(runs, running) {
  const last = runs[0] ?? null;
  const failing = last && last.status !== 'success';
  const head = document.getElementById('head');
  head.innerHTML = '';

  const button = el('button', { class: 'primary', id: 'run', text: running ? 'Reading...' : 'Read the banks now' });
  button.disabled = running;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api('/api/sync/run', { method: 'POST' });
      await refresh();
    } catch (err) {
      showError(err.message);
      button.disabled = false;
    }
  });

  head.append(el('div', { class: 'card' }, [
    el('span', { class: `state ${running ? 'warn' : failing ? 'bad' : last ? 'ok' : ''}` }, [
      el('span', { class: 'dot', style: last || running ? null : 'background:var(--neutral)' }),
      el('span', { text: running ? 'Reading the banks now'
        : failing ? 'The last read failed'
        : last ? 'Up to date' : 'Never read' }),
    ]),
    el('div', { class: 'figure date', style: 'font-size:2rem',
      text: last ? formatWhen(last.started_at) : 'no runs yet' }),
    el('div', { class: 'delta' }, [
      el('span', { class: 'q', text: last
        ? `last read, ${last.txns_inserted || 'no'} new transaction${last.txns_inserted === 1 ? '' : 's'}`
        : 'nothing has been read into this database' }),
    ]),
    failing && last.error_message
      ? el('p', { class: 'warn small', style: 'margin:12px 0 0;white-space:pre-wrap', text: last.error_message })
      : null,
    el('div', { class: 'row', style: 'margin-top:16px' }, [button]),
  ]));
}

async function refresh() {
  try {
    const { runs, running } = await api('/api/sync/runs');
    renderHead(runs, running);

    const holder = document.getElementById('runs');
    holder.innerHTML = '';
    if (runs.length > 1) {
      holder.append(
        el('div', { class: 'sec', text: 'Before that' }),
        el('div', { class: 'card flush' }, runs.slice(1).map(runRow)),
      );
    }

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

await refresh();
