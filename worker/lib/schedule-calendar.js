/** Calendario civile Europe/Rome. Nessuna chiamata a provider o modello. */
export const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function partsAt(at) {
  return Object.fromEntries(formatter.formatToParts(new Date(at)).map(p => [p.type, p.value]));
}
export function romeParts(date = new Date()) {
  const p = partsAt(date.getTime());
  const before = partsAt(date.getTime() - 60 * MINUTE);
  return {
    weekday: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday],
    hour: Number(p.hour), minute: Number(p.minute), day: Number(p.day),
    dateKey: `${p.year}-${p.month}-${p.day}`,
    fold: ['year', 'month', 'day', 'hour', 'minute'].every(k => p[k] === before[k]) ? 1 : 0,
  };
}
function rebalanceDay(config, parts) {
  if (config.cadence === 'daily') return parts.weekday >= 1 && parts.weekday <= 5;
  if (config.cadence === 'weekly') return parts.weekday === config.rebalanceWeekday;
  if (config.cadence !== 'monthly') return false;
  const [year, month] = (parts.dateKey ?? '').split('-').map(Number);
  const lastDay = year && month ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 31;
  return parts.day === Math.min(config.rebalanceDayOfMonth, lastDay);
}
export function decideKind(config, parts) {
  if (parts.fold === 1) return null;
  if (parts.hour === config.rebalanceHour && parts.minute === config.rebalanceMinute && rebalanceDay(config, parts)) return 'rebalance';
  if (parts.minute !== 0) return null;
  return (config.snapshotHours ?? []).includes(parts.hour) ? 'snapshot' : 'heartbeat';
}
function offsetAt(at) {
  const p = partsAt(at);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - at;
}
function localSlot(dateKey, hour, minute, offsets) {
  const wall = Date.parse(`${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const candidates = offsets.map(offset => wall - offset).sort((a, b) => a - b);
  const matches = candidates.filter(at => {
    const p = romeParts(new Date(at));
    return p.dateKey === dateKey && p.hour === hour && p.minute === minute;
  });
  return {
    // Fold: solo il primo istante. Gap: un record saltato, mai un ordine alle 03:xx.
    dueAt: matches[0] ?? Math.max(...candidates) - 1,
    localDue: `${dateKey} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    skipReason: matches.length ? null : 'dst_nonexistent',
  };
}
/** Intervallo (from, to]. Il dispatcher limita ogni lotto a sette giorni. */
export function calendarOccurrences(config, from, to, { rebalanceOnly = false } = {}) {
  if (to <= from) return [];
  const first = Date.parse(`${romeParts(new Date(from)).dateKey}T12:00:00Z`);
  const last = Date.parse(`${romeParts(new Date(to)).dateKey}T12:00:00Z`);
  const out = [];
  for (let noon = first; noon <= last; noon += DAY) {
    const parts = romeParts(new Date(noon));
    const offsets = [...new Set([offsetAt(noon - 12 * 60 * MINUTE), offsetAt(noon + 12 * 60 * MINUTE)])];
    const hasRebalance = rebalanceDay(config, parts);
    const slots = [];
    if (hasRebalance) slots.push({ hour: config.rebalanceHour, minute: config.rebalanceMinute, kind: 'rebalance' });
    if (!rebalanceOnly) for (let hour = 0; hour < 24; hour++) {
      if (hasRebalance && hour === config.rebalanceHour && config.rebalanceMinute === 0) continue;
      slots.push({ hour, minute: 0, kind: (config.snapshotHours ?? []).includes(hour) ? 'snapshot' : 'heartbeat' });
    }
    for (const slot of slots) {
      const occurrence = { ...localSlot(parts.dateKey, slot.hour, slot.minute, offsets), kind: slot.kind };
      if (occurrence.dueAt > from && occurrence.dueAt <= to) out.push(occurrence);
    }
  }
  return out.sort((a, b) => a.dueAt - b.dueAt || a.localDue.localeCompare(b.localDue));
}
export function nextRebalance(config, now = Date.now()) {
  return calendarOccurrences(config, now, now + 35 * DAY, { rebalanceOnly: true }).find(row => !row.skipReason) ?? null;
}
