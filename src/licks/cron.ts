export interface Schedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Field {
  name: string;
  min: number;
  max: number;
  names?: string[];
  offset?: number;
}

const FIELDS: Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS, offset: 0 },
];

function value(text: string, field: Field): number {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
  if (named >= 0) return named + (field.offset ?? 0);
  if (!/^\d+$/.test(text)) throw new Error(`${field.name}: "${text}" is not a number`);
  const number = Number(text);
  if (number < field.min || number > field.max)
    throw new Error(`${field.name}: ${number} is outside ${field.min}–${field.max}`);
  return number;
}

function range(part: string, field: Field): [number, number] {
  if (part === '*') return [field.min, field.max];
  const [from, to] = part.split('-');
  const start = value(from as string, field);
  const end = to === undefined ? start : value(to, field);
  if (end < start) throw new Error(`${field.name}: range ${part} runs backwards`);
  return [start, end];
}

function step(text: string | undefined, field: Field): number {
  if (text === undefined) return 1;
  if (!/^\d+$/.test(text) || Number(text) === 0)
    throw new Error(`${field.name}: step "${text}" must be a positive number`);
  return Number(text);
}

function field(text: string, spec: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    if (part === '') throw new Error(`${spec.name}: empty list item`);
    const [base, every, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`${spec.name}: "${part}" has two steps`);
    const [start, end] = range(base as string, spec);
    const stride = step(every, spec);
    const last =
      every !== undefined && !(base as string).includes('-') && base !== '*' ? spec.max : end;
    for (let n = start; n <= last; n += stride) out.add(n);
  }
  return out;
}

export function parseSchedule(expression: string): Schedule {
  const text = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      `"${expression}" needs 5 fields (minute hour day month weekday), not ${parts.length}`
    );
  const [minutes, hours, days, months, weekdays] = parts.map((part, at) =>
    field(part, FIELDS[at] as Field)
  ) as Set<number>[];
  if ((weekdays as Set<number>).delete(7)) (weekdays as Set<number>).add(0);
  return {
    minutes: minutes as Set<number>,
    hours: hours as Set<number>,
    days: days as Set<number>,
    months: months as Set<number>,
    weekdays: weekdays as Set<number>,
    anyDay: parts[2] === '*',
    anyWeekday: parts[4] === '*',
  };
}

function dayMatches(schedule: Schedule, date: Date): boolean {
  const day = schedule.days.has(date.getDate());
  const weekday = schedule.weekdays.has(date.getDay());
  if (schedule.anyDay) return weekday;
  if (schedule.anyWeekday) return day;
  return day || weekday;
}

const LIMIT_YEARS = 5;

export function nextFire(schedule: Schedule, after: number): number | null {
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = new Date(after).getFullYear() + LIMIT_YEARS;
  while (date.getFullYear() <= limit) {
    if (!schedule.months.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
    } else if (!dayMatches(schedule, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
    } else if (!schedule.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
    } else if (!schedule.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
    } else return date.getTime();
  }
  return null;
}

export interface Missed {
  count: number;
  more: boolean;
}

export function missedFires(
  schedule: Schedule,
  from: number,
  until: number,
  cap = 100_000
): Missed {
  let count = 0;
  let at: number | null = from;
  while (count < cap) {
    at = nextFire(schedule, at);
    if (at === null || at > until) return { count, more: false };
    count++;
  }
  const next = nextFire(schedule, at);
  return { count, more: next !== null && next <= until };
}
