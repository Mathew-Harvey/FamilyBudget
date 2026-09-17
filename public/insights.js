import { api, el, formatAmount, renderNav, showError, formatWhen, pageIntro } from '/app.js';

renderNav('/insights');
pageIntro('Ask Claude about it', 'Periodic analysis and predictive budgeting. Off until you switch it on: it costs money per run and sends financial data off this machine.');

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

try {
  await load();
} catch (err) {
  showError(err.message);
}
