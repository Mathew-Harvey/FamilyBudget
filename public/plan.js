// What it would take to last.
//
// The Today page says when the money runs out. This says what would have to go
// for it not to, which is the question that actually follows.
//
// It is built as cumulative steps rather than one number because that is how it
// gets done. Each one names the actual things, because "cut 2,000 a month" is
// not a plan.
//
// The rule it holds hardest: when a step is not enough, it says so and says by
// how much. A page that let someone cancel their subscriptions and believe the
// problem was handled would be doing them real harm. See docs/behaviour.md.
import { api, el, formatAmount, renderNav, showError } from '/app.js';

renderNav('/plan');
const money = (value) => formatAmount(value);

// One step. The outcome line is the point of it, so it goes first and largest.
function stepCard(step, index) {
  const outcome = step.lasts
    ? el('div', { class: 'good', style: 'font-weight:700;font-size:1.05rem' },
        [el('span', { text: 'This balances. Nothing runs out.' })])
    : el('div', { style: 'font-weight:700;font-size:1.05rem' }, [
        el('span', { class: 'warn', text: step.beyond_horizon
          ? `Lasts past ${step.horizon_date_friendly}`
          : `Still runs out ${step.runway_date_friendly}` }),
        el('span', { class: 'muted', style: 'font-weight:400', text: ` , still ${money(step.still_short_per_month)} a month short` }),
      ]);

  const list = el('div', { class: 'stack', style: 'gap:0.15rem;margin-top:0.5rem' },
    step.removes.map((row) =>
      el('div', { class: 'row', style: 'gap:0.5rem;align-items:baseline' }, [
        el('span', { class: 'truncate grow', text: row.what }),
        el('span', { class: 'amount out', style: 'white-space:nowrap',
          text: row.from ? `${money(row.per_month)} off ${money(row.from)}` : money(row.per_month) }),
      ])));

  if (step.removes_more > 0) {
    list.append(el('div', { class: 'muted', text: `and ${step.removes_more} more` }));
  }

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'row', style: 'align-items:baseline;gap:0.5rem' }, [
      el('span', { class: 'badge', text: `Step ${index + 1}` }),
      el('strong', { class: 'grow', text: step.title }),
    ]),
    el('div', { class: 'muted', text: step.detail }),
    outcome,
    el('div', { class: 'muted', style: 'margin-top:0.3rem', text: `Saves ${money(step.saves_per_month)} a month. What goes:` }),
    list,
  ]);
}

async function load() {
  try {
    const { plan, levers } = await api('/api/plan');

    const head = document.getElementById('head');
    head.innerHTML = '';
    head.className = 'card stack';
    head.append(
      el('h2', { style: 'margin:0', text: 'What it would take to last' }),
      el('p', { style: 'margin:0' }, [
        el('span', { text: 'As things stand the money runs out ' }),
        el('strong', { text: plan.now.runway_date_friendly ?? 'beyond this projection' }),
        el('span', { text: ', because ' }),
        el('strong', { class: 'amount out', text: `${money(plan.now.gap_per_month)} a month` }),
        el('span', { text: ' more goes out than comes in. Closing that gap is the whole job.' }),
      ]),
      el('p', { class: 'muted', style: 'margin:0', text:
        'Each step below includes the ones above it, because that is how it would be lived. Nothing here changes anything: it is what the numbers would do.' }),
    );

    const steps = document.getElementById('steps');
    steps.innerHTML = '';
    plan.steps.forEach((step, index) => steps.append(stepCard(step, index)));

    // The floor: every listed change done, and whether that is enough.
    const floor = document.getElementById('floor');
    floor.innerHTML = '';
    floor.append(el('div', { class: 'card stack' }, [
      el('h3', { style: 'margin:0', text: 'All changes together' }),
      el('div', { style: 'font-size:1.2rem;font-weight:700', class: plan.floor.lasts ? 'good' : 'warn',
        text: plan.floor.lasts
          ? `That balances, on ${money(plan.floor.saves_per_month)} a month of changes.`
          : `Even all of it leaves you ${money(plan.floor.still_short_per_month)} a month short.` }),
      el('p', { class: 'muted', style: 'margin:0', text: plan.floor.lasts
        ? 'Together, the changes above cover what was short.'
        : 'Cutting cannot close this on its own. The rest has to come from what comes in, from selling something, or from changing what the debts cost each month.' }),
    ]));

    // Selling things. A lever, not a plan.
    const leverBox = document.getElementById('levers');
    leverBox.innerHTML = '';
    if (levers.length) {
      leverBox.append(el('div', { class: 'card stack' }, [
        el('h3', { style: 'margin:0', text: 'Selling things buys time, it does not fix the gap' }),
        el('div', { class: 'muted', text: 'Each line assumes the ones above it are sold too. This buys weeks to make the changes above stick, and once it is spent it is gone.' }),
        el('div', { class: 'stack', style: 'gap:0.2rem' }, levers.map((lever) =>
          el('div', { class: 'row', style: 'gap:0.5rem;align-items:baseline' }, [
            el('span', { class: 'truncate grow', text: lever.name }),
            el('span', { class: 'amount', style: 'white-space:nowrap', text: money(lever.worth) }),
            el('span', { class: 'good', style: 'white-space:nowrap;min-width:7rem;text-align:right',
              text: lever.days_gained === null ? '' : `+${lever.days_gained} days` }),
          ]))),
      ]));
    }

    // What is not being touched. Said out loud, because a page that only lists
    // losses reads as though everything is going.
    const kept = document.getElementById('kept');
    kept.innerHTML = '';
    if (plan.kept.length) {
      kept.append(el('div', { class: 'card stack' }, [
        el('h3', { style: 'margin:0', text: 'What none of this touches' }),
        el('div', { class: 'muted', text: 'The roof, the power, the cover and the debts stay exactly as they are.' }),
        el('div', { class: 'stack', style: 'gap:0.15rem' }, plan.kept.slice(0, 10).map((row) =>
          el('div', { class: 'row', style: 'gap:0.5rem;align-items:baseline' }, [
            el('span', { class: 'truncate grow', text: row.what }),
            el('span', { class: 'amount', style: 'white-space:nowrap', text: `${money(row.per_month)} a month` }),
          ]))),
        el('p', { class: 'muted', style: 'margin:0', text:
          `Anything in the wrong group can be moved on the Spending page. The trimming assumes ${plan.trim_percent} percent less on food, fuel and care.` }),
      ]));
    }
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

await load();
