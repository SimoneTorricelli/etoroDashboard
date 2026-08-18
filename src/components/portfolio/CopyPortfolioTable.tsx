import { AnimatePresence, motion } from 'framer-motion';
import { Copy, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPrice, formatUnits } from '@/lib/format';
import { DataTable } from '@/components/shared/DataTable';
import type { DataTableColumn } from '@/components/shared/DataTable';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import { CLASS_LABELS } from './analytics';
import type { CopyPortfolio } from '@/lib/data/types';

export interface CopyPortfolioTableProps {
  portfolios: CopyPortfolio[];
  fmtMoney: (usd: number) => string;
  fmtSignedMoney: (usd: number) => string;
  onSelect?: (portfolio: CopyPortfolio) => void;
}

export function CopyPortfolioTable({ portfolios, fmtMoney, fmtSignedMoney, onSelect }: CopyPortfolioTableProps) {
  const columns: DataTableColumn<CopyPortfolio>[] = [
    {
      key: 'name', header: 'Copy portfolio', sticky: true,
      sortValue: (p) => p.name,
      cell: (p) => (
        <div className="flex items-center gap-2.5">
          <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg', p.isAgent ? 'bg-agent/15 text-agent' : 'bg-info/15 text-info')}>
            <Copy className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium text-text-0">{p.name}</div>
            <div className="truncate text-micro text-text-2">{p.parentUsername ?? (p.isAgent ? 'eToro Agent' : 'eToro Copy')}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'type', header: 'Tipo', align: 'center',
      sortValue: (p) => p.isAgent ? 1 : 0,
      cell: (p) => <span className={cn('rounded-md px-1.5 py-0.5 text-micro font-medium', p.isAgent ? 'bg-agent/15 text-agent' : 'bg-info/15 text-info')}>{p.isAgent ? 'Agent' : 'Copy'}</span>,
    },
    { key: 'positions', header: 'Posizioni', align: 'right', sortValue: (p) => p.positions.length, cell: (p) => <span className="text-text-1">{p.positions.length}</span> },
    { key: 'value', header: 'Valore', align: 'right', sortValue: (p) => p.value, cell: (p) => <span className="font-medium text-text-0">{fmtMoney(p.value)}</span> },
    { key: 'activePnl', header: 'P&L attivo', align: 'right', sortValue: (p) => p.activeUnrealizedPnl, cell: (p) => <PnlValue value={p.activeUnrealizedPnl} format={fmtSignedMoney} /> },
    { key: 'closedPnl', header: 'P&L chiuso', align: 'right', sortValue: (p) => p.closedRealizedPnl, cell: (p) => <PnlValue value={p.closedRealizedPnl} format={fmtSignedMoney} /> },
    { key: 'totalPnl', header: 'P&L totale', align: 'right', sortValue: (p) => p.totalPnl, cell: (p) => <PnlValue value={p.totalPnl} format={fmtSignedMoney} /> },
  ];
  return <DataTable columns={columns} rows={portfolios} rowKey={(p) => p.copyId} defaultSortKey="totalPnl" onRowClick={onSelect} emptyMessage="Nessun copy portfolio attivo." />;
}

function PnlValue({ value, format }: { value: number; format: (value: number) => string }) {
  return <span className={value >= 0 ? 'text-gain' : 'text-loss'}>{format(value)}</span>;
}

export function CopyPortfolioDrawer({ portfolio, onClose, fmtMoney, fmtSignedMoney }: { portfolio: CopyPortfolio | null; onClose: () => void; fmtMoney: (usd: number) => string; fmtSignedMoney: (usd: number) => string }) {
  return (
    <AnimatePresence>
      {portfolio && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside
            className="fixed right-0 top-0 z-50 flex h-[100dvh] w-full max-w-[480px] flex-col border-l border-hairline bg-bg-1"
            initial={{ x: 480 }} animate={{ x: 0 }} exit={{ x: 480 }} transition={{ duration: 0.28 }} role="dialog" aria-label={`Dettagli ${portfolio.name}`}
          >
            <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
              <div className="flex items-center gap-3"><Copy className={cn('h-5 w-5', portfolio.isAgent ? 'text-agent' : 'text-info')} aria-hidden /><div><h2 className="text-title text-text-0">{portfolio.name}</h2><p className="text-caption text-text-2">{portfolio.isAgent ? 'Copy portfolio Agent' : 'Copy trading'} · {portfolio.positions.length} posizioni</p></div></div>
              <button type="button" onClick={onClose} aria-label="Chiudi dettagli copy portfolio" className="rounded-md p-1.5 text-text-2 hover:bg-bg-2 hover:text-text-0"><X className="h-5 w-5" aria-hidden /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Metric label="Valore" value={fmtMoney(portfolio.value)} />
                <Metric label="Investito" value={fmtMoney(portfolio.invested)} />
                <Metric label="P&L attivo" value={fmtSignedMoney(portfolio.activeUnrealizedPnl)} tone={portfolio.activeUnrealizedPnl >= 0 ? 'gain' : 'loss'} />
                <Metric label="P&L chiuso" value={fmtSignedMoney(portfolio.closedRealizedPnl)} tone={portfolio.closedRealizedPnl >= 0 ? 'gain' : 'loss'} />
                <Metric label="P&L totale" value={fmtSignedMoney(portfolio.totalPnl)} tone={portfolio.totalPnl >= 0 ? 'gain' : 'loss'} />
                <Metric label="Inizio copy" value={portfolio.startDate ? new Date(portfolio.startDate).toLocaleDateString('it-IT') : 'Non disponibile'} />
              </div>
              <div className="mt-5 flex items-center justify-between"><h3 className="text-body-strong text-text-0">Acquisti del copy</h3><span className="text-micro text-text-2">Aggiornati con eToro</span></div>
              <div className="mt-2 divide-y divide-hairline rounded-lg border border-hairline bg-bg-0">
                {portfolio.positions.map((position) => (
                  <div key={position.positionId} className="flex items-center gap-3 px-3 py-3">
                    <InstrumentAvatar symbol={position.symbol} size={28} imageUrl={position.imageUrl} />
                    <div className="min-w-0 flex-1"><div className="font-mono text-ticker text-text-0">{position.symbol}</div><div className="truncate text-micro text-text-2">{position.name} · {CLASS_LABELS[position.assetClass] ?? position.assetClass}</div></div>
                    <div className="text-right"><div className="text-caption tabular-nums text-text-0">{fmtMoney(position.currentValue ?? position.invested)}</div><div className="text-micro tabular-nums text-text-2">{formatUnits(position.units)} · {formatPrice(position.currentPrice ?? position.openPrice)}</div></div>
                  </div>
                ))}
                {portfolio.positions.length === 0 && <p className="px-3 py-6 text-center text-caption text-text-2">Nessuna posizione interna disponibile nella risposta eToro.</p>}
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'gain' | 'loss' }) {
  return <div className="rounded-lg border border-hairline bg-bg-0 p-2.5"><div className="text-micro uppercase tracking-[0.04em] text-text-2">{label}</div><div className={cn('mt-1 text-caption font-medium tabular-nums', tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : 'text-text-0')}>{value}</div></div>;
}
