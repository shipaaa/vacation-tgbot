export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

export function parseCalendarDate(value: string): CalendarDateParts | null {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const display = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  const year = Number(iso?.[1] ?? display?.[3]);
  const month = Number(iso?.[2] ?? display?.[2]);
  const day = Number(iso?.[3] ?? display?.[1]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function formatDate(value: string): string {
  const parts = parseCalendarDate(value);
  if (!parts) return value;
  return [
    String(parts.day).padStart(2, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.year).padStart(4, "0"),
  ].join(".");
}

export function dateInTimezone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.day}.${value.month}.${value.year}`;
  } catch {
    return formatDate(date.toISOString().slice(0, 10));
  }
}
