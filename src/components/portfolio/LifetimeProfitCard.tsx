import { useEffect, useRef, useState } from 'react';
import { Download, Plus, Upload, Wallet } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAppData } from '@/lib/data/store';
import { formatCompact, formatCurrency, formatSignedCurrency } from '@/lib/format';
import { calculateLifetimeProfit, parseProfitAmount, validateProfitHistory } from '@/lib/finance/lifetime-profit';
import type { ProfitHistory, ProfitYear } from '@/lib/finance/lifetime-profit';
import { loadProfitHistory, saveProfitHistory } from '@/lib/finance/profit-storage';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const inputClass = 'mt-1 w-full rounded-lg border border-hairline bg-bg-0 px-3 py-2 text-body text-text-0 outline-none focus:border-info';
const buttonClass = 'rounded-lg border border-hairline px-3 py-2 text-caption text-text-1 hover:bg-bg-2 disabled:opacity-40';
const money = (value: number) => formatCurrency(value, 'USD');
const signed = (value: number) => formatSignedCurrency(value, 'USD');
const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('it-IT');

export function LifetimeProfitCard() {
  const { settings } = useAppData();
  const owner = JSON.stringify([settings.live.proxyUrl, settings.live.environment, settings.live.userKey]);
  const [scope, setScope] = useState<{ owner: string; key: string } | null>(null);
  const [failedOwner, setFailedOwner] = useState('');
  useEffect(() => {
    let cancelled = false;
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner)).then(buffer => {
      const hash = [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (!cancelled) setScope({ owner, key: `torino.profit.v1.${hash}` });
    }).catch(() => { if (!cancelled) setFailedOwner(owner); });
    return () => { cancelled = true; };
  }, [owner]);
  if (scope?.owner !== owner) return <section className="card-surface col-span-12 p-5 text-text-1">{failedOwner === owner ? 'Archivio guadagni non disponibile in questo browser.' : 'Caricamento guadagno effettivo…'}</section>;
  return <ProfitWorkspace key={scope.key} storageKey={scope.key} />;
}

function ProfitWorkspace({ storageKey }: { storageKey: string }) {
  const [loaded] = useState(() => loadProfitHistory(storageKey));
  const [history, setHistory] = useState(loaded.history);
  const [error, setError] = useState(loaded.error);
  const [draft, setDraft] = useState<ProfitHistory | null>(null);
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const points = calculateLifetimeProfit(history);
  const last = points.at(-1);
  const today = new Date().toISOString().slice(0, 10);

  function exportHistory() {
    try {
      const raw = localStorage.getItem(storageKey) ?? JSON.stringify(history, null, 2);
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `guadagno-effettivo-${today}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('Esportazione non riuscita: archivio locale non accessibile.'); }
  }

  return <section className="card-surface density-pad col-span-12 min-w-0 p-5" aria-labelledby="lifetime-profit-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="lifetime-profit-title" className="flex items-center gap-2 text-title text-text-0"><Wallet className="h-4 w-4 text-gain" aria-hidden />Guadagno effettivo</h2>
        <p className="mt-1 max-w-3xl text-caption text-text-2">Il risultato del conto nel tempo, compresi utili reinvestiti e prelievi, al netto del capitale apportato.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} onClick={exportHistory} aria-label="Esporta backup guadagni"><Download className="h-4 w-4" /></button>
        <button type="button" className={buttonClass} onClick={() => fileRef.current?.click()} aria-label="Importa backup guadagni"><Upload className="h-4 w-4" /></button>
        <button type="button" className="rounded-lg bg-gain px-3 py-2 text-caption font-semibold text-bg-0 hover:bg-gain/90" onClick={() => setDraft(structuredClone(history))}>{last ? 'Aggiorna storico' : 'Aggiungi storico'}</button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" aria-label="File backup guadagni" onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (!file) return;
          try {
            if (file.size > 1_000_000) throw new Error('Il backup supera 1 MB.');
            const parsed: unknown = JSON.parse(await file.text());
            const errors = validateProfitHistory(parsed);
            if (errors.length) throw new Error(errors.join(' '));
            setDraft(parsed as ProfitHistory); setNotice('Backup caricato in anteprima. Salva per sostituire lo storico di questo conto.');
          } catch (err) { setError(err instanceof Error ? err.message : 'Backup non valido.'); }
        }} />
      </div>
    </div>
    {error && <p role="alert" className="mt-3 text-caption text-loss">{error}</p>}
    {notice && <p role="status" className="mt-3 text-caption text-info">{notice}</p>}
    {!last ? <div className="mt-5 rounded-xl border border-dashed border-hairline-strong bg-bg-0 p-5">
      <h3 className="text-body-strong text-text-0">Quanto hai guadagnato dall’inizio?</h3>
      <p className="mt-2 max-w-3xl text-body text-text-1">Servono i versamenti, i prelievi e il valore totale del conto per ogni anno. Lo storico API attualmente usato dall’app non contiene tutti questi dati: aggiungi i riepiloghi dagli estratti conto eToro, dal primo versamento a oggi.</p>
      <p className="mt-3 text-caption text-text-2">Esempio: versi 10.000 $, guadagni e reinvesti 2.000 $, prelevi 1.000 $ e ti restano 11.000 $. Guadagno complessivo: 2.000 $.</p>
      <a className="mt-3 inline-block text-caption text-info hover:underline" href="https://www.etoro.com/documents/accountstatement" target="_blank" rel="noreferrer">Apri estratto conto eToro ↗</a>
    </div> : <>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-micro text-text-2">
        <span className="rounded-full bg-info/10 px-2 py-1 text-info">{history.sinceInception ? 'Dall’apertura del conto' : `Dal 01/01/${history.startYear} · storico parziale`}</span>
        <span>Fino al {dateLabel(last.through)}{last.through === today ? ' · oggi' : ' · da aggiornare per il risultato a oggi'}</span>
        <span>Conto trading USD · dati da te verificati</span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Metric label="Guadagno complessivo" value={last.cumulativeProfit} description="Include anche il P&L ancora aperto." hero />
        <Metric label="Risultato già realizzato" value={last.realizedProfit} description={last.realizedProfit === null ? 'Aggiungi il P&L aperto iniziale e finale per separarlo.' : 'Utili e perdite realizzati, inclusi proventi e costi registrati nel conto.'} />
        <Metric label="P&L ancora aperto" value={last.unrealized} description="Variazione non realizzata delle posizioni alla data finale." />
      </div>
      <div className="mt-5 h-64 w-full" aria-label="Grafico del guadagno cumulato in USD; valori disponibili anche nella tabella Dettaglio per anno">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 12, right: 15, bottom: 4, left: 15 }} accessibilityLayer>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="year" interval="preserveStartEnd" tick={{ fill: '#56645C', fontSize: 12 }} />
            <YAxis tickFormatter={value => formatCompact(Number(value), 'USD')} tick={{ fill: '#56645C', fontSize: 11 }} width={80} />
            <Tooltip labelFormatter={(_label, payload) => payload[0]?.payload ? `Al ${dateLabel(payload[0].payload.through)}` : ''} formatter={(value: number, name: string) => [signed(value), name]} contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 10, color: 'hsl(var(--foreground))' }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={0} stroke="#7D8981" />
            <Line type="linear" dataKey="cumulativeProfit" name="Guadagno complessivo" stroke="#0D5434" strokeWidth={3} dot={{ r: 4 }} isAnimationActive={false} />
            <Line type="linear" dataKey="realizedProfit" name="Già realizzato" stroke="#356F9F" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-micro text-text-2">Riepiloghi annuali in USD · l’ultimo punto può coprire solo parte dell’anno.</p>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-hairline pt-4 lg:grid-cols-4">
        {[['Valore conto finale', last.equity], ['Versamenti cumulati', last.totalDeposits], ['Prelievi cumulati', last.totalWithdrawals], ['Altri apporti netti', last.totalAdjustments]].map(([label, value]) => <div key={label}><div className="text-micro text-text-2">{label}</div><div className="mt-1 text-body-strong text-text-0 tabular-nums">{money(Number(value))}</div></div>)}
      </div>
      <details className="mt-4 rounded-lg border border-hairline p-3">
        <summary className="cursor-pointer text-caption text-text-1">Dettaglio per anno</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full whitespace-nowrap text-right text-caption tabular-nums">
            <caption className="sr-only">Riconciliazione annuale del conto trading, importi in USD</caption>
            <thead className="text-text-2"><tr>{['Fino al', 'Versamenti', 'Prelievi', 'Altri apporti', 'Valore conto', 'Guadagno periodo', 'Cumulato', 'Realizzato cumulato'].map(label => <th scope="col" className="px-3 py-2 font-medium" key={label}>{label}</th>)}</tr></thead>
            <tbody className="text-text-0">{points.map(point => <tr key={point.year} className="border-t border-hairline"><th scope="row" title={point.source} className="px-3 py-2 font-normal">{dateLabel(point.through)}</th>{[point.deposits, point.withdrawals, point.adjustments, point.equity, point.annualProfit, point.cumulativeProfit, point.realizedProfit].map((value, index) => <td key={index} className={cn('px-3 py-2', index >= 4 && value !== null && (value < 0 ? 'text-loss' : 'text-gain'))}>{value === null ? '—' : money(value)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </>}
    <details className="mt-4 text-caption text-text-2">
      <summary className="cursor-pointer">Come viene calcolato</summary>
      <div className="mt-2 max-w-4xl space-y-2">
        <p>Guadagno = valore finale − valore iniziale + prelievi − versamenti − altri apporti netti. Il reinvestimento, gli acquisti e le vendite sono movimenti interni: non aggiungerli ai versamenti o ai prelievi. Dividendi e interessi già presenti nel conto sono già inclusi.</p>
        <p>I prelievi possono contenere capitale e profitto: non vengono etichettati interamente come guadagno. Il risultato realizzato si ottiene sottraendo dal guadagno complessivo la variazione del P&L non realizzato. Non indica quanti utili siano stati specificamente prelevati o reinvestiti.</p>
        <p>Usa solo il conto trading USD, incluso cash e copy trading. I trasferimenti da o verso eToro Money sono versamenti o prelievi di questo conto. Trasferimenti di titoli o bonus di capitale vanno negli altri apporti, con segno. Commissioni e imposte già addebitate nel conto sono incluse; spese e imposte pagate fuori dal conto sono escluse.</p>
        <p>Importi in USD per conservare il valore contabile storico, indipendentemente dalla valuta della dashboard. Non misura il risultato dei cambi EUR/USD né il potere d’acquisto. Il grafico collega riepiloghi annuali, non ricostruisce le oscillazioni tra due date.</p>
        <p>Archivio locale a questo browser e alla connessione configurata. Esporta un backup prima di cambiare chiave utente, proxy o dispositivo.</p>
      </div>
    </details>
    <Dialog open={draft !== null} onOpenChange={open => { if (!open) { setDraft(null); setNotice(''); } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-hairline bg-bg-1 text-text-0 sm:max-w-3xl">
        <DialogHeader><DialogTitle>Storico del guadagno effettivo</DialogTitle><DialogDescription className="text-text-2">Un riepilogo per anno, con flussi dal 1° gennaio alla data indicata. Inserisci 0 solo se hai verificato che non ci siano movimenti.</DialogDescription></DialogHeader>
        {draft && <ProfitEditor initial={draft} onCancel={() => { setDraft(null); setNotice(''); }} onSave={next => {
          saveProfitHistory(storageKey, next); setHistory(next); setError(''); setDraft(null); setNotice('Storico salvato in questo browser.');
        }} />}
      </DialogContent>
    </Dialog>
  </section>;
}

function Metric({ label, value, description, hero }: { label: string; value: number | null; description: string; hero?: boolean }) {
  return <div className={cn('rounded-xl border p-4', hero ? 'border-gain/30 bg-gain/5' : 'border-hairline bg-bg-0')}>
    <div className="text-caption text-text-1">{label}</div>
    <div className={cn('mt-2 font-display text-2xl tabular-nums', value === null ? 'text-text-2' : value >= 0 ? 'text-gain' : 'text-loss')}>{value === null ? '—' : signed(value)}</div>
    <p className="mt-2 text-micro text-text-2">{description}</p>
  </div>;
}

function Amount({ label, value, onChange, optional = false }: { label: string; value: number | null; onChange: (value: number | null) => void; optional?: boolean }) {
  const [text, setText] = useState(value === null || !Number.isFinite(value) ? '' : String(value));
  return <label className="block text-caption text-text-1">{label}<input className={inputClass} inputMode="decimal" value={text} placeholder={optional ? 'Non disponibile' : '0,00'} required={!optional} onChange={event => {
    const raw = event.target.value; setText(raw); onChange(optional && !raw.trim() ? null : parseProfitAmount(raw));
  }} /></label>;
}

function ProfitEditor({ initial, onSave, onCancel }: { initial: ProfitHistory; onSave: (history: ProfitHistory) => void; onCancel: () => void }) {
  const { portfolio, status } = useAppData();
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [errors, setErrors] = useState<string[]>([]);
  const [verified, setVerified] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const today = new Date(now).toISOString().slice(0, 10);
  const fresh = portfolio && status === 'connected' && now - portfolio.asOf < 120_000 && portfolio.asOf <= now;
  function update(next: ProfitHistory) { setDraft(next); setVerified(false); }
  function updateRow(index: number, patch: Partial<ProfitYear>) { update({ ...draft, years: draft.years.map((row, i) => i === index ? { ...row, ...patch } : row) }); }
  function addYear() {
    const year = draft.years.length ? Math.max(...draft.years.map(row => Number(row.through.slice(0, 4)))) + 1 : draft.startYear;
    if (!Number.isInteger(year) || year > Number(today.slice(0, 4))) { setErrors(['Controlla l’anno iniziale e le date: non puoi aggiungere anni futuri.']); return; }
    update({ ...draft, years: [...draft.years, { through: year === Number(today.slice(0, 4)) ? today : `${year}-12-31`, deposits: NaN, withdrawals: NaN, adjustments: 0, equity: NaN, unrealized: null, source: 'Estratto conto eToro' }] });
  }
  return <form onSubmit={event => {
    event.preventDefault();
    const found = validateProfitHistory(draft);
    if (!verified) found.push('Verifica che valori e flussi coprano lo stesso conto e lo stesso periodo.');
    if (found.length) { setErrors(found); return; }
    try { onSave(draft); } catch (err) { setErrors([err instanceof Error ? err.message : 'Salvataggio non riuscito: controlla lo spazio del browser.']); }
  }} className="space-y-5">
    <div className="rounded-lg border border-hairline bg-bg-0 p-3 text-caption text-text-1">Prendi dall’estratto il valore totale del conto (equity), non il capitale investito né il solo cash. Per separare il risultato realizzato, aggiungi il P&L delle sole posizioni ancora aperte, incluso quello dei copy.</div>
    <label className="flex items-start gap-2 text-caption text-text-1"><input type="checkbox" className="mt-1" checked={draft.sinceInception} onChange={event => { update({ ...draft, sinceInception: event.target.checked, ...(event.target.checked ? { openingEquity: 0, openingUnrealized: 0 } : {}) }); setRevision(revision + 1); }} />Lo storico parte dall’anno del primo versamento e include tutti gli anni dall’apertura del conto.</label>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="block text-caption text-text-1">Anno iniziale<input className={inputClass} type="number" min="1900" max={Number(today.slice(0, 4))} value={draft.startYear} required onChange={event => update({ ...draft, startYear: Number(event.target.value) })} /></label>
      {!draft.sinceInception && <>
        <Amount key={`opening-${revision}`} label="Valore conto al 1° gennaio (USD)" value={draft.openingEquity} onChange={value => update({ ...draft, openingEquity: value ?? NaN })} />
        <Amount key={`unrealized-${revision}`} label="P&L aperto al 1° gennaio (USD)" value={draft.openingUnrealized} optional onChange={value => update({ ...draft, openingUnrealized: value })} />
      </>}
    </div>
    {draft.years.map((row, index) => <fieldset key={`${index}-${revision}`} className="space-y-3 rounded-xl border border-hairline p-4">
      <legend className="px-1 text-body-strong">Riepilogo {index + 1}</legend>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block flex-1 text-caption text-text-1">Dati fino al (incluso)<input type="date" value={row.through} max={today} required className={inputClass} onChange={event => updateRow(index, { through: event.target.value })} /></label>
        <button type="button" className={buttonClass} onClick={() => { update({ ...draft, years: draft.years.filter((_, i) => i !== index) }); setRevision(revision + 1); }}>Rimuovi anno</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Amount label="Versamenti dell’anno (USD)" value={row.deposits} onChange={value => updateRow(index, { deposits: value ?? NaN })} />
        <Amount label="Prelievi dell’anno (USD)" value={row.withdrawals} onChange={value => updateRow(index, { withdrawals: value ?? NaN })} />
        <Amount label="Valore totale conto finale (USD)" value={row.equity} onChange={value => updateRow(index, { equity: value ?? NaN })} />
        <Amount label="P&L ancora aperto finale (USD)" value={row.unrealized} optional onChange={value => updateRow(index, { unrealized: value })} />
        <Amount label="Altri apporti netti (+/− USD)" value={row.adjustments} onChange={value => updateRow(index, { adjustments: value ?? NaN })} />
        <label className="block text-caption text-text-1">Fonte<input className={inputClass} value={row.source} required maxLength={500} onChange={event => updateRow(index, { source: event.target.value })} /></label>
      </div>
      {row.through.slice(0, 4) === today.slice(0, 4) && <div>
        <button type="button" disabled={!fresh} className={buttonClass} onClick={() => {
          if (!portfolio || !fresh || Date.now() - portfolio.asOf >= 120_000) return;
          const manualKnown = portfolio.positions.every(position => Number.isFinite(position.pnl));
          const copiesKnown = (portfolio.copyPortfolios ?? []).every(copy => Number.isFinite(copy.activeUnrealizedPnl));
          const copyCoverageKnown = !portfolio.mirrorValue || Boolean(portfolio.copyPortfolios?.length);
          const unrealized = manualKnown && copiesKnown && copyCoverageKnown ? portfolio.positions.reduce((sum, position) => sum + position.pnl!, 0) + (portfolio.copyPortfolios ?? []).reduce((sum, copy) => sum + copy.activeUnrealizedPnl, 0) : null;
          updateRow(index, { through: new Date(portfolio.asOf).toISOString().slice(0, 10), equity: portfolio.totalValue, unrealized, source: `Valore/P&L: snapshot eToro ${new Date(portfolio.asOf).toISOString()}; flussi: verifica manuale` }); setRevision(revision + 1);
        }}>Usa valore e P&L del conto aggiornato</button>
        <p className="mt-1 text-micro text-text-2">{fresh ? 'Copia uno snapshot. Aggiorna anche i versamenti e prelievi fino alla stessa data prima di salvare.' : 'Disponibile con una connessione eToro attiva e uno snapshot recente.'}</p>
      </div>}
    </fieldset>)}
    <button type="button" className={cn(buttonClass, 'flex items-center gap-1')} onClick={addYear}><Plus className="h-4 w-4" aria-hidden />Aggiungi anno</button>
    <label className="flex items-start gap-2 text-caption text-text-1"><input type="checkbox" className="mt-1" checked={verified} onChange={event => setVerified(event.target.checked)} />Ho verificato tutti i flussi e i valori del conto trading USD fino alle date indicate, senza includere reinvestimenti come nuovi versamenti.</label>
    {errors.length > 0 && <div role="alert" className="space-y-1 text-caption text-loss">{errors.map(error => <p key={error}>{error}</p>)}</div>}
    <div className="flex justify-end gap-2"><button type="button" className={buttonClass} onClick={onCancel}>Annulla</button><button type="submit" className="rounded-lg bg-gain px-4 py-2 text-caption font-semibold text-bg-0">Salva storico</button></div>
  </form>;
}
