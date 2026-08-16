export type StrategyRisk = 'basso' | 'medio' | 'alto' | 'molto-alto';

export type StrategyRebalance = 'giornaliero' | 'settimanale' | 'mensile';

export type StrategyPortfolioStatus = 'bozza' | 'pronto' | 'attivo' | 'in pausa';

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
  createdAt: number;
  updatedAt: number;
}

export interface StrategyValidation {
  valid: boolean;
  errors: string[];
}

const STORAGE_KEY = 'torino.strategy-portfolios.v1';

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'dividends',
    name: 'Dividendi',
    tagline: 'Flussi e bassa rotazione',
    description: 'Una base orientata a strumenti maturi e distribuzioni, con limiti stretti per singola posizione.',
    risk: 'medio',
    accent: 'gain',
    defaultAgentName: 'Dividend',
    defaultBudgetUsd: 2000,
    defaultMinOrderUsd: 50,
    defaultMaxOrderUsd: 250,
    defaultMaxPositions: 10,
    defaultCashReservePct: 10,
    defaultMaxOrdersPerDay: 4,
    defaultRebalance: 'mensile',
  },
  {
    id: 'defensive',
    name: 'Conservativa',
    tagline: 'Diversificazione e controllo',
    description: 'Pensata per limitare concentrazione e turnover, mantenendo una riserva di liquidità.',
    risk: 'basso',
    accent: 'info',
    defaultAgentName: 'Difesa',
    defaultBudgetUsd: 2000,
    defaultMinOrderUsd: 50,
    defaultMaxOrderUsd: 200,
    defaultMaxPositions: 12,
    defaultCashReservePct: 20,
    defaultMaxOrdersPerDay: 3,
    defaultRebalance: 'mensile',
  },
  {
    id: 'growth',
    name: 'Crescita',
    tagline: 'Più esposizione, più oscillazione',
    description: 'Portafoglio orientato alla crescita con un tetto per posizione e ribilanciamento regolare.',
    risk: 'alto',
    accent: 'agent',
    defaultAgentName: 'Crescita',
    defaultBudgetUsd: 2000,
    defaultMinOrderUsd: 50,
    defaultMaxOrderUsd: 225,
    defaultMaxPositions: 10,
    defaultCashReservePct: 10,
    defaultMaxOrdersPerDay: 6,
    defaultRebalance: 'settimanale',
  },
  {
    id: 'crypto',
    name: 'Crypto',
    tagline: 'Volatilità sotto controllo',
    description: 'Un contenitore dedicato agli asset crypto, con ordine massimo più basso e leva disattivata.',
    risk: 'molto-alto',
    accent: 'warn',
    defaultAgentName: 'Crypto',
    defaultBudgetUsd: 1000,
    defaultMinOrderUsd: 25,
    defaultMaxOrderUsd: 150,
    defaultMaxPositions: 6,
    defaultCashReservePct: 20,
    defaultMaxOrdersPerDay: 5,
    defaultRebalance: 'settimanale',
  },
  {
    id: 'tactical',
    name: 'Tattica',
    tagline: 'Regole più reattive',
    description: 'Un portafoglio più dinamico con budget per singola entrata ridotto e kill switch sempre disponibile.',
    risk: 'alto',
    accent: 'loss',
    defaultAgentName: 'Tattico',
    defaultBudgetUsd: 1000,
    defaultMinOrderUsd: 25,
    defaultMaxOrderUsd: 100,
    defaultMaxPositions: 12,
    defaultCashReservePct: 15,
    defaultMaxOrdersPerDay: 8,
    defaultRebalance: 'giornaliero',
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
    return Array.isArray(parsed) ? parsed as StrategyPortfolioConfig[] : [];
  } catch {
    return [];
  }
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
