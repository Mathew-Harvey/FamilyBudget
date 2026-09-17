// The cash curve, drawn once and used by both pages that show it.
//
// Home and Forecast each had their own idea of this, which is one more place
// for two pictures of the same projection to disagree. This is the only one.
//
// What it answers, in order of what a household actually asks:
//
//   1. Am I building up or running down? The band between the curve and where
//      the money stands today is filled in the direction it is moving, so that
//      is a colour and an area rather than a sentence. A fortnight that dips
//      before payday and recovers after shows as red then green, which is the
//      real texture of it and is invisible in any monthly figure.
//   2. When does it get serious? If the curve reaches zero, that crossing is
//      the runway date the page leads with, marked where it happens.
//   3. What will I have? The end of the line carries its own figure.
//
// Drawn as one scale with two annotated levels, today's balance and zero. Two
// levels is not two axes: every mark is dollars, measured the same way.
import { el, formatAmount } from '/app.js';

const W = 1000;
const H = 300;
let seq = 0;

// A date a person can picture. friendlyDate lives on the server for the pages
// that say it in a sentence; this is the short form for an axis.
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso) {
  const [, month, day] = String(iso).slice(0, 10).split('-');
  return `${Number(day)} ${SHORT_MONTHS[Number(month) - 1]}`;
}

export function cashChart(series, { height = 200, runwayDate = null } = {}) {
  const points = series.filter((point) => point.balance_cents !== undefined);
  if (points.length < 2) return el('p', { class: 'muted small', text: 'Not enough to project yet.' });

  const values = points.map((point) => Number(point.balance_cents));
  const start = values[0];
  const last = values.at(-1);
  const lowest = Math.min(...values);
  const highest = Math.max(...values);

  // Fitted to the curve, not forced down to zero: the band is measured from
  // today's level and says so, so it is not an area to an axis that would be
  // claiming something about the distance to nothing. Zero is pulled in only
  // when the money gets near enough to it to matter, because then how close it
  // comes is the whole story and a chart that cropped it would be hiding it.
  const nearZero = lowest < 0 || lowest < highest * 0.25;
  const floor = nearZero ? Math.min(lowest, 0) : lowest;
  // Air at both ends. Padding only the top left the lowest point sitting on the
  // floor of the plot, where a dip before payday reads as the chart running out
  // of room rather than as the money doing something.
  const pad = Math.max((highest - floor) * 0.1, 1);
  const min = floor - pad;
  const max = highest + pad;
  const span = max - min || 1;

  const x = (i) => (i / (points.length - 1)) * W;
  const y = (value) => (1 - (value - min) / span) * H;
  const refY = y(start);

  const line = values
    .map((value, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(value).toFixed(1)}`)
    .join(' ');
  // Closed back along today's level, so the enclosed area is exactly the
  // distance from where the money stands now. Clipped above and below that
  // level and filled twice, which makes every crossing land in the right
  // colour without anyone having to find the crossings.
  const band = `${line} L${W},${refY.toFixed(1)} L0,${refY.toFixed(1)} Z`;

  const id = `c${++seq}`;
  const zeroShown = nearZero && min <= 0 && max >= 0;
  const runwayIndex = runwayDate
    ? points.findIndex((point) => point.date === runwayDate)
    : -1;

  const svg = `
    <svg class="plot" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <clipPath id="${id}up"><rect x="0" y="0" width="${W}" height="${Math.max(refY, 0).toFixed(1)}"/></clipPath>
        <clipPath id="${id}dn"><rect x="0" y="${Math.max(refY, 0).toFixed(1)}" width="${W}" height="${Math.max(H - refY, 0).toFixed(1)}"/></clipPath>
      </defs>
      <path d="${band}" fill="var(--in)" opacity="0.14" clip-path="url(#${id}up)"/>
      <path d="${band}" fill="var(--out)" opacity="0.14" clip-path="url(#${id}dn)"/>
      ${zeroShown ? `<line x1="0" y1="${y(0).toFixed(1)}" x2="${W}" y2="${y(0).toFixed(1)}"
        stroke="var(--out)" stroke-width="1" vector-effect="non-scaling-stroke"/>` : ''}
      <line x1="0" y1="${refY.toFixed(1)}" x2="${W}" y2="${refY.toFixed(1)}"
            stroke="var(--axis)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      <path d="${line}" fill="none" stroke="var(--ink)" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg>`;

  const wrap = el('div', { class: 'cash', style: `height:${height}px` });
  wrap.innerHTML = svg;

  // Labels are HTML rather than SVG text: the plot is stretched to the card's
  // width, which would stretch any text inside it with it.
  const at = (i) => `${((x(i) / W) * 100).toFixed(2)}%`;
  const up = (value) => `${((y(value) / H) * 100).toFixed(2)}%`;

  // Which side of its own line the word sits on, decided by where the curve
  // goes first. It starts on the line by definition, so a fixed side collides
  // with it about half the time.
  const climbs = values.slice(1, 8).filter((value) => value > start).length >= 4;
  wrap.append(el('span', {
    class: `ref ${climbs ? 'below' : 'above'}`, style: `top:${up(start)}`, text: 'today',
  }));

  // The band is a tint either side of today's level and the zero line is a
  // threshold, and both are reddish when things are going badly. One word
  // settles which is which, and it only appears when zero is on the chart.
  if (zeroShown) {
    wrap.append(el('span', { class: 'zero', style: `top:${up(0)}`, text: 'nothing left' }));
  }

  // One label at the end, and one on the crossing if there is one. Not a number
  // on every point: the rest is in the tooltip, where it is asked for.
  if (runwayIndex > 0) {
    wrap.append(el('span', {
      class: 'mark bad',
      style: `left:${at(runwayIndex)};top:${up(values[runwayIndex])}`,
    }, [el('i'), el('b', { text: shortDate(runwayDate) })]));
  }
  // Not when the line has already crossed zero. The curve past that point is
  // what the arithmetic does next, not a balance anyone can have: a bank
  // account does not hold minus two hundred dollars, and printing it beside the
  // date the money ran out offers a second, wronger answer to the same
  // question. The crossing is the whole story by then.
  if (runwayIndex < 0) {
    wrap.append(el('span', {
      class: `end ${last >= start ? 'up' : 'down'}`,
      style: `top:${up(last)}`,
    }, [
      el('b', { text: formatAmount((last / 100).toFixed(2)) }),
      el('span', { text: ` by ${shortDate(points.at(-1).date)}` }),
    ]));
  }

  // The hover layer. A crosshair and one tooltip: the chart shows the shape and
  // this answers "what about that day", which is the only other question it
  // raises. Touch counts, so this is pointer events rather than mouse.
  const cursor = el('span', { class: 'cursor' });
  const tip = el('span', { class: 'tip' });
  const skin = el('span', { class: 'skin' });
  wrap.append(cursor, tip, skin);

  const move = (event) => {
    const box = wrap.getBoundingClientRect();
    const share = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    const i = Math.round(share * (points.length - 1));
    const value = values[i];
    const change = value - start;
    cursor.style.left = at(i);
    cursor.style.setProperty('--dot', up(value));
    // Kept inside the plot on both axes. It used to sit above the chart, which
    // on the front page meant it covered the headline figure.
    const level = (y(value) / H) * 100;
    tip.style.left = at(i);
    tip.style.top = `${level.toFixed(2)}%`;
    tip.classList.toggle('flip', share > 0.6);
    tip.classList.toggle('under', level < 42);
    tip.innerHTML = '';
    tip.append(
      el('b', { text: formatAmount((value / 100).toFixed(2)) }),
      el('span', { text: shortDate(points[i].date) }),
      el('span', {
        class: change >= 0 ? 'good' : 'warn',
        text: `${change >= 0 ? '+' : '−'}${formatAmount((Math.abs(change) / 100).toFixed(2))} on today`,
      }),
    );
    wrap.classList.add('hovering');
  };
  skin.addEventListener('pointermove', move);
  skin.addEventListener('pointerdown', move);
  skin.addEventListener('pointerleave', () => wrap.classList.remove('hovering'));

  return wrap;
}
