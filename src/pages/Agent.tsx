/**
 * eToro Agent (/agent) — investimenti automatizzati (design/agent.md).
 * ROW 0: banner di sicurezza condizionali (REAL / kill switch / auto-esecuzione)
 * ROW 1: 4 stat tiles (Regole attive / Ordini oggi / Budget allocato / P&L Agent)
 * ROW 2: Gruppi con limiti di capitale (span 5) | Regole (span 7)
 * ROW 3: Coda conferme (span 5, condizionale) | Log + tabella esecuzioni (span 7)
 * ROW 4: Backtest-lite (span 12)
 * Modali: RuleBuilder, GroupEditor, KillSwitchDialog, presa visione auto-esecuzione.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { motion } from 'framer-motion';
import {
  Bot, BrainCircuit, Clock3, Copy, Download, EllipsisVertical, OctagonX, Pencil, Play, Plus, Power,
  Scale, Trash2, Zap, Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import {
  formatCurrency, formatDateTime, formatPercent, formatPrice, formatSignedCurrency, formatTime,
} from '@/lib/format';
import { RiskBanner } from '@/components/shared/RiskBanner';
import { StatusDot } from '@/components/shared/StatusDot';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import { LogStream } from '@/components/shared/LogStream';
import { EmptyState } from '@/components/shared/EmptyState';
import { DataTable } from '@/components/shared/DataTable';
import type { DataTableColumn } from '@/components/shared/DataTable';
import type { AgentExecution, AgentGroup, AgentRule, LogLevel } from '@/lib/data/types';
import { RuleBuilder } from '@/components/agent/RuleBuilder';
import { GroupEditor } from '@/components/agent/GroupEditor';
import { KillSwitchDialog } from '@/components/agent/KillSwitchDialog';
import { BacktestCard } from '@/components/agent/BacktestCard';
import { StrategyPortfolioStudio } from '@/components/agent/StrategyPortfolioStudio';
import { AgentMasterSwitch } from '@/components/agent/AgentMasterSwitch';
import {
  DEFAULT_SLTP, conditionChip, hasAutoAck, loadGroupMeta, loadSlTpMap, saveGroupMeta, setAutoAck,
} from '@/components/agent/agent-utils';
import type { SlTp } from '@/components/agent/agent-utils';

const PENDING_TTL_MS = 15 * 60_000; // countdown indicativo per la coda conferme

const stagger = (i: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.28, delay: i * 0.05, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
});

export default function Agent() {
  const {
    agent, agentVersion, quotes, instruments, logs,
    fromUsd, displayCurrency, fxRate, realExecutionActive,
  } = useAppData();
  const cur = displayCurrency;
  const toUsd = (v: number) => (displayCurrency === 'USD' ? v : fxRate?.rate ? v * fxRate.rate : Number.NaN);

  const [searchParams, setSearchParams] = useSearchParams();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AgentRule | null>(null);
  const [presetInstrument, setPresetInstrument] = useState<number | null>(null);
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<AgentGroup | null>(null);
  const [killOpen, setKillOpen] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [ackChecked, setAckChecked] = useState(false);
  const [groupMeta, setGroupMeta] = useState<Record<string, number[]>>(() => loadGroupMeta());
  const [sltpMap, setSltpMap] = useState<Record<string, SlTp>>(() => loadSlTpMap());
  const [now, setNow] = useState(() => Date.now());

  /* ── Snapshot engine (agentVersion forza il re-render) ───────────── */
  void agentVersion;
  const groups = agent.getGroups();
  const rules = agent.getRules();
  const executions = agent.getExecutions();
  const pending = agent.getPendingConfirmations();
  const activeRules = agent.getActiveRulesCount();
  const execToday = agent.getExecutionsToday();
  const remainingBudget = agent.getRemainingBudget();
  const masterEnabled = agent.masterEnabled;
  const autoExecute = agent.autoExecute;
  const killEngaged = agent.killSwitchEngaged;

  /* ── Default OFF: senza presa visione l'auto-esecuzione resta spenta ─ */
  useEffect(() => {
    if (!hasAutoAck() && agent.autoExecute) agent.setAutoExecute(false);
  }, [agent]);

  /* ── Query params: ?new=rule e ?instrument=<id> ──────────────────── */
  /* eslint-disable react-hooks/set-state-in-effect -- sincronizza l'apertura del wizard con i query params (sistema esterno: URL) */
  useEffect(() => {
    const isNew = searchParams.get('new') === 'rule';
    const iidRaw = searchParams.get('instrument');
    if (!isNew && !iidRaw) return;
    const iid = iidRaw ? Number(iidRaw) : NaN;
    setPresetInstrument(Number.isFinite(iid) && instruments.some((i) => i.instrumentId === iid) ? iid : null);
    setEditingRule(null);
    setBuilderOpen(true);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, instruments]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* ── Tick per countdown coda ─────────────────────────────────────── */
  useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);

  /* ── Toast sulle nuove esecuzioni ────────────────────────────────── */
  const seenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!seenRef.current) {
      seenRef.current = new Set(executions.map((e) => e.id));
      return;
    }
    const seen = seenRef.current;
    for (const e of [...executions].reverse()) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const what = `BUY ${e.symbol} · ${formatCurrency(fromUsd(e.amount), cur, 0)}`;
      if (e.status === 'executed') {
        if (e.mode === 'live') {
          toast.error(`Ordine REALE eseguito: ${what}`, { description: `Regola "${e.ruleName}"` });
        } else {
          toast(`Agent: ${what}`, {
            description: `Regola "${e.ruleName}" eseguita @ ${formatPrice(e.price)}`,
            icon: <Bot className="h-4 w-4 text-agent" />,
          });
        }
      } else if (e.status === 'pending_confirm') {
        toast.warning(`Trigger in attesa di conferma: ${what}`, { description: `Regola "${e.ruleName}"` });
      } else if (e.status === 'failed') {
        toast.error(`Ordine Agent fallito: ${e.symbol}`, { description: e.reason });
      }
    }
  }, [executions, fromUsd, cur]);

  /* ── P&L Agent: mark-to-market delle esecuzioni sui prezzi correnti ─ */
  const agentPnl = useMemo(() => {
    let pnl = 0;
    let invested = 0;
    for (const e of executions) {
      if (e.status !== 'executed') continue;
      const q = quotes[e.instrumentId];
      if (!q) continue;
      pnl += ((q.last - e.price) / e.price) * e.amount;
      invested += e.amount;
    }
    return { pnl, pnlPct: invested > 0 ? (pnl / invested) * 100 : 0 };
  }, [executions, quotes]);

  const groupPnl = (groupId: string) => {
    let pnl = 0;
    for (const e of executions) {
      if (e.groupId !== groupId || e.status !== 'executed') continue;
      const q = quotes[e.instrumentId];
      if (q) pnl += ((q.last - e.price) / e.price) * e.amount;
    }
    return pnl;
  };

  const lastExecutionFor = (ruleId: string) => executions.find((e) => e.ruleId === ruleId);

  const groupInstruments = (groupId: string): number[] => {
    const set = new Set<number>(groupMeta[groupId] ?? []);
    for (const r of rules) if (r.groupId === groupId) r.instrumentIds.forEach((id) => set.add(id));
    return [...set];
  };

  /* ── Azioni ──────────────────────────────────────────────────────── */
  const handleMasterChanged = (on: boolean) => {
    toast(on ? 'Agent attivato' : 'Agent in pausa', {
      icon: <Bot className="h-4 w-4 text-agent" />,
    });
  };

  const handleAutoToggle = (on: boolean) => {
    if (on && !hasAutoAck()) {
      setAckChecked(false);
      setAckOpen(true);
      return;
    }
    agent.setAutoExecute(on);
    toast(on ? 'Auto-esecuzione attiva — le regole eseguiranno senza conferma' : 'Auto-esecuzione disattivata', {
      icon: <Zap className="h-4 w-4 text-agent" />,
    });
  };

  const confirmAck = () => {
    if (!ackChecked) return;
    setAutoAck();
    agent.setAutoExecute(true);
    setAckOpen(false);
    toast('Auto-esecuzione attiva — le regole eseguiranno senza conferma', {
      icon: <Zap className="h-4 w-4 text-agent" />,
    });
  };

  const handleGroupSave = (name: string, capitalLimitUsd: number, instrumentIds: number[]) => {
    let groupId: string;
    if (editingGroup) {
      agent.updateGroup(editingGroup.id, { name, capitalLimit: capitalLimitUsd });
      groupId = editingGroup.id;
      toast(`Gruppo "${name}" aggiornato`);
    } else {
      groupId = agent.addGroup({ name, capitalLimit: capitalLimitUsd }).id;
      toast(`Gruppo "${name}" creato`, { icon: <Bot className="h-4 w-4 text-agent" /> });
    }
    const meta = { ...groupMeta, [groupId]: instrumentIds };
    setGroupMeta(meta);
    saveGroupMeta(meta);
  };

  const handleDeleteGroup = (g: AgentGroup) => {
    agent.removeGroup(g.id);
    const meta = { ...groupMeta };
    delete meta[g.id];
    setGroupMeta(meta);
    saveGroupMeta(meta);
    toast(`Gruppo "${g.name}" eliminato (con le sue regole)`);
  };

  const handleDuplicateRule = (r: AgentRule) => {
    const copy = agent.addRule({
      name: `${r.name} (copia)`,
      groupId: r.groupId,
      instrumentIds: [...r.instrumentIds],
      condition: { ...r.condition },
      action: { ...r.action },
      enabled: false,
      cooldownMinutes: r.cooldownMinutes,
    });
    const map = { ...sltpMap };
    if (map[r.id]) map[copy.id] = map[r.id];
    setSltpMap(map);
    toast(`Regola duplicata: "${copy.name}" (in pausa)`);
  };

  const exportLog = () => {
    const lines = logs
      .slice()
      .reverse()
      .map((l) => `${formatTime(l.timestamp)} [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `torino-agent-log-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const autoRulesCount = autoExecute ? activeRules : 0;

  return (
    <div className="grid grid-cols-12 gap-4">
      <Toaster position="bottom-right" />

      {/* ── Header pagina (sticky: kill switch sempre raggiungibile) ── */}
      <div className="sticky top-14 z-30 col-span-12 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-bg-0/85 px-1 py-2 backdrop-blur-md">
        <div>
          <h1 className="flex items-center gap-2 font-display text-display-lg text-text-0">
            <Bot className="h-7 w-7 text-agent" aria-hidden />
            eToro Agent
          </h1>
          <p className="text-caption text-text-1">
            Motore di regole per investimenti automatici — opera solo entro i limiti che imposti.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span className="hidden items-center gap-1.5 rounded-full border border-hairline bg-bg-1 px-2.5 py-1 text-micro text-text-1 md:flex">
            <StatusDot variant={execToday >= agent.maxOrdersPerDay ? 'warn' : 'agent'} />
            Ordini oggi {execToday}/{agent.maxOrdersPerDay}
          </span>
          <AgentMasterSwitch agent={agent} realExecutionActive={realExecutionActive} disabled={killEngaged} onChanged={handleMasterChanged} />
          <label className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-label text-text-1">
              <Zap className="h-3.5 w-3.5 text-agent" aria-hidden />
              Auto-esecuzione
            </span>
            <Switch
              checked={autoExecute}
              onCheckedChange={handleAutoToggle}
              className="data-[state=checked]:bg-agent"
              aria-label="Esecuzione automatica senza conferma"
            />
          </label>
          {killEngaged ? (
            <button
              type="button"
              onClick={() => {
                agent.disengageKillSwitch();
                toast('Kill switch disattivato — riattiva l\'Agent per riprendere');
              }}
              className="flex items-center gap-1.5 rounded-lg border border-loss bg-loss/15 px-3 py-2 text-body-strong text-loss transition-colors hover:bg-loss/25"
            >
              <Power className="h-4 w-4" aria-hidden />
              Disattiva kill switch
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setKillOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-loss/60 px-3 py-2 text-body-strong text-loss transition-all hover:bg-loss/10 hover:shadow-[0_0_12px_#F4556B33]"
            >
              <OctagonX className="h-4 w-4" aria-hidden />
              Interrompi tutto
            </button>
          )}
        </div>
      </div>

      {/* ── ROW 0: banner di sicurezza ──────────────────────────────── */}
      {realExecutionActive && masterEnabled && (
        <RiskBanner
          variant="danger"
          dismissible={false}
          className="col-span-12"
          message="Agent attivo sul conto reale — le regole abilitate possono usare denaro reale entro i limiti configurati."
        />
      )}
      {killEngaged && (
        <RiskBanner
          variant="danger"
          dismissible={false}
          className="col-span-12"
          message="KILL SWITCH attivo — tutte le regole sono interrotte. Le posizioni aperte non verranno chiuse automaticamente."
        />
      )}
      {!killEngaged && autoExecute && masterEnabled && (
        <RiskBanner
          variant="warn"
          dismissible={false}
          className="col-span-12"
          message={`⚡ Esecuzione automatica attiva su ${autoRulesCount} ${autoRulesCount === 1 ? 'regola' : 'regole'} — l'Agent può operare senza chiederti conferma, entro i limiti di capitale impostati.`}
        />
      )}

      {/* ── ROW 1: stat tiles ───────────────────────────────────────── */}
      <StatTiles
        activeRules={activeRules}
        totalRules={rules.length}
        execToday={execToday}
        maxOrders={agent.maxOrdersPerDay}
        groups={groups}
        remainingBudget={remainingBudget}
        pnl={agentPnl}
        fromUsd={fromUsd}
        cur={cur}
      />

      <motion.section {...stagger(1)} className="card-surface density-pad col-span-12 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-title text-text-0">Come decide l’Agent, oggi</h2>
            <p className="mt-1 max-w-3xl text-caption leading-relaxed text-text-1">
              Non c’è un’AI che sceglie liberamente cosa comprare. Il motore applica esclusivamente le regole, gli strumenti e i limiti che configuri tu.
            </p>
          </div>
          <span className="rounded-full border border-info/35 bg-info/10 px-2.5 py-1 text-micro font-medium text-info">Motore deterministico · non AI</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <AgentMechanic icon={<BrainCircuit className="h-4 w-4" aria-hidden />} title="1. Legge i segnali" copy="Prezzo live eToro e, per media mobile o RSI, candele giornaliere reali. Non inventa previsioni né cambia gli asset della regola." />
          <AgentMechanic icon={<Scale className="h-4 w-4" aria-hidden />} title="2. Applica i limiti" copy="Controlla budget del gruppo, importo per ordine, cooldown, massimo ordini giornalieri e kill switch prima di creare un ordine." />
          <AgentMechanic icon={<Clock3 className="h-4 w-4" aria-hidden />} title="3. Esegue solo mentre è operativo" copy="In questa versione il motore gira quando Torino è aperto. La cadenza di ribilanciamento delle strategie è salvata, ma non invia ancora ribilanciamenti automatici." />
        </div>
        <div className="mt-3 rounded-lg border border-agent/25 bg-agent/5 px-3 py-2.5 text-caption leading-relaxed text-text-1">
          <span className="font-medium text-agent">Come deve entrare l’AI:</span> analizza regime di mercato, volatilità, correlazioni, trend e fondamentali; propone nuovi pesi con motivazione e confidenza. Un motore deterministico separato applica universo consentito, turnover massimo, riserva cash e limiti di perdita prima di autorizzare qualsiasi ordine. L’AI non deve poter aggirare questi vincoli.
        </div>
      </motion.section>

      {/* ── Portafogli strategici reali ───────────────────────────── */}
      <StrategyPortfolioStudio
        fromUsd={fromUsd}
        toUsd={toUsd}
        displayCurrency={cur}
        realExecutionActive={realExecutionActive}
      />

      {/* ── ROW 2: Gruppi (span 5) ──────────────────────────────────── */}
      <motion.section {...stagger(1)} className="col-span-12 lg:col-span-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-title text-text-0">Gruppi e limiti di capitale</h2>
          <button
            type="button"
            onClick={() => { setEditingGroup(null); setGroupEditorOpen(true); }}
            className="flex items-center gap-1 rounded-lg border border-agent/50 px-2.5 py-1.5 text-micro font-medium text-agent transition-colors hover:bg-agent/10"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Nuovo gruppo
          </button>
        </div>
        <div className="space-y-3">
          {groups.map((g, i) => (
            <GroupCard
              key={g.id}
              group={g}
              index={i}
              rules={rules.filter((r) => r.groupId === g.id)}
              instrumentIds={groupInstruments(g.id)}
              instruments={instruments}
              pnl={groupPnl(g.id)}
              fromUsd={fromUsd}
              cur={cur}
              onEdit={() => { setEditingGroup(g); setGroupEditorOpen(true); }}
              onDelete={() => handleDeleteGroup(g)}
            />
          ))}
          {groups.length === 0 && (
            <p className="rounded-xl border border-dashed border-hairline-strong p-6 text-center text-caption text-text-2">
              Nessun gruppo: creane uno per assegnare un limite di capitale alle regole.
            </p>
          )}
        </div>
      </motion.section>

      {/* ── ROW 2: Regole (span 7) ──────────────────────────────────── */}
      <motion.section {...stagger(2)} className="col-span-12 lg:col-span-7">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-title text-text-0">Regole</h2>
          <button
            type="button"
            onClick={() => { setEditingRule(null); setPresetInstrument(null); setBuilderOpen(true); }}
            className="flex items-center gap-1.5 rounded-lg bg-agent px-3 py-1.5 text-body-strong text-bg-0 transition-colors hover:bg-agent/90"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Nuova regola
          </button>
        </div>
        {rules.length === 0 ? (
          <EmptyState
            headline="Nessuna regola attiva"
            copy="Crea la prima regola: scegli strumenti, condizione di ingresso e importo. L'Agent opererà solo entro i limiti del gruppo."
            actionLabel="Crea la prima regola"
            onAction={() => { setEditingRule(null); setBuilderOpen(true); }}
            icon={<Bot className="mb-4 h-10 w-10 text-agent opacity-60" aria-hidden />}
          />
        ) : (
          <div className="space-y-3">
            {rules.map((r, i) => (
              <RuleCard
                key={r.id}
                rule={r}
                index={i}
                group={groups.find((g) => g.id === r.groupId)}
                instruments={instruments}
                sltp={sltpMap[r.id] ?? DEFAULT_SLTP}
                autoExecute={autoExecute}
                lastExec={lastExecutionFor(r.id)}
                fromUsd={fromUsd}
                cur={cur}
                onToggle={(on) => {
                  agent.toggleRule(r.id, on);
                  toast(on
                    ? `Regola attivata — ${autoExecute ? 'eseguirà senza conferma' : 'chiederà conferma a ogni trigger'}`
                    : `Regola in pausa: "${r.name}"`,
                    { icon: <Bot className="h-4 w-4 text-agent" /> });
                }}
                onEdit={() => { setEditingRule(r); setPresetInstrument(null); setBuilderOpen(true); }}
                onDuplicate={() => handleDuplicateRule(r)}
                onDelete={() => {
                  agent.removeRule(r.id);
                  toast(`Regola "${r.name}" eliminata`);
                }}
              />
            ))}
          </div>
        )}
      </motion.section>

      {/* ── ROW 3: Coda conferme (condizionale) ─────────────────────── */}
      {pending.length > 0 && (
        <motion.section
          {...stagger(3)}
          className="card-surface density-pad col-span-12 border-l-2 border-l-warn p-5 lg:col-span-5"
        >
          <h2 className="mb-3 flex items-center gap-2 text-title text-text-0">
            <StatusDot variant="warn" />
            In attesa di conferma ({pending.length})
          </h2>
          <div className="space-y-3">
            {pending.map((e) => (
              <PendingCard
                key={e.id}
                exec={e}
                now={now}
                fromUsd={fromUsd}
                cur={cur}
                onConfirm={() => void agent.confirmExecution(e.id)}
                onIgnore={() => agent.ignoreExecution(e.id)}
              />
            ))}
          </div>
        </motion.section>
      )}

      {/* ── ROW 3: Log + tabella esecuzioni ─────────────────────────── */}
      <motion.section
        {...stagger(4)}
        className={cn('card-surface density-pad col-span-12 p-5', pending.length > 0 ? 'lg:col-span-7' : 'lg:col-span-12')}
      >
        <LogAndExecutions logs={logs} executions={executions} fromUsd={fromUsd} cur={cur} onExport={exportLog} />
      </motion.section>

      {/* ── ROW 4: Backtest-lite ────────────────────────────────────── */}
      <BacktestCard
        rules={rules}
        sltpMap={sltpMap}
        capitalLimitFor={(r) => groups.find((g) => g.id === r.groupId)?.capitalLimit ?? r.action.amount * 5}
      />

      {/* ── Modali ──────────────────────────────────────────────────── */}
      <RuleBuilder
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        agent={agent}
        groups={groups}
        instruments={instruments}
        editingRule={editingRule}
        presetInstrumentId={presetInstrument}
        groupMeta={groupMeta}
        displayCurrency={cur}
        fromUsd={fromUsd}
        toUsd={toUsd}
        onSaved={() => setSltpMap(loadSlTpMap())}
      />
      <GroupEditor
        open={groupEditorOpen}
        onOpenChange={setGroupEditorOpen}
        group={editingGroup}
        instruments={instruments}
        initialInstrumentIds={editingGroup ? groupInstruments(editingGroup.id) : []}
        displayCurrency={cur}
        fromUsd={fromUsd}
        toUsd={toUsd}
        onSave={handleGroupSave}
      />
      <KillSwitchDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        onEngage={() => {
          agent.engageKillSwitch();
          toast.error('KILL SWITCH attivato — tutte le regole interrotte');
        }}
      />

      {/* Presa visione auto-esecuzione (prima attivazione) */}
      <Dialog open={ackOpen} onOpenChange={setAckOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-agent" aria-hidden />
              Attiva esecuzione automatica
            </DialogTitle>
            <DialogDescription>
              Con l'auto-esecuzione le regole attive inviano ordini appena la condizione
              scatta, senza passare dalla coda di conferma.
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-loss/60 bg-loss/5 p-3">
            <Checkbox
              checked={ackChecked}
              onCheckedChange={(v) => setAckChecked(v === true)}
              className="mt-0.5"
            />
            <span className="text-caption text-text-0">
              Comprendo che le regole attive eseguiranno ordini senza chiedermi conferma,
              entro i limiti di capitale dei gruppi.
            </span>
          </label>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setAckOpen(false)}
              className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-0 transition-colors hover:bg-bg-2"
            >
              Annulla
            </button>
            <button
              type="button"
              disabled={!ackChecked}
              onClick={confirmAck}
              className="rounded-lg bg-agent px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-agent/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Attiva auto-esecuzione
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AgentMechanic({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-bg-1 p-3.5">
      <div className="flex items-center gap-2 text-body-strong text-text-0"><span className="text-agent">{icon}</span>{title}</div>
      <p className="mt-1.5 text-caption leading-relaxed text-text-2">{copy}</p>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   Sub-componenti della pagina
   ════════════════════════════════════════════════════════════════════ */

function StatTiles({
  activeRules, totalRules, execToday, maxOrders, groups, remainingBudget, pnl, fromUsd, cur,
}: {
  activeRules: number;
  totalRules: number;
  execToday: number;
  maxOrders: number;
  groups: AgentGroup[];
  remainingBudget: number;
  pnl: { pnl: number; pnlPct: number };
  fromUsd(n: number): number;
  cur: 'EUR' | 'USD';
}) {
  const usedTotal = groups.reduce((s, g) => s + g.usedCapital, 0);
  const limitTotal = groups.reduce((s, g) => s + g.capitalLimit, 0);
  const ringPct = maxOrders > 0 ? Math.min(1, execToday / maxOrders) : 0;
  const R = 15.5;
  const CIRC = 2 * Math.PI * R;

  return (
    <div className="col-span-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* Regole attive */}
      <motion.div {...stagger(0)} className="card-surface density-pad p-5">
        <div className="flex items-center justify-between">
          <span className="overline">Regole attive</span>
          <StatusDot variant={activeRules > 0 ? 'agent' : 'idle'} />
        </div>
        <div className="mt-2 font-display text-display-md text-text-0 tabular-nums">
          {activeRules}<span className="text-text-2">/{totalRules}</span>
        </div>
        <p className="mt-2 text-caption text-text-2">
          {activeRules > 0 ? 'in valutazione a ogni tick' : 'nessuna regola in esecuzione'}
        </p>
      </motion.div>

      {/* Ordini eseguiti oggi (progress ring) */}
      <motion.div {...stagger(1)} className="card-surface density-pad p-5">
        <div className="flex items-center justify-between">
          <span className="overline">Ordini eseguiti oggi</span>
          <StatusDot variant={execToday >= maxOrders ? 'warn' : 'agent'} />
        </div>
        <div className="mt-2 flex items-center gap-3">
          <svg width="40" height="40" viewBox="0 0 40 40" className="-rotate-90" aria-hidden>
            <circle cx="20" cy="20" r={R} fill="none" stroke="#1C2530" strokeWidth="4" />
            <motion.circle
              cx="20" cy="20" r={R} fill="none"
              stroke={execToday >= maxOrders ? '#F5A623' : '#9B8CFF'}
              strokeWidth="4" strokeLinecap="round"
              strokeDasharray={CIRC}
              initial={{ strokeDashoffset: CIRC }}
              animate={{ strokeDashoffset: CIRC * (1 - ringPct) }}
              transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
            />
          </svg>
          <div className="font-display text-display-md text-text-0 tabular-nums">
            {execToday}<span className="text-text-2">/{maxOrders}</span>
          </div>
        </div>
        <p className="mt-2 text-caption text-text-2">
          {execToday >= maxOrders ? 'limite giornaliero raggiunto' : 'rate-limit giornaliero'}
        </p>
      </motion.div>

      {/* Budget allocato (stacked bar per gruppo) */}
      <motion.div {...stagger(2)} className="card-surface density-pad p-5">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 overline">Budget allocato<TooltipProvider delayDuration={150}><Tooltip><TooltipTrigger asChild><button type="button" aria-label="Origine del budget allocato" className="text-text-2 hover:text-text-1"><Info className="h-3.5 w-3.5" aria-hidden /></button></TooltipTrigger><TooltipContent className="max-w-80"><p className="text-caption">Somma dei limiti dei gruppi creati dall’utente. Usato = somma del capitale impiegato; residuo = somma di max(limite − usato, 0).</p>{groups.length ? <ul className="mt-2 space-y-1 text-micro text-text-2">{groups.map((group) => <li key={group.id}>{group.name}: {formatCurrency(fromUsd(group.usedCapital), cur, 0)} / {formatCurrency(fromUsd(group.capitalLimit), cur, 0)}</li>)}</ul> : <p className="mt-2 text-micro text-text-2">Nessun gruppo: origine vuota, budget zero.</p>}</TooltipContent></Tooltip></TooltipProvider></span>
          <StatusDot variant="agent" />
        </div>
        <div className="mt-2 font-display text-display-md text-text-0 tabular-nums">
          {formatCurrency(fromUsd(usedTotal), cur, 0)}
          <span className="text-body text-text-2"> / {formatCurrency(fromUsd(limitTotal), cur, 0)}</span>
        </div>
        <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
          {groups.map((g, i) => {
            const w = limitTotal > 0 ? (g.usedCapital / limitTotal) * 100 : 0;
            return (
              <motion.div
                key={g.id}
                className={i % 2 === 0 ? 'bg-agent' : 'bg-agent/50'}
                initial={{ width: 0 }}
                animate={{ width: `${w}%` }}
                transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
              />
            );
          })}
        </div>
        <p className="mt-2 text-caption text-text-2">
          residuo {formatCurrency(fromUsd(remainingBudget), cur, 0)}
        </p>
      </motion.div>

      {/* P&L Agent */}
      <motion.div {...stagger(3)} className="card-surface density-pad p-5">
        <div className="flex items-center justify-between">
          <span className="overline">P&L Agent</span>
          <StatusDot variant={pnl.pnl >= 0 ? 'ok' : 'error'} />
        </div>
        <div
          className={cn(
            'mt-2 font-display text-display-md tabular-nums',
            pnl.pnl >= 0 ? 'text-gain' : 'text-loss',
          )}
        >
          {formatSignedCurrency(fromUsd(pnl.pnl), cur)}
        </div>
        <p className="mt-2 text-caption text-text-2">
          {formatPercent(pnl.pnlPct)} mark-to-market sulle operazioni eseguite
        </p>
      </motion.div>
    </div>
  );
}

/* ── Group card ────────────────────────────────────────────────────── */
function GroupCard({
  group, index, rules, instrumentIds, instruments, pnl, fromUsd, cur, onEdit, onDelete,
}: {
  group: AgentGroup;
  index: number;
  rules: AgentRule[];
  instrumentIds: number[];
  instruments: { instrumentId: number; symbol: string }[];
  pnl: number;
  fromUsd(n: number): number;
  cur: 'EUR' | 'USD';
  onEdit(): void;
  onDelete(): void;
}) {
  const [armingDelete, setArmingDelete] = useState(false);
  const pct = group.capitalLimit > 0 ? (group.usedCapital / group.capitalLimit) * 100 : 0;
  const atLimit = pct >= 100;
  const nearLimit = pct >= 80 && !atLimit;
  const barColor = atLimit ? 'bg-loss' : nearLimit ? 'bg-warn' : 'bg-agent';

  useEffect(() => {
    if (!armingDelete) return;
    const t = setTimeout(() => setArmingDelete(false), 3000);
    return () => clearTimeout(t);
  }, [armingDelete]);

  return (
    <motion.div
      {...stagger(index)}
      className={cn(
        'card-surface density-pad p-4 transition-shadow',
        atLimit && 'border-loss/50 shadow-[0_0_10px_#F4556B22]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-body-strong text-text-0">{group.name}</h3>
          <p className="text-caption text-text-2">
            {rules.length} {rules.length === 1 ? 'regola' : 'regole'} · P&amp;L{' '}
            <span className={pnl >= 0 ? 'text-gain' : 'text-loss'}>
              {formatSignedCurrency(fromUsd(pnl), cur)}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Modifica gruppo ${group.name}`}
            className="rounded-md p-1.5 text-text-2 transition-colors hover:bg-bg-2 hover:text-text-0"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => (armingDelete ? onDelete() : setArmingDelete(true))}
            aria-label={`Elimina gruppo ${group.name}`}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              armingDelete ? 'bg-loss/15 text-loss' : 'text-text-2 hover:bg-bg-2 hover:text-loss',
            )}
          >
            {armingDelete
              ? <span className="px-1 text-micro font-medium">Conferma?</span>
              : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </div>
      </div>

      {instrumentIds.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {instrumentIds.slice(0, 8).map((id) => {
            const inst = instruments.find((i) => i.instrumentId === id);
            if (!inst) return null;
            return (
              <span
                key={id}
                className="flex items-center gap-1 rounded-full border border-hairline bg-bg-2 px-1.5 py-0.5 text-micro text-text-1"
              >
                <InstrumentAvatar symbol={inst.symbol} size={14} />
                <span className="font-mono">{inst.symbol}</span>
              </span>
            );
          })}
          {instrumentIds.length > 8 && (
            <span className="rounded-full bg-bg-2 px-1.5 py-0.5 text-micro text-text-2">
              +{instrumentIds.length - 8}
            </span>
          )}
        </div>
      )}

      <div className="mt-3">
        <div className="flex items-center justify-between text-caption">
          <span className="text-text-1 tabular-nums">
            {formatCurrency(fromUsd(group.usedCapital), cur, 0)} / {formatCurrency(fromUsd(group.capitalLimit), cur, 0)} investiti
          </span>
          <span className={cn('tabular-nums', atLimit ? 'text-loss' : nearLimit ? 'text-warn' : 'text-text-2')}>
            {pct.toFixed(0)}%
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
          <motion.div
            className={cn('h-full rounded-full', barColor)}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, pct)}%` }}
            transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
          />
        </div>
        {atLimit && (
          <p className="mt-1.5 text-caption font-medium text-loss">
            Limite raggiunto — nessun nuovo ordine su questo gruppo
          </p>
        )}
      </div>
    </motion.div>
  );
}

/* ── Rule card ─────────────────────────────────────────────────────── */
function RuleCard({
  rule, index, group, instruments, sltp, autoExecute, lastExec, fromUsd, cur,
  onToggle, onEdit, onDuplicate, onDelete,
}: {
  rule: AgentRule;
  index: number;
  group?: AgentGroup;
  instruments: { instrumentId: number; symbol: string }[];
  sltp: SlTp;
  autoExecute: boolean;
  lastExec?: AgentExecution;
  fromUsd(n: number): number;
  cur: 'EUR' | 'USD';
  onToggle(on: boolean): void;
  onEdit(): void;
  onDuplicate(): void;
  onDelete(): void;
}) {
  const [armingDelete, setArmingDelete] = useState(false);

  useEffect(() => {
    if (!armingDelete) return;
    const t = setTimeout(() => setArmingDelete(false), 3000);
    return () => clearTimeout(t);
  }, [armingDelete]);

  const symbols = rule.instrumentIds
    .map((id) => instruments.find((i) => i.instrumentId === id)?.symbol)
    .filter(Boolean) as string[];

  return (
    <motion.div
      layout="position"
      {...stagger(index)}
      className={cn(
        'card-surface density-pad border-l-[3px] border-l-agent p-4',
        !rule.enabled && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body-strong text-text-0">{rule.name}</h3>
            {group && (
              <span className="rounded-full border border-hairline bg-bg-2 px-2 py-0.5 text-micro text-text-1">
                {group.name}
              </span>
            )}
            {rule.enabled ? (
              autoExecute ? (
                <span className="flex items-center gap-1 rounded-full bg-agent/15 px-2 py-0.5 text-micro font-medium text-agent">
                  <Zap className="h-3 w-3" aria-hidden />
                  Automatica
                </span>
              ) : (
                <span className="rounded-full bg-warn/15 px-2 py-0.5 text-micro font-medium text-warn">
                  Con conferma
                </span>
              )
            ) : (
              <span className="rounded-full bg-bg-3 px-2 py-0.5 text-micro font-medium text-text-2">
                In pausa
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {symbols.slice(0, 4).map((s) => (
              <span key={s} className="flex items-center gap-1 rounded-md bg-bg-2 px-1.5 py-0.5">
                <InstrumentAvatar symbol={s} size={14} />
                <span className="font-mono text-micro text-text-0">{s}</span>
              </span>
            ))}
            {symbols.length > 4 && (
              <span className="rounded-md bg-bg-2 px-1.5 py-0.5 text-micro text-text-2">+{symbols.length - 4}</span>
            )}
            <span className="rounded-md border border-agent/30 bg-agent/10 px-1.5 py-0.5 font-mono text-micro text-agent">
              {conditionChip(rule.condition)}
            </span>
          </div>

          <p className="mt-2 text-caption text-text-1">
            Compra {formatCurrency(fromUsd(rule.action.amount), cur, 0)} · SL −{sltp.stopLossPct}% · TP +{sltp.takeProfitPct}%
          </p>
          <p className="mt-1 text-caption text-text-2">
            Ultima esecuzione: {lastExec ? formatDateTime(lastExec.timestamp) : 'mai'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={rule.enabled}
            onCheckedChange={onToggle}
            className="data-[state=checked]:bg-agent"
            aria-label={`Attiva/disattiva regola ${rule.name}`}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Azioni per ${rule.name}`}
                className="rounded-md p-1.5 text-text-2 transition-colors hover:bg-bg-2 hover:text-text-0"
              >
                <EllipsisVertical className="h-4 w-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Modifica
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy className="h-3.5 w-3.5" aria-hidden /> Duplica
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => (armingDelete ? onDelete() : setArmingDelete(true))}
                className="text-loss focus:text-loss"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {armingDelete ? 'Conferma eliminazione' : 'Elimina'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </motion.div>
  );
}

/* ── Pending confirmation card ─────────────────────────────────────── */
function PendingCard({
  exec, now, fromUsd, cur, onConfirm, onIgnore,
}: {
  exec: AgentExecution;
  now: number;
  fromUsd(n: number): number;
  cur: 'EUR' | 'USD';
  onConfirm(): void;
  onIgnore(): void;
}) {
  const remaining = Math.max(0, exec.timestamp + PENDING_TTL_MS - now);
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
      className="rounded-lg border border-warn/40 bg-warn/5 p-3"
    >
      <div className="flex items-center gap-2">
        <InstrumentAvatar symbol={exec.symbol} size={24} />
        <div className="min-w-0 flex-1">
          <p className="text-body-strong text-text-0">
            Compra {formatCurrency(fromUsd(exec.amount), cur, 0)} di{' '}
            <span className="font-mono">{exec.symbol}</span>
          </p>
          <p className="truncate text-caption text-text-1">
            {exec.reason ?? 'Condizione soddisfatta'} · regola "{exec.ruleName}"
          </p>
        </div>
        <span className="shrink-0 font-mono text-micro text-warn tabular-nums">
          scade tra {mm}:{String(ss).padStart(2, '0')}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="flex items-center gap-1 rounded-lg bg-gain px-3 py-1.5 text-micro font-semibold text-bg-0 transition-colors hover:bg-gain/90"
        >
          <Play className="h-3 w-3" aria-hidden />
          Esegui
        </button>
        <button
          type="button"
          onClick={onIgnore}
          className="rounded-lg border border-hairline-strong px-3 py-1.5 text-micro font-medium text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
        >
          Ignora
        </button>
        <span className="ml-auto font-mono text-micro text-text-2">
          @ {formatPrice(exec.price)}
        </span>
      </div>
    </motion.div>
  );
}

/* ── Log + tabella esecuzioni ──────────────────────────────────────── */
type LogFilter = 'all' | 'agent' | 'errors' | 'system';

const LOG_FILTERS: { key: LogFilter; label: string }[] = [
  { key: 'all', label: 'Tutti' },
  { key: 'agent', label: 'Agent' },
  { key: 'errors', label: 'Errori' },
  { key: 'system', label: 'Sistema' },
];

const EXEC_STATUS: Record<AgentExecution['status'], { label: string; cls: string }> = {
  executed: { label: 'Eseguito', cls: 'bg-gain-dim text-gain' },
  pending_confirm: { label: 'In attesa', cls: 'bg-warn/15 text-warn' },
  skipped: { label: 'Saltato', cls: 'bg-bg-3 text-text-1' },
  failed: { label: 'Fallito', cls: 'bg-loss-dim text-loss' },
};

function LogAndExecutions({
  logs, executions, fromUsd, cur, onExport,
}: {
  logs: { id: string; timestamp: number; level: LogLevel; message: string }[];
  executions: AgentExecution[];
  fromUsd(n: number): number;
  cur: 'EUR' | 'USD';
  onExport(): void;
}) {
  const [filter, setFilter] = useState<LogFilter>('all');
  const [autoScroll, setAutoScroll] = useState(true);

  const filteredLogs = useMemo(() => {
    switch (filter) {
      case 'agent': return logs.filter((l) => l.level === 'agent');
      case 'errors': return logs.filter((l) => l.level === 'error');
      case 'system': return logs.filter((l) => l.level === 'info' || l.level === 'success' || l.level === 'warn');
      default: return logs;
    }
  }, [logs, filter]);

  const columns = useMemo<DataTableColumn<AgentExecution>[]>(() => [
    {
      key: 'time',
      header: 'Ora',
      sortValue: (e) => e.timestamp,
      cell: (e) => <span className="font-mono text-caption text-text-1">{formatDateTime(e.timestamp)}</span>,
      width: '110px',
    },
    {
      key: 'symbol',
      header: 'Strumento',
      sortValue: (e) => e.symbol,
      cell: (e) => (
        <span className="flex items-center gap-1.5">
          <InstrumentAvatar symbol={e.symbol} size={20} />
          <span className="font-mono text-ticker text-text-0">{e.symbol}</span>
        </span>
      ),
    },
    {
      key: 'rule',
      header: 'Regola',
      sortValue: (e) => e.ruleName,
      cell: (e) => <span className="text-caption text-text-1">{e.ruleName}</span>,
    },
    {
      key: 'amount',
      header: 'Importo',
      align: 'right',
      sortValue: (e) => e.amount,
      cell: (e) => <span className="tabular-nums text-text-0">{formatCurrency(fromUsd(e.amount), cur, 0)}</span>,
    },
    {
      key: 'price',
      header: 'Prezzo',
      align: 'right',
      sortValue: (e) => e.price,
      cell: (e) => <span className="font-mono tabular-nums text-text-1">{formatPrice(e.price)}</span>,
    },
    {
      key: 'status',
      header: 'Stato',
      sortValue: (e) => e.status,
      cell: (e) => (
        <span className={cn('rounded-full px-2 py-0.5 text-micro font-medium', EXEC_STATUS[e.status].cls)}>
          {EXEC_STATUS[e.status].label}
        </span>
      ),
    },
    {
      key: 'reason',
      header: 'Note',
      cell: (e) => <span className="text-caption text-text-2">{e.reason ?? '—'}</span>,
    },
  ], [fromUsd, cur]);

  return (
    <Tabs defaultValue="log">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="log">Log esecuzioni</TabsTrigger>
          <TabsTrigger value="exec">Tabella esecuzioni ({executions.length})</TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-micro text-text-2">
            Auto-scroll
            <Switch checked={autoScroll} onCheckedChange={setAutoScroll} aria-label="Auto-scroll log" />
          </label>
          <button
            type="button"
            onClick={onExport}
            className="flex items-center gap-1 rounded-lg border border-hairline px-2.5 py-1.5 text-micro font-medium text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Esporta log
          </button>
        </div>
      </div>

      <TabsContent value="log" className="mt-3">
        <div className="mb-2 flex gap-1.5">
          {LOG_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-full px-2.5 py-1 text-micro font-medium transition-colors',
                filter === f.key ? 'bg-agent/15 text-agent' : 'bg-bg-2 text-text-2 hover:text-text-1',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <LogStream entries={filteredLogs} maxHeight={280} autoScroll={autoScroll} />
      </TabsContent>

      <TabsContent value="exec" className="mt-3">
        <DataTable
          columns={columns}
          rows={executions}
          rowKey={(e) => e.id}
          defaultSortKey="time"
          defaultSortDir="desc"
          emptyMessage="Nessuna esecuzione registrata."
        />
      </TabsContent>
    </Tabs>
  );
}
