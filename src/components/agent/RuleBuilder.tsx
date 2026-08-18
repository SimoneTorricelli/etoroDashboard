/**
 * RuleBuilder — wizard modale a 3 step (design/agent.md):
 *  1. Strumenti & gruppo (con budget residuo live)
 *  2. Condizione di ingresso + importo + SL/TP + cooldown
 *  3. Riepilogo, modalità di esecuzione e attivazione
 * Supporta creazione e modifica (editingRule) e preselezione strumento.
 */
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Zap } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import type { AgentEngine } from '@/lib/agent/engine';
import type { AgentConditionType, AgentGroup, AgentRule, Instrument } from '@/lib/data/types';
import {
  DEFAULT_SLTP,
  conditionSentence,
  hasAutoAck,
  loadSlTpMap,
  saveSlTpMap,
  setAutoAck,
} from './agent-utils';

export interface RuleBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentEngine;
  groups: AgentGroup[];
  instruments: Instrument[];
  /** Regola in modifica; null/undefined = nuova regola. */
  editingRule?: AgentRule | null;
  /** Strumento preselezionato (da ?instrument=<id>). */
  presetInstrumentId?: number | null;
  /** Strumenti assegnati ai gruppi (sidecar) per la preselezione. */
  groupMeta: Record<string, number[]>;
  displayCurrency: 'EUR' | 'USD';
  fromUsd: (usd: number) => number;
  toUsd: (display: number) => number;
  onSaved?: () => void;
}

const NEW_GROUP = '__new__';

const CONDITION_OPTIONS: Array<{ value: AgentConditionType; label: string; explanation: string; example: string }> = [
  {
    value: 'drop_from_avg', label: 'Calo % dalla media a N giorni',
    explanation: 'Confronta il prezzo live con la media delle chiusure giornaliere eToro del periodo scelto.',
    example: 'Esempio: compra se il prezzo è almeno 3% sotto la media delle ultime 20 chiusure.',
  },
  {
    value: 'daily_drop', label: 'Calo nella seduta',
    explanation: 'Scatta quando la variazione odierna supera in negativo la percentuale indicata.',
    example: 'Esempio: compra se oggi perde almeno il 3% rispetto alla chiusura precedente.',
  },
  {
    value: 'price_below', label: 'Prezzo sotto soglia',
    explanation: 'Scatta quando il prezzo live scende sotto un valore assoluto scelto da te.',
    example: 'Esempio: compra solo sotto 180 USD.',
  },
  {
    value: 'price_above', label: 'Prezzo sopra soglia',
    explanation: 'Scatta quando il prezzo live sale sopra un valore assoluto scelto da te.',
    example: 'Esempio: compra solo dopo il superamento di 200 USD.',
  },
  {
    value: 'rsi_below', label: 'RSI-14 sotto soglia',
    explanation: 'RSI sotto 30 indica spesso forte pressione di vendita; non garantisce però un rimbalzo.',
    example: 'Esempio: compra quando RSI(14) scende sotto 30.',
  },
];

const COOLDOWN_OPTIONS = [
  { value: 60, label: '1 ora' },
  { value: 240, label: '4 ore' },
  { value: 720, label: '12 ore' },
  { value: 1440, label: '24 ore' },
];

const STEP_TITLES = ['Strumenti & gruppo', 'Condizione & importo', 'Riepilogo & attivazione'];

const slide = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -24 },
  transition: { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
};

export function RuleBuilder({
  open, onOpenChange, agent, groups, instruments, editingRule, presetInstrumentId,
  groupMeta, displayCurrency, fromUsd, toUsd, onSaved,
}: RuleBuilderProps) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [groupSel, setGroupSel] = useState<string>('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupLimit, setNewGroupLimit] = useState(1000);
  const [instrumentIds, setInstrumentIds] = useState<number[]>([]);
  const [condType, setCondType] = useState<AgentConditionType>('drop_from_avg');
  const [condValue, setCondValue] = useState(3);
  const [windowDays, setWindowDays] = useState(20);
  const [amount, setAmount] = useState(100);
  const [slPct, setSlPct] = useState(DEFAULT_SLTP.stopLossPct);
  const [tpPct, setTpPct] = useState(DEFAULT_SLTP.takeProfitPct);
  const [cooldown, setCooldown] = useState(240);
  const [execMode, setExecMode] = useState<'confirm' | 'auto'>('confirm');
  const [ackChecked, setAckChecked] = useState(false);

  /* Reset/apertura */
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setAckChecked(false);
    if (editingRule) {
      setName(editingRule.name);
      setGroupSel(editingRule.groupId);
      setInstrumentIds([...editingRule.instrumentIds]);
      setCondType(editingRule.condition.type);
      setCondValue(editingRule.condition.value);
      setWindowDays(editingRule.condition.windowDays ?? 20);
      setAmount(Math.round(fromUsd(editingRule.action.amount)));
      const sltp = loadSlTpMap()[editingRule.id] ?? DEFAULT_SLTP;
      setSlPct(sltp.stopLossPct);
      setTpPct(sltp.takeProfitPct);
      setCooldown(editingRule.cooldownMinutes);
      setExecMode(agent.autoExecute ? 'auto' : 'confirm');
    } else {
      setName('');
      setGroupSel(groups[0]?.id ?? NEW_GROUP);
      setNewGroupName('');
      setNewGroupLimit(1000);
      setInstrumentIds(presetInstrumentId != null ? [presetInstrumentId] : []);
      setCondType('drop_from_avg');
      setCondValue(3);
      setWindowDays(20);
      setAmount(100);
      setSlPct(DEFAULT_SLTP.stopLossPct);
      setTpPct(DEFAULT_SLTP.takeProfitPct);
      setCooldown(240);
      setExecMode(agent.autoExecute ? 'auto' : 'confirm');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingRule]);

  const selectedGroup = groups.find((g) => g.id === groupSel) ?? null;
  const remainingBudget = selectedGroup
    ? Math.max(0, fromUsd(selectedGroup.capitalLimit - selectedGroup.usedCapital))
    : 0;

  /* Preselezione strumenti dal gruppo scelto (solo nuove regole) */
  useEffect(() => {
    if (!open || editingRule) return;
    if (groupSel !== NEW_GROUP && instrumentIds.length === 0) {
      const meta = groupMeta[groupSel];
      if (meta && meta.length > 0) setInstrumentIds(meta.slice(0, 4));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupSel, open]);

  const symbols = useMemo(
    () =>
      instrumentIds
        .map((id) => instruments.find((i) => i.instrumentId === id)?.symbol)
        .filter(Boolean)
        .join(', ') || '—',
    [instrumentIds, instruments],
  );

  const condition = useMemo(
    () => ({
      type: condType,
      value: condValue,
      ...(condType === 'drop_from_avg' ? { windowDays } : {}),
    }),
    [condType, condValue, windowDays],
  );
  const conditionHelp = CONDITION_OPTIONS.find((option) => option.value === condType) ?? CONDITION_OPTIONS[0];

  const summary = `Compra ${formatCurrency(amount, displayCurrency, 0)} di ${symbols} ${conditionSentence(condition, symbols)} · SL −${slPct}% · TP +${tpPct}%.`;

  /* ── Validazione per step ────────────────────────────────────────── */
  const step0Valid =
    name.trim().length > 0 &&
    instrumentIds.length > 0 &&
    (groupSel === NEW_GROUP ? newGroupName.trim().length > 0 && newGroupLimit > 0 : groupSel !== '');
  const step1Valid =
    condValue > 0 &&
    amount >= 10 &&
    slPct > 0 &&
    tpPct > 0 &&
    (condType !== 'drop_from_avg' || windowDays >= 2);
  const ackNeeded = execMode === 'auto' && !hasAutoAck();
  const step2Valid = !ackNeeded || ackChecked;

  const canNext = step === 0 ? step0Valid : step === 1 ? step1Valid : step2Valid;

  const toggleInstrument = (id: number) => {
    setInstrumentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleSave = () => {
    if (!canNext) return;
    let groupId = groupSel;
    if (groupSel === NEW_GROUP) {
      const g = agent.addGroup({ name: newGroupName.trim(), capitalLimit: toUsd(newGroupLimit) });
      groupId = g.id;
    }
    const payload = {
      name: name.trim(),
      groupId,
      instrumentIds,
      condition,
      action: { type: 'buy' as const, amount: toUsd(amount), leverage: 1 },
      enabled: true,
      cooldownMinutes: cooldown,
    };
    let ruleId: string;
    if (editingRule) {
      agent.updateRule(editingRule.id, payload);
      ruleId = editingRule.id;
    } else {
      ruleId = agent.addRule(payload).id;
    }
    const map = loadSlTpMap();
    map[ruleId] = { stopLossPct: slPct, takeProfitPct: tpPct };
    saveSlTpMap(map);

    // Modalità esecuzione (globale per l'engine)
    if (execMode === 'auto') {
      setAutoAck();
      if (!agent.autoExecute) agent.setAutoExecute(true);
    } else if (agent.autoExecute) {
      agent.setAutoExecute(false);
    }

    onSaved?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {editingRule ? 'Modifica regola' : 'Nuova regola'}
            <span className="rounded-full bg-agent/15 px-2 py-0.5 text-micro font-medium text-agent">
              {step + 1}/3 · {STEP_TITLES[step]}
            </span>
          </DialogTitle>
          <DialogDescription>
            L'Agent opera solo entro i limiti di capitale del gruppo scelto.
          </DialogDescription>
        </DialogHeader>

        {/* step dots */}
        <div className="flex items-center gap-1.5" aria-hidden>
          {STEP_TITLES.map((t, i) => (
            <div
              key={t}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors duration-300',
                i <= step ? 'bg-agent' : 'bg-bg-3',
              )}
            />
          ))}
        </div>

        <div className="min-h-[300px]">
          <AnimatePresence mode="wait" initial={false}>
            {step === 0 && (
              <motion.div key="s0" {...slide} className="space-y-4">
                <div>
                  <Label htmlFor="rule-name" className="overline mb-2 block">Nome regola</Label>
                  <Input
                    id="rule-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder='Es. "Compra i cali — Tech"'
                    maxLength={60}
                  />
                </div>

                <div>
                  <Label className="overline mb-2 block">Gruppo</Label>
                  <Select value={groupSel} onValueChange={setGroupSel}>
                    <SelectTrigger>
                      <SelectValue placeholder="Scegli un gruppo" />
                    </SelectTrigger>
                    <SelectContent>
                      {groups.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.name} — residuo {formatCurrency(fromUsd(g.capitalLimit - g.usedCapital), displayCurrency, 0)}
                        </SelectItem>
                      ))}
                      <SelectItem value={NEW_GROUP}>+ Crea nuovo gruppo</SelectItem>
                    </SelectContent>
                  </Select>
                  {groupSel === NEW_GROUP && (
                    <div className="mt-2 flex items-center gap-2">
                      <Input
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                        placeholder="Nome del nuovo gruppo"
                        maxLength={40}
                      />
                      <Input
                        type="number"
                        min={50}
                        step={50}
                        value={newGroupLimit}
                        onChange={(e) => setNewGroupLimit(Math.max(0, Number(e.target.value) || 0))}
                        className="w-28 tabular-nums"
                        aria-label="Limite capitale nuovo gruppo"
                      />
                    </div>
                  )}
                  {selectedGroup && (
                    <p className="mt-1.5 text-caption text-text-1">
                      Budget residuo del gruppo:{' '}
                      <span className="font-medium text-agent tabular-nums">
                        {formatCurrency(remainingBudget, displayCurrency, 0)}
                      </span>{' '}
                      su {formatCurrency(fromUsd(selectedGroup.capitalLimit), displayCurrency, 0)}.
                    </p>
                  )}
                </div>

                <div>
                  <Label className="overline mb-2 block">
                    Strumenti ({instrumentIds.length} selezionati)
                  </Label>
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-hairline bg-bg-0 p-2">
                    <div className="flex flex-wrap gap-1.5">
                      {instruments.map((inst) => {
                        const active = instrumentIds.includes(inst.instrumentId);
                        return (
                          <button
                            key={inst.instrumentId}
                            type="button"
                            onClick={() => toggleInstrument(inst.instrumentId)}
                            className={cn(
                              'flex items-center gap-1.5 rounded-full border px-2 py-1 text-micro font-medium transition-colors',
                              active
                                ? 'border-agent/60 bg-agent/15 text-agent'
                                : 'border-hairline bg-bg-2 text-text-1 hover:border-hairline-strong hover:text-text-0',
                            )}
                          >
                            <InstrumentAvatar symbol={inst.symbol} size={16} />
                            <span className="font-mono">{inst.symbol}</span>
                            {active && <Check className="h-3 w-3" aria-hidden />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 1 && (
              <motion.div key="s1" {...slide} className="space-y-4">
                <div>
                  <Label className="overline mb-2 block">Condizione di ingresso</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={condType} onValueChange={(value) => {
                      const next = value as AgentConditionType;
                      setCondType(next);
                      setCondValue(next === 'rsi_below' ? 30 : next === 'price_below' || next === 'price_above' ? 100 : 3);
                    }}>
                      <SelectTrigger className="w-[240px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CONDITION_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0}
                      step={condType === 'rsi_below' ? 1 : 0.5}
                      value={condValue}
                      onChange={(e) => setCondValue(Number(e.target.value) || 0)}
                      className="w-24 tabular-nums"
                      aria-label="Soglia condizione"
                    />
                    {condType === 'drop_from_avg' && (
                      <>
                        <span className="text-body text-text-1">% in</span>
                        <Input
                          type="number"
                          min={2}
                          max={120}
                          value={windowDays}
                          onChange={(e) => setWindowDays(Math.max(2, Number(e.target.value) || 2))}
                          className="w-20 tabular-nums"
                          aria-label="Finestra in giorni"
                        />
                        <span className="text-body text-text-1">giorni</span>
                      </>
                    )}
                    {condType === 'rsi_below' && <span className="text-body text-text-1">(RSI a 14 giorni)</span>}
                  </div>
                  <p key={summary} className="mt-2 text-caption text-agent">
                    {conditionSentence(condition, symbols)}.
                  </p>
                  <div className="mt-2 rounded-lg border border-info/25 bg-info/5 p-3 text-caption leading-relaxed text-text-1">
                    <p>{conditionHelp.explanation}</p>
                    <p className="mt-1 text-text-2">{conditionHelp.example}</p>
                    {(condType === 'drop_from_avg' || condType === 'rsi_below') ? <p className="mt-1 text-micro text-info">Il segnale usa candele giornaliere reali eToro, aggiornate ogni 15 minuti per limitare le chiamate.</p> : null}
                  </div>
                </div>

                <div className="rounded-lg border border-hairline bg-bg-1 p-3">
                  <p className="text-body-strong text-text-0">Altre regole utili da aggiungere in seguito</p>
                  <p className="mt-1 text-caption leading-relaxed text-text-2">
                    Accumulo periodico (DCA), incrocio tra medie mobili, breakout con volume, scostamento dai pesi target e presa di profitto progressiva. Non sono selezionabili finché il motore non ne gestisce dati, test e limiti in modo completo.
                  </p>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <Label className="overline">Importo per esecuzione</Label>
                    <span className="font-mono text-ticker text-agent tabular-nums">
                      {formatCurrency(amount, displayCurrency, 0)}
                    </span>
                  </div>
                  <Slider
                    min={10}
                    max={Math.max(50, Math.floor(remainingBudget))}
                    step={10}
                    value={[Math.min(amount, Math.max(50, Math.floor(remainingBudget)))]}
                    onValueChange={([v]) => setAmount(v)}
                  />
                  <p className="mt-1.5 text-caption text-text-2">
                    Limitato dal budget residuo del gruppo
                    {selectedGroup ? ` (${formatCurrency(remainingBudget, displayCurrency, 0)})` : ''}.
                  </p>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="overline mb-2 block">Stop loss %</Label>
                    <Input
                      type="number" min={1} max={50} step={0.5}
                      value={slPct}
                      onChange={(e) => setSlPct(Math.max(0.5, Number(e.target.value) || 0))}
                      className="tabular-nums"
                    />
                  </div>
                  <div>
                    <Label className="overline mb-2 block">Take profit %</Label>
                    <Input
                      type="number" min={1} max={200} step={0.5}
                      value={tpPct}
                      onChange={(e) => setTpPct(Math.max(0.5, Number(e.target.value) || 0))}
                      className="tabular-nums"
                    />
                  </div>
                  <div>
                    <Label className="overline mb-2 block">Cooldown</Label>
                    <Select value={String(cooldown)} onValueChange={(v) => setCooldown(Number(v))}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COOLDOWN_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div key="s2" {...slide} className="space-y-4">
                <div className="rounded-lg border border-agent/30 bg-agent/5 p-4">
                  <span className="overline">Riepilogo</span>
                  <p key={summary} className="mt-2 text-body-strong text-text-0">{summary}</p>
                  <p className="mt-1 text-caption text-text-1">
                    Gruppo: {groupSel === NEW_GROUP ? newGroupName : selectedGroup?.name} · Cooldown{' '}
                    {COOLDOWN_OPTIONS.find((o) => o.value === cooldown)?.label}.
                  </p>
                </div>

                <div>
                  <Label className="overline mb-2 block">Modalità di esecuzione</Label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setExecMode('confirm')}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        execMode === 'confirm'
                          ? 'border-warn/60 bg-warn/10'
                          : 'border-hairline bg-bg-2 hover:border-hairline-strong',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-body-strong text-text-0">Chiedi sempre conferma</span>
                        <span className="rounded-full bg-gain/15 px-1.5 py-0.5 text-micro font-medium text-gain">
                          Consigliata
                        </span>
                      </div>
                      <p className="mt-1 text-caption text-text-1">
                        Ogni trigger finisce in coda e richiede il tuo OK.
                      </p>
                    </motion.button>
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setExecMode('auto')}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        execMode === 'auto'
                          ? 'border-agent/60 bg-agent/10'
                          : 'border-hairline bg-bg-2 hover:border-hairline-strong',
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-agent" aria-hidden />
                        <span className="text-body-strong text-text-0">Esegui automaticamente</span>
                      </div>
                      <p className="mt-1 text-caption text-text-1">
                        Nessuna conferma: ordini inviati appena scatta la condizione.
                      </p>
                    </motion.button>
                  </div>
                  <p className="mt-1.5 text-caption text-text-2">
                    La modalità è un'impostazione globale dell'Agent e vale per tutte le regole attive.
                  </p>

                  {execMode === 'auto' && (
                    <label
                      className={cn(
                        'mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border p-3',
                        ackNeeded && !ackChecked ? 'border-loss/60 bg-loss/5' : 'border-hairline bg-bg-2',
                      )}
                    >
                      <Checkbox
                        checked={ackChecked}
                        onCheckedChange={(v) => setAckChecked(v === true)}
                        className="mt-0.5"
                      />
                      <span className="text-caption text-text-0">
                        Comprendo che l'Agent invierà ordini senza mia conferma, entro il limite di{' '}
                        {selectedGroup
                          ? formatCurrency(fromUsd(selectedGroup.capitalLimit), displayCurrency, 0)
                          : formatCurrency(newGroupLimit, displayCurrency, 0)}{' '}
                        del gruppo.
                      </span>
                    </label>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-hairline pt-4">
          <button
            type="button"
            onClick={() => (step === 0 ? onOpenChange(false) : setStep((s) => s - 1))}
            className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-0 transition-colors hover:bg-bg-2"
          >
            {step === 0 ? 'Annulla' : 'Indietro'}
          </button>
          {step < 2 ? (
            <button
              type="button"
              disabled={!canNext}
              onClick={() => setStep((s) => s + 1)}
              className="rounded-lg bg-agent px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-agent/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Avanti
            </button>
          ) : (
            <button
              type="button"
              disabled={!step2Valid}
              onClick={handleSave}
              className="rounded-lg bg-agent px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-agent/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editingRule ? 'Salva regola' : 'Attiva regola'}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
