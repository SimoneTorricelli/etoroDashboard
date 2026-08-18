/**
 * InstrumentsTable — tabella strumenti della tab attiva (design/markets.md §2).
 * Colonne: Strumento | Ultimo | Δ 1g | Δ 7g | Δ 1M | Spark 30g | Volume |
 * Cap./Mercato | Azioni (watchlist, avviso, regola Agent, dettagli).
 * Prezzi con tick-flash live; hover riga collegato alla heatmap.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Bell, ChevronRight, Star, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCompact, formatPercent, formatPrice } from '@/lib/format';
import { DataTable } from '@/components/shared/DataTable';
import type { DataTableColumn } from '@/components/shared/DataTable';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import { Sparkline } from '@/components/shared/Sparkline';
import { TickValue } from '@/components/shared/TickValue';
import type { MarketRow } from './meta';

export interface InstrumentsTableProps {
  rows: MarketRow[];
  onSelect(id: number): void;
}

function pctCell(value: number | null) {
  if (value == null) return <span className="text-text-2">—</span>;
  return (
    <span className={cn('tabular-nums', value > 0 ? 'text-gain' : value < 0 ? 'text-loss' : 'text-text-1')}>
      {formatPercent(value)}
    </span>
  );
}

export function InstrumentsTable({ rows, onSelect }: InstrumentsTableProps) {
  const navigate = useNavigate();
  const [watchlist, setWatchlist] = useState<Set<number>>(() => new Set());
  const [alerts, setAlerts] = useState<Set<number>>(() => new Set());

  const toggle = (set: Set<number>, id: number, apply: (next: Set<number>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const columns = useMemo<DataTableColumn<MarketRow>[]>(() => [
    {
      key: 'instrument',
      header: 'Strumento',
      sticky: true,
      sortValue: (r) => r.instrument.symbol,
      cell: (r) => (
        <div className="flex items-center gap-2.5">
          <InstrumentAvatar symbol={r.instrument.symbol} size={32} imageUrl={r.instrument.imageUrl} backgroundColor={r.instrument.imageBackgroundColor} textColor={r.instrument.imageTextColor} />
          <div className="min-w-0">
            <div className="font-mono text-ticker text-text-0">{r.instrument.symbol}</div>
            <div className="max-w-[180px] truncate text-micro text-text-2">{r.instrument.name}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'last',
      header: 'Ultimo',
      align: 'right',
      sortValue: (r) => r.quote?.last ?? -Infinity,
      cell: (r) => (
        <TickValue value={r.quote?.last ?? 0} className="text-body-strong text-text-0">
          {r.quote ? formatPrice(r.quote.last) : '—'}
        </TickValue>
      ),
    },
    {
      key: 'change1d',
      header: 'Δ 1g',
      align: 'right',
      sortValue: (r) => r.quote?.changePct ?? -Infinity,
      cell: (r) => pctCell(r.quote?.changePct ?? null),
    },
    {
      key: 'change7d',
      header: 'Δ 7g',
      align: 'right',
      sortValue: (r) => r.change7d ?? -Infinity,
      cell: (r) => pctCell(r.change7d),
    },
    {
      key: 'change1m',
      header: 'Δ 1M',
      align: 'right',
      sortValue: (r) => r.change1m ?? -Infinity,
      cell: (r) => pctCell(r.change1m),
    },
    {
      key: 'spark',
      header: 'Spark 30g',
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end">
          <Sparkline data={r.spark} width={80} height={28} live />
        </div>
      ),
    },
    {
      key: 'volume',
      header: 'Volume',
      align: 'right',
      sortValue: (r) => r.volume ?? -Infinity,
      cell: (r) => (
        <span className="tabular-nums text-text-1">{r.volume == null ? 'N/D eToro' : formatCompact(r.volume, r.instrument.currency)}</span>
      ),
    },
    {
      key: 'marketCap',
      header: 'Cap./Mercato',
      align: 'right',
      sortValue: (r) => r.marketCap ?? -Infinity,
      cell: (r) => (
        <span className="tabular-nums text-text-1">{r.marketCap == null ? 'N/D eToro' : formatCompact(r.marketCap, r.instrument.currency)}</span>
      ),
    },
    {
      key: 'actions',
      header: 'Azioni',
      align: 'right',
      width: '128px',
      cell: (r) => {
        const id = r.instrument.instrumentId;
        const btn = 'rounded-md p-1.5 text-text-2 transition-colors hover:bg-bg-3 hover:text-text-0';
        return (
          <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
            <button
              aria-label={watchlist.has(id) ? 'Rimuovi dalla watchlist' : 'Aggiungi alla watchlist'}
              title="Watchlist"
              onClick={() => toggle(watchlist, id, setWatchlist)}
              className={cn(btn, watchlist.has(id) && 'text-warn')}
            >
              <Star className="h-4 w-4" fill={watchlist.has(id) ? 'currentColor' : 'none'} aria-hidden />
            </button>
            <button
              aria-label={alerts.has(id) ? 'Rimuovi avviso prezzo' : 'Imposta avviso prezzo'}
              title="Avviso prezzo"
              onClick={() => toggle(alerts, id, setAlerts)}
              className={cn(btn, alerts.has(id) && 'text-info')}
            >
              <Bell className="h-4 w-4" fill={alerts.has(id) ? 'currentColor' : 'none'} aria-hidden />
            </button>
            <button
              aria-label={`Crea regola Agent su ${r.instrument.symbol}`}
              title="Crea regola Agent"
              onClick={() => navigate(`/agent?new=rule&instrument=${id}`)}
              className={cn(btn, 'hover:text-agent')}
            >
              <Zap className="h-4 w-4" aria-hidden />
            </button>
            <button
              aria-label={`Dettagli ${r.instrument.symbol}`}
              title="Dettagli"
              onClick={() => onSelect(id)}
              className={btn}
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        );
      },
    },
  ], [watchlist, alerts, navigate, onSelect]);

  return (
    <div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.instrument.instrumentId}
        onRowClick={(r) => onSelect(r.instrument.instrumentId)}
        defaultSortKey="marketCap"
        defaultSortDir="desc"
        emptyMessage="Nessuno strumento trovato"
      />
    </div>
  );
}
