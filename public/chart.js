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
//   3. How much, and when? Both axes carry that now. It used to have neither:
//      two annotated levels, "today" and "nothing left", and no scale, so
//      nothing on it could be read as an amount or as a date. A curve with no
//      axes is a mood. The y axis is round dollar steps, the x axis is month
//      boundaries starting at today, and the line ends carry their own figure.
//
// One scale, one measure, dollars. "today" is a tick on the time axis and not
// a rule across the plot: it is a moment, and drawing it as a horizontal line
// labelled with a word that means a day was the chart's most confusing mark.
import { el, formatAmount } from '/app.js';

const W = 1000;
const H = 300;
let seq = 0;

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A date a person can picture. The year rides along whenever the chart spans
// more than one of them: a crossing two years out labelled "27 Sep" is a
// different and much better sounding claim than the one the sentence under the
// chart is making, and the two were disagreeing on the same card.
function shortDate(iso, withYear = false) {
  const [year, month, day] = String(iso).slice(0, 10).split('-');
  return `${Number(day)} ${SHORT_MONTHS[Number(month) - 1]}${withYear ? ` ${year}` : ''}`;
}

// --- the y axis -----------------------------------------------------------

// Round dollar steps, chosen in integer cents. Nothing here is float
// arithmetic on an amount: the ladder is 1, 2 and 5 at every power of ten, so
// a step is an exact integer and every tick is an exact multiple of it. Which
// step to use is a question about the drawing, not about the money.
function tickStep(spanCents, target) {
  const rough = spanCents / target;
  for (let power = 100; power <= 1e12; power *= 10) {
    for (const base of [1, 2, 5]) {
      if (base * power >= rough) return base * power;
    }
  }
  return 1e12;
}

// Zero needs no special case: it is a multiple of every step, so it is always
// a tick whenever it is on the chart, which is what makes the red boundary a
// labelled level rather than a floating word.
function axisTicks(minCents, maxCents, target = 4) {
  const step = tickStep(Math.max(maxCents - minCents, 1), target);
  const out = [];
  for (let value = Math.ceil(minCents / step) * step; value <= maxCents; value += step) {
    out.push(value);
  }
  // A projection flat enough that no round step lands inside it still needs a
  // scale, or the gutter is empty beside a line.
  return out.length ? out : [Math.round((minCents + maxCents) / 2 / 100) * 100];
}

// Whole dollars, by string rather than by dividing: every tick is an exact
// multiple of a dollar, so the cents are always .00 and printing them is two
// characters of noise in a narrow gutter.
function axisAmount(cents) {
  const whole = String(Math.abs(cents)).padStart(3, '0').slice(0, -2);
  return `${cents < 0 ? '-' : ''}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

// --- the x axis -----------------------------------------------------------

// Month boundaries, so the axis reads "1 Mar" rather than whatever day an even
// stride happened to land on. Today is the first tick, by the word rather than
// by a date: it is where the curve starts and it is the thing every other mark
// is measured from.
function dateTicks(points) {
  const firsts = [];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].date.slice(8, 10) === '01') firsts.push(i);
  }
  const last = points.length - 1;
  // Nothing crowding either end: a label a fortnight in lands on "today" and
  // one at 98 percent hangs off the card. Thinned after that rather than
  // before, or a chart whose first month is dropped is left with four ticks
  // where it asked for five.
  const room = firsts.filter((index) => index / last > 0.24 && index / last < 0.93);
  const stride = Math.max(1, Math.ceil(room.length / 4));
  let year = null;
  return [
    { index: 0, text: 'today', first: true },
    ...room
      .filter((_, n) => n % stride === 0)
      .map((index, n) => {
        const [y, m] = points[index].date.split('-');
        const text = y === year ? SHORT_MONTHS[Number(m) - 1] : `${SHORT_MONTHS[Number(m) - 1]} ${y}`;
        year = y;
        // Four dates fit a card and three fit a phone, so every second one is
        // marked to drop at the width where they start landing on each other.
        // A thinner axis is a reading; two dates on top of each other is not.
        return { index, text, thin: n % 2 === 1 };
      }),
  ];
}

// --- the curve ------------------------------------------------------------

// A second curve on the same scale, drawn as a hairline.
//
// The plan page asks what a set of changes would do, and the only honest
// answer is two curves: the money as it is, and the money with the changes
// made. That is one chart with one job, "how far apart are these", and the
// reference is deliberately quiet: no fill, no colour, one word on it. It is
// aligned by date rather than by index so a shorter or offset series cannot be
// drawn against the wrong days.
//
// label and reference.label are what the legend calls each line. A legend is
// drawn only when there are two, because one line needs no key: the card above
// it already says what is plotted.
export function cashChart(series, {
  height = 200,
  runwayDate = null,
  label = 'With the plan',
  reference = null,
} = {}) {
  const points = series.filter((point) => point.balance_cents !== undefined);
  if (points.length < 2) return el('p', { class: 'muted small', text: 'Not enough to project yet.' });

  const values = points.map((point) => Number(point.balance_cents));
  const start = values[0];
  const spansYears = points[0].date.slice(0, 4) !== points.at(-1).date.slice(0, 4);
  const when = (iso) => shortDate(iso, spansYears);

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
  // story and a chart that cropped it would be hiding it.
  const nearZero = lowest < 0 || lowest < highest * 0.25;
  // How far below zero the chart bothers to go. Past a crossing there is no
  // balance to report, only a date: nobody's account holds minus a hundred
  // thousand dollars, and letting that set the scale squashed the curve the
  // page is actually about into the top fifth of the plot, where its sawtooth
  // was a flat squiggle. Enough depth to make a crossing unmistakable, and the
  // rest goes off the bottom, hatched, the same way a month taller than the
  // Lasting chart is hatched at the top: the chart carries on past here.
  const room = highest > 0 ? -Math.round(highest * 0.24) : lowest;
  const floor = nearZero ? Math.max(Math.min(lowest, 0), room) : lowest;
  const clipped = lowest < floor;
  // Air at both ends. Padding only the top left the lowest point sitting on the
  // floor of the plot, where a dip before payday reads as the chart running out
  // of room rather than as the money doing something. None below when the floor
  // is a deliberate cut, because the hatch band is what sits there instead.
  const pad = Math.max((highest - floor) * 0.1, 1);
  const min = clipped ? floor : floor - pad;
  const max = highest + pad;
  const span = max - min || 1;

  const x = (i) => (i / (points.length - 1)) * W;
  const y = (value) => (1 - (value - min) / span) * H;

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
  const zeroShown = min <= 0 && max >= 0;
  const ticks = axisTicks(min, max);

  // Solid hairlines. Dashing a gridline adds ink that is not data and, on this
  // chart, would be a third thing wearing the pattern the comparison curve
  // owns. Drawn over the fill rather than under it, in the hairline token
  // rather than the divider one: the fill is a tint but it is a tint of a
  // status colour, and under it a level was legible in the margin and gone
  // across the plot, which is the half of a gridline that does no work.
  const grid = ticks.filter((value) => value !== 0)
    .map((value) => `<line x1="0" y1="${y(value).toFixed(1)}" x2="${W}" y2="${y(value).toFixed(1)}"
        stroke="var(--axis)" stroke-width="1" vector-effect="non-scaling-stroke"/>`)
    .join('');

  // Where each line runs out. The date the server gave is authoritative, but it
  // can fall outside the days being drawn, so the first day under zero is the
  // fallback: a curve that visibly crosses the red line must carry the mark.
  const crossing = (vals, date) => {
    const named = date ? points.findIndex((point) => point.date === date) : -1;
    return named > 0 ? named : vals.findIndex((value) => value !== null && value < 0);
  };
  const runwayIndex = crossing(values, runwayDate);
  const refIndex = hasRef ? crossing(refValues, reference.runwayDate ?? null) : -1;

  const svg = `
    <svg class="plot" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <clipPath id="${id}in"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
        <clipPath id="${id}up"><rect x="0" y="0" width="${W}" height="${split.toFixed(1)}"/></clipPath>
        <clipPath id="${id}dn"><rect x="0" y="${split.toFixed(1)}" width="${W}" height="${(H - split).toFixed(1)}"/></clipPath>
      </defs>
      <g clip-path="url(#${id}in)">
        <path d="${band}" fill="var(--in)" opacity="0.14" clip-path="url(#${id}up)"/>
        <path d="${band}" fill="var(--out)" opacity="0.14" clip-path="url(#${id}dn)"/>
        ${grid}
        ${zeroShown ? `<line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}"
          stroke="var(--out)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` : ''}
        ${hasRef ? `<path d="${refLine}" fill="none" stroke="var(--neutral)" stroke-width="2"
          stroke-dasharray="5 4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
        <path d="${line}" fill="none" stroke="var(--ink)" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      </g>
    </svg>`;

  const wrap = el('div', { class: `cash${clipped ? ' clipped' : ''}`, style: `height:${height}px` });
  wrap.innerHTML = svg;

  // Labels are HTML rather than SVG text: the plot is stretched to the card's
  // width, which would stretch any text inside it with it.
  const at = (i) => `${((x(i) / W) * 100).toFixed(2)}%`;
  const up = (value) => `${((y(value) / H) * 100).toFixed(2)}%`;

  // One label per line, at the point that line is about, and never a number on
  // every point. The crossing when there is one; the end figure only when this
  // chart has no legend, because a legend states both outcomes side by side
  // where they can be compared and a second copy of one of them is the same
  // fact twice for the price of the picture.
  const mark = (index, klass, words) => wrap.append(el('span', {
    class: `mark ${klass}`,
    style: `left:${at(index)};top:${up(index === refIndex ? refValues[index] : values[index])}`,
  }, [el('i'), el('b', { text: words })]));

  if (runwayIndex > 0) mark(runwayIndex, 'bad', when(points[runwayIndex].date));
  // Not once the line has crossed zero. The curve past that point is what the
  // arithmetic does next, not a balance anyone can have: a bank account does
  // not hold minus two hundred dollars, and printing it beside the date the
  // money ran out offers a second, wronger answer to the same question. The
  // crossing is the whole story by then.
  if (runwayIndex < 0 && !hasRef) {
    wrap.append(el('span', {
      // Never red for merely ending lower than today. There is no crossing on
      // this branch, so the figure is money the household still has. It sits
      // above its own line, except where that would put it off the top of the
      // plot and onto the card's own text, which is where a curve that ends on
      // its highest point always put it.
      class: `end${y(values.at(-1)) / H < 0.18 ? ' under' : ''}`,
      style: `top:${up(values.at(-1))}`,
    }, [
      el('b', { text: formatAmount((values.at(-1) / 100).toFixed(2)) }),
      el('span', { text: ` by ${when(points.at(-1).date)}` }),
    ]));
  }

  // The reference gets the same treatment in a quieter key, and carries its own
  // name, because "which line is this" is the first question a second line
  // raises and a legend two inches below is a worse answer than the word.
  if (hasRef) {
    const refLabel = reference.label ?? 'as it is';
    // Two marks in the same place is one mark and an illegible one. Nothing
    // ticked means the two curves are the same curve, so they run out on the
    // same day: the legend still names both, which is where that fact belongs
    // when the chart has nowhere to put it.
    const together = runwayIndex > 0 && refIndex > 0
      && Math.abs(refIndex - runwayIndex) / points.length < 0.06;
    // The name and nothing else. Its own line is still plunging through the
    // space just under the crossing, so a date there is read across a dashed
    // hairline for no gain: the key underneath says when, next to the other
    // line's when, which is the comparison anybody came here for.
    if (refIndex > 0 && !together) {
      mark(refIndex, 'quiet', refLabel);
    } else if (refIndex < 0) {
      const lastRef = refValues.length - 1
        - [...refValues].reverse().findIndex((value) => value !== null);
      wrap.append(el('span', {
        class: 'end ref', style: `top:${up(refValues[lastRef])}`, text: refLabel,
      }));
    }
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
      el('span', { text: when(points[i].date) }),
      // The sign carries the direction. Colouring it would be the old rule
      // again in miniature: "lower than today" is not a warning.
      el('span', {
        text: `${change >= 0 ? '+' : '−'}${formatAmount((Math.abs(change) / 100).toFixed(2))} on today`,
      }),
      // The distance between the two lines, which is the whole reason there
      // are two. Integer cents subtracted from integer cents, decimal only at
      // the boundary, the same rule as everywhere else money is handled.
      hasRef && refValues[i] !== null
        ? el('span', { class: 'gap', text:
            `${formatAmount((Math.abs(value - refValues[i]) / 100).toFixed(2))} ${value >= refValues[i] ? 'ahead of' : 'behind'} ${reference.label ?? 'as it is'}` })
        : null,
    );
    wrap.classList.add('hovering');
  };
  skin.addEventListener('pointermove', move);
  skin.addEventListener('pointerdown', move);
  skin.addEventListener('pointerleave', () => wrap.classList.remove('hovering'));

  // What each line comes to, said in the legend so identity and outcome arrive
  // together. A key that only names a colour makes you look back at the chart
  // to find out what it was for.
  const outcome = (vals, index) => {
    if (index > 0) return `nothing left ${when(points[index].date)}`;
    const lastIndex = vals.length - 1 - [...vals].reverse().findIndex((value) => value !== null);
    return `${formatAmount((vals[lastIndex] / 100).toFixed(2))} by ${when(points[lastIndex].date)}`;
  };

  const chart = el('div', { class: 'chart' }, [
    // Zero is the one level with a meaning and not just a value, so it carries
    // the words for it. They used to float over the plot at the left, where the
    // curve starts and every other mark ends up, so "nothing left" read as a
    // caption nobody could attach to anything. On the scale, under its own
    // figure, it is unmistakably the name of that line.
    el('div', { class: 'yaxis' }, ticks.map((value) => el('span', {
      class: value === 0 ? 'nil' : null,
      style: `top:${up(value)}`,
    }, [
      el('b', { text: axisAmount(value) }),
      value === 0 ? el('i', { text: 'nothing left' }) : null,
    ]))),
    wrap,
    el('div', { class: 'xaxis' }, dateTicks(points).map((tick) => el('span', {
      class: [tick.first ? 'first' : null, tick.thin ? 'thin' : null].filter(Boolean).join(' ') || null,
      style: `left:${at(tick.index)}`,
      text: tick.text,
    }))),
    // A key looks like the mark it names. Two solid squares for a solid line
    // and a dashed hairline is a legend you have to decode, and in dark mode
    // --ink is white, so the key for the main curve was a small white box
    // beside a sentence: it read as a tick box nobody had ticked.
    // The name and the outcome are one run of text rather than two flex items,
    // or a phone lays them out as two narrow columns and wraps each of them
    // down the card.
    hasRef ? el('div', { class: 'keys' }, [
      el('span', {}, [
        el('i', { class: 'line' }),
        el('span', {}, [
          // A text node rather than a span: .keys makes every span inside it an
          // inline flex box, and a flex box drops the space at the end of its
          // own text, so the name ran straight into the figure.
          document.createTextNode(`${label} `),
          el('b', { text: outcome(values, runwayIndex) }),
        ]),
      ]),
      el('span', {}, [
        el('i', { class: 'dash' }),
        el('span', {}, [
          document.createTextNode(`${reference.label ?? 'as it is'} `),
          el('b', { text: outcome(refValues, refIndex) }),
        ]),
      ]),
    ]) : null,
  ]);

  return chart;
}
