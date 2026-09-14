import { emptyProfitHistory, validateProfitHistory } from './lifetime-profit';
import type { ProfitHistory } from './lifetime-profit';

export function loadProfitHistory(key: string): { history: ProfitHistory; error: string } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { history: emptyProfitHistory(), error: '' };
    const parsed: unknown = JSON.parse(raw);
    const errors = validateProfitHistory(parsed);
    if (errors.length) throw new Error(errors.join(' '));
    return { history: parsed as ProfitHistory, error: '' };
  } catch {
    return { history: emptyProfitHistory(), error: 'Storico non leggibile. I dati salvati non sono stati modificati: esporta il backup per recuperarli.' };
  }
}

export function saveProfitHistory(key: string, history: ProfitHistory): void {
  const errors = validateProfitHistory(history);
  if (errors.length) throw new Error(errors.join(' '));
  const serialized = JSON.stringify(history);
  localStorage.setItem(key, serialized);
  if (localStorage.getItem(key) !== serialized) throw new Error('Salvataggio non riuscito.');
}
