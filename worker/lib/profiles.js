/**
 * Profili di strategia.
 *
 * Un profilo è un insieme coerente di vincoli: invece di tarare quindici
 * numeri, se ne sceglie uno e i guardrail si allineano. Restano comunque
 * sovrascrivibili singolarmente: il profilo è un punto di partenza, non
 * una gabbia.
 */

export const PROFILES = {
  defensive: {
    id: 'defensive',
    label: 'Difensivo',
    summary: 'Protezione del capitale prima di tutto. Poche posizioni, molto liquide, nessuna crypto.',
    targetVolPct: [0, 8],
    horizon: 'lungo periodo, 3+ anni',
    maxHoldings: 6,
    minHoldings: 3,
    maxWeightPerClass: { etf: 0.85, bond: 0.50, commodity: 0.25, stock: 0.25, crypto: 0, cash: 1 },
    minCashPct: 0.10,
    maxCashPct: 0.60,
    maxTurnoverPct: 0.12,
    minRebalanceBandAbs: 0.04,
    minConfidence: 0.65,
    drawdownStopPct: 0.10,
    minHoldingDays: 30,
    reentryCooldownDays: 45,
    substitutionEdge: 25,
    watcherEnabled: false,
    opportunisticBudgetPct: 0,
    riskProfile: 'Difensivo. Obiettivo primario: non perdere capitale. Preferisci ETF ampi, obbligazionario e oro. Evita concentrazione, settori ciclici e strumenti illiquidi. In caso di dubbio, resta liquido.',
  },
  balanced: {
    id: 'balanced',
    label: 'Bilanciato',
    summary: 'Crescita moderata con rischio controllato. Azionario ampio più una quota contenuta di crypto.',
    targetVolPct: [8, 14],
    horizon: 'medio periodo, 1–3 anni',
    maxHoldings: 8,
    minHoldings: 4,
    maxWeightPerClass: { etf: 0.80, bond: 0.40, commodity: 0.25, stock: 0.45, crypto: 0.12, cash: 1 },
    minCashPct: 0.05,
    maxCashPct: 0.50,
    maxTurnoverPct: 0.20,
    minRebalanceBandAbs: 0.03,
    minConfidence: 0.55,
    drawdownStopPct: 0.15,
    minHoldingDays: 21,
    reentryCooldownDays: 30,
    substitutionEdge: 18,
    watcherEnabled: true,
    opportunisticBudgetPct: 0.08,
    riskProfile: 'Bilanciato. Crescita moderata con protezione del capitale. Diversifica fra classi, evita di concentrare più di un terzo su un singolo tema. La crypto è ammessa solo come quota satellite.',
  },
  dynamic: {
    id: 'dynamic',
    label: 'Dinamico',
    summary: 'Segue il momentum, accetta oscillazioni. Settoriali e crypto fino al 20%.',
    targetVolPct: [14, 22],
    horizon: 'medio-breve, 6–18 mesi',
    maxHoldings: 10,
    minHoldings: 5,
    maxWeightPerClass: { etf: 0.70, bond: 0.30, commodity: 0.25, stock: 0.60, crypto: 0.20, cash: 1 },
    minCashPct: 0.03,
    maxCashPct: 0.45,
    maxTurnoverPct: 0.28,
    minRebalanceBandAbs: 0.025,
    minConfidence: 0.50,
    drawdownStopPct: 0.20,
    minHoldingDays: 14,
    reentryCooldownDays: 21,
    substitutionEdge: 15,
    watcherEnabled: true,
    opportunisticBudgetPct: 0.12,
    riskProfile: 'Dinamico. Segui i trend affermati e ruota verso ciò che mostra forza relativa, ma esci con decisione quando il momentum si rompe. Accetta volatilità, non accettare perdite strutturali.',
  },
  aggressive: {
    id: 'aggressive',
    label: 'Aggressivo',
    summary: 'Massima esposizione al rischio. Azioni singole e crypto fino al 30%.',
    targetVolPct: [22, 100],
    horizon: 'breve, 3–12 mesi',
    maxHoldings: 12,
    minHoldings: 5,
    maxWeightPerClass: { etf: 0.60, bond: 0.20, commodity: 0.25, stock: 0.75, crypto: 0.30, cash: 1 },
    minCashPct: 0.02,
    maxCashPct: 0.40,
    maxTurnoverPct: 0.35,
    minRebalanceBandAbs: 0.02,
    minConfidence: 0.45,
    drawdownStopPct: 0.28,
    minHoldingDays: 7,
    reentryCooldownDays: 14,
    substitutionEdge: 12,
    watcherEnabled: true,
    opportunisticBudgetPct: 0.18,
    riskProfile: 'Aggressivo. Cerca rendimento elevato accettando drawdown importanti. Concentra su convinzioni forti, ma taglia rapidamente le posizioni che si deteriorano. Nessuna leva, nessuno short.',
  },
};

/** Chiavi che il profilo sovrascrive quando viene applicato. */
export const PROFILE_KEYS = [
  'maxHoldings', 'minHoldings', 'maxWeightPerClass', 'minCashPct', 'maxCashPct',
  'maxTurnoverPct', 'minRebalanceBandAbs', 'minConfidence', 'drawdownStopPct',
  'minHoldingDays', 'reentryCooldownDays', 'substitutionEdge',
  'watcherEnabled', 'opportunisticBudgetPct', 'riskProfile',
];

export function listProfiles() {
  return Object.values(PROFILES).map((profile) => ({
    id: profile.id,
    label: profile.label,
    summary: profile.summary,
    targetVolPct: profile.targetVolPct,
    horizon: profile.horizon,
    maxHoldings: profile.maxHoldings,
    cryptoCap: profile.maxWeightPerClass.crypto,
    drawdownStopPct: profile.drawdownStopPct,
    watcherEnabled: profile.watcherEnabled,
  }));
}

/** Restituisce la configurazione con i valori del profilo applicati. */
export function applyProfile(config, profileId) {
  const profile = PROFILES[profileId];
  if (!profile) return config;
  const next = { ...config, strategyProfile: profile.id };
  for (const key of PROFILE_KEYS) next[key] = profile[key];
  return next;
}

/** Descrizione testuale del profilo, iniettata nel prompt. */
export function describeProfile(config) {
  if (config.strategySpec) {
    const spec = config.strategySpec;
    return [
      `Strategia guidata “${spec.name}”: ${spec.objective?.description ?? config.riskProfile}`,
      `Orizzonte ${spec.objective?.horizonMonths ?? 'n/d'} mesi. Volatilità annua desiderata ${spec.risk?.targetVolatilityPct?.min ?? 'n/d'}–${spec.risk?.targetVolatilityPct?.max ?? 'n/d'}%.`,
      `Tieni fra ${spec.diversification?.minPositions ?? config.minHoldings} e ${spec.diversification?.maxPositions ?? config.maxHoldings} strumenti, mirando a ${config.preferredHoldings ?? spec.diversification?.preferredPositions ?? config.minHoldings}; il minimo non è il target. Universo policy-dynamic, cap e preferenze non ampliabili dall'AI.`,
      config.riskProfile,
    ].join(' ');
  }
  const profile = PROFILES[config.strategyProfile] ?? PROFILES.balanced;
  return [
    `Profilo ${profile.label}: ${profile.summary}`,
    `Orizzonte ${profile.horizon}. Volatilità annua desiderata ${profile.targetVolPct[0]}–${profile.targetVolPct[1]}%.`,
    `Tieni fra ${config.minHoldings} e ${config.maxHoldings} strumenti in portafoglio, mirando a ${config.preferredHoldings ?? config.minHoldings}.`,
    config.riskProfile,
  ].join(' ');
}
