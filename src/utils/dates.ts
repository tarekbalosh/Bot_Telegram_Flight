const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseIsoDateUTC(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatIsoDateUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Formats YYYY-MM-DD as dd/MM/yyyy (used by Kiwi Tequila API).
 */
export function toDdMmYyyy(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Returns current year-month key as YYYY-MM.
 */
export function getCurrentYearMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function getDayOfYear(date: Date = new Date()): number {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const currentUTC = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
  return Math.floor((currentUTC - startOfYear) / MS_PER_DAY) + 1;
}

export function enumerateDatesInRange(dateFrom: string, dateTo: string): string[] {
  const start = parseIsoDateUTC(dateFrom);
  const end = parseIsoDateUTC(dateTo);
  if (start.getTime() > end.getTime()) {
    return [];
  }

  const dates: string[] = [];
  for (let ts = start.getTime(); ts <= end.getTime(); ts += MS_PER_DAY) {
    dates.push(formatIsoDateUTC(new Date(ts)));
  }
  return dates;
}

/**
 * Picks up to `count` dates evenly spread across [dateFrom, dateTo],
 * always including the first and last dates (when count >= 2), and
 * rotating the interior offset by day-of-year so successive runs cover different days.
 */
export function sampleSearchDates(
  dateFrom: string,
  dateTo: string,
  count: number,
  referenceDate: Date = new Date()
): string[] {
  const allDates = enumerateDatesInRange(dateFrom, dateTo);
  if (allDates.length === 0 || count <= 0) {
    return [];
  }
  if (count === 1 || allDates.length === 1) {
    return [allDates[0]];
  }
  if (allDates.length <= count) {
    return allDates;
  }

  const first = allDates[0];
  const last = allDates[allDates.length - 1];
  const interior = allDates.slice(1, allDates.length - 1);
  const interiorTargetCount = count - 2;

  if (interiorTargetCount <= 0 || interior.length === 0) {
    return [first, last];
  }

  const dayOffset = getDayOfYear(referenceDate);
  const selected = new Set<string>([first, last]);
  const bucketSize = interior.length / interiorTargetCount;

  for (let i = 0; i < interiorTargetCount; i++) {
    const bucketStart = Math.floor(i * bucketSize);
    const bucketEnd = Math.max(
      bucketStart + 1,
      Math.floor((i + 1) * bucketSize)
    );
    const span = bucketEnd - bucketStart;
    const rotatedIndex = bucketStart + (dayOffset % span);
    const clampedIndex = Math.min(interior.length - 1, Math.max(0, rotatedIndex));
    selected.add(interior[clampedIndex]);
  }

  // If rounding caused any collision, fill remaining slots deterministically
  for (let i = 0; selected.size < count && i < interior.length; i++) {
    const idx = (i + dayOffset) % interior.length;
    selected.add(interior[idx]);
  }

  return Array.from(selected).sort();
}

