import { useState } from 'react';
import {
  Bell, CheckCircle2, CloudDownload, History, Landmark, ListChecks, Loader2, RefreshCw, Star, TrendingUp, WalletCards, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { hasLiveCredentials } from '@/lib/settings';
import { useAppData } from '@/lib/data/store';
import { loadEtoroDataHubSnapshot, syncEtoroDataHub } from '@/lib/data/EtoroDataHub';
import type { EtoroDataHubSnapshot, HubCapabilityKey } from '@/lib/data/EtoroDataHub';

const LABELS: Record<HubCapabilityKey, { title: string; icon: typeof History }> = {
  balances: { title: 'Storico portafoglio', icon: History },
  trades: { title: 'Operazioni chiuse', icon: ListChecks },
  cash: { title: 'Cash flow e dividendi', icon: Landmark },
  watchlists: { title: 'Watchlist', icon: Star },
  alerts: { title: 'Price alert', icon: TrendingUp },
  notifications: { title: 'Notifiche', icon: Bell },
  rankings: { title: 'Popular Investor', icon: WalletCards },
};

function percent(value: number): string {
  return `${value.toLocaleString('it-IT', { maximumFractionDigits: 1 })}%`;
}

export function EtoroDataHubSection() {
  const { settings } = useAppData();
  const [snapshot, setSnapshot] = useState<EtoroDataHubSnapshot | null>(() => loadEtoroDataHubSnapshot());
  const [loading, setLoading] = useState(false);
  const ready = hasLiveCredentials(settings);

  const sync = async () => {
    if (!ready || loading) return;
    setLoading(true);
    try {
      const next = await syncEtoroDataHub(settings.live);
      setSnapshot(next);
      const available = next.capabilities.filter((item) => item.status !== 'unavailable').length;
      toast.success('Dati eToro sincronizzati', { description: `${available}/${next.capabilities.length} superfici API disponibili.` });
    } catch (error) {
      toast.error('Sincronizzazione non riuscita', { description: error instanceof Error ? error.message : 'Controlla proxy e permessi.' });
    } finally {
      setLoading(false);
    }
  };

  const potentialDividends = snapshot?.cashTransactions.filter((transaction) => transaction.isPotentialDividend) ?? [];

  return (
    <section id="dati-etoro" data-settings-section className="scroll-mt-24">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><CloudDownload className="h-5 w-5 text-agent" aria-hidden /><h2 className="text-title text-text-0">Dati avanzati eToro</h2></div>
          <p className="mt-1 max-w-3xl text-caption leading-relaxed text-text-1">Una lettura manuale e coordinata di storico saldo, operazioni, conti cash, watchlist, alert, notifiche e ranking. Nessuna modifica e nessun ordine vengono inviati da questa sezione.</p>
        </div>
        <button type="button" onClick={() => void sync()} disabled={!ready || loading} className="inline-flex items-center gap-2 rounded-lg bg-agent px-3 py-2 text-caption font-medium text-bg-0 hover:bg-agent/90 disabled:cursor-not-allowed disabled:opacity-40">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          Sincronizza ora
        </button>
      </div>

      {!ready ? <div className="rounded-xl border border-warn/30 bg-warn/5 p-4 text-caption text-warn">Completa prima chiavi e proxy. La sincronizzazione non usa dati dimostrativi.</div> : null}

      {snapshot ? <>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {snapshot.capabilities.map((capability) => {
            const meta = LABELS[capability.key];
            const Icon = meta.icon;
            const ok = capability.status !== 'unavailable';
            return <div key={capability.key} className={cn('rounded-xl border bg-bg-1 p-3', capability.status === 'unavailable' ? 'border-loss/30' : capability.status === 'empty' ? 'border-warn/25' : 'border-gain/25')}>
              <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-caption font-medium text-text-0"><Icon className="h-4 w-4 text-agent" aria-hidden />{meta.title}</span>{ok ? <CheckCircle2 className={cn('h-4 w-4', capability.status === 'empty' ? 'text-warn' : 'text-gain')} aria-label="Disponibile" /> : <XCircle className="h-4 w-4 text-loss" aria-label="Non disponibile" />}</div>
              <p className="mt-2 text-micro leading-relaxed text-text-2">{capability.detail}</p>
            </div>;
          })}
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <div className="rounded-xl border border-hairline bg-bg-1 p-4">
            <p className="overline">Storico reale</p>
            <div className="mt-2 font-display text-display-md text-text-0">{snapshot.balances.length} giorni</div>
            <p className="mt-1 text-caption text-text-2">Saldo, liquidità, investito e P&amp;L dagli snapshot eToro fino a 12 mesi.</p>
          </div>
          <div className="rounded-xl border border-hairline bg-bg-1 p-4">
            <p className="overline">Operazioni chiuse</p>
            <div className={cn('mt-2 font-display text-display-md', snapshot.closedPnl >= 0 ? 'text-gain' : 'text-loss')}>{snapshot.closedPnl.toLocaleString('it-IT', { style: 'currency', currency: 'USD' })}</div>
            <p className="mt-1 text-caption text-text-2">{snapshot.closedTradesCount} operazioni negli ultimi 12 mesi · positive {snapshot.profitableTradesPct == null ? '—' : percent(snapshot.profitableTradesPct)}</p>
          </div>
          <div className="rounded-xl border border-hairline bg-bg-1 p-4">
            <p className="overline">Dividendi riconciliabili</p>
            <div className="mt-2 font-display text-display-md text-info">{potentialDividends.length}</div>
            <p className="mt-1 text-caption text-text-2">Movimenti cash classificati come dividendo/distribuzione. Se zero, l’Account Statement resta la fonte certa del conto Trading.</p>
          </div>
        </div>

        {snapshot.popularInvestors.length > 0 ? <div className="mt-4 overflow-hidden rounded-xl border border-hairline bg-bg-1">
          <div className="border-b border-hairline px-4 py-3"><h3 className="text-body-strong text-text-0">Popular Investor · selezione dati reali</h3><p className="text-micro text-text-2">Ordinati per numero di copiatori, periodo un anno. Il rendimento non è una raccomandazione.</p></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-caption"><thead className="bg-bg-0 text-micro uppercase tracking-wide text-text-2"><tr><th className="px-4 py-2">Trader</th><th className="px-3 py-2 text-right">Rendimento</th><th className="px-3 py-2 text-right">Annualizzato</th><th className="px-3 py-2 text-right">Rischio</th><th className="px-3 py-2 text-right">Drawdown</th><th className="px-4 py-2 text-right">Copiatori</th></tr></thead><tbody className="divide-y divide-hairline">{snapshot.popularInvestors.slice(0, 8).map((investor) => <tr key={`${investor.cid}-${investor.username}`}><td className="px-4 py-2.5"><div className="font-medium text-text-0">{investor.fullName || investor.username}</div><div className="text-micro text-text-2">@{investor.username}</div></td><td className={cn('px-3 py-2.5 text-right font-mono', investor.gain >= 0 ? 'text-gain' : 'text-loss')}>{percent(investor.gain)}</td><td className="px-3 py-2.5 text-right font-mono text-text-1">{percent(investor.annualizedReturn)}</td><td className="px-3 py-2.5 text-right font-mono text-warn">{investor.riskScore || '—'}/10</td><td className="px-3 py-2.5 text-right font-mono text-loss">{percent(Math.abs(investor.drawdown))}</td><td className="px-4 py-2.5 text-right font-mono text-text-0">{investor.copiers.toLocaleString('it-IT')}</td></tr>)}</tbody></table></div>
        </div> : null}

        <p className="mt-3 text-micro text-text-2">Ultima sincronizzazione: {new Date(snapshot.asOf).toLocaleString('it-IT')} · cache solo per questa sessione · nessun polling aggiuntivo</p>
      </> : <div className="rounded-xl border border-dashed border-hairline-strong p-5 text-caption text-text-2">Premi “Sincronizza ora” per verificare quali dei nuovi permessi sono realmente utilizzabili dalla tua chiave.</div>}
    </section>
  );
}
