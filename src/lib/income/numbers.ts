/** Both a decimal point and Italian decimal comma are accepted. Grouping dots
 * are accepted only alongside a comma and with complete three-digit groups. */
export function parseIncomeNumber(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.includes('.') && text.includes(',') && !/^\d{1,3}(?:\.\d{3})+,\d*$/.test(text)) return NaN;
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  if (!/^\d*(?:\.\d*)?$/.test(normalized) || !/\d/.test(normalized)) return NaN;
  return Number(normalized);
}
