/**
 * CsvImporter — parsing dell'Account Statement eToro (CSV) via PapaParse.
 *
 * L'Account Statement eToro contiene una sezione "Open Positions" e una
 * "Closed Positions" con colonne tipo:
 *   Position ID, Action, Amount, Units / Contracts, Open Rate, Open Date,
 *   Close Rate, Close Date, Profit, Fees, Leverage, SL, TP, ISIN, Notes
 * Le intestazioni possono variare: il parser è tollerante sui nomi colonna.
 */
import Papa from 'papaparse';
import type { Position } from './types';

export interface CsvImportResult {
  positions: Position[];
  /** Righe riconosciute ma saltate (es. posizioni chiuse). */
  skipped: number;
  errors: string[];
}

const COLUMN_ALIASES: Record<string, string[]> = {
  positionId: ['position id', 'positionid', 'id'],
  action: ['action', 'type', 'instrument'],
  amount: ['amount', 'invested'],
  units: ['units / contracts', 'units', 'contracts'],
  openRate: ['open rate', 'openrate', 'open price'],
  openDate: ['open date', 'opendate'],
  leverage: ['leverage'],
  stopLoss: ['sl', 'stop loss'],
  takeProfit: ['tp', 'take profit'],
  isBuy: ['is buy', 'direction', 'long/short'],
};

function findColumn(headers: string[], key: keyof typeof COLUMN_ALIASES): number {
  const aliases = COLUMN_ALIASES[key];
  return headers.findIndex((h) => aliases.includes(h.trim().toLowerCase()));
}

function parseNumber(raw: string | undefined): number {
  if (!raw) return 0;
  // eToro usa formato "1,234.56" (en-US); gestiamo anche "1.234,56"
  let s = raw.replace(/[$€£\s]/g, '');
  if (/,\d{2}$/.test(s) && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.'); // it
  else s = s.replace(/,/g, ''); // en
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Parsing testo CSV → posizioni aperte. */
export function parseAccountStatement(csvText: string): CsvImportResult {
  const errors: string[] = [];
  const positions: Position[] = [];
  let skipped = 0;

  const result = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  if (result.errors.length) {
    for (const e of result.errors.slice(0, 5)) errors.push(`Riga ${e.row ?? '?'}: ${e.message}`);
  }

  const headers = result.meta.fields ?? [];
  const col = {
    positionId: findColumn(headers, 'positionId'),
    action: findColumn(headers, 'action'),
    amount: findColumn(headers, 'amount'),
    units: findColumn(headers, 'units'),
    openRate: findColumn(headers, 'openRate'),
    openDate: findColumn(headers, 'openDate'),
    leverage: findColumn(headers, 'leverage'),
    stopLoss: findColumn(headers, 'stopLoss'),
    takeProfit: findColumn(headers, 'takeProfit'),
    isBuy: findColumn(headers, 'isBuy'),
  };

  if (col.action < 0 || col.openRate < 0) {
    errors.push('Colonne obbligatorie non trovate (Action / Open Rate). Verifica che sia un Account Statement eToro.');
    return { positions, skipped, errors };
  }

  const get = (row: Record<string, string>, idx: number) =>
    idx >= 0 ? row[headers[idx]] ?? '' : '';

  let seq = 7000;
  for (const row of result.data) {
    const action = get(row, col.action).trim();
    if (!action) { skipped++; continue; }
    const openRate = parseNumber(get(row, col.openRate));
    if (openRate <= 0) { skipped++; continue; }

    const symbol = action.split(' ')[0].toUpperCase();
    const dirRaw = get(row, col.isBuy).toLowerCase();
    const isBuy = dirRaw ? (dirRaw === 'buy' || dirRaw === 'long' || dirRaw === 'true') : !action.toLowerCase().startsWith('sell');
    const units = parseNumber(get(row, col.units)) || parseNumber(get(row, col.amount)) / openRate || 1;
    const amount = parseNumber(get(row, col.amount)) || units * openRate;

    positions.push({
      positionId: parseNumber(get(row, col.positionId)) || seq++,
      instrumentId: 0, // sconosciuto dal CSV: da mappare via search strumenti
      symbol,
      name: action,
      assetClass: 'stock',
      currency: 'USD',
      isBuy,
      units,
      openPrice: openRate,
      openDate: get(row, col.openDate) || new Date().toISOString(),
      invested: amount,
      fees: 0,
      leverage: parseNumber(get(row, col.leverage)) || 1,
      stopLossRate: parseNumber(get(row, col.stopLoss)) || undefined,
      takeProfitRate: parseNumber(get(row, col.takeProfit)) || undefined,
    });
  }

  return { positions, skipped, errors };
}

/** Helper: legge un File e ritorna il risultato del parsing. */
export function importAccountStatementFile(file: File): Promise<CsvImportResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(parseAccountStatement(String(reader.result ?? '')));
    reader.onerror = () => reject(new Error('Lettura file fallita'));
    reader.readAsText(file);
  });
}
