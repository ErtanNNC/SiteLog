/** "2026-10" → first and last calendar day of the month (ISO dates). */
export function monthDaysRange(yearMonth: string): { start: string; end: string } {
  const [y, m] = yearMonth.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${yearMonth}-01`, end: `${yearMonth}-${String(last).padStart(2, '0')}` };
}
