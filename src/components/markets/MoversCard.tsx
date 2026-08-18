/**
 * MoversCard — Top Movers con tre mini-liste a tab:
 * "In rialzo" / "In ribasso" / "Più scambiati".
 * Righe: monogramma, ticker, prezzo (tick-flash), DeltaChip.
 * Riordino animato con Framer layout. Click → drawer.
 */
import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { formatPrice } from '@/lib/format';
import { DeltaChip } from '@/components/shared/DeltaChip';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import { TickValue } from '@/components/shared/TickValue';
import type { MarketRow } from './meta';

type MoversTab = 'up' | 'down' | 'volume';

const TABS: { key: MoversTab; label: string }[] = [
  { key: 'up', label: 'In rialzo' },
  { key: 'down', label: 'In ribasso' },
  { key: 'volume', label: 'Più scambiati' },
];

const MAX_ROWS = 7;

export function MoversCard({ rows, onSelect }: { rows: MarketRow[]; onSelect(id: number): void }) {
  const [tab, setTab] = useState<MoversTab>('up');

  const list = useMemo(() => {
    const withQuote = rows.filter((r) => r.quote);
    const sorted = [...withQuote].sort((a, b) => {
      if (tab === 'up') return (b.quote!.changePct) - (a.quote!.changePct);
      if (tab === 'down') return (a.quote!.changePct) - (b.quote!.changePct);
      return (b.volume ?? -Infinity) - (a.volume ?? -Infinity);
    });
    return sorted.slice(0, MAX_ROWS);
  }, [rows, tab]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-title text-text-0">Top Movers</h2>
        <div className="flex rounded-lg border border-hairline bg-bg-0 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'rounded-md px-2 py-1 text-micro font-medium transition-colors',
                tab === t.key ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex-1 divide-y divide-hairline">
        {list.map((r) => {
          const q = r.quote!;
          const id = r.instrument.instrumentId;
          return (
            <motion.button
              key={`${tab}-${id}`}
              layout="position"
              type="button"
              onClick={() => onSelect(id)}
              transition={{ type: 'spring', duration: 0.3 }}
              className="flex w-full items-center gap-2.5 py-2 text-left transition-colors hover:bg-bg-2"
            >
              <InstrumentAvatar symbol={r.instrument.symbol} size={28} imageUrl={r.instrument.imageUrl} backgroundColor={r.instrument.imageBackgroundColor} textColor={r.instrument.imageTextColor} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-ticker text-text-0">{r.instrument.symbol}</div>
                <div className="truncate text-micro text-text-2">{r.instrument.name}</div>
              </div>
              <TickValue value={q.last} className="text-caption text-text-1">
                {formatPrice(q.last)}
              </TickValue>
              <DeltaChip value={q.changePct} size="sm" />
            </motion.button>
          );
        })}
        {list.length === 0 && (
          <p className="py-6 text-center text-caption text-text-2">Nessun dato disponibile.</p>
        )}
      </div>
    </div>
  );
}
