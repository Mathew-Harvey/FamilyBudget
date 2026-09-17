// What it would take to last.
//
// Home says when the money runs out. This says what would have to go for it not
// to, which is the question that follows.
//
// The page leads with one diagram: a track as long as the gap, with each step's
// saving filling it from the left. Whether cutting is enough is then a length
// rather than a sentence, and the part that does not fill is the part that
// cannot come from cutting. docs/behaviour.md is firm that a page which let
// someone cancel their subscriptions and believe the problem was handled would
// be doing them harm, and an unfilled track says that without a paragraph.
//
// The other rule it holds to: name what goes. "Cut 2,000 a month" is a number,
// not a plan. Every step lists the actual things, so it can be argued with.
import { api, el, formatAmount, renderNav, showError } from '/app.js';
import { cashChart } from '/chart.js';

renderNav('/plan');

const money = (value) => formatAmount(value);
const abs = (value) => formatAmount(String(value).replace('-', ''));
const cents = (value) => Math.round(Number(value ?? 0) * 100);

// Each step is drawn in the tier it acts on, so the colours mean the same thing
// here as on Home and Spending: dark is a bill you must pay, pale is a choice.
const TONE = { optional: 'cut', trim: 'trim' };
// Short enough for a key. The card below carries the full title.
const SHORT = { optional: 'Optional costs', trim: 'Trimming' };

// --- the diagram ----------------------------------------------------------

// The track is the gap. Each step fills part of it. What is left unfilled is
// what cutting cannot reach.
function gapDiagram(plan, short) {
  const gap = cents(plan.now.gap_per_month);
  const steps = plan.steps;
  if (!short || gap <= 0 || !steps.length) return null;

  // Cumulative, because each step includes the ones above it. The bar shows the
  // increment each one adds so the segments read as separate choices.
  let running = 0;
  const segments = steps.map((step) => {
    const total = Math.min(cents(step.saves_per_month), gap);
    const added = Math.max(total - running, 0);
    running = Math.max(running, total);
    return { key: step.key, added };
  }).filter((segment) => segment.added > 0);

  const shortfall = Math.max(gap - running, 0);

  return el('div', {}, [
    el('div', { class: 'split', style: 'height:22px' }, [
      ...segments.map((segment) => el('i', {
        style: `flex:${segment.added};background:var(--tier-${TONE[segment.key] ?? 'trim'})`,
      })),
      shortfall > 0 ? el('i', { class: 'unreachable', style: `flex:${shortfall}` }) : null,
    ]),
    el('div', { class: 'keys' }, [
      ...segments.map((segment, index) => el('span', {}, [
        el('i', { style: `background:var(--tier-${TONE[segment.key] ?? 'trim'})` }),
        el('span', { text: `${SHORT[segment.key] ?? steps[index].title} ` }),
        el('b', { text: money((segment.added / 100).toFixed(2)) }),
      ])),
      shortfall > 0 ? el('span', {}, [
        el('i', { class: 'unreachable' }),
        el('span', { text: 'Cutting cannot reach ' }),
        el('b', { text: money((shortfall / 100).toFixed(2)) }),
      ]) : null,
    ]),
  ]);
}

// --- the curve ------------------------------------------------------------

function planCurve(plan) {
  const curve = plan.curve;
  if (!curve?.as_is?.series?.length) return null;
  // Nothing to change, so nothing to compare: one curve, no reference.
  if (!curve.with_plan) {
    return cashChart(curve.as_is.series, { height: 200, runwayDate: curve.as_is.runway_date });
  }
  return el('div', {}, [
    cashChart(curve.with_plan.series, {
      height: 200,
      runwayDate: curve.with_plan.runway_date,
      reference: { series: curve.as_is.series, label: 'as it is' },
    }),
    el('div', { class: 'keys', style: 'margin-top:6px' }, [
      el('span', {}, [el('i', { style: 'background:var(--ink)' }), el('span', { text: 'With all of it' })]),
      el('span', {}, [el('i', { style: 'background:var(--neutral)' }), el('span', { text: 'As it is' })]),
    ]),
  ]);
}

// --- a step ---------------------------------------------------------------

function stepCard(step, index, short) {
  const outcome = !short
    ? el('div', { class: 'state ok', style: 'font-size:0.88rem' }, [
        el('span', { class: 'dot' }),
        el('span', { text: index === 0
          ? `Frees up ${money(step.saves_per_month)} a month`
          : `${money(step.saves_per_month)} a month with the steps above it` }),
      ])
    : step.lasts
      ? el('div', { class: 'state ok', style: 'font-size:0.88rem' }, [
          el('span', { class: 'dot' }),
          el('span', { text: 'This balances. Nothing runs out.' }),
        ])
      : el('div', { class: 'state bad', style: 'font-size:0.88rem' }, [
          el('span', { class: 'dot' }),
          el('span', { text: step.beyond_horizon
            ? `Lasts past ${step.horizon_date_friendly}, still ${money(step.still_short_per_month)} short`
            : `Runs out ${step.runway_date_friendly}, still ${money(step.still_short_per_month)} short` }),
        ]);

  const rows = step.removes.map((row) =>
    el('div', { class: 'row spread', style: 'gap:10px;padding:5px 0' }, [
      el('span', { class: 'truncate grow', text: row.what === 'Discretionary allowance'
        ? 'Everything else optional, day to day'
        : row.what }),
      el('span', { class: 'amount out', text: row.from
        ? `${money(row.per_month)} off ${money(row.from)}`
        : money(row.per_month) }),
    ]));
  if (step.removes_more > 0) {
    rows.push(el('div', { class: 's', text: `and ${step.removes_more} more` }));
  }

  return el('div', { class: 'card' }, [
    el('div', { class: 'row', style: 'gap:9px;margin-bottom:6px' }, [
      el('span', { class: `av ${TONE[step.key] ?? 'trim'}`, style: 'width:26px;height:26px;border-radius:8px;font-size:0.72rem', text: String(index + 1) }),
      el('strong', { class: 'grow', text: step.title }),
      // What this step adds, which is what the lines below it sum to.
      el('span', { class: 'amount', text: money(step.adds_per_month ?? step.saves_per_month) }),
    ]),
    outcome,
    el('div', { style: 'margin-top:10px' }, rows),
  ]);
}

// --- the page -------------------------------------------------------------

async function load() {
  try {
    const { plan, levers } = await api('/api/plan');

    // Positive is going backwards. Read off the sign of the string rather than
    // multiplying by 100, which would be float arithmetic on an amount to
    // answer a question about a minus sign. Zero is not short either.
    const gapText = String(plan.now.gap_per_month ?? '0');
    const short = !gapText.startsWith('-') && Number(gapText) > 0;

    const head = document.getElementById('head');
    head.innerHTML = '';
    head.append(el('div', { class: 'card' }, [
      el('span', { class: `state ${short ? 'bad' : 'ok'}` }, [
        el('span', { class: 'dot' }),
        // The same words Home uses for the same state. "Already balanced" is
        // break even, and it was said of a household thousands a month ahead.
        el('span', { text: short ? 'Going backwards' : 'More is coming in than going out' }),
      ]),
      el('div', { class: 'figure', text: abs(plan.now.gap_per_month) }),
      el('div', { class: `delta ${short ? 'down' : 'up'}` }, [
        el('span', { class: 'q', text: short
          ? `a month short${plan.now.runway_date_friendly ? `, runs out ${plan.now.runway_date_friendly}` : ''}`
          : 'a month left over' }),
      ]),
      gapDiagram(plan, short),
      // Two curves, one scale: the money as it is, and the money with every
      // step below taken. What the plan is worth is the distance between them,
      // which no figure on this page carries and which grows with time. The
      // ink line is the plan because the plan is what this page is about; the
      // dashed line is where you are without it.
      planCurve(plan),
      !short ? el('p', { class: 'muted small', style: 'margin:14px 0 0',
        text: 'Nothing below has to happen. It is what each change would be worth.' }) : null,
    ]));

    const steps = document.getElementById('steps');
    steps.innerHTML = '';
    if (plan.steps.length) steps.append(el('div', { class: 'sec', text: 'In this order' }));
    plan.steps.forEach((step, index) => steps.append(stepCard(step, index, short)));

    // The floor: every listed change taken, and whether that is enough.
    const floor = document.getElementById('floor');
    floor.innerHTML = '';
    floor.append(el('div', { class: 'card' }, [
      el('div', { class: 'row spread' }, [
        el('span', { class: 'grow' }, [
          el('span', { class: 't', text: 'All of it together' }),
          el('span', { class: 's', text: !short
            ? 'on top of what is already left over'
            : plan.floor.lasts ? 'covers what was short' : 'cutting cannot close this on its own' }),
        ]),
        el('span', { class: `amount ${plan.floor.lasts ? 'in' : 'out'}`, style: 'font-size:1.2rem',
          text: money(plan.floor.saves_per_month) }),
      ]),
      short && !plan.floor.lasts ? el('p', { class: 'warn small', style: 'margin:10px 0 0',
        text: `Still ${money(plan.floor.still_short_per_month)} a month short. The rest has to come from `
          + 'what comes in, from selling something, or from changing what the debts cost.' }) : null,
    ]));

    // Selling things. A lever, not a plan.
    const leverBox = document.getElementById('levers');
    leverBox.innerHTML = '';
    if (levers.length) {
      leverBox.append(
        el('div', { class: 'sec', text: 'Selling something buys time, it does not fix the gap' }),
        el('div', { class: 'card flush' }, levers.map((lever) =>
          el('div', { class: 'item' }, [
            el('span', { class: 'grow' }, [
              el('span', { class: 't truncate', text: lever.name }),
              el('span', { class: 's', text: `with everything above, ${money(lever.with_everything_above)}` }),
            ]),
            el('span', { class: 'right' }, [
              el('span', { class: 'amount', text: money(lever.worth) }),
              lever.days_gained === null ? null
                : el('span', { class: 's good', text: `+${lever.days_gained} days` }),
            ]),
          ]))),
      );
    }

    // Repeating costs nothing has judged. Not offered as savings, because
    // proposing you cancel something nobody has looked at is a default
    // pretending to be advice, and not hidden either.
    const undecided = plan.undecided ?? [];
    const undecidedBox = document.getElementById('undecided');
    undecidedBox.innerHTML = '';
    if (undecided.length) {
      undecidedBox.append(el('div', { class: 'nudge' }, [
        el('h3', { text: undecided.length === 1
          ? 'One repeating cost has not been looked at'
          : `${undecided.length} repeating costs have not been looked at` }),
        el('p', { text: 'Nothing above offers to stop these, because nothing has said '
          + 'whether they are optional. Say so on Spending and they join the plan.' }),
        el('div', { style: 'margin-top:9px' }, undecided.slice(0, 6).map((row) =>
          el('div', { class: 'row spread', style: 'padding:3px 0' }, [
            el('span', { class: 'grow truncate', text: row.what }),
            el('span', { class: 'amount', text: money(row.per_month) }),
          ]))),
        el('a', { class: 'btn', href: '/spending', text: 'Decide them', style: 'margin-top:11px' }),
      ]));
    }

    // What is not being touched. Said out loud, because a page that only lists
    // losses reads as though everything is going.
    const kept = document.getElementById('kept');
    kept.innerHTML = '';
    if (plan.kept.length) {
      kept.append(
        el('div', { class: 'sec', text: 'None of this changes' }),
        el('div', { class: 'card flush' }, plan.kept.slice(0, 10).map((row) =>
          el('div', { class: 'item' }, [
            el('span', { class: 'av keep', style: 'width:26px;height:26px;border-radius:8px;font-size:0.7rem', text: '✓' }),
            el('span', { class: 'grow truncate t', text: row.what }),
            el('span', { class: 'amount', text: money(row.per_month) }),
          ]))),
      );
    }
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

await load();
