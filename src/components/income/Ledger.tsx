import { useState } from 'react';
import Papa from 'papaparse';
import { eventCents, mergeEvents, validateEvent } from '@/lib/income/engine';
import type { IncomeEvent } from '@/lib/income/engine';
import { Field, inputClass } from './Fields';

const button = 'rounded-lg border border-hairline bg-bg-2 px-3 py-2 text-sm text-text-0';
export function IncomeLedger({ events, onChange }: { events: IncomeEvent[]; onChange: (events: IncomeEvent[]) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [message, setMessage] = useState('');
  const [entry, setEntry] = useState<Record<string, string>>({ id: '', account: 'eToro', kind: 'dividend', status: 'paid', date: today, currency: 'EUR', gross: '', withholding: '0', fees: '0', fx: '', source: '' });
  function merge(rows: IncomeEvent[]) {
    if (rows.some(e => e.status === 'paid' && e.date > today)) throw new Error('Un incasso non può avere una data futura');
    const combined = mergeEvents(events, rows);
    if (combined.length > 10000) throw new Error('Limite di 10.000 accrediti');
    onChange(combined); setMessage(`${combined.length - events.length} accrediti aggiunti alla bozza. Premi Salva modifiche per conservarli.`);
  }
  async function importFile(file: File) {
    try {
      if (file.size > 2000000) throw new Error('CSV troppo grande (massimo 2 MB)');
      const result = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: true });
      if (result.errors.length) throw new Error(result.errors[0].message);
      merge(result.data.map(validateEvent));
    } catch (e) { setMessage((e as Error).message); }
  }
  return <section className="card-surface p-5 sm:p-6"><h2 className="text-lg font-medium text-text-0">Gli accrediti effettivi</h2><p className="mt-2 text-sm text-text-1">Questi importi vengono dall’estratto conto. Sono separati dalle stime automatiche, che non dimostrano un pagamento ricevuto.</p>
    <details className="mt-4"><summary className="cursor-pointer text-sm text-text-1">Importazione e registrazione facoltativa</summary><p className="my-3 text-xs text-text-2">CSV: id, account, kind, status, date, currency, gross, withholding, fees, fx, source. Importi con punto decimale; date AAAA-MM-GG. Cambio USD per EUR richiesto per gli eventi USD.</p><label className={`${button} cursor-pointer`}>Importa CSV<input type="file" accept=".csv" className="sr-only" onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = ''; }} /></label>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['id', 'ID univoco'], ['account', 'Conto'], ['date', 'Data'], ['gross', 'Importo lordo'], ['withholding', 'Ritenute'], ['fees', 'Costi'], ['fx', 'Cambio storico EUR/USD'], ['source', 'Estratto / riferimento']].map(([key, label]) => <Field key={key} label={label}><input className={inputClass} type={key === 'date' ? 'date' : 'text'} value={entry[key]} onChange={e => setEntry({ ...entry, [key]: e.target.value })} /></Field>)}
        <Field label="Tipo"><select className={inputClass} value={entry.kind} onChange={e => setEntry({ ...entry, kind: e.target.value })}><option value="dividend">Dividendo</option><option value="interest">Interessi</option><option value="other">Altra rendita</option></select></Field><Field label="Stato"><select className={inputClass} value={entry.status} onChange={e => setEntry({ ...entry, status: e.target.value })}><option value="paid">Incassato</option><option value="accrued">Maturato</option><option value="declared">Dichiarato</option></select></Field><Field label="Valuta"><select className={inputClass} value={entry.currency} onChange={e => setEntry({ ...entry, currency: e.target.value })}><option>EUR</option><option>USD</option></select></Field></div>
      <button type="button" className={`${button} mt-3`} onClick={() => { try { merge([validateEvent(entry)]); } catch (e) { setMessage((e as Error).message); } }}>Aggiungi alla bozza</button>
    </details>
    {message && <p role="status" className="mt-3 text-sm text-text-1">{message}</p>}
    {events.length ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[500px] text-left text-sm"><thead className="text-xs text-text-2"><tr><th className="p-2">Data / conto</th><th className="p-2">Stato</th><th className="p-2">Dopo ritenute e costi</th><th className="p-2">Fonte</th></tr></thead><tbody>{events.slice(0, 100).map(e => <tr className="border-t border-hairline" key={`${e.account}:${e.id}`}><td className="p-2">{e.date} · {e.account}</td><td className="p-2">{{ paid: 'Incassato', accrued: 'Maturato', declared: 'Dichiarato' }[e.status]}</td><td className="p-2">{new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(eventCents(e) / 100)}</td><td className="p-2">{e.source}</td></tr>)}</tbody></table></div> : <p className="mt-5 rounded-xl bg-bg-2 p-4 text-sm text-text-2">Nessun accredito importato. Non serve compilare questo registro per vedere la rendita stimata e il grafico.</p>}
  </section>;
}
