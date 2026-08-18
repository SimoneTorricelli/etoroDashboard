export type StrategyRisk = 'basso' | 'medio' | 'alto' | 'molto-alto';

export type StrategyRebalance = 'giornaliero' | 'settimanale' | 'mensile';

export type StrategyPortfolioStatus = 'bozza' | 'pronto' | 'simulato' | 'da inizializzare' | 'attivo' | 'in pausa';

export interface StrategyAllocation {
  symbol: string;
  weightPct: number;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  tagline: string;
  description: string;
  risk: StrategyRisk;
  accent: 'gain' | 'info' | 'agent' | 'warn' | 'loss';
  defaultAgentName: string;
  defaultBudgetUsd: number;
  defaultMinOrderUsd: number;
  defaultMaxOrderUsd: number;
  defaultMaxPositions: number;
  defaultCashReservePct: number;
  defaultMaxOrdersPerDay: number;
  defaultRebalance: StrategyRebalance;
  objective: string;
  horizon: string;
  allocations: StrategyAllocation[];
  /** Scenario di stress dichiarato, non previsione. */
  stressLossPct: number;
}

export interface StrategyPortfolioConfig {
  id: string;
  templateId: string;
  name: string;
  budgetUsd: number;
  minOrderUsd: number;
  maxOrderUsd: number;
  maxPositions: number;
  cashReservePct: number;
  maxOrdersPerDay: number;
  rebalance: StrategyRebalance;
  status: StrategyPortfolioStatus;
  etoroAgentPortfolioId?: string;
  mirrorId?: string;
  virtualBalanceUsd?: number;
  tokenAvailable?: boolean;
  activatedAt?: number;
  initializedAt?: number;
  /** Ricevute non sensibili: servono a verificare eseguiti e residui dopo un refresh. */
  initializationOrders?: StrategyOrderReceipt[];
  lastInitializationCheckAt?: number;
  simulation?: {
    /** Versione del resolver e del modello di ribilanciamento usati. */
    modelVersion?: number;
    returnPct: number;
    maxDrawdownPct: number;
    volatilityPct: number;
    p10Pct: number;
    p50Pct: number;
    p90Pct: number;
    /** Parametri giornalieri usati per proiettare orizzonti diversi. */
    dailyMeanLog?: number;
    dailyVolatilityLog?: number;
    annualizedMedianPct?: number;
    coveragePct: number;
    observations: number;
    /** true se una parte dei pesi è stata mantenuta costante per assenza di storico. */
    partial?: boolean;
    assets?: Array<{
      symbol: string;
      weightPct: number;
      status: 'coperto' | 'senza-storico' | 'non-trovato' | 'errore-dati' | 'cash';
      observations: number;
    }>;
    asOf: number;
  };
  createdAt: number;
  updatedAt: number;
}

export type StrategyOrderReceiptStatus = 'accepted' | 'pending' | 'partially-filled' | 'filled' | 'rejected' | 'failed';

export interface StrategyOrderReceipt {
  symbol: string;
  instrumentId: number;
  requestedVirtualAmountUsd: number;
  orderId?: number;
  referenceId: string;
  status: StrategyOrderReceiptStatus;
  statusLabel: string;
  filledVirtualAmountUsd: number;
  positionIds: number[];
  error?: string;
}

export interface StrategyValidation {
  valid: boolean;
  errors: string[];
}

const STORAGE_KEY = 'torino.strategy-portfolios.v1';
export const STRATEGY_SIMULATION_MODEL_VERSION = 3;

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'dividends',
    name: 'Dividendi',
    tagline: 'Flussi e bassa rotazione',
    description: 'Una base orientata a strumenti maturi e distribuzioni, con limiti stretti per singola posizione.',
    risk: 'medio',
    accent: 'gain',
    defaultAgentName: 'Dividend',
    defaultBudgetUsd: 0,
    defaultMinOrderUsd: 50,
    defaultMaxOrderUsd: 250,
    defaultMaxPositions: 10,
    defaultCashReservePct: 10,
    defaultMaxOrdersPerDay: 4,
    defaultRebalance: 'mensile',
    objective: 'Flussi distribuiti e qualità', horizon: '3–5 anni', stressLossPct: 25,
    allocations: [{ symbol: 'SCHD', weightPct: 35 }, { symbol: 'VIG', weightPct: 25 }, { symbol: 'KO', weightPct: 15 }, { symbol: 'PG', weightPct: 15 }, { symbol: 'JPM', weightPct: 10 }],
  },
  {
    id: 'defensive',
    name: 'Conservativa',
    tagline: 'Diversificazione e controllo',
    description: 'Pensata per limitare concentrazione e turnover, mantenendo una riserva di liquidità.',
    risk: 'basso',
    accent: 'info',
    defaultAgentName: 'Difesa',
    defaultBudgetUsd: 0,
    defaultMinOrderUsd: 50,
    defaultMaxOrderUsd: 200,
    defaultMaxPositions: 12,
    defaultCashReservePct: 20,
    defaultMaxOrdersPerDay: 3,
    defaultRebalance: 'mensile',
    objective: 'Preservazione e volatilità ridotta', horizon: '3–7 anni', stressLossPct: 18,
    allocations: [{ symbol: 'SPY', weightPct: 30 }, { symbol: 'TLT', weightPct: 25 }, { symbol: 'GLD', weightPct: 20 }, { symbol: 'VIG', weightPct: 15 }, { symbol: 'Cash', weightPct: 10 }],
  },
  {
    id: 'growth',
    name: 'Crescita',
    tagline: 'Più esposizione, più oscillazione',
    description: 'Portafoglio orientato alla crescita con un tetto per posizione e ribilanciamento regolare.',
    risk: 'alto',
    accent: 'agent',
    defaultAgentName: 'Crescita',
    defaultBudgetUsd: 0,
    defaultMinOrderUsd: 50,
    defaultMaxOrderUsd: 225,
    defaultMaxPositions: 10,
    defaultCashReservePct: 10,
    defaultMaxOrdersPerDay: 6,
    defaultRebalance: 'settimanale',
    objective: 'Crescita del capitale', horizon: '5+ anni', stressLossPct: 40,
    allocations: [{ symbol: 'QQQ', weightPct: 30 }, { symbol: 'AAPL', weightPct: 20 }, { symbol: 'MSFT', weightPct: 20 }, { symbol: 'NVDA', weightPct: 20 }, { symbol: 'AMZN', weightPct: 10 }],
  },
  {
    id: 'crypto',
    name: 'Crypto',
    tagline: 'Volatilità sotto controllo',
    description: 'Un contenitore dedicato agli asset crypto, con ordine massimo più basso e leva disattivata.',
    risk: 'molto-alto',
    accent: 'warn',
    defaultAgentName: 'Crypto',
    defaultBudgetUsd: 0,
    defaultMinOrderUsd: 25,
    defaultMaxOrderUsd: 150,
    defaultMaxPositions: 6,
    defaultCashReservePct: 20,
    defaultMaxOrdersPerDay: 5,
    defaultRebalance: 'settimanale',
    objective: 'Esposizione crypto diversificata', horizon: '4+ anni', stressLossPct: 65,
    allocations: [{ symbol: 'BTC', weightPct: 50 }, { symbol: 'ETH', weightPct: 30 }, { symbol: 'SOL', weightPct: 10 }, { symbol: 'XRP', weightPct: 5 }, { symbol: 'ADA', weightPct: 5 }],
  },
  {
    id: 'tactical',
    name: 'Tattica',
    tagline: 'Regole più reattive',
    description: 'Un portafoglio più dinamico con budget per singola entrata ridotto e kill switch sempre disponibile.',
    risk: 'alto',
    accent: 'loss',
    defaultAgentName: 'Tattico',
    defaultBudgetUsd: 0,
    defaultMinOrderUsd: 25,
    defaultMaxOrderUsd: 100,
    defaultMaxPositions: 12,
    defaultCashReservePct: 15,
    defaultMaxOrdersPerDay: 8,
    defaultRebalance: 'giornaliero',
    objective: 'Opportunità tattiche con limiti stretti', horizon: '3–18 mesi', stressLossPct: 35,
    allocations: [{ symbol: 'SPY', weightPct: 25 }, { symbol: 'QQQ', weightPct: 25 }, { symbol: 'BTC', weightPct: 20 }, { symbol: 'GLD', weightPct: 15 }, { symbol: 'Cash', weightPct: 15 }],
  },
];

function uid(): string {
  return `strategy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function getStrategyTemplate(id: string): StrategyTemplate {
  return STRATEGY_TEMPLATES.find((template) => template.id === id) ?? STRATEGY_TEMPLATES[0];
}

export function createStrategyDraft(templateId: string): StrategyPortfolioConfig {
  const template = getStrategyTemplate(templateId);
  const now = Date.now();
  return {
    id: uid(),
    templateId: template.id,
    name: template.defaultAgentName,
    budgetUsd: template.defaultBudgetUsd,
    minOrderUsd: template.defaultMinOrderUsd,
    maxOrderUsd: template.defaultMaxOrderUsd,
    maxPositions: template.defaultMaxPositions,
    cashReservePct: template.defaultCashReservePct,
    maxOrdersPerDay: template.defaultMaxOrdersPerDay,
    rebalance: template.defaultRebalance,
    status: 'bozza',
    createdAt: now,
    updatedAt: now,
  };
}

export function loadStrategyPortfolios(): StrategyPortfolioConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as StrategyPortfolioConfig[]).map((portfolio) => {
      const simulation = portfolio.simulation;
      const migratedPortfolio = portfolio.status === 'attivo' && portfolio.etoroAgentPortfolioId && !portfolio.initializedAt
        ? { ...portfolio, status: 'da inizializzare' as const }
        : portfolio;
      if (!simulation) return migratedPortfolio;
      const migratedCurrent = simulation.modelVersion == null
        && simulation.observations >= 500
        && !(simulation.assets ?? []).some((asset) => asset.status === 'non-trovato');
      if (simulation.modelVersion === STRATEGY_SIMULATION_MODEL_VERSION || migratedCurrent) {
        return { ...migratedPortfolio, simulation: { ...simulation, modelVersion: STRATEGY_SIMULATION_MODEL_VERSION } };
      }
      // Non mostrare esiti salvati con un resolver o un modello precedente:
      // un vecchio "strumento non trovato" non deve sopravvivere agli aggiornamenti.
      return {
        ...migratedPortfolio,
        status: migratedPortfolio.status === 'attivo' || migratedPortfolio.status === 'da inizializzare' ? migratedPortfolio.status : 'pronto',
        simulation: undefined,
      };
    });
  } catch {
    return [];
  }
}

export interface StrategyOrderPlanItem {
  symbol: string;
  weightPct: number;
  instrumentId: number;
  /** Importo sul saldo virtuale dell'Agent Portfolio. */
  virtualAmountUsd: number;
  /** Impatto stimato sul capitale reale collegato dall'utente. */
  mirrorAmountUsd: number;
  chunks: number[];
}

export interface StrategyOrderPlan {
  virtualBalanceUsd: number;
  mirrorBudgetUsd: number;
  scale: number;
  cashReservePct: number;
  virtualCashReserveUsd: number;
  mirrorCashReserveUsd: number;
  orders: StrategyOrderPlanItem[];
  unresolvedSymbols: string[];
  totalOrders: number;
  generatedAt: number;
}

/**
 * Costruisce un piano iniziale senza side effect. I limiti min/max configurati
 * sono espressi sul capitale reale copiato e vengono scalati sul saldo virtuale
 * dell'Agent Portfolio, come richiesto dal modello mirror di eToro.
 */
export function buildStrategyOrderPlan(
  config: StrategyPortfolioConfig,
  virtualBalanceUsd: number,
  resolvedInstruments: Record<string, number>,
): StrategyOrderPlan {
  const template = getStrategyTemplate(config.templateId);
  const mirrorBudgetUsd = Math.max(0, config.budgetUsd);
  const safeVirtualBalance = Math.max(0, virtualBalanceUsd);
  const scale = mirrorBudgetUsd > 0 ? safeVirtualBalance / mirrorBudgetUsd : 0;
  const templateCashPct = template.allocations.find((allocation) => allocation.symbol === 'Cash')?.weightPct ?? 0;
  const cashReservePct = Math.max(config.cashReservePct, templateCashPct);
  const investablePct = Math.max(0, 100 - cashReservePct);
  const investableAllocations = template.allocations.filter((allocation) => allocation.symbol !== 'Cash' && allocation.weightPct > 0);
  const sourceWeight = investableAllocations.reduce((sum, allocation) => sum + allocation.weightPct, 0);
  const unresolvedSymbols: string[] = [];
  const orders = investableAllocations.flatMap<StrategyOrderPlanItem>((allocation) => {
    const instrumentId = resolvedInstruments[allocation.symbol.toUpperCase()] ?? 0;
    if (instrumentId <= 0 || sourceWeight <= 0 || scale <= 0) {
      unresolvedSymbols.push(allocation.symbol);
      return [];
    }
    const normalizedWeightPct = allocation.weightPct / sourceWeight * investablePct;
    const mirrorAmountUsd = mirrorBudgetUsd * normalizedWeightPct / 100;
    const virtualAmountUsd = mirrorAmountUsd * scale;
    const virtualMin = config.minOrderUsd * scale;
    const virtualMax = Math.max(virtualMin, config.maxOrderUsd * scale);
    if (virtualAmountUsd + 0.005 < virtualMin) return [];
    const chunkCount = Math.max(1, Math.ceil(virtualAmountUsd / virtualMax));
    const chunk = Math.round(virtualAmountUsd / chunkCount * 100) / 100;
    const chunks = Array.from({ length: chunkCount }, (_, index) => {
      const assigned = chunk * (chunkCount - 1);
      return index === chunkCount - 1 ? Math.round((virtualAmountUsd - assigned) * 100) / 100 : chunk;
    }).filter((amount) => amount >= virtualMin - 0.01);
    return [{
      symbol: allocation.symbol,
      weightPct: normalizedWeightPct,
      instrumentId,
      virtualAmountUsd: Math.round(virtualAmountUsd * 100) / 100,
      mirrorAmountUsd: Math.round(mirrorAmountUsd * 100) / 100,
      chunks,
    }];
  });
  return {
    virtualBalanceUsd: safeVirtualBalance,
    mirrorBudgetUsd,
    scale,
    cashReservePct,
    virtualCashReserveUsd: Math.round(safeVirtualBalance * cashReservePct) / 100,
    mirrorCashReserveUsd: Math.round(mirrorBudgetUsd * cashReservePct) / 100,
    orders,
    unresolvedSymbols,
    totalOrders: orders.reduce((sum, item) => sum + item.chunks.length, 0),
    generatedAt: Date.now(),
  };
}

export function saveStrategyPortfolios(portfolios: StrategyPortfolioConfig[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolios));
  } catch {
    /* localStorage pieno o bloccato: la UI resta comunque utilizzabile. */
  }
}

export function validateStrategyPortfolio(config: StrategyPortfolioConfig): StrategyValidation {
  const errors: string[] = [];
  const nameLength = config.name.trim().length;
  if (nameLength < 6 || nameLength > 10) errors.push('Il nome Agent deve avere da 6 a 10 caratteri.');
  if (!Number.isFinite(config.budgetUsd) || config.budgetUsd <= 0) errors.push('Il budget deve essere maggiore di zero.');
  if (!Number.isFinite(config.minOrderUsd) || config.minOrderUsd <= 0) errors.push('Il minimo per operazione deve essere maggiore di zero.');
  if (!Number.isFinite(config.maxOrderUsd) || config.maxOrderUsd < config.minOrderUsd) errors.push('Il massimo per operazione deve essere almeno il minimo.');
  if (!Number.isInteger(config.maxPositions) || config.maxPositions < 1) errors.push('Indica almeno una posizione massima.');
  if (config.cashReservePct < 0 || config.cashReservePct >= 100) errors.push('La riserva deve essere tra 0% e 99%.');
  if (!Number.isInteger(config.maxOrdersPerDay) || config.maxOrdersPerDay < 1) errors.push('Indica almeno un ordine massimo al giorno.');
  return { valid: errors.length === 0, errors };
}

export function allocationPreview(config: StrategyPortfolioConfig) {
  const operatingBudgetUsd = Math.max(0, config.budgetUsd * (1 - config.cashReservePct / 100));
  const equalSplitUsd = config.maxPositions > 0 ? operatingBudgetUsd / config.maxPositions : 0;
  const affordablePositions = config.minOrderUsd > 0
    ? Math.floor(operatingBudgetUsd / config.minOrderUsd)
    : 0;
  return {
    operatingBudgetUsd,
    equalSplitUsd,
    affordablePositions: Math.min(config.maxPositions, affordablePositions),
    maxSingleEntryUsd: Math.min(config.maxOrderUsd, operatingBudgetUsd),
  };
}
