// What the allowance is made of, drawn once for the two pages that show it.
//
// "Everything else optional, day to day" is the largest optional figure in the
// app and was the only one with nothing under it. Plan offered it as something
// to stop and the allowance page asked for a number to replace it with, and
// neither said what it was. It is not a category anybody chose: it is what is
// left of the money going out once the transfers, the refunds, the one offs,
// the repeating costs and everything judged must pay or could trim have been
// taken out, and on most households the larger part of it is at places nobody
// has ever looked at. The row's own caption, takeaway and clothes, was
// describing a judgement that had not been made.
//
// One module, for the same reason there is one cash chart: two drawings of one
// figure are free to disagree about it. Nothing here does arithmetic on money.
// The server apportions the total across the places so the rows add up to the
// head exactly, and every amount arrives as a string and is printed as one.
import { el, formatAmount, initialsOf } from '/app.js';

const money = (value) => formatAmount(value);
const amount = (value) => Number(String(value ?? '0'));

// The split: how much of this anybody has actually judged.
//
// Same grammar as the Spending page's diagram, because it is the same
// distinction. A place with no judgement on it gets the hatch rather than a
// colour, since 'optional' there is a default and a default is not a finding.
function judgement(data, { link = true } = {}) {
  const judged = amount(data.judged.per_month);
  const unjudged = amount(data.unjudged.per_month);
  const total = judged + unjudged;
  if (total <= 0) return [];

  const share = (value) => Math.round((value / total) * 100);
  const places = (n) => `${n} place${n === 1 ? '' : 's'}`;

  return [
    el('div', { class: 'split' }, [
      judged > 0 ? el('i', {
        style: `flex:${judged};background:var(--tier-cut)`,
        title: `Judged optional: ${money(data.judged.per_month)} a month`,
      }) : null,
      unjudged > 0 ? el('i', {
        class: 'unreachable',
        style: `flex:${unjudged}`,
        title: `Never looked at: ${money(data.unjudged.per_month)} a month`,
      }) : null,
    ]),
    el('div', { class: 'keys' }, [
      judged > 0 ? el('span', {}, [
        el('i', { style: 'background:var(--tier-cut)' }),
        el('span', { text: `Judged optional, ${places(data.judged.places)} ` }),
        el('b', { text: `${share(judged)}%` }),
      ]) : null,
      unjudged > 0 ? el('span', {}, [
        el('i', { class: 'unreachable' }),
        el('span', { text: `Never looked at, ${places(data.unjudged.places)} ` }),
        el('b', { text: `${share(unjudged)}%` }),
      ]) : null,
    ]),
    // Where to go about it. Without this the hatching is a complaint with no
    // answer: the tier is a judgement and the Spending page is where places are
    // judged, so that is the link, not a second control here.
    unjudged > 0 && link
      ? el('p', { class: 'muted small', style: 'margin:12px 0 0' }, [
          el('span', { text: `${money(data.unjudged.per_month)} a month of this is at `
            + `${places(data.unjudged.places)} nothing has said are optional. The plan counts `
            + 'them as optional because that is the safer default, not because anybody decided it. ' }),
          el('a', { href: '/spending', text: 'Say what they are' }),
          el('span', { text: ' and this figure becomes a finding.' }),
        ])
      : null,
  ].filter(Boolean);
}

// One place, priced and captioned the way the Spending page prices one.
//
// The figure alone on the first line with a short unit under it, because an
// amount is nowrap and every word carried up beside it is width the name pays
// for. At phone width the money column here is 90 pixels and the name gets 170;
// with "a month" on the figure and the year figure under it the column took 180
// and the list read "Amazon Ma..." and "EFTPOS PU...", which is the one thing it
// exists to say. The year is not missed: it is the framing that undoes a
// subscription, where the question is whether to cancel, and nobody cancels a
// supermarket. The allowance is a rate and the month is the unit it is set in.
//
// The caption leads with the judgement when there is not one, for the same
// reason: it is the finding, and it has to survive being cut off.
function placeRow(row) {
  const days = `paid on ${row.days_paid} day${row.days_paid === 1 ? '' : 's'}`;
  const what = row.category && row.category !== 'Uncategorised' ? row.category : null;
  const caption = [row.judged ? null : 'Not looked at', what, days].filter(Boolean).join(', ');
  return el('a', { class: 'item', href: `/spending?place=${encodeURIComponent(row.key ?? row.name)}` }, [
    el('span', { class: `av ${row.judged ? 'cut' : 'unknown'}`, text: initialsOf(row.name) }),
    el('span', { class: 'grow' }, [
      el('span', { class: 't truncate', text: row.name }),
      el('span', { class: 's truncate', text: caption }),
    ]),
    el('span', { class: 'right' }, [
      el('span', { class: 'amount out', text: money(row.per_month) }),
      el('span', { class: 's', text: 'a month' }),
    ]),
  ]);
}

// The whole thing: the split, the places, and what is deliberately not in it.
//
// `link` off drops the pointer to the Spending page, for a caller that is
// already sitting on it.
export function optionalParts(data, { link = true } = {}) {
  if (!data || !data.places?.length) return [];

  return [
    ...judgement(data, { link }),
    el('div', { class: 'card flush', style: 'margin-top:14px' }, [
      ...data.places.map(placeRow),
      // Named rather than dropped, or the list stops adding up to its own head
      // at the twelfth row and nothing says so.
      data.rest
        ? el('div', { class: 'item' }, [
            el('span', { class: 'grow' }, [
              el('span', { class: 't', text: `and ${data.rest.places} more places` }),
              el('span', { class: 's', text: 'smaller than every one above' }),
            ]),
            el('span', { class: 'right' }, [
              el('span', { class: 'amount out', text: money(data.rest.per_month) }),
              el('span', { class: 's', text: 'a month' }),
            ]),
          ])
        : null,
    ].filter(Boolean)),
    // What is not in it. The question this figure raises first is whether the
    // mortgage or the groceries are hiding inside it, and the answer is no: they
    // are counted elsewhere and counting them here would be counting them twice.
    el('p', { class: 'muted small', style: 'margin:12px 0 0', text:
      `Over the last ${data.effective_days} days. Not in this: anything that repeats, `
      + 'anything marked must pay or could trim, anything marked a one off, and money '
      + 'moved between our own accounts.' }),
  ];
}

// The one line that says whether the figure in force is the life behind it.
//
// A chosen allowance and what optional spending has actually been are two
// different claims, and a breakdown of the second printed under the first
// without a word would be a list that does not add up to its own heading.
export function optionalChoiceNote(data) {
  if (!data) return null;
  if (!data.chosen) {
    return el('p', { class: 'muted small', style: 'margin:0 0 12px', text:
      'Nobody has chosen a figure, so the plan follows what this has actually been. '
      + 'These are the places it came from.' });
  }
  if (amount(data.not_in_the_plan_per_month) > 0) {
    return el('p', { class: 'muted small', style: 'margin:0 0 12px', text:
      `The plan carries ${money(data.in_force_per_month)} because somebody chose it. `
      + `Optional spending has actually been ${money(data.per_month)} a month at these places, `
      + `so ${money(data.not_in_the_plan_per_month)} a month of it is going out and is not in `
      + 'the projection.' });
  }
  if (amount(data.above_history_per_month) > 0) {
    return el('p', { class: 'muted small', style: 'margin:0 0 12px', text:
      `The plan carries ${money(data.in_force_per_month)} because somebody chose it, `
      + `which is ${money(data.above_history_per_month)} a month more than this has actually `
      + `been running at. These are the places the ${money(data.per_month)} went.` });
  }
  return el('p', { class: 'muted small', style: 'margin:0 0 12px', text:
    `Somebody chose ${money(data.in_force_per_month)}, which is what this has been running `
    + 'at. These are the places it went.' });
}
