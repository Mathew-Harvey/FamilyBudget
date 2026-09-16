// "Today" for a household in Perth is not "today" in UTC.
//
// Render runs in UTC, and so does new Date(). Perth is eight hours ahead, so
// from 4pm to midnight UTC the calendar date here is already tomorrow. Anything
// that asks "which pay period are we in" or "what has happened in the last 30
// days" was answering for the wrong day for a third of every day. Every date
// the app derives from the clock comes through here instead, and db.js sets the
// same zone on every Postgres connection so current_date agrees.
const DAY_MS = 86_400_000;

export const HOUSEHOLD_TIMEZONE = process.env.HOUSEHOLD_TIMEZONE || 'Australia/Perth';

// en-CA formats as YYYY-MM-DD, which is the only reason that locale is used.
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: HOUSEHOLD_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function today(now = new Date()) {
  return formatter.format(now);
}

// Dates are handled as YYYY-MM-DD strings, and arithmetic on them is done at
// UTC midnight so a daylight saving change somewhere cannot skip or repeat a
// day. Perth has no daylight saving, but the code should not depend on that.
export function addDays(date, days) {
  const at = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  return new Date(at.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysAgo(days, now = new Date()) {
  return addDays(today(now), -days);
}

export function daysFromNow(days, now = new Date()) {
  return addDays(today(now), days);
}
