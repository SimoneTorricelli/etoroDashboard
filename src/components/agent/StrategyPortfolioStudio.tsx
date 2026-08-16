import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import {
  Check, ChevronRight, CircleDollarSign, CloudDownload, ExternalLink, Info, Loader2,
  LockKeyhole, Play, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles, Target, WalletCards,
} from 'lucide-react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { hasLiveCredentials } from '@/lib/settings';
import type { DisplayCurrency } from '@/lib/settings';
import { useAppData } from '@/lib/data/store';
import { createAgentPortfolio, listAgentPortfolios } from '@/lib/agent/etoro-agent-api';
import type { RemoteAgentPortfolio } from '@/lib/agent/etoro-agent-api';
import {
  allocationPreview, createStrategyDraft, getStrategyTemplate, loadStrategyPortfolios, saveStrategyPortfolios,
  STRATEGY_TEMPLATES, validateStrategyPortfolio,
} from '@/lib/agent/strategy-portfolios';
import type { StrategyPortfolioConfig, StrategyTemplate } from '@/lib/agent/strategy-portfolios';

const riskLabel: Record<StrategyTemplate['risk'], string> = {
  basso: 'Rischio più contenuto',
  medio: 'Rischio intermedio',
  alto: 'Rischio alto',
  'molto-alto': 'Rischio molto alto',
};

const accentClasses: Record<StrategyTemplate['accent'], { border: string; text: string; bg: string }> = {
  gain: { border: 'border-gain/40', text: 'text-gain', bg: 'bg-gain/10' },
  info: { border: 'border-info/40', text: 'text-info', bg: 'bg-info/10' },
  agent: { border: 'border-agent/40', text: 'text-agent', bg: 'bg-agent/10' },
  warn: { border: 'border-warn/40', text: 'text-warn', bg: 'bg-warn/10' },
  loss: { border: 'border-loss/40', text: 'text-loss', bg: 'bg-loss/10' },
};

const statusClasses: Record<StrategyPortfolioConfig['status'], string> = {
  bozza: 'bg-bg-2 text-text-2',
  pronto: 'bg-info/10 text-info',
  attivo: 'bg-gain/10 text-gain',
  'in pausa': 'bg-warn/10 text-warn',
};

function money(value: number, currency: DisplayCurrency): string {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
}

function inputMoney(value: number, fromUsd: (usd: number) => number): number {
  return Math.round(fromUsd(value) * 100) / 100;
}

function numberInput(onChange: (value: number) => void) {
  return (event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value) || 0);
}

export function StrategyPortfolioStudio({
  fromUsd,
  toUsd,
  displayCurrency,
  realExecutionActive,
}: {
  fromUsd(usd: number): number;
  toUsd(value: number): number;
  displayCurrency: DisplayCurrency;
  realExecutionActive: boolean;
}) {
  const { settings } = useAppData();
  const [portfolios, setPortfolios] = useState<StrategyPortfolioConfig[]>(() => loadStrategyPortfolios());
  const [editing, setEditing] = useState<StrategyPortfolioConfig | null>(null);
  const [confirming, setConfirming] = useState<StrategyPortfolioConfig | null>(null);
  const [ackReal, setAckReal] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteAgentPortfolio[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteChecked, setRemoteChecked] = useState(false);

  useEffect(() => saveStrategyPortfolios(portfolios), [portfolios]);

  const currencySymbol = displayCurrency === 'EUR' ? '€' : '$';
  const liveReady = hasLiveCredentials(settings);

  const openEditor = (templateId: string) => {
    const existing = portfolios.find((portfolio) => portfolio.templateId === templateId && !portfolio.etoroAgentPortfolioId);
    setEditing(existing ? { ...existing } : createStrategyDraft(templateId));
  };

  const updateEditing = <K extends keyof StrategyPortfolioConfig>(key: K, value: StrategyPortfolioConfig[K]) => {
    setEditing((current) => current ? { ...current, [key]: value, updatedAt: Date.now() } : current);
  };

  const saveDraft = () => {
    if (!editing) return;
    const validation = validateStrategyPortfolio(editing);
    if (!validation.valid) {
      toast.error('Controlla i limiti del portafoglio', { description: validation.errors[0] });
      return;
    }
    const next = { ...editing, status: 'pronto' as const, updatedAt: Date.now() };
    setPortfolios((current) => current.some((item) => item.id === next.id)
      ? current.map((item) => item.id === next.id ? next : item)
      : [...current, next]);
    setEditing(null);
    toast.success(`Strategia ${getStrategyTemplate(next.templateId).name} salvata`, { description: 'Nessun ordine è stato inviato.' });
  };

  const syncRemote = async () => {
    if (!liveReady) {
      toast.error('Configura prima le chiavi e il proxy nella sezione Impostazioni.');
      return;
    }
    setRemoteLoading(true);
    try {
      const result = await listAgentPortfolios(settings.live);
      setRemote(result);
      setRemoteChecked(true);
      toast.success(`${result.length} Agent Portfolio trovati su eToro`);
    } catch (error) {
      toast.error('Impossibile leggere gli Agent Portfolio', { description: error instanceof Error ? error.message : 'Errore del proxy o di eToro' });
    } finally {
      setRemoteLoading(false);
    }
  };

  const activateRemote = async () => {
    if (!confirming || !realExecutionActive || !ackReal) return;
    setCreatingId(confirming.id);
    try {
      const created = await createAgentPortfolio(settings.live, confirming);
      setPortfolios((current) => current.map((item) => item.id === confirming.id ? {
        ...item,
        status: 'attivo',
        etoroAgentPortfolioId: created.id,
        mirrorId: created.mirrorId,
        virtualBalanceUsd: created.virtualBalanceUsd,
        tokenAvailable: created.tokenAvailable,
        activatedAt: Date.now(),
        updatedAt: Date.now(),
      } : item));
      setRemote((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setRemoteChecked(true);
      setConfirming(null);
      setAckReal(false);
      toast.success(`${confirming.name} creato su eToro`, {
        description: 'Budget reale collegato. Il token è stato ricevuto ma non viene salvato nel browser.',
      });
    } catch (error) {
      toast.error('Creazione Agent Portfolio non riuscita', { description: error instanceof Error ? error.message : 'Errore del proxy o di eToro' });
    } finally {
      setCreatingId(null);
    }
  };

  const draftPreview = useMemo(() => editing ? allocationPreview(editing) : null, [editing]);

  return (
    <section className="col-span-12 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <WalletCards className="h-5 w-5 text-agent" aria-hidden />
            <h2 className="text-title text-text-0">Portafogli strategici</h2>
          </div>
          <p className="max-w-3xl text-caption text-text-1">
            Crea strategie separate, definisci budget e limiti per singola entrata, poi collegale a un Agent Portfolio reale su eToro.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void syncRemote()}
          disabled={remoteLoading}
          className="flex items-center gap-2 rounded-lg border border-hairline-strong px-3 py-2 text-caption text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0 disabled:cursor-wait disabled:opacity-60"
        >
          {remoteLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CloudDownload className="h-4 w-4" aria-hidden />}
          Leggi da eToro
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {STRATEGY_TEMPLATES.map((template) => {
          const style = accentClasses[template.accent];
          const configured = portfolios.some((portfolio) => portfolio.templateId === template.id);
          return (
            <div key={template.id} className={cn('card-surface flex min-h-[214px] flex-col border p-4', style.border)}>
              <div className="flex items-start justify-between gap-2">
                <div className={cn('flex h-9 w-9 items-center justify-center rounded-xl', style.bg)}>
                  <Sparkles className={cn('h-4 w-4', style.text)} aria-hidden />
                </div>
                {configured && <span className="rounded-full bg-gain/10 px-2 py-1 text-micro text-gain">Configurata</span>}
              </div>
              <h3 className="mt-3 text-body-strong text-text-0">{template.name}</h3>
              <p className={cn('mt-1 text-micro font-medium', style.text)}>{template.tagline}</p>
              <p className="mt-2 flex-1 text-caption leading-relaxed text-text-2">{template.description}</p>
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-micro text-text-2">{riskLabel[template.risk]}</span>
                <button
                  type="button"
                  onClick={() => openEditor(template.id)}
                  className={cn('flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-micro font-medium transition-colors', style.bg, style.text, 'hover:brightness-110')}
                >
                  {configured ? 'Modifica' : 'Configura'} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {portfolios.length > 0 && (
        <div className="card-surface density-pad p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-body-strong text-text-0">Le tue strategie</h3>
              <p className="text-caption text-text-2">Prima configuriamo i limiti; l’attivazione reale richiede un’ultima conferma.</p>
            </div>
            <span className="text-micro text-text-2">{portfolios.length} configurate</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {portfolios.map((portfolio) => {
              const template = getStrategyTemplate(portfolio.templateId);
              const preview = allocationPreview(portfolio);
              return (
                <div key={portfolio.id} className="rounded-xl border border-hairline bg-bg-1 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-body-strong text-text-0">{portfolio.name}</h4>
                        <span className={cn('rounded-full px-2 py-0.5 text-micro', statusClasses[portfolio.status])}>{portfolio.status}</span>
                      </div>
                      <p className="mt-1 text-caption text-text-2">{template.name} · {template.tagline}</p>
                    </div>
                    {portfolio.etoroAgentPortfolioId && <span className="font-mono text-micro text-gain">eToro #{portfolio.etoroAgentPortfolioId}</span>}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-caption sm:grid-cols-4">
                    <Metric label="Budget" value={money(fromUsd(portfolio.budgetUsd), displayCurrency)} />
                    <Metric label="Operativo" value={money(fromUsd(preview.operatingBudgetUsd), displayCurrency)} />
                    <Metric label="Max entrata" value={money(fromUsd(portfolio.maxOrderUsd), displayCurrency)} />
                    <Metric label="Posizioni" value={`${portfolio.maxPositions}`} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
                    <span className="flex items-center gap-1.5 text-micro text-text-2"><Target className="h-3.5 w-3.5 text-agent" aria-hidden /> Fino a {preview.affordablePositions} posizioni finanziabili ai minimi impostati</span>
                    <div className="flex gap-2">
                      {portfolio.status !== 'attivo' && (
                        <button
                          type="button"
                          onClick={() => openEditor(portfolio.templateId)}
                          className="rounded-lg border border-hairline-strong px-2.5 py-1.5 text-micro text-text-1 transition-colors hover:bg-bg-2"
                        >
                          Modifica limiti
                        </button>
                      )}
                      {portfolio.status !== 'attivo' ? (
                        <button
                          type="button"
                          onClick={() => { setAckReal(false); setConfirming(portfolio); }}
                          className="flex items-center gap-1.5 rounded-lg bg-agent px-2.5 py-1.5 text-micro font-medium text-bg-0 transition-colors hover:bg-agent/90"
                        >
                          <Play className="h-3.5 w-3.5" aria-hidden /> Attiva su eToro
                        </button>
                      ) : (
                        <span className="flex items-center gap-1.5 rounded-lg bg-gain/10 px-2.5 py-1.5 text-micro text-gain"><Check className="h-3.5 w-3.5" aria-hidden /> Collegato</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {remoteChecked && (
        <div className="card-surface density-pad p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-body-strong text-text-0">Agent Portfolio già presenti su eToro</h3>
              <p className="text-caption text-text-2">Lettura tramite il proxy configurato. Nessuna modifica viene eseguita da questo elenco.</p>
            </div>
            <button type="button" onClick={() => void syncRemote()} className="rounded-lg p-2 text-text-2 transition-colors hover:bg-bg-2 hover:text-text-0" aria-label="Aggiorna Agent Portfolio">
              <RefreshCw className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {remote.length === 0 ? (
            <p className="rounded-lg border border-dashed border-hairline-strong p-4 text-caption text-text-2">Nessun Agent Portfolio restituito dall’account.</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {remote.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-bg-1 px-3 py-3">
                  <div className="min-w-0"><p className="truncate text-caption font-medium text-text-0">{item.name}</p><p className="font-mono text-micro text-text-2">ID {item.id}</p></div>
                  <span className="shrink-0 rounded-full bg-gain/10 px-2 py-1 text-micro text-gain">Collegato</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!liveReady && (
        <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-caption text-text-1">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span>Puoi configurare e salvare le strategie anche ora. Per leggerle o crearle su eToro devi prima completare chiavi, proxy, ambiente <strong className="text-text-0">Real</strong> e permesso di scrittura in Impostazioni.</span>
        </div>
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[680px]">
          {editing && draftPreview && <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><SlidersHorizontal className="h-5 w-5 text-agent" aria-hidden /> Configura {getStrategyTemplate(editing.templateId).name}</DialogTitle>
              <DialogDescription>Questi sono limiti del motore Torino. eToro riceverà il solo budget totale alla creazione dell’Agent Portfolio.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome Agent Portfolio" hint="6–10 caratteri">
                <Input value={editing.name} onChange={(event) => updateEditing('name', event.target.value)} maxLength={10} placeholder="Es. Dividend" />
              </Field>
              <Field label={`Budget reale (${currencySymbol})`} hint={`eToro invierà ${money(toUsd(editing.budgetUsd), 'USD')}`}>
                <Input type="number" min={1} step={50} value={inputMoney(editing.budgetUsd, fromUsd)} onChange={numberInput((value) => updateEditing('budgetUsd', Math.round(toUsd(value) * 100) / 100))} />
              </Field>
              <Field label={`Minimo per operazione (${currencySymbol})`} hint="Evita micro-ordini">
                <Input type="number" min={1} step={5} value={inputMoney(editing.minOrderUsd, fromUsd)} onChange={numberInput((value) => updateEditing('minOrderUsd', Math.round(toUsd(value) * 100) / 100))} />
              </Field>
              <Field label={`Massimo per operazione (${currencySymbol})`} hint="Tetto per singola entrata">
                <Input type="number" min={1} step={5} value={inputMoney(editing.maxOrderUsd, fromUsd)} onChange={numberInput((value) => updateEditing('maxOrderUsd', Math.round(toUsd(value) * 100) / 100))} />
              </Field>
              <Field label="Numero massimo posizioni" hint="Se arrivano 20 strumenti, ne limita la selezione">
                <Input type="number" min={1} max={100} step={1} value={editing.maxPositions} onChange={numberInput((value) => updateEditing('maxPositions', Math.max(1, Math.round(value))))} />
              </Field>
              <Field label="Riserva di liquidità (%)" hint="Resta non investita">
                <Input type="number" min={0} max={99} step={5} value={editing.cashReservePct} onChange={numberInput((value) => updateEditing('cashReservePct', Math.min(99, Math.max(0, value))))} />
              </Field>
              <Field label="Massimo ordini al giorno" hint="Kill switch operativo aggiuntivo">
                <Input type="number" min={1} max={100} step={1} value={editing.maxOrdersPerDay} onChange={numberInput((value) => updateEditing('maxOrdersPerDay', Math.max(1, Math.round(value))))} />
              </Field>
              <Field label="Ribilanciamento" hint="Frequenza di controllo della strategia">
                <select value={editing.rebalance} onChange={(event) => updateEditing('rebalance', event.target.value as StrategyPortfolioConfig['rebalance'])} className="flex h-10 w-full rounded-lg border border-hairline-strong bg-bg-1 px-3 text-caption text-text-0 outline-none focus:border-agent">
                  <option value="giornaliero">Giornaliero</option><option value="settimanale">Settimanale</option><option value="mensile">Mensile</option>
                </select>
              </Field>
            </div>
            <div className="grid gap-2 rounded-xl border border-agent/25 bg-agent/5 p-4 sm:grid-cols-3">
              <Metric label="Budget operativo" value={money(fromUsd(draftPreview.operatingBudgetUsd), displayCurrency)} />
              <Metric label="Divisione teorica" value={money(fromUsd(draftPreview.equalSplitUsd), displayCurrency)} />
              <Metric label="Cap massimo entrata" value={money(fromUsd(draftPreview.maxSingleEntryUsd), displayCurrency)} />
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-hairline bg-bg-1 p-3 text-micro text-text-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gain" aria-hidden /> Le regole non useranno leva: questo studio applicherà solamente ordini buy/sell entro i limiti definiti.</div>
            <DialogFooter>
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-1 transition-colors hover:bg-bg-2">Annulla</button>
              <button type="button" onClick={saveDraft} className="rounded-lg bg-agent px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-agent/90">Salva strategia</button>
            </DialogFooter>
          </>}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(confirming)} onOpenChange={(open) => { if (!open && !creatingId) { setConfirming(null); setAckReal(false); } }}>
        <DialogContent className="sm:max-w-[560px]">
          {confirming && <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-loss" aria-hidden /> Conferma attivazione reale</DialogTitle>
              <DialogDescription>Questa è l’ultima schermata prima della chiamata POST alle API Agent Portfolio di eToro.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-hairline bg-bg-1 p-4 text-caption"><Metric label="Portafoglio" value={confirming.name} /><Metric label="Budget reale" value={money(fromUsd(confirming.budgetUsd), displayCurrency)} /><Metric label="Min / max ordine" value={`${money(fromUsd(confirming.minOrderUsd), displayCurrency)} / ${money(fromUsd(confirming.maxOrderUsd), displayCurrency)}`} /><Metric label="Riserva" value={`${confirming.cashReservePct}%`} /></div>
              {!realExecutionActive && <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-caption text-warn"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Per sicurezza il pulsante è disabilitato: attiva Live + Real + Lettura e scrittura in Impostazioni.</div>}
              {realExecutionActive && <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-loss/50 bg-loss/5 p-3"><Checkbox checked={ackReal} onCheckedChange={(value) => setAckReal(value === true)} className="mt-0.5" /><span className="text-caption text-text-0">Confermo che eToro potrà prelevare {money(fromUsd(confirming.budgetUsd), displayCurrency)} dal conto reale e creare un Agent Portfolio con permesso di scrittura.</span></label>}
              <p className="flex items-start gap-2 text-micro text-text-2"><CircleDollarSign className="mt-0.5 h-4 w-4 shrink-0 text-agent" aria-hidden /> Il limite minimo/massimo per singolo ordine resta una regola del motore Torino; l’API di creazione eToro riceve il budget totale e i permessi reali.</p>
            </div>
            <DialogFooter>
              <button type="button" disabled={Boolean(creatingId)} onClick={() => { setConfirming(null); setAckReal(false); }} className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-1 transition-colors hover:bg-bg-2">Annulla</button>
              <button type="button" disabled={!realExecutionActive || !ackReal || Boolean(creatingId)} onClick={() => void activateRemote()} className="flex items-center gap-2 rounded-lg bg-loss px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-loss/90 disabled:cursor-not-allowed disabled:opacity-40">
                {creatingId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ExternalLink className="h-4 w-4" aria-hidden />} Crea portafoglio reale
              </button>
            </DialogFooter>
          </>}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-caption text-text-0">{label}</Label><div>{children}</div><p className="text-micro text-text-2">{hint}</p></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-micro text-text-2">{label}</p><p className="mt-0.5 text-caption font-medium tabular-nums text-text-0">{value}</p></div>;
}
