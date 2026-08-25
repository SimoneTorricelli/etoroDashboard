/**
 * Editor dei guardrail. Ogni parametro è modificabile e spiegato: sono i
 * limiti che il codice impone alla proposta dell'AI, e vanno capiti prima di
 * essere cambiati.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, RotateCcw, Save, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { InstrumentSearch } from '@/components/autopilot/InstrumentSearch';
import { autopilot, type AutopilotConfig, type InstrumentHit, type WhitelistEntry } from '@/lib/agent/autopilot-api';

/** eToro classifica gli strumenti con etichette libere: le normalizziamo. */
function inferClass(assetClass: string, name: string): WhitelistEntry['class'] {
  const text = `${assetClass} ${name}`.toLowerCase();
  if (/crypto|coin|token|bitcoin|ethereum/.test(text)) return 'crypto';
  if (/etf|index|fund/.test(text)) return 'etf';
  if (/bond|treasury|gilt/.test(text)) return 'bond';
  if (/gold|silver|oil|commodit|natural gas/.test(text)) return 'commodity';
  return 'stock';
}

const WEEKDAYS = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
const CLASSES: WhitelistEntry['class'][] = ['etf', 'stock', 'bond', 'commodity', 'crypto'];

interface FieldProps {
  label: string;
  help: string;
  children: React.ReactNode;
}

function Field({ label, help, children }: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-text-0">{label}</Label>
      {children}
      <p className="text-xs leading-relaxed text-text-1">{help}</p>
    </div>
  );
}

interface Props {
  config: AutopilotConfig;
  onSaved: () => Promise<void> | void;
}

export function GuardrailsEditor({ config, onSaved }: Props) {
  const [draft, setDraft] = useState<AutopilotConfig>(config);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(config); }, [config]);

  const set = <K extends keyof AutopilotConfig>(key: K, value: AutopilotConfig[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const pct = (value: number) => Math.round(value * 1000) / 10;
  const fromPct = (value: string) => Math.max(0, Number(value) || 0) / 100;

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config]);

  const save = async () => {
    setBusy(true);
    try {
      const result = await autopilot.updateConfig({
        budgetEur: draft.budgetEur,
        cadence: draft.cadence,
        rebalanceWeekday: draft.rebalanceWeekday,
        rebalanceDayOfMonth: draft.rebalanceDayOfMonth,
        rebalanceHour: draft.rebalanceHour,
        rebalanceMinute: draft.rebalanceMinute,
        maxOrdersPerRun: draft.maxOrdersPerRun,
        maxOrdersPerDay: draft.maxOrdersPerDay,
        minOrderUsd: draft.minOrderUsd,
        maxOrderUsd: draft.maxOrderUsd,
        maxTurnoverPct: draft.maxTurnoverPct,
        minRebalanceBandAbs: draft.minRebalanceBandAbs,
        minRebalanceBandRel: draft.minRebalanceBandRel,
        minCashPct: draft.minCashPct,
        maxCashPct: draft.maxCashPct,
        drawdownStopPct: draft.drawdownStopPct,
        minConfidence: draft.minConfidence,
        riskProfile: draft.riskProfile,
        whitelist: draft.whitelist,
      });
      if (result.rejected.length) toast.warning(`Alcuni valori sono stati scartati: ${result.rejected.join(' · ')}`);
      else toast.success('Guardrail aggiornati');
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const updateEntry = (index: number, patch: Partial<WhitelistEntry>) =>
    set('whitelist', draft.whitelist.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const totalMaxWeight = draft.whitelist.reduce((sum, item) => sum + item.maxWeight, 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base text-text-0">
              <SlidersHorizontal className="size-4 text-agent" /> Guardrail e strategia
            </CardTitle>
            <CardDescription className="text-text-1">
              Sono i limiti che il codice impone alla proposta dell’AI. Il modello può muoversi solo dentro questi confini: se sfora, il piano viene ridotto o scartato.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={!dirty || busy} onClick={() => setDraft(config)}>
              <RotateCcw className="size-4" /> Annulla
            </Button>
            <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
              <Save className="size-4" /> Salva
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-text-0">Quando gira</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Cadenza" help="Ogni quanto parte il ciclo completo con l’AI.">
              <Select value={draft.cadence} onValueChange={(value) => set('cadence', value as AutopilotConfig['cadence'])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Giornaliera (lun–ven)</SelectItem>
                  <SelectItem value="weekly">Settimanale</SelectItem>
                  <SelectItem value="monthly">Mensile</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {draft.cadence === 'weekly' && (
              <Field label="Giorno" help="Giorno della settimana del ribilanciamento.">
                <Select value={String(draft.rebalanceWeekday)} onValueChange={(value) => set('rebalanceWeekday', Number(value))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((day, index) => <SelectItem key={day} value={String(index + 1)}>{day}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            )}

            {draft.cadence === 'monthly' && (
              <Field label="Giorno del mese" help="Da 1 a 28, per evitare mesi corti.">
                <Input type="number" min={1} max={28} value={draft.rebalanceDayOfMonth}
                  onChange={(event) => set('rebalanceDayOfMonth', Number(event.target.value))} />
              </Field>
            )}

            <Field label="Ora (Europe/Rome)" help="Il cron si sveglia ogni ora e agisce in questa fascia. L’ora legale è gestita in automatico.">
              <Input type="number" min={0} max={23} value={draft.rebalanceHour}
                onChange={(event) => set('rebalanceHour', Number(event.target.value))} />
            </Field>

            <Field label="Budget (EUR)" help="Capitale nominale gestito. Serve a dimensionare gli ordini: tienilo allineato a quanto hai davvero sull’Agent Portfolio.">
              <Input type="number" min={10} step={10} value={draft.budgetEur}
                onChange={(event) => set('budgetEur', Number(event.target.value))} />
            </Field>
          </div>
        </section>

        <Separator className="bg-hairline" />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-text-0">Limiti sugli ordini</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Ordini per run" help="Quanti ordini al massimo può generare un singolo ribilanciamento. Gli scostamenti più grandi hanno la precedenza.">
              <Input type="number" min={1} max={20} value={draft.maxOrdersPerRun}
                onChange={(event) => set('maxOrdersPerRun', Number(event.target.value))} />
            </Field>
            <Field label="Ordini per 24h" help="Tetto complessivo giornaliero, valido anche sommando run manuali.">
              <Input type="number" min={1} max={40} value={draft.maxOrdersPerDay}
                onChange={(event) => set('maxOrdersPerDay', Number(event.target.value))} />
            </Field>
            <Field label="Ordine minimo (USD)" help="Sotto questa soglia l’ordine viene scartato: non vale la pena muovere briciole.">
              <Input type="number" min={1} value={draft.minOrderUsd}
                onChange={(event) => set('minOrderUsd', Number(event.target.value))} />
            </Field>
            <Field label="Ordine massimo (USD)" help="Tetto per singolo ordine. Limita il danno di una proposta sbagliata.">
              <Input type="number" min={5} value={draft.maxOrderUsd}
                onChange={(event) => set('maxOrderUsd', Number(event.target.value))} />
            </Field>
          </div>
        </section>

        <Separator className="bg-hairline" />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-text-0">Limiti sul portafoglio</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Turnover massimo (%)" help="Quota di portafoglio movimentabile in una sola run. Se il piano la supera, viene scalato proporzionalmente.">
              <Input type="number" min={1} max={100} value={pct(draft.maxTurnoverPct)}
                onChange={(event) => set('maxTurnoverPct', fromPct(event.target.value))} />
            </Field>
            <Field label="Banda minima assoluta (%)" help="Sotto questo scostamento dal target non si fa nulla. Evita di comprare e vendere in continuazione per differenze irrilevanti.">
              <Input type="number" min={0.1} step={0.5} value={pct(draft.minRebalanceBandAbs)}
                onChange={(event) => set('minRebalanceBandAbs', fromPct(event.target.value))} />
            </Field>
            <Field label="Cassa minima (%)" help="Liquidità sempre protetta: gli acquisti non possono intaccarla.">
              <Input type="number" min={0} max={90} value={pct(draft.minCashPct)}
                onChange={(event) => set('minCashPct', fromPct(event.target.value))} />
            </Field>
            <Field label="Cassa massima (%)" help="Oltre questa soglia la proposta viene segnalata: troppa liquidità ferma è essa stessa una scelta.">
              <Input type="number" min={5} max={100} value={pct(draft.maxCashPct)}
                onChange={(event) => set('maxCashPct', fromPct(event.target.value))} />
            </Field>
            <Field label="Stop drawdown (%)" help="Perdita massima dal massimo storico. Superata, l’agente si congela da solo e ti avvisa.">
              <Input type="number" min={2} max={60} value={pct(draft.drawdownStopPct)}
                onChange={(event) => set('drawdownStopPct', fromPct(event.target.value))} />
            </Field>
            <Field label="Confidence minima" help="Quanto deve essere sicuro il modello perché il piano sia eseguibile. Da 0 a 1: più alto = più prudente.">
              <Input type="number" min={0} max={1} step={0.05} value={draft.minConfidence}
                onChange={(event) => set('minConfidence', Number(event.target.value))} />
            </Field>
          </div>
        </section>

        <Separator className="bg-hairline" />

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text-0">Universo consentito</h3>
            <div className="flex items-center gap-2">
              <Badge variant={totalMaxWeight >= 1 ? 'outline' : 'destructive'}>
                somma tetti {(totalMaxWeight * 100).toFixed(0)}%
              </Badge>
              <Button variant="outline" size="sm"
                onClick={() => set('whitelist', [...draft.whitelist, { symbol: '', name: '', class: 'etf', maxWeight: 0.2 }])}>
                <Plus className="size-4" /> Riga vuota
              </Button>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-text-1">
            L’AI può proporre solo questi ticker. Qualunque simbolo fuori lista fa scartare l’intera proposta.
            Il tetto è il peso massimo che quello strumento può raggiungere in portafoglio. La somma dei tetti deve superare il 100%, altrimenti l’allocazione non è realizzabile.
          </p>

          <InstrumentSearch
            existing={draft.whitelist.map((item) => item.symbol)}
            onPick={(hit: InstrumentHit) => set('whitelist', [...draft.whitelist, {
              symbol: hit.aliases[0] ?? hit.symbol,
              name: hit.name,
              class: inferClass(hit.assetClass, hit.name),
              maxWeight: 0.2,
            }])}
          />

          <div className="space-y-2">
            {draft.whitelist.map((entry, index) => (
              <div key={index} className="grid gap-2 rounded-lg border border-hairline bg-bg-2/40 p-2 sm:grid-cols-[1fr_1.4fr_1fr_auto_auto] sm:items-center">
                <Input placeholder="Ticker (es. SPY)" value={entry.symbol}
                  onChange={(event) => updateEntry(index, { symbol: event.target.value.toUpperCase() })} />
                <Input placeholder="Nome" value={entry.name}
                  onChange={(event) => updateEntry(index, { name: event.target.value })} />
                <Select value={entry.class} onValueChange={(value) => updateEntry(index, { class: value as WhitelistEntry['class'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CLASSES.map((klass) => <SelectItem key={klass} value={klass}>{klass}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-1">
                  <Input type="number" min={1} max={100} className="w-20" value={pct(entry.maxWeight)}
                    onChange={(event) => updateEntry(index, { maxWeight: fromPct(event.target.value) })} />
                  <span className="text-xs text-text-1">% max</span>
                </div>
                <Button variant="ghost" size="icon" className="text-loss"
                  onClick={() => set('whitelist', draft.whitelist.filter((_, i) => i !== index))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </section>

        <Separator className="bg-hairline" />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-text-0">Profilo di rischio</h3>
          <Field label="Istruzioni per il modello" help="Testo libero iniettato nel prompt. Descrivi come vuoi che ragioni: orizzonte, tolleranza alle perdite, preferenze settoriali, cosa evitare.">
            <Textarea rows={3} value={draft.riskProfile}
              onChange={(event) => set('riskProfile', event.target.value)} />
          </Field>
        </section>

        {dirty && (
          <div className="sticky bottom-0 -mx-6 -mb-6 border-t border-hairline-strong bg-bg-1/95 px-6 py-3 backdrop-blur">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-warn">Ci sono modifiche non salvate.</p>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                <Save className="size-4" /> Salva le modifiche
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
