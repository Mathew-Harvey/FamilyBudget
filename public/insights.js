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

function affordCard(r) {
  const verdictClass = r.verdict === 'yes comfortably' ? 'in' : r.verdict === 'not yet' ? 'out' : '';
  const bits = [
    el('div', { class: 'row' }, [
      el('span', { class: `badge ${r.verdict === 'not yet' ? 'pending' : ''}`, text: r.verdict }),
      el('strong', { text: r.headline }),
    ]),
    el('p', { style: 'margin:0', text: r.reasoning }),
  ];

  for (const path of r.paths ?? []) {
    bits.push(
      el('div', { class: 'card stack', style: 'margin:0' }, [
        el('div', { class: 'row' }, [
          el('strong', { text: path.name }),
          path.frees_up ? el('span', { class: 'amount in', text: formatAmount(path.frees_up) }) : null,
          path.when_affordable ? el('span', { class: 'muted', text: `affordable from ${path.when_affordable}` }) : null,
        ]),
        el('ul', { style: 'margin:0;padding-left:1.1rem' }, (path.steps ?? []).map((step) => el('li', { text: step }))),
        el('div', { class: 'muted', text: `Trade off: ${path.tradeoff}` }),
      ]),
    );
  }

  if ((r.trims ?? []).length) {
    bits.push(el('strong', { text: 'Where the money could come from' }));
    for (const trim of r.trims) {
      bits.push(
        el('div', { class: 'row' }, [
          el('span', { class: 'badge', text: `${trim.pain} pain` }),
          el('span', { class: 'amount in', text: `${formatAmount(trim.monthly_saving)}/mo` }),
          el('span', { class: 'grow', text: `${trim.what}. ${trim.how}` }),
        ]),
      );
    }
  }

  for (const risk of r.risks ?? []) bits.push(el('div', { class: 'muted', text: `Risk: ${risk}` }));
  return el('div', { class: 'stack' }, bits);
}

async function loadLevers() {
  const { assets, expected_income: income } = await api('/api/analyst/levers');

  const assetHolder = document.getElementById('assetList');
  assetHolder.innerHTML = '';
  for (const asset of assets) {
    const remove = el('button', { class: 'small', text: 'Remove' });
    remove.addEventListener('click', async () => {
      await api(`/api/analyst/assets/${asset.id}`, { method: 'DELETE' });
      await loadLevers();
    });
    assetHolder.append(
      el('div', { class: 'row' }, [
        el('span', { class: 'grow truncate', text: asset.name }),
        el('span', { class: 'amount in', text: formatAmount(asset.estimated_value) }),
        asset.sold_on ? el('span', { class: 'badge', text: `sold ${asset.sold_on}` }) : null,
        remove,
      ]),
    );
  }
  if (assets.length) {
    const total = assets.filter((a) => a.sellable && !a.sold_on).reduce((sum, a) => sum + Number(a.estimated_value), 0);
    assetHolder.append(el('div', { class: 'muted', text: `${formatAmount(total.toFixed(2))} could be raised by selling.` }));
  }

  const incomeHolder = document.getElementById('incomeList');
  incomeHolder.innerHTML = '';
  for (const stream of income) {
    const remove = el('button', { class: 'small', text: 'Remove' });
    remove.addEventListener('click', async () => {
      await api(`/api/analyst/expected-income/${stream.id}`, { method: 'DELETE' });
      await loadLevers();
    });
    incomeHolder.append(
      el('div', { class: 'row' }, [
        el('span', { class: 'grow truncate', text: stream.label }),
        el('span', { class: 'amount in', text: formatAmount(stream.amount) }),
        el('span', { class: 'muted', text: `every ${stream.cadence_days}d${stream.starts_on ? `, from ${String(stream.starts_on).slice(0, 10)}` : ''}` }),
        el('span', { class: 'badge', text: stream.confidence }),
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

async function runAfford(endpoint, body) {
  const holder = document.getElementById('affordResult');
  const state = document.getElementById('affordState');
  holder.innerHTML = '';
  state.textContent = 'Thinking, this takes a moment...';
  try {
    const { analysis } = await api(endpoint, { method: 'POST', body });
    state.textContent = '';
    holder.append(analysis.result.verdict ? affordCard(analysis.result) : analysisCard(analysis));
    await load();
    showError('');
  } catch (err) {
    showError(err.message);
    state.textContent = '';
  }
}

document.getElementById('affordButton').addEventListener('click', () => {
  const amount = document.getElementById('affordAmount').value;
  if (!amount) return showError('Put in an amount first');
  return runAfford('/api/analyst/afford', {
    amount,
    description: document.getElementById('affordWhat').value || null,
    when: document.getElementById('affordWhen').value || null,
  });
});

document.getElementById('trimButton').addEventListener('click', () => runAfford('/api/analyst/trim', {}));

document.getElementById('addAsset').addEventListener('click', async () => {
  try {
    await api('/api/analyst/assets', {
      method: 'POST',
      body: {
        name: document.getElementById('assetName').value,
        estimated_value: document.getElementById('assetValue').value,
      },
    });
    document.getElementById('assetName').value = '';
    document.getElementById('assetValue').value = '';
    await loadLevers();
    showError('');
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById('addIncome').addEventListener('click', async () => {
  try {
    await api('/api/analyst/expected-income', {
      method: 'POST',
      body: {
        label: document.getElementById('incLabel').value,
        amount: document.getElementById('incAmount').value,
        cadence_days: document.getElementById('incCadence').value || 30,
        starts_on: document.getElementById('incStart').value || null,
        confidence: document.getElementById('incConfidence').value,
      },
    });
    for (const id of ['incLabel', 'incAmount', 'incStart']) document.getElementById(id).value = '';
    await loadLevers();
    showError('');
  } catch (err) {
    showError(err.message);
  }
});

try {
  await load();
  await loadLevers();
} catch (err) {
  showError(err.message);
}
