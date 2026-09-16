import { api, el, formatAmount, renderNav, showError } from '/app.js';

renderNav('/insights');

const SEVERITY = { high: 'out', medium: '', low: '' };

function analysisCard(analysis) {
  const r = analysis.result ?? {};
  const bits = [];

  if (r.headline) bits.push(el('strong', { style: 'font-size:1.05rem', text: r.headline }));
  if (r.summary) bits.push(el('p', { style: 'margin:0', text: r.summary }));

  for (const o of r.observations ?? []) {
    bits.push(
      el('div', { class: 'stack', style: 'gap:0.1rem' }, [
        el('div', { class: 'row' }, [
          el('span', { class: `badge ${o.severity === 'high' ? 'pending' : ''}`, text: o.severity }),
          el('strong', { text: o.title }),
        ]),
        el('div', { class: 'muted', text: o.detail }),
      ]),
    );
  }

  if ((r.recommendations ?? []).length) {
    bits.push(el('strong', { text: 'What to do' }));
    for (const rec of r.recommendations) {
      bits.push(
        el('div', { class: 'stack', style: 'gap:0.1rem' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'badge', text: rec.effort }),
            el('span', { text: rec.action }),
            rec.estimated_monthly_impact
              ? el('span', { class: 'amount in', text: `${formatAmount(rec.estimated_monthly_impact)} a month` })
              : null,
          ]),
          el('div', { class: 'muted', text: rec.why }),
        ]),
      );
    }
  }

  if ((r.predicted_expenses ?? []).length) {
    bits.push(el('strong', { text: 'Likely coming up' }));
    for (const p of r.predicted_expenses) bits.push(proposalRow(p));
  }

  if ((r.questions_for_you ?? []).length) {
    bits.push(el('strong', { text: 'It would help to know' }));
    for (const q of r.questions_for_you) bits.push(el('div', { class: 'muted', text: q }));
  }

  bits.push(
    el('div', { class: 'muted', style: 'font-size:0.78rem' }, [
      `${new Date(analysis.created_at).toLocaleString()}, ${analysis.model ?? ''}, `,
      `${analysis.input_tokens ?? 0} in / ${analysis.output_tokens ?? 0} out`,
      analysis.question ? ` . asked: "${analysis.question}"` : '',
    ]),
  );

  return el('div', { class: 'card stack' }, bits);
}

function proposalRow(p) {
  const add = el('button', { class: 'small primary', text: 'Add to forecast' });
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      await api('/api/analyst/accept-proposal', { method: 'POST', body: { proposal: p } });
      add.textContent = 'Added';
      showError('');
    } catch (err) {
      showError(err.message);
      add.disabled = false;
    }
  });

  return el('div', { class: 'stack', style: 'gap:0.1rem' }, [
    el('div', { class: 'row' }, [
      el('span', { class: 'badge', text: p.confidence }),
      el('strong', { text: p.label }),
      el('span', { class: 'amount out', text: formatAmount(p.typical_amount) }),
      el('span', { class: 'muted', text: `every ${p.cadence_days} days${p.next_due ? `, from ${p.next_due}` : ''}` }),
      add,
    ]),
    el('div', { class: 'muted', text: p.reason }),
  ]);
}

async function loadManual() {
  const { accounts } = await api('/api/accounts');
  const manual = accounts.filter((a) => a.source === 'manual');
  const holder = document.getElementById('manualList');
  holder.innerHTML = '';
  if (!manual.length) {
    holder.append(el('p', { class: 'muted', text: 'None yet.' }));
    return;
  }
  for (const account of manual) {
    const input = el('input', { type: 'number', step: '0.01', value: Math.abs(Number(account.latest_balance ?? 0)), style: 'width:8rem' });
    const save = el('button', { class: 'small', text: 'Update' });
    save.addEventListener('click', async () => {
      try {
        await api(`/api/analyst/manual-accounts/${account.id}/balance`, {
          method: 'POST',
          body: { balance: input.value },
        });
        await loadManual();
        showError('');
      } catch (err) {
        showError(err.message);
      }
    });
    const remove = el('button', { class: 'small', text: 'Remove' });
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove ${account.name}?`)) return;
      await api(`/api/analyst/manual-accounts/${account.id}`, { method: 'DELETE' });
      await loadManual();
    });

    holder.append(
      el('div', { class: 'row', style: 'padding:0.3rem 0' }, [
        el('span', { class: 'grow truncate', text: `${account.bank} ${account.name}` }),
        el('span', { class: 'badge', text: account.type ?? '' }),
        input,
        save,
        remove,
      ]),
    );
  }
}

async function load() {
  const { settings, claude, analyses } = await api('/api/analyst');
  document.getElementById('enabled').checked = settings.enabled;
  document.getElementById('cadence').value = settings.cadence_days;
  document.getElementById('effort').value = settings.effort;
  document.getElementById('claudeState').textContent = claude.configured
    ? `Using ${claude.model}. Last run ${settings.last_run_at ? new Date(settings.last_run_at).toLocaleString() : 'never'}.`
    : 'ANTHROPIC_API_KEY is not set, so analysis cannot run yet. Add it to the environment and restart.';

  const history = document.getElementById('history');
  history.innerHTML = '';
  if (!analyses.length) {
    history.append(el('p', { class: 'empty', text: 'Nothing yet. Run one above.' }));
  } else {
    for (const analysis of analyses) history.append(analysisCard(analysis));
  }
  await loadManual();
}

document.getElementById('saveSettings').addEventListener('click', async () => {
  try {
    await api('/api/analyst/settings', {
      method: 'POST',
      body: {
        enabled: document.getElementById('enabled').checked,
        cadence_days: Number(document.getElementById('cadence').value) || 7,
        effort: document.getElementById('effort').value,
      },
    });
    await load();
    showError('');
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById('run').addEventListener('click', async () => {
  const button = document.getElementById('run');
  button.disabled = true;
  document.getElementById('runState').textContent = 'Thinking, this takes a moment...';
  try {
    await api('/api/analyst/analyse', {
      method: 'POST',
      body: { question: document.getElementById('question').value || null },
    });
    document.getElementById('runState').textContent = '';
    document.getElementById('question').value = '';
    await load();
    showError('');
  } catch (err) {
    showError(err.message);
    document.getElementById('runState').textContent = '';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('planButton').addEventListener('click', async () => {
  const button = document.getElementById('planButton');
  const description = document.getElementById('plan').value.trim();
  if (!description) return;
  button.disabled = true;
  const holder = document.getElementById('planResult');
  holder.innerHTML = '<p class="muted">Working it out...</p>';
  try {
    const { analysis } = await api('/api/analyst/plan-expense', { method: 'POST', body: { description } });
    const r = analysis.result;
    holder.innerHTML = '';
    holder.append(el('div', { class: 'muted', text: r.understood }));
    for (const p of r.proposals ?? []) holder.append(proposalRow(p));
    if (r.effect) holder.append(el('div', { class: 'muted', text: r.effect }));
    for (const q of r.questions_for_you ?? []) holder.append(el('div', { class: 'muted', text: `Worth knowing: ${q}` }));
    showError('');
  } catch (err) {
    showError(err.message);
    holder.innerHTML = '';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('addAccount').addEventListener('click', async () => {
  try {
    await api('/api/analyst/manual-accounts', {
      method: 'POST',
      body: {
        bank: document.getElementById('mBank').value,
        name: document.getElementById('mName').value,
        type: document.getElementById('mType').value,
        balance: document.getElementById('mBalance').value || null,
        is_liquid: ['savings', 'transaction'].includes(document.getElementById('mType').value),
      },
    });
    for (const id of ['mBank', 'mName', 'mBalance']) document.getElementById(id).value = '';
    await loadManual();
    showError('');
  } catch (err) {
    showError(err.message);
  }
});

try {
  await load();
} catch (err) {
  showError(err.message);
}
