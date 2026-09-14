import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Wallet } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAppData } from '@/lib/data/store';
import type { DataProvider } from '@/lib/data/DataProvider';
import { profitByMonth, profitByYear } from '@/lib/data/EtoroProfitHistory';
import type { AutomaticProfitHistory } from '@/lib/data/EtoroProfitHistory';
import { formatCompact, formatCurrency, formatSignedCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

const signed = (value: number) => formatSignedCurrency(value, 'USD');
const money = (value: number) => formatCurrency(value, 'USD');
const date = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('it-IT');

export function LifetimeProfitCard() {
  const { provider } = useAppData();
  // A new provider is a different connection: never carry the previous account's result across it.
  return <AutomaticProfitCard key={providerIdentity(provider)} provider={provider} />;
}
const providerIds = new WeakMap<DataProvider, number>();
let nextProviderId = 0;
function providerIdentity(provider: DataProvider | null) {
  if (!provider) return 'disconnected';
  let id = providerIds.get(provider);
  if (id === undefined) { id = ++nextProviderId; providerIds.set(provider, id); }
  return id;
}

function AutomaticProfitCard({ provider }: { provider: DataProvider | null }) {
  const [history, setHistory] = useState<AutomaticProfitHistory | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(provider));
  const [revision, setRevision] = useState(0);
  const [granularity, setGranularity] = useState<'month' | 'year'>('month');
  const [progress, setProgress] = useState({ count: 0, pages: 0 });
  useEffect(() => {
    if (!provider) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let full = revision > 0;
    async function sync() {
      setLoading(true);
      try {
        const result = await provider!.getProfitHistory(controller.signal, (count, pages) => {
          if (!controller.signal.aborted) setProgress({ count, pages });
        }, full);
        if (!controller.signal.aborted) { setHistory(result); setError(''); }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Storico eToro temporaneamente non disponibile.');
      } finally {
        full = false;
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void sync(), 5 * 60_000); }
      }
    }
    void sync();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [provider, revision]);
  const years = history ? profitByYear(history) : [];
  const chart = history ? granularity === 'month' ? profitByMonth(history) : years.map(row => ({ label: String(row.year), cumulative: row.cumulative })) : [];
  const realized = history ? history.trades.reduce((sum, trade) => sum + trade.profit, 0) : null;
  const unrealized = history?.openPnl ?? null;
  const total = realized !== null && unrealized !== null ? realized + unrealized : null;

  return <section className="card-surface density-pad col-span-12 min-w-0 p-5" aria-labelledby="lifetime-profit-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="lifetime-profit-title" className="flex items-center gap-2 text-title text-text-0"><Wallet className="h-4 w-4 text-gain" aria-hidden />Guadagno effettivo</h2>
        <p className="mt-1 text-caption text-text-2">Calcolo automatico dai profitti e dalle perdite delle operazioni eToro, anche se reinvestiti o prelevati.</p>
      </div>
      <button type="button" disabled={!provider || loading} onClick={() => setRevision(value => value + 1)} className="flex items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-caption text-text-1 hover:bg-bg-2 disabled:opacity-50"><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />Aggiorna</button>
    </div>
    {!provider && <p className="mt-5 text-body text-text-1">Lo storico viene recuperato automaticamente quando il conto eToro è collegato.</p>}
    {loading && <p role="status" className="mt-4 flex items-center gap-2 text-caption text-info"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Recupero storico eToro…{progress.pages > 0 ? ` ${progress.count} chiusure · ${progress.pages} pagine lette` : ''}</p>}
    {error && <p role="alert" className="mt-4 rounded-lg border border-warn/30 bg-warn/5 p-3 text-caption text-warn">Sincronizzazione non riuscita. {error}{history ? ' I valori sotto appartengono all’ultima sincronizzazione riuscita.' : ' Il profitto resta non disponibile finché lo storico non può essere letto.'}</p>}
    {history && <>
      <div className="mt-4 flex flex-wrap gap-2 text-micro text-text-2">
        <span className="rounded-full bg-info/10 px-2 py-1 text-info">Sincronizzato da eToro · {history.trades.length} chiusure</span>
        <span className="py-1">{years.length ? `Operazioni dal ${date(history.trades[0].closedAt.slice(0, 10))}` : 'Nessuna chiusura nel periodo restituito'} · aggiornato {new Date(history.asOf).toLocaleString('it-IT')}</span>
      </div>
      {history.rangeLimited && <p className="mt-3 rounded-lg border border-warn/30 bg-warn/5 p-3 text-caption text-warn">eToro ha limitato la lettura al periodo {date(history.from)} – {date(history.through)}. Questi risultati coprono solo le operazioni recuperate, non tutto il guadagno dall’apertura del conto.</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Metric label="Profitto operazioni chiuse" value={realized} description="Profitti meno perdite: restano conteggiati dopo reinvestimenti e prelievi." hero />
        <Metric label="P&L ancora aperto" value={unrealized} description="Posizioni manuali e copy aperti allo snapshot della sincronizzazione." />
        <Metric label="Chiuso + aperto rilevato" value={total} description="Somma delle chiusure recuperate e del P&L attuale. Non è il saldo del conto." />
      </div>
      <p className="mt-3 text-caption text-text-2">Risultato delle operazioni. Dividendi, interessi, staking o costi non compresi nel profitto dei trade non sono inclusi: il totale economico completo del conto non è ancora verificabile con questi dati.</p>
      {years.length > 0 ? <>
        <div className="mt-4 flex gap-2" aria-label="Raggruppamento grafico">{(['month', 'year'] as const).map(value => <button key={value} type="button" aria-pressed={granularity === value} onClick={() => setGranularity(value)} className={cn('rounded-lg border border-hairline px-3 py-1 text-caption', granularity === value ? 'bg-bg-3 text-text-0' : 'text-text-2')}>{value === 'month' ? 'Per mese' : 'Per anno'}</button>)}</div>
        <div className="mt-5 h-64 w-full" aria-label="Grafico del profitto realizzato cumulato in USD; valori disponibili nella tabella annuale">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 12, right: 15, bottom: 4, left: 5 }} accessibilityLayer>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" interval="preserveStartEnd" tick={{ fill: '#56645C', fontSize: 12 }} />
              <YAxis tickFormatter={value => formatCompact(Number(value), 'USD')} tick={{ fill: '#56645C', fontSize: 11 }} width={80} />
              <Tooltip labelFormatter={label => String(label)} formatter={(value: number) => [signed(value), 'Realizzato cumulato']} contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 10, color: 'hsl(var(--foreground))' }} />
              <ReferenceLine y={0} stroke="#7D8981" />
              <Line type="linear" dataKey="cumulative" name="Realizzato cumulato" stroke="#0D5434" strokeWidth={3} dot={{ r: 4 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-micro text-text-2">Profitto realizzato cumulato in USD. Il periodo corrente è parziale. Il P&L aperto di oggi non viene retrodatato sul grafico.</p>
        <details className="mt-4 rounded-lg border border-hairline p-3">
          <summary className="cursor-pointer text-caption text-text-1">Dettaglio per anno</summary>
          <div className="mt-3 overflow-x-auto"><table className="w-full whitespace-nowrap text-right text-caption tabular-nums">
            <caption className="sr-only">Profitti delle operazioni eToro in USD</caption>
            <thead className="text-text-2"><tr>{['Anno', 'Chiusure', 'Manuali', 'Copy trading', 'Realizzato anno', 'Cumulato'].map(label => <th scope="col" className="px-3 py-2 font-medium" key={label}>{label}</th>)}</tr></thead>
            <tbody className="text-text-0">{years.map(point => <tr key={point.year} className="border-t border-hairline"><th scope="row" className="px-3 py-2 font-normal">{point.year}</th><td className="px-3 py-2">{point.count}</td>{[point.manual, point.copy, point.profit, point.cumulative].map((value, index) => <td key={index} className={cn('px-3 py-2', value < 0 ? 'text-loss' : 'text-gain')}>{money(value)}</td>)}</tr>)}</tbody>
          </table></div>
        </details>
      </> : <p className="mt-4 text-caption text-text-2">Non risultano operazioni chiuse nel periodo restituito da eToro.</p>}
    </>}
    <details className="mt-4 text-caption text-text-2">
      <summary className="cursor-pointer">Cosa viene conteggiato</summary>
      <div className="mt-2 max-w-4xl space-y-2">
        <p>Sommiamo il profitto netto di ogni operazione chiusa, incluse quelle in perdita e quelle dei copy. Il capitale inizialmente investito non entra nella somma. I profitti delle posizioni mirror chiuse non vengono aggiunti nuovamente dal P&L del portafoglio.</p>
        <p>Prelevare o reinvestire un utile non cancella l’operazione che lo ha generato: per questo resta nel grafico. Non aggiungiamo gli importi dei prelievi, che potrebbero contenere anche capitale.</p>
        <p>Lo storico e il P&L aperto vengono letti automaticamente e aggiornati ogni cinque minuti mentre questa pagina è aperta. La lettura continua fino a una pagina vuota, anche se eToro restituisce meno operazioni del numero richiesto. Non sono richiesti importi o riepiloghi manuali.</p>
        <p>I movimenti eToro Money non sono il registro completo del conto trading. Le API consultate non forniscono una riconciliazione completa di versamenti, prelievi e proventi fuori dai trade: non vengono stimati come zero.</p>
      </div>
    </details>
  </section>;
}

function Metric({ label, value, description, hero }: { label: string; value: number | null; description: string; hero?: boolean }) {
  return <div className={cn('rounded-xl border p-4', hero ? 'border-gain/30 bg-gain/5' : 'border-hairline bg-bg-0')}>
    <div className="text-caption text-text-1">{label}</div>
    <div className={cn('mt-2 font-display text-2xl tabular-nums', value === null ? 'text-text-2' : value >= 0 ? 'text-gain' : 'text-loss')}>{value === null ? '—' : signed(value)}</div>
    <p className="mt-2 text-micro text-text-2">{description}</p>
  </div>;
}
