import { api, el, formatAmount, renderNav, showError, formatWhen, pageIntro } from '/app.js';

renderNav('/insights');
pageIntro('Ask Claude about it',
  'A read of the household, a verdict on something you are thinking of buying, '
  + 'and a cost you know is coming turned into a commitment.');

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
      `${formatWhen(analysis.created_at)}, ${analysis.model ?? ''}, `,
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

// On or off, and whether it could run at all. Two separate facts, and the page
// used to leave both to be deduced: the switch sat in a row of form controls
// and whether the key was even configured was a grey sentence above them.
//
// The switch is only about running on a schedule. Analyse now works whether or
// not it is on, which the page never said, so "off" read as "this page does
// nothing" and everything under it looked inert.
function renderHead(settings, claude) {
  const head = document.getElementById('head');
  head.innerHTML = '';

  const toggle = el('input', {
    type: 'checkbox', class: 'switch',
    'aria-label': 'Analyse automatically after a sync',
  });
  toggle.checked = Boolean(settings.enabled);
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      await api('/api/analyst/settings', { method: 'POST', body: { enabled: toggle.checked } });
      await load();
      showError('');
    } catch (err) {
      showError(err.message);
      toggle.checked = Boolean(settings.enabled);
      toggle.disabled = false;
    }
  });

  head.append(el('div', { class: 'card' }, [
    el('div', { class: 'row spread' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: `state ${claude.configured ? (settings.enabled ? 'ok' : '') : 'warn'}` }, [
          el('span', { class: 'dot', style: settings.enabled && claude.configured ? null : 'background:var(--neutral)' }),
          el('span', { text: !claude.configured
            ? 'Cannot run yet'
            : settings.enabled ? 'Runs itself after a sync' : 'Only runs when you ask' }),
        ]),
        el('span', { class: 't', style: 'margin-top:8px', text: claude.configured
          ? `Last run ${formatWhen(settings.last_run_at)}`
          : 'ANTHROPIC_API_KEY is not set' }),
        el('span', { class: 's', text: claude.configured
          ? `${claude.model}, at most every ${settings.cadence_days} days`
          : 'Add it to the environment and restart, then this can run' }),
      ]),
      claude.configured ? toggle : null,
    ]),
    // What leaves the machine, said plainly and linked. Every field in the
    // snapshot goes through scrubLabel first, because banks put account and BSB
    // numbers inside the description text itself.
    el('p', { class: 'muted small', style: 'margin:12px 0 0' }, [
      el('span', { text: 'Each run costs money and sends figures off this machine. '
        + 'Nothing that identifies an account goes with them. ' }),
      el('a', { href: '/api/analyst/snapshot', target: '_blank', text: 'See exactly what gets sent' }),
    ]),
  ]));
}

async function load() {
  const { settings, claude, analyses } = await api('/api/analyst');
  document.getElementById('cadence').value = settings.cadence_days;
  document.getElementById('effort').value = settings.effort;
  renderHead(settings, claude);

  // Nothing below this can work without a key, so it is not offered. A button
  // that only ever returns an error is a worse answer than a greyed out one
  // with the reason written beside it.
  for (const id of ['run', 'affordButton', 'trimButton', 'planButton']) {
    document.getElementById(id).disabled = !claude.configured;
  }
  document.getElementById('runState').textContent = claude.configured
    ? '' : 'Needs ANTHROPIC_API_KEY before it can answer anything.';

  const history = document.getElementById('history');
  history.innerHTML = '';
  if (analyses.length) {
    history.append(el('div', { class: 'sec', text: 'What it has said' }));
    for (const analysis of analyses) history.append(analysisCard(analysis));
  }
}

document.getElementById('saveSettings').addEventListener('click', async () => {
  try {
    await api('/api/analyst/settings', {
      method: 'POST',
      body: {
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

try {
  await load();
} catch (err) {
  showError(err.message);
}
