import { afterEach, describe, expect, it, vi } from "vitest";
import { addDaysToDay, utcIsoToZonedDay, zonedDayStartToUtcIso } from "../state/timezone.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("zonedDayStartToUtcIso — calendar day → UTC instant", () => {
  it("converts the start of the day to UTC according to the column's time zone", () => {
    // Europe/Istanbul = UTC+3 (no DST): 3 September 00:00 → 2 September 21:00Z
    expect(zonedDayStartToUtcIso("2026-09-03", "Europe/Istanbul")).toBe("2026-09-02T21:00:00.000Z");
  });

  it("the upper bound is the start of the next day (half-open interval)", () => {
    expect(zonedDayStartToUtcIso(addDaysToDay("2026-09-03", 1), "Europe/Istanbul")).toBe("2026-09-03T21:00:00.000Z");
  });

  it("in the UTC time zone the conversion is the identity", () => {
    expect(zonedDayStartToUtcIso("2026-09-03", "UTC")).toBe("2026-09-03T00:00:00.000Z");
  });

  /**
   * The day DST starts (New York, 8 March 2026 02:00 → 03:00): the offset is
   * -05:00 at the start of the day and -04:00 at the start of the next day. A
   * single-pass conversion would shift the upper bound by an hour and the last
   * hour of the range would fall outside the filter.
   */
  it("on a DST transition day the start of the day and the start of the next day are converted with DIFFERENT offsets", () => {
    expect(zonedDayStartToUtcIso("2026-03-08", "America/New_York")).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedDayStartToUtcIso("2026-03-09", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
  });

  it("input that is not YYYY-MM-DD returns null", () => {
    expect(zonedDayStartToUtcIso("03.09.2026", "UTC")).toBeNull();
    expect(zonedDayStartToUtcIso("", "UTC")).toBeNull();
    expect(zonedDayStartToUtcIso("2026-09-03T10:00:00Z", "UTC")).toBeNull();
  });

  it("an invalid timezone does not crash the table — falls back to the browser time zone and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = zonedDayStartToUtcIso("2026-09-03", "Mars/Phobos");
    const second = zonedDayStartToUtcIso("2026-09-04", "Mars/Phobos");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Number.isNaN(Date.parse(first as string))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("utcIsoToZonedDay — UTC instant → calendar day", () => {
  it("reduces the instant to the day in the column's time zone", () => {
    // 2 September 21:00Z is 3 September 00:00 in Istanbul.
    expect(utcIsoToZonedDay("2026-09-02T21:00:00.000Z", "Europe/Istanbul")).toBe("2026-09-03");
    expect(utcIsoToZonedDay("2026-09-02T21:00:00.000Z", "UTC")).toBe("2026-09-02");
  });

  it("a start-of-day value returns to the SAME day on a round trip", () => {
    const start = zonedDayStartToUtcIso("2026-09-03", "Europe/Istanbul");
    expect(utcIsoToZonedDay(start as string, "Europe/Istanbul")).toBe("2026-09-03");
  });

  it("unparseable input returns null", () => {
    expect(utcIsoToZonedDay("tomorrow", "UTC")).toBeNull();
    expect(utcIsoToZonedDay("", "UTC")).toBeNull();
  });
});
