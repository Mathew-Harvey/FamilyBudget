// The cash curve, drawn once and used by both pages that show it.
//
// Home and Forecast each had their own idea of this, which is one more place
// for two pictures of the same projection to disagree. This is the only one.
//
// What it answers, in order of what a household actually asks:
//
//   1. Am I building up or running down? The slope of the line says that, and
//      it needs no help: a line going down already conveys money going out.
//   2. When does it get serious? Red means one thing only, that the money is
//      predicted to go below zero, and the crossing is marked where it happens.
//      The band used to be measured from today's balance instead, so an
//      ordinary fortnight that dips before payday and recovers after was
//      painted red while the balance sat at twenty thousand dollars. Red is a
//      status colour and spending it on "lower than it is right now" leaves
//      nothing to say "you have run out" with.
//   3. What will I have? The end of the line carries its own figure.
//
// Drawn as one scale with two annotated levels, today's balance and zero. Two
// levels is not two axes: every mark is dollars, measured the same way. Today's
// level stays as a hairline to measure against, it is simply no longer what
// decides the colour.
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

// A second curve on the same scale, drawn as a hairline.
//
// The plan page asks what a set of changes would do, and the only honest
// answer is two curves: the money as it is, and the money with the changes
// made. That is one chart with one job, "how far apart are these", and the
// reference is deliberately quiet: no fill, no colour, one word at its end.
// It is aligned by date rather than by index so a shorter or offset series
// cannot be drawn against the wrong days.
export function cashChart(series, { height = 200, runwayDate = null, reference = null } = {}) {
  const points = series.filter((point) => point.balance_cents !== undefined);
  if (points.length < 2) return el('p', { class: 'muted small', text: 'Not enough to project yet.' });

  const values = points.map((point) => Number(point.balance_cents));
  const start = values[0];
  const last = values.at(-1);

  const refByDate = new Map((reference?.series ?? [])
    .filter((point) => point.balance_cents !== undefined)
    .map((point) => [point.date, Number(point.balance_cents)]));
  const refValues = points.map((point) => refByDate.get(point.date) ?? null);
  const hasRef = refValues.some((value) => value !== null);

  // The scale covers both curves, or the comparison is drawn against a lie.
  const everything = values.concat(refValues.filter((value) => value !== null));
  const lowest = Math.min(...everything);
  const highest = Math.max(...everything);

  // Fitted to the curve, not forced down to zero. Twenty two thousand dollars
  // moving by two is a flat line on a scale that starts at nothing, and how it
  // moves is what the chart is for. Zero is pulled in as soon as the money gets
  // near enough to it to matter, because then how close it comes is the whole
  // story and a chart that cropped it would be hiding it. The fill reaching the
  // foot of the plot is a tint, not an area anyone is asked to read off: the
  // figures are on the line and in the tooltip.
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
  // Only through the days the reference has a value for, so a gap breaks the
  // line rather than being bridged by a straight segment across it.
  let refPenDown = false;
  const refLine = refValues.map((value, i) => {
    if (value === null) { refPenDown = false; return ''; }
    const op = refPenDown ? 'L' : 'M';
    refPenDown = true;
    return `${op}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
  }).filter(Boolean).join(' ');
  // Closed along zero, so the filled area is the money there is rather than the
  // distance from where it stands today. Filled twice and clipped at the same
  // level, which puts every crossing in the right colour without anyone having
  // to find the crossings.
  //
  // Closing at the foot of the plot instead looks equivalent and is not: the
  // enclosed region then runs past zero everywhere, so a household with money
  // in the bank got a red strip across the full width of its chart.
  const zeroY = y(0);
  const band = `${line} L${W},${zeroY.toFixed(1)} L0,${zeroY.toFixed(1)} Z`;

  // The same level, clamped into the plot for the clips. Off the bottom means
  // the money never comes near zero and there is no red; off the top means the
  // whole projection is under water and there is no green.
  const split = Math.min(Math.max(zeroY, 0), H);

  const id = `c${++seq}`;
  const zeroShown = nearZero && min <= 0 && max >= 0;
  const runwayIndex = runwayDate
    ? points.findIndex((point) => point.date === runwayDate)
    : -1;

  const svg = `
    <svg class="plot" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <clipPath id="${id}up"><rect x="0" y="0" width="${W}" height="${split.toFixed(1)}"/></clipPath>
        <clipPath id="${id}dn"><rect x="0" y="${split.toFixed(1)}" width="${W}" height="${(H - split).toFixed(1)}"/></clipPath>
      </defs>
      <path d="${band}" fill="var(--in)" opacity="0.14" clip-path="url(#${id}up)"/>
      <path d="${band}" fill="var(--out)" opacity="0.14" clip-path="url(#${id}dn)"/>
      ${zeroShown ? `<line x1="0" y1="${y(0).toFixed(1)}" x2="${W}" y2="${y(0).toFixed(1)}"
        stroke="var(--out)" stroke-width="1" vector-effect="non-scaling-stroke"/>` : ''}
      <line x1="0" y1="${refY.toFixed(1)}" x2="${W}" y2="${refY.toFixed(1)}"
            stroke="var(--axis)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      ${hasRef ? `<path d="${refLine}" fill="none" stroke="var(--neutral)" stroke-width="1.5"
            stroke-dasharray="4 3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
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

  // The one word that names the threshold the colour is about. Only drawn when
  // zero is on the chart, which is the only time any of it is red.
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
      // Never red for merely ending lower than today. There is no crossing on
      // this branch, so the figure is money the household still has.
      class: 'end',
      style: `top:${up(last)}`,
    }, [
      el('b', { text: formatAmount((last / 100).toFixed(2)) }),
      el('span', { text: ` by ${shortDate(points.at(-1).date)}` }),
    ]));
  }

  if (hasRef) {
    const lastRefIndex = refValues.length - 1 - [...refValues].reverse().findIndex((value) => value !== null);
    wrap.append(el('span', {
      class: 'end ref',
      style: `top:${up(refValues[lastRefIndex])}`,
      text: reference.label ?? 'as it is',
    }));
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
      el('b', { class: value < 0 ? 'under-zero' : '', text: formatAmount((value / 100).toFixed(2)) }),
      el('span', { text: shortDate(points[i].date) }),
      // The sign carries the direction. Colouring it would be the old rule
      // again in miniature: "lower than today" is not a warning.
      el('span', {
        text: `${change >= 0 ? '+' : '−'}${formatAmount((Math.abs(change) / 100).toFixed(2))} on today`,
      }),
      hasRef && refValues[i] !== null
        ? el('span', { text: `${reference.label ?? 'as it is'} ${formatAmount((refValues[i] / 100).toFixed(2))}` })
        : null,
    );
    wrap.classList.add('hovering');
  };
  skin.addEventListener('pointermove', move);
  skin.addEventListener('pointerdown', move);
  skin.addEventListener('pointerleave', () => wrap.classList.remove('hovering'));

  return wrap;
}
