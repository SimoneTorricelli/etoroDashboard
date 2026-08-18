/**
 * PositionsTable — tabella completa delle posizioni con:
 * - group-by (Nessuno / Classe / Settore / Valuta / Gruppo Agent) con header
 *   collassabili e subtotali;
 * - ordinamento client-side sulle colonne numeriche;
 * - riga totali in footer;
 * - P&L live con tick-flash, sparkline 30g, azioni (dettagli / chiudi).
 */
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, ChevronDown, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPercent, formatPrice, formatUnits } from '@/lib/format';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import { Sparkline } from '@/components/shared/Sparkline';
import { TickValue } from '@/components/shared/TickValue';
import { CLASS_LABELS } from './analytics';
import type { PositionRow } from './analytics';

export type GroupBy = 'none' | 'class' | 'sector' | 'currency' | 'agent';

const GROUP_OPTIONS: Array<{ key: GroupBy; label: string }> = [
  { key: 'none', label: 'Nessun raggruppamento' },
  { key: 'class', label: 'Per asset class' },
  { key: 'sector', label: 'Per settore' },
  { key: 'currency', label: 'Per valuta' },
  { key: 'agent', label: 'Per gruppo Agent' },
];

type SortKey = 'value' | 'pnl' | 'pnlPct' | 'weight' | 'symbol';

export interface PositionsTableProps {
  rows: PositionRow[];
  fmtMoney: (usd: number) => string;
  fmtSignedMoney: (usd: number) => string;
  sparkFor: (instrumentId: number) => number[];
  agentGroupFor: (instrumentId: number) => string;
  onDetails: (row: PositionRow) => void;
  onClose: (row: PositionRow) => Promise<void>;
}

const SORTERS: Record<SortKey, (r: PositionRow) => number | string> = {
  value: (r) => r.value,
  pnl: (r) => r.pnlUsd,
  pnlPct: (r) => r.pnlPctValue,
  weight: (r) => r.weight,
  symbol: (r) => r.symbol,
};

export function PositionsTable({
  rows, fmtMoney, fmtSignedMoney, sparkFor, agentGroupFor, onDetails, onClose,
}: PositionsTableProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [confirmCloseId, setConfirmCloseId] = useState<number | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);

  const sorted = useMemo(() => {
    const get = SORTERS[sortKey];
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, sortKey, sortDir]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: '__all__', label: '', rows: sorted }];
    const keyOf = (r: PositionRow): string => {
      switch (groupBy) {
        case 'class': return CLASS_LABELS[r.assetClass] ?? r.assetClass;
        case 'sector': return r.sector;
        case 'currency': return r.currency;
        case 'agent': return agentGroupFor(r.instrumentId);
        default: return '';
      }
    };
    const map = new Map<string, PositionRow[]>();
    for (const r of sorted) {
      const k = keyOf(r);
      const arr = map.get(k);
      if (arr) arr.push(r);
      else map.set(k, [r]);
    }
    return [...map.entries()]
      .map(([key, groupRows]) => ({
        key,
        label: key,
        rows: groupRows,
      }))
      .sort((a, b) => {
        const va = a.rows.reduce((s, r) => s + r.value, 0);
        const vb = b.rows.reduce((s, r) => s + r.value, 0);
        return vb - va;
      });
  }, [sorted, groupBy, agentGroupFor]);

  const totals = useMemo(() => ({
    value: rows.reduce((s, r) => s + r.value, 0),
    pnl: rows.reduce((s, r) => s + r.pnlUsd, 0),
    invested: rows.reduce((s, r) => s + r.invested, 0),
    weight: rows.reduce((s, r) => s + r.weight, 0),
  }), [rows]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleClose = async (row: PositionRow) => {
    if (confirmCloseId !== row.positionId) {
      setConfirmCloseId(row.positionId);
      setTimeout(() => setConfirmCloseId((id) => (id === row.positionId ? null : id)), 3000);
      return;
    }
    setConfirmCloseId(null);
    setClosingId(row.positionId);
    try { await onClose(row); } finally { setClosingId(null); }
  };

  const th = (label: string, key?: SortKey, align: 'left' | 'right' = 'right') => (
    <th
      className={cn(
        'sticky top-0 z-10 bg-bg-2 px-3 py-2 text-label font-medium uppercase tracking-[0.04em] text-text-2',
        align === 'right' ? 'text-right' : 'text-left',
        key && 'cursor-pointer select-none hover:text-text-1',
      )}
      onClick={key ? () => toggleSort(key) : undefined}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {key && sortKey === key && (
          <ArrowUp className={cn('h-3 w-3 transition-transform duration-200', sortDir === 'desc' && 'rotate-180')} aria-hidden />
        )}
      </span>
    </th>
  );

  const renderRow = (r: PositionRow, i: number) => (
    <motion.tr
      key={r.positionId}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, delay: Math.min(i * 0.015, 0.3) }}
      className="cursor-pointer border-b border-hairline transition-colors hover:bg-bg-2"
      onClick={() => onDetails(r)}
    >
      <td className="px-3 py-2.5">
        <span className="flex items-center gap-2.5">
          <InstrumentAvatar symbol={r.symbol} size={28} imageUrl={r.imageUrl} />
          <span className="min-w-0">
            <span className="block font-mono text-ticker text-text-0">{r.symbol}</span>
            <span className="block max-w-[160px] truncate text-micro text-text-2">{r.name}</span>
          </span>
        </span>
      </td>
      <td className="px-3 py-2.5 text-caption text-text-1">{CLASS_LABELS[r.assetClass] ?? r.assetClass}</td>
      <td className="px-3 py-2.5 text-caption text-text-1">{r.sector}</td>
      <td className="px-3 py-2.5 font-mono text-micro text-text-2">{r.currency}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-text-1">{formatUnits(r.units)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-text-1">{formatPrice(r.openPrice)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-text-0">
        <TickValue value={r.price}>{formatPrice(r.price)}</TickValue>
      </td>
      <td className="px-3 py-2.5 text-right text-body-strong tabular-nums text-text-0">{fmtMoney(r.value)}</td>
      <td className={cn('px-3 py-2.5 text-right tabular-nums', r.pnlUsd >= 0 ? 'text-gain' : 'text-loss')}>
        <TickValue value={r.pnlUsd}>{fmtSignedMoney(r.pnlUsd)}</TickValue>
      </td>
      <td className={cn('px-3 py-2.5 text-right tabular-nums', r.pnlPctValue >= 0 ? 'text-gain' : 'text-loss')}>
        {formatPercent(r.pnlPctValue)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-text-1">
        {(r.weight * 100).toLocaleString('it-IT', { maximumFractionDigits: 1 })}%
      </td>
      <td className="px-3 py-2.5">
        <Sparkline data={sparkFor(r.instrumentId)} width={60} height={20} />
      </td>
      <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            title="Dettagli posizione"
            aria-label={`Dettagli ${r.symbol}`}
            className="rounded-md p-1.5 text-text-2 transition-colors hover:bg-bg-3 hover:text-text-0"
            onClick={() => onDetails(r)}
          >
            <Info className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            title={confirmCloseId === r.positionId ? 'Conferma chiusura' : 'Chiudi posizione'}
            aria-label={`Chiudi ${r.symbol}`}
            disabled={closingId === r.positionId}
            className={cn(
              'rounded-md px-1.5 py-1.5 transition-colors',
              confirmCloseId === r.positionId
                ? 'bg-loss-dim text-micro font-medium text-loss'
                : 'text-text-2 hover:bg-loss-dim hover:text-loss',
            )}
            onClick={() => void handleClose(r)}
          >
            {confirmCloseId === r.positionId ? 'Conferma' : <XCircle className="h-4 w-4" aria-hidden />}
          </button>
        </span>
      </td>
    </motion.tr>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-title text-text-0">Posizioni ({rows.length})</h2>
        <label className="flex items-center gap-2 text-caption text-text-2">
          Raggruppa
          <select
            value={groupBy}
            onChange={(e) => { setGroupBy(e.target.value as GroupBy); setCollapsed(new Set()); }}
            className="rounded-md border border-hairline bg-bg-3 px-2 py-1 text-caption text-text-0 outline-none focus:border-hairline-strong"
          >
            {GROUP_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-hairline">
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="border-b border-hairline">
              {th('Strumento', 'symbol', 'left')}
              {th('Classe', undefined, 'left')}
              {th('Settore', undefined, 'left')}
              {th('Valuta', undefined, 'left')}
              {th('Unità')}
              {th('Prezzo medio')}
              {th('Ultimo')}
              {th('Valore', 'value')}
              {th('P&L', 'pnl')}
              {th('P&L %', 'pnlPct')}
              {th('Peso %', 'weight')}
              {th('Spark 30g')}
              {th('Azioni')}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isCollapsed = collapsed.has(g.key);
              const gValue = g.rows.reduce((s, r) => s + r.value, 0);
              const gPnl = g.rows.reduce((s, r) => s + r.pnlUsd, 0);
              return (
                <GroupBody
                  key={g.key}
                  showHeader={groupBy !== 'none'}
                  label={g.label}
                  count={g.rows.length}
                  valueLabel={fmtMoney(gValue)}
                  pnlLabel={fmtSignedMoney(gPnl)}
                  pnlPositive={gPnl >= 0}
                  collapsed={isCollapsed}
                  onToggle={() => toggleGroup(g.key)}
                >
                  <AnimatePresence initial={false}>
                    {!isCollapsed && g.rows.map((r, i) => renderRow(r, i))}
                  </AnimatePresence>
                </GroupBody>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-3 py-8 text-center text-caption text-text-2">
                  Nessuna posizione corrisponde al filtro.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-hairline-strong bg-bg-2/40 font-semibold">
                <td className="px-3 py-2.5 text-text-0" colSpan={7}>Totale</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-text-0">{fmtMoney(totals.value)}</td>
                <td className={cn('px-3 py-2.5 text-right tabular-nums', totals.pnl >= 0 ? 'text-gain' : 'text-loss')}>
                  {fmtSignedMoney(totals.pnl)}
                </td>
                <td className={cn('px-3 py-2.5 text-right tabular-nums', totals.pnl >= 0 ? 'text-gain' : 'text-loss')}>
                  {formatPercent(totals.invested > 0 ? (totals.pnl / totals.invested) * 100 : 0)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-text-1">
                  {(totals.weight * 100).toLocaleString('it-IT', { maximumFractionDigits: 1 })}%
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

interface GroupBodyProps {
  showHeader: boolean;
  label: string;
  count: number;
  valueLabel: string;
  pnlLabel: string;
  pnlPositive: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function GroupBody({ showHeader, label, count, valueLabel, pnlLabel, pnlPositive, collapsed, onToggle, children }: GroupBodyProps) {
  if (!showHeader) return <>{children}</>;
  return (
    <>
      <tr
        className="cursor-pointer border-b border-hairline bg-bg-2/50 transition-colors hover:bg-bg-2"
        onClick={onToggle}
      >
        <td colSpan={13} className="px-3 py-2">
          <span className="flex items-center gap-2">
            <ChevronDown
              className={cn('h-4 w-4 text-text-2 transition-transform duration-200', collapsed && '-rotate-90')}
              aria-hidden
            />
            <span className="text-body-strong text-text-0">{label}</span>
            <span className="text-micro text-text-2">{count} posizion{count === 1 ? 'e' : 'i'}</span>
            <span className="ml-auto flex items-center gap-4 tabular-nums">
              <span className="text-caption text-text-1">{valueLabel}</span>
              <span className={cn('text-caption', pnlPositive ? 'text-gain' : 'text-loss')}>{pnlLabel}</span>
            </span>
          </span>
        </td>
      </tr>
      {children}
    </>
  );
}
