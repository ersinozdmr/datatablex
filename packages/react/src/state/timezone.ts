/**
 * `column.timezone` is a DISPLAY conversion only: the wire format is always UTC
 * ISO 8601. The date range filter needs both directions of this conversion: the
 * CALENDAR DAY the user picks is converted to UTC as the start/end of that day
 * in the time zone, and when an existing filter is reopened, the UTC instant is
 * reduced back to the day in the same time zone.
 *
 * The conversion is done with `Intl`; not adding a date library (dayjs/date-fns)
 * is deliberate: the only runtime dependency of `@datatablex/react` is
 * `@datatablex/core`, and the date library copy that a UI kit ships is not part
 * of the contract of this package.
 */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, created);
  return created;
}

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const warnedZones = new Set<string>();

/**
 * An invalid IANA identifier (`Intl` throws a `RangeError`) does NOT crash the
 * table: it falls back to the browser's own time zone and warns once in a
 * development build, so that a misspelled `timezone` does not silently produce
 * a wrong range.
 */
function resolveTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return hostTimeZone();
  try {
    formatterFor(timeZone);
    return timeZone;
  } catch {
    if (process.env.NODE_ENV !== "production" && !warnedZones.has(timeZone)) {
      warnedZones.add(timeZone);
      console.warn(
        `[datatablex] column.timezone is invalid: "${timeZone}" — falling back to the browser's time zone.`,
      );
    }
    return hostTimeZone();
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

/** The wall-clock time of a UTC instant in the given time zone. */
function wallClockAt(instant: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  const hour = read("hour");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Some engines format midnight as "24" under `hour12: false`.
    hour: hour === 24 ? 0 : hour,
    minute: read("minute"),
    second: read("second"),
    ms: 0,
  };
}

/** The offset (ms) of the time zone AT that instant; it changes during the year with DST. */
function offsetMsAt(instant: number, timeZone: string): number {
  const w = wallClockAt(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // The formatter drops milliseconds, so the comparison is also made against the
  // instant rounded down to the second (`floor` is the right direction for
  // negative instants).
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Wall-clock time to UTC instant. Two passes are needed: the first offset is
 * read at the GUESSED instant, and if the corrected instant falls on the other
 * side of a DST boundary, the offset is read again there and applied. A
 * single-pass conversion would produce a one-hour shift on a clock-change day.
 */
function wallClockToInstant(wall: WallClock, timeZone: string): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.ms);
  const firstPass = guess - offsetMsAt(guess, timeZone);
  return guess - offsetMsAt(firstPass, timeZone);
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

/**
 * Pins a `YYYY-MM-DD` calendar day to the START of that day (00:00) in the
 * given time zone and returns it as a UTC ISO 8601 string. Without `timeZone`
 * (or with an invalid one) the browser's time zone is used. Returns `null` if
 * `day` is not in `YYYY-MM-DD` form.
 *
 * There is deliberately NO "end of day" counterpart: an inclusive `23:59:59.999`
 * would leave out the last records of the day at PostgreSQL's microsecond
 * precision. The upper bound is always the start of the next day, used with
 * `lt` (`addDaysToDay(day, 1)` → this function). Because the end is the start of
 * the next day, a day that contains a DST change is correctly 23 or 25 hours
 * long.
 *
 * @example
 * ```ts
 * zonedDayStartToUtcIso("2025-03-10", "Europe/Istanbul"); // "2025-03-09T21:00:00.000Z"
 *
 * // Berlin switches to summer time on 2025-03-30, so that day is 23 hours long.
 * zonedDayStartToUtcIso("2025-03-30", "Europe/Berlin"); // "2025-03-29T23:00:00.000Z"
 * zonedDayStartToUtcIso(addDaysToDay("2025-03-30", 1), "Europe/Berlin"); // "2025-03-30T22:00:00.000Z"
 * ```
 */
export function zonedDayStartToUtcIso(day: string, timeZone?: string): string | null {
  if (!DAY_PATTERN.test(day)) return null;
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const wall: WallClock = { year, month, day: date, hour: 0, minute: 0, second: 0, ms: 0 };
  const instant = wallClockToInstant(wall, resolveTimeZone(timeZone));
  if (Number.isNaN(instant)) return null;
  return new Date(instant).toISOString();
}

/**
 * Reduces a UTC ISO 8601 instant to the calendar day (`YYYY-MM-DD`) in the given
 * time zone (the browser's time zone if omitted or invalid). Returns `null` if
 * `iso` cannot be parsed.
 *
 * @example
 * ```ts
 * utcIsoToZonedDay("2025-03-09T21:30:00.000Z", "Europe/Istanbul"); // "2025-03-10"
 * ```
 */
export function utcIsoToZonedDay(iso: string, timeZone?: string): string | null {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return null;
  const w = wallClockAt(instant, resolveTimeZone(timeZone));
  if (Number.isNaN(w.year)) return null;
  return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}`;
}

/**
 * Adds or subtracts `delta` days to a `YYYY-MM-DD` calendar day (plain calendar
 * arithmetic; it involves NO time zone conversion). It builds and
 * decodes the HALF-OPEN end bound of datetime leaves (see `state/filterRules.ts`):
 * an "until 3 September" bound is built as `< the start of 4 September`, which
 * requires moving the day forward by one first.
 *
 * @example
 * ```ts
 * addDaysToDay("2025-02-28", 1); // "2025-03-01"
 * addDaysToDay("2025-03-01", -1); // "2025-02-28"
 * ```
 */
export function addDaysToDay(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, date + delta));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`;
}
