/**
 * Motore regole "eToro Agent".
 *
 * - Valuta le condizioni a ogni tick di quote: calo % dalla media, soglia
 *   prezzo, RSI-14 semplice.
 * - Vincoli: limite di capitale per gruppo, cooldown per regola, max ordini/giorno,
 *   kill switch globale.
 * - Live + Write: invia ordini reali via provider. Live read-only o senza
 *   auto-esecuzione: crea esecuzioni `pending_confirm` da confermare a mano.
 * - Scrive sul log condiviso (livello 'agent').
 * - Persiste regole/gruppi su localStorage.
 */
import type { DataProvider } from '../data/DataProvider';
import type {
  AgentExecution,
  AgentGroup,
  AgentRule,
  DataMode,
  LogLevel,
  Quote,
} from '../data/types';

const STORAGE_KEY = 'torino.agent.v1';
const PRICE_WINDOW = 64; // campioni per media/RSI
const DEFAULT_MAX_ORDERS_PER_DAY = 5;

export interface AgentEngineHooks {
  getProvider(): DataProvider | null;
  getMode(): DataMode;
  /** true solo in Live con permessi write. */
  canWrite(): boolean;
  log(level: LogLevel, message: string): void;
}

interface PersistedState {
  groups: AgentGroup[];
  rules: AgentRule[];
  masterEnabled: boolean;
  autoExecute: boolean;
  maxOrdersPerDay: number;
}

type UpdateListener = () => void;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** RSI-14 semplice su una serie di prezzi (ultimo = più recente). */
export function computeRsi(prices: number[], period = 14): number | null {
  if (prices.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  const slice = prices.slice(-(period + 1));
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function defaultState(): PersistedState {
  return { groups: [], rules: [], masterEnabled: false, autoExecute: false, maxOrdersPerDay: DEFAULT_MAX_ORDERS_PER_DAY };
}

function isLegacySeedState(state: PersistedState): boolean {
  const groupIds = new Set(state.groups.map((group) => group.id));
  const ruleIds = new Set(state.rules.map((rule) => rule.id));
  return state.groups.length === 2
    && state.rules.length === 3
    && groupIds.has('grp-importantissimo')
    && groupIds.has('grp-lungo-periodo')
    && ruleIds.has('rule-compra-i-cali')
    && ruleIds.has('rule-btc-sotto-soglia')
    && ruleIds.has('rule-rsi-etf');
}

export class AgentEngine {
  private hooks: AgentEngineHooks;
  private groups: AgentGroup[];
  private rules: AgentRule[];
  private executions: AgentExecution[] = [];
  private priceHistory = new Map<number, number[]>();
  private listeners = new Set<UpdateListener>();
  masterEnabled: boolean;
  autoExecute: boolean;
  maxOrdersPerDay: number;
  killSwitchEngaged = false;

  constructor(hooks: AgentEngineHooks) {
    this.hooks = hooks;
    const persisted = this.load();
    const state = persisted ?? defaultState();
    this.groups = state.groups;
    this.rules = state.rules;
    this.masterEnabled = state.masterEnabled;
    this.autoExecute = state.autoExecute;
    this.maxOrdersPerDay = state.maxOrdersPerDay;
  }

  /* ── Persistenza ─────────────────────────────────────────────────── */
  private load(): PersistedState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw) as PersistedState;
      return isLegacySeedState(state) ? defaultState() : state;
    } catch { return null; }
  }

  private persist() {
    try {
      const state: PersistedState = {
        groups: this.groups, rules: this.rules,
        masterEnabled: this.masterEnabled, autoExecute: this.autoExecute,
        maxOrdersPerDay: this.maxOrdersPerDay,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* ignora */ }
  }

  /* ── Sottoscrizioni UI ───────────────────────────────────────────── */
  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.persist();
    for (const l of this.listeners) l();
  }

  /* ── Getters (snapshot per React) ────────────────────────────────── */
  getGroups(): AgentGroup[] { return this.groups.map((g) => ({ ...g })); }
  getRules(): AgentRule[] { return this.rules.map((r) => ({ ...r, instrumentIds: [...r.instrumentIds] })); }
  getExecutions(): AgentExecution[] { return [...this.executions]; }
  getPendingConfirmations(): AgentExecution[] {
    return this.executions.filter((e) => e.status === 'pending_confirm');
  }
  getActiveRulesCount(): number { return this.rules.filter((r) => r.enabled).length; }
  getExecutionsToday(): number {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return this.executions.filter((e) => e.timestamp >= start.getTime() && e.status === 'executed').length;
  }
  getRemainingBudget(): number {
    return this.groups.reduce((s, g) => s + Math.max(0, g.capitalLimit - g.usedCapital), 0);
  }

  /* ── Mutazioni API (usate dalla pagina Agent e dagli inline CTA) ─── */
  setMasterEnabled(enabled: boolean) {
    this.masterEnabled = enabled;
    this.hooks.log('agent', enabled ? 'Agent attivato — le regole valuteranno i prossimi tick.' : 'Agent in pausa — nessuna esecuzione automatica.');
    this.notify();
  }

  setAutoExecute(auto: boolean) {
    this.autoExecute = auto;
    this.hooks.log('agent', auto
      ? 'Auto-esecuzione attiva — le regole eseguiranno senza conferma.'
      : 'Auto-esecuzione disattivata — ogni trigger richiederà conferma.');
    this.notify();
  }

  engageKillSwitch() {
    this.killSwitchEngaged = true;
    this.masterEnabled = false;
    this.hooks.log('error', 'KILL SWITCH attivato — tutte le regole interrotte. Le posizioni aperte NON verranno chiuse automaticamente.');
    this.notify();
  }

  disengageKillSwitch() {
    this.killSwitchEngaged = false;
    this.hooks.log('agent', 'Kill switch disattivato. Riattiva l\'Agent per riprendere le esecuzioni.');
    this.notify();
  }

  addGroup(group: Omit<AgentGroup, 'id' | 'usedCapital'>): AgentGroup {
    const g: AgentGroup = { ...group, id: uid('grp'), usedCapital: 0 };
    this.groups.push(g);
    this.notify();
    return g;
  }

  updateGroup(id: string, patch: Partial<Omit<AgentGroup, 'id'>>) {
    const g = this.groups.find((x) => x.id === id);
    if (g) Object.assign(g, patch);
    this.notify();
  }

  removeGroup(id: string) {
    this.groups = this.groups.filter((g) => g.id !== id);
    this.rules = this.rules.filter((r) => r.groupId !== id);
    this.notify();
  }

  addRule(rule: Omit<AgentRule, 'id' | 'executionsToday'>): AgentRule {
    const r: AgentRule = { ...rule, id: uid('rule'), executionsToday: 0 };
    this.rules.push(r);
    this.hooks.log('agent', `Regola creata: "${r.name}" nel gruppo ${this.groupName(r.groupId)}.`);
    this.notify();
    return r;
  }

  updateRule(id: string, patch: Partial<Omit<AgentRule, 'id'>>) {
    const r = this.rules.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
    this.notify();
  }

  removeRule(id: string) {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.notify();
  }

  toggleRule(id: string, enabled: boolean) {
    const r = this.rules.find((x) => x.id === id);
    if (!r) return;
    r.enabled = enabled;
    this.hooks.log('agent', enabled
      ? `Regola attivata: "${r.name}" — eseguirà senza conferma.`
      : `Regola in pausa: "${r.name}".`);
    this.notify();
  }

  /* ── Valutazione condizioni sui tick ─────────────────────────────── */
  handleQuotes(quotes: Quote[]) {
    for (const q of quotes) {
      let hist = this.priceHistory.get(q.instrumentId);
      if (!hist) { hist = []; this.priceHistory.set(q.instrumentId, hist); }
      hist.push(q.last);
      if (hist.length > PRICE_WINDOW) hist.shift();
    }
    if (!this.masterEnabled || this.killSwitchEngaged) return;
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      this.evaluateRule(rule, quotes);
    }
  }

  private groupName(id: string): string {
    return this.groups.find((g) => g.id === id)?.name ?? id;
  }

  private evaluateRule(rule: AgentRule, quotes: Quote[]) {
    // Cooldown
    if (rule.lastTriggeredAt && Date.now() - rule.lastTriggeredAt < rule.cooldownMinutes * 60_000) return;
    // Max ordini/giorno globale
    if (this.getExecutionsToday() >= this.maxOrdersPerDay) return;

    for (const iid of rule.instrumentIds) {
      const quote = quotes.find((q) => q.instrumentId === iid);
      if (!quote) continue;
      if (!this.conditionMet(rule, iid, quote.last)) continue;
      void this.trigger(rule, quote);
      break; // un trigger per tick per regola
    }
  }

  private conditionMet(rule: AgentRule, instrumentId: number, price: number): boolean {
    const c = rule.condition;
    const hist = this.priceHistory.get(instrumentId) ?? [];
    switch (c.type) {
      case 'price_below': return price < c.value;
      case 'price_above': return price > c.value;
      case 'drop_from_avg': {
        if (hist.length < 10) return false;
        const avg = hist.reduce((s, p) => s + p, 0) / hist.length;
        return ((avg - price) / avg) * 100 >= c.value;
      }
      case 'rsi_below': {
        const rsi = computeRsi(hist);
        return rsi != null && rsi < c.value;
      }
    }
  }

  private async trigger(rule: AgentRule, quote: Quote) {
    const group = this.groups.find((g) => g.id === rule.groupId);
    const mode = this.hooks.getMode();
    rule.lastTriggeredAt = Date.now();

    // Limite capitale gruppo
    if (group && group.usedCapital + rule.action.amount > group.capitalLimit) {
      this.record(rule, quote, 'skipped', mode, `Budget gruppo "${group.name}" esaurito (${group.capitalLimit - group.usedCapital}$ residui).`);
      this.notify();
      return;
    }

    const needsConfirmation = !this.autoExecute || (mode === 'live' && !this.hooks.canWrite());
    if (needsConfirmation) {
      this.record(rule, quote, 'pending_confirm', mode,
        mode === 'live' && !this.hooks.canWrite()
          ? 'Chiavi in sola lettura — conferma manuale richiesta.'
          : 'In attesa di conferma utente.');
      this.hooks.log('agent', `Trigger "${rule.name}" su ${quote.instrumentId} — in attesa di conferma.`);
      this.notify();
      return;
    }

    await this.executeOrder(rule, quote, mode);
  }

  private record(rule: AgentRule, quote: Quote, status: AgentExecution['status'], mode: DataMode, reason?: string): AgentExecution {
    const inst = this.hooks.getProvider()?.listInstruments().find((i) => i.instrumentId === quote.instrumentId);
    const exec: AgentExecution = {
      id: uid('exec'),
      ruleId: rule.id,
      ruleName: rule.name,
      groupId: rule.groupId,
      instrumentId: quote.instrumentId,
      symbol: inst?.symbol ?? `#${quote.instrumentId}`,
      timestamp: Date.now(),
      amount: rule.action.amount,
      price: quote.last,
      status,
      mode,
      reason,
    };
    this.executions.unshift(exec);
    if (this.executions.length > 200) this.executions.length = 200;
    return exec;
  }

  private async executeOrder(rule: AgentRule, quote: Quote, mode: DataMode) {
    const provider = this.hooks.getProvider();
    if (!provider) {
      this.record(rule, quote, 'failed', mode, 'Connessione Live non disponibile.');
      this.hooks.log('error', `Agent: ordine bloccato per "${rule.name}": connessione Live non disponibile.`);
      this.notify();
      return;
    }
    const result = await provider.placeMarketOrder({
      instrumentId: quote.instrumentId,
      isBuy: true,
      amount: rule.action.amount,
      leverage: rule.action.leverage,
    });
    if (result.ok) {
      rule.executionsToday += 1;
      const group = this.groups.find((g) => g.id === rule.groupId);
      if (group) group.usedCapital += rule.action.amount;
      this.record(rule, quote, 'executed', mode);
      this.hooks.log('agent', `Agent: BUY ${rule.action.amount}$ su strumento #${quote.instrumentId} @ ${quote.last.toFixed(2)} — regola "${rule.name}".`);
    } else {
      this.record(rule, quote, 'failed', mode, result.message);
      this.hooks.log('error', `Agent: ordine fallito per "${rule.name}": ${result.message ?? 'errore sconosciuto'}`);
    }
    this.notify();
  }

  /** Conferma manuale di un'esecuzione pending (CTA inline). */
  async confirmExecution(execId: string) {
    const exec = this.executions.find((e) => e.id === execId && e.status === 'pending_confirm');
    if (!exec) return;
    const rule = this.rules.find((r) => r.id === exec.ruleId);
    const provider = this.hooks.getProvider();
    if (!provider) {
      exec.status = 'failed';
      exec.reason = 'Connessione Live non disponibile.';
      this.hooks.log('error', `Conferma bloccata per ${exec.symbol}: connessione Live non disponibile.`);
      this.notify();
      return;
    }
    const result = await provider.placeMarketOrder({
      instrumentId: exec.instrumentId,
      isBuy: true,
      amount: exec.amount,
      leverage: rule?.action.leverage ?? 1,
    });
    if (result.ok) {
      exec.status = 'executed';
      const group = this.groups.find((g) => g.id === exec.groupId);
      if (group) group.usedCapital += exec.amount;
      this.hooks.log('agent', `Confermato manualmente: BUY ${exec.symbol} · $${exec.amount}.`);
    } else {
      exec.status = 'failed';
      exec.reason = result.message;
      this.hooks.log('error', `Conferma fallita per ${exec.symbol}: ${result.message ?? 'errore'}`);
    }
    this.notify();
  }

  /** Ignora un'esecuzione pending. */
  ignoreExecution(execId: string) {
    const exec = this.executions.find((e) => e.id === execId && e.status === 'pending_confirm');
    if (!exec) return;
    exec.status = 'skipped';
    exec.reason = 'Ignorato dall\'utente.';
    this.hooks.log('info', `Trigger ignorato: ${exec.symbol} (${exec.ruleName}).`);
    this.notify();
  }
}
