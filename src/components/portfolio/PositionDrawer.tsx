/**
 * PositionDrawer — drawer destro (420px) con dettaglio posizione:
 * strip principali, metriche, protezioni SL/TP e azione di chiusura
 * con conferma in due passi (design.md: drawer 280ms, scrim 40%).
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router';
import { Bot, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDate, formatPercent, formatPrice, formatUnits } from '@/lib/format';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import { DeltaChip } from '@/components/shared/DeltaChip';
import { Sparkline } from '@/components/shared/Sparkline';
import { CLASS_LABELS } from './analytics';
import type { PositionRow } from './analytics';

export interface PositionDrawerProps {
  row: PositionRow | null;
  onClose: () => void;
  fmtMoney: (usd: number) => string;
  fmtSignedMoney: (usd: number) => string;
  sparkFor: (instrumentId: number) => number[];
  onClosePosition: (row: PositionRow) => Promise<void>;
}

export function PositionDrawer({ row, onClose, fmtMoney, fmtSignedMoney, sparkFor, onClosePosition }: PositionDrawerProps) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => { setConfirming(false); }, [row?.positionId]);

  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row, onClose]);

  const handleClose = async () => {
    if (!row) return;
    if (!confirming) { setConfirming(true); return; }
    setClosing(true);
    try { await onClosePosition(row); onClose(); } finally { setClosing(false); setConfirming(false); }
  };

  return (
    <AnimatePresence>
      {row && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed right-0 top-0 z-50 flex h-[100dvh] w-full max-w-[420px] flex-col border-l border-hairline bg-bg-1"
            initial={{ x: 420 }}
            animate={{ x: 0 }}
            exit={{ x: 420 }}
            transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
            role="dialog"
            aria-label={`Dettagli posizione ${row.symbol}`}
          >
            <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
              <span className="flex items-center gap-3">
                <InstrumentAvatar symbol={row.symbol} size={36} imageUrl={row.imageUrl} />
                <span>
                  <span className="block font-mono text-ticker text-text-0">{row.symbol}</span>
                  <span className="block text-caption text-text-2">{row.name}</span>
                </span>
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Chiudi dettagli"
                className="rounded-md p-1.5 text-text-2 transition-colors hover:bg-bg-2 hover:text-text-0"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="flex items-end justify-between">
                <div>
                  <span className="overline">Valore posizione</span>
                  <div className="mt-1 font-display text-display-md tabular-nums text-text-0">{fmtMoney(row.value)}</div>
                </div>
                <DeltaChip value={row.pnlPctValue} size="md" />
              </div>
              <div className={cn('mt-1 text-body-strong tabular-nums', row.pnlUsd >= 0 ? 'text-gain' : 'text-loss')}>
                {fmtSignedMoney(row.pnlUsd)} ({formatPercent(row.pnlPctValue)})
              </div>

              <div className="mt-4 rounded-lg border border-hairline bg-bg-0 p-3">
                <span className="overline">Ultimi prezzi</span>
                <div className="mt-2">
                  <Sparkline data={sparkFor(row.instrumentId)} width={340} height={48} live />
                </div>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-body">
                <Metric label="Classe" value={CLASS_LABELS[row.assetClass] ?? row.assetClass} />
                <Metric label="Settore" value={row.sector} />
                <Metric label="Valuta" value={row.currency} mono />
                <Metric label="Unità" value={formatUnits(row.units)} mono />
                <Metric label="Prezzo medio" value={formatPrice(row.openPrice)} mono />
                <Metric label="Ultimo prezzo" value={formatPrice(row.price)} mono />
                <Metric label="Investito" value={fmtMoney(row.invested)} mono />
                <Metric label="Commissioni" value={fmtMoney(row.fees)} mono />
                <Metric label="Leva" value={`x${row.leverage}`} mono />
                <Metric label="Apertura" value={formatDate(row.openDate)} />
                <Metric
                  label="Stop-loss"
                  value={row.stopLossRate != null ? formatPrice(row.stopLossRate) : 'Non impostato'}
                  mono={row.stopLossRate != null}
                  warn={row.stopLossRate == null}
                />
                <Metric
                  label="Take-profit"
                  value={row.takeProfitRate != null ? formatPrice(row.takeProfitRate) : '—'}
                  mono
                />
              </dl>
            </div>

            <div className="space-y-2 border-t border-hairline px-5 py-4">
              <button
                type="button"
                onClick={() => navigate('/agent')}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-agent/40 bg-agent/10 px-4 py-2.5 text-body-strong text-agent transition-colors hover:bg-agent/20"
              >
                <Bot className="h-4 w-4" aria-hidden />
                Crea regola Agent su {row.symbol}
              </button>
              <button
                type="button"
                disabled={closing}
                onClick={() => void handleClose()}
                className={cn(
                  'w-full rounded-lg px-4 py-2.5 text-body-strong transition-colors',
                  confirming
                    ? 'bg-loss text-white hover:bg-loss/90'
                    : 'border border-loss/40 bg-loss-dim text-loss hover:bg-loss/20',
                )}
              >
                {closing ? 'Chiusura in corso…' : confirming ? 'Conferma chiusura posizione' : 'Chiudi posizione'}
              </button>
              {confirming && (
                <p className="text-center text-micro text-text-2">
                  La posizione verrà chiusa al prezzo di mercato corrente.
                </p>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function Metric({ label, value, mono, warn }: { label: string; value: string; mono?: boolean; warn?: boolean }) {
  return (
    <div>
      <dt className="text-micro uppercase tracking-[0.04em] text-text-2">{label}</dt>
      <dd className={cn('mt-0.5 text-body-strong', mono && 'tabular-nums', warn ? 'text-warn' : 'text-text-0')}>
        {value}
      </dd>
    </div>
  );
}
