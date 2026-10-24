export function parseIsoTimestamp(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const timezone = match[8];
  if (timezone === undefined) return null;
  const offset = timezone === "Z" ? null : /[+-](\d{2}):(\d{2})/.exec(timezone);
  const offsetHour = offset ? Number(offset[1]) : 0;
  const offsetMinute = offset ? Number(offset[2]) : 0;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > (daysInMonth ?? 0) ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) {
    return null;
  }

  const milliseconds = Date.parse(value.replace(" ", "T"));
  if (!Number.isFinite(milliseconds)) return null;
  const microseconds = Number((fraction + "000000").slice(0, 6));
  return BigInt(milliseconds) * 1000n + BigInt(microseconds % 1000);
}
