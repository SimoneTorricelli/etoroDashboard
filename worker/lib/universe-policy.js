/**
 * Policy-driven candidate universe for Autopilot StrategySpec v1.
 *
 * This module is intentionally side-effect free: it does not call eToro, read
 * storage, fetch market data, or infer that a symbol is tradeable. Every item
 * produced here is only a candidate. The pipeline must still resolve the
 * symbol against the current eToro catalogue before it can be considered.
 *
 * Policy semantics:
 * - `exclude` is always a hard veto.
 * - a non-empty `include` is a hard allow-list for candidates to which that
 *   taxonomy applies (sector-focused equities for sectors, tagged products for
 *   themes). Sector/theme-neutral diversifiers are left available.
 * - `prefer` changes deterministic ranking but never widens an exclusion.
 * - percentage fields in StrategySpec use percentage points; pipeline
 *   `maxWeight` values use decimal fractions.
 */

const ASSET_CLASSES = Object.freeze(['etf', 'stock', 'bond', 'commodity', 'crypto']);
const CRYPTO_TIERS = Object.freeze(['large-cap', 'mid-cap', 'small-cap']);

const candidate = (
  symbol,
  name,
  assetClass,
  {
    sector = null,
    themes = [],
    traits = [],
    region = 'global',
    cryptoTier = null,
    meme = false,
    catalogMaxWeightPct = 20,
    basePriority = 50,
  } = {},
) => ({
  symbol,
  name,
  class: assetClass,
  sector,
  themes,
  traits,
  region,
  cryptoTier,
  meme,
  catalogMaxWeightPct,
  basePriority,
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Broad, curated discovery catalogue. Symbols are search hints, not an eToro
 * availability assertion; availability and exact instrument identity are
 * deliberately resolved later by the pipeline.
 */
export const POLICY_CANDIDATE_CATALOG = deepFreeze([
  // Core, factor, sector, and thematic ETFs.
  candidate('SPY', 'SPDR S&P 500 ETF Trust', 'etf', { themes: ['broad-market'], traits: ['core', 'us-large-cap'], region: 'us', catalogMaxWeightPct: 40, basePriority: 100 }),
  candidate('VTI', 'Vanguard Total Stock Market ETF', 'etf', { themes: ['broad-market'], traits: ['core', 'us-all-cap'], region: 'us', catalogMaxWeightPct: 40, basePriority: 99 }),
  candidate('VT', 'Vanguard Total World Stock ETF', 'etf', { themes: ['broad-market'], traits: ['core', 'global-equity'], catalogMaxWeightPct: 40, basePriority: 99 }),
  candidate('IWDA.L', 'iShares Core MSCI World UCITS ETF', 'etf', { themes: ['broad-market'], traits: ['core', 'developed-markets'], catalogMaxWeightPct: 40, basePriority: 98 }),
  candidate('IUSA.L', 'iShares Core S&P 500 UCITS ETF', 'etf', { themes: ['broad-market'], traits: ['core', 'us-large-cap'], region: 'us', catalogMaxWeightPct: 40, basePriority: 97 }),
  candidate('EFA', 'iShares MSCI EAFE ETF', 'etf', { themes: ['broad-market'], traits: ['developed-markets'], catalogMaxWeightPct: 30, basePriority: 88 }),
  candidate('IEMG', 'iShares Core MSCI Emerging Markets ETF', 'etf', { themes: ['broad-market'], traits: ['emerging-markets'], catalogMaxWeightPct: 25, basePriority: 86 }),
  candidate('IWM', 'iShares Russell 2000 ETF', 'etf', { themes: ['broad-market'], traits: ['us-small-cap'], region: 'us', catalogMaxWeightPct: 22, basePriority: 82 }),
  candidate('IJR', 'iShares Core S&P Small-Cap ETF', 'etf', { themes: ['broad-market'], traits: ['us-small-cap'], region: 'us', catalogMaxWeightPct: 22, basePriority: 81 }),
  candidate('QUAL', 'iShares MSCI USA Quality Factor ETF', 'etf', { themes: ['broad-market'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 28, basePriority: 91 }),
  candidate('USMV', 'iShares MSCI USA Min Vol Factor ETF', 'etf', { themes: ['broad-market'], traits: ['low-volatility'], region: 'us', catalogMaxWeightPct: 28, basePriority: 89 }),
  candidate('MTUM', 'iShares MSCI USA Momentum Factor ETF', 'etf', { themes: ['broad-market'], traits: ['momentum'], region: 'us', catalogMaxWeightPct: 24, basePriority: 84 }),
  candidate('VTV', 'Vanguard Value ETF', 'etf', { themes: ['broad-market', 'dividend-quality'], traits: ['value'], region: 'us', catalogMaxWeightPct: 28, basePriority: 87 }),
  candidate('VUG', 'Vanguard Growth ETF', 'etf', { themes: ['broad-market', 'artificial-intelligence'], traits: ['growth'], region: 'us', catalogMaxWeightPct: 28, basePriority: 88 }),
  candidate('VIG', 'Vanguard Dividend Appreciation ETF', 'etf', { themes: ['dividend-quality'], traits: ['quality', 'dividend-growth'], region: 'us', catalogMaxWeightPct: 28, basePriority: 91 }),
  candidate('SCHD', 'Schwab U.S. Dividend Equity ETF', 'etf', { themes: ['dividend-quality'], traits: ['income', 'quality'], region: 'us', catalogMaxWeightPct: 28, basePriority: 91 }),
  candidate('DGRO', 'iShares Core Dividend Growth ETF', 'etf', { themes: ['dividend-quality'], traits: ['income', 'dividend-growth'], region: 'us', catalogMaxWeightPct: 26, basePriority: 88 }),
  candidate('QQQ', 'Invesco QQQ Trust', 'etf', { sector: 'technology', themes: ['artificial-intelligence', 'semiconductors'], traits: ['growth'], region: 'us', catalogMaxWeightPct: 30, basePriority: 94 }),
  candidate('XLK', 'Technology Select Sector SPDR Fund', 'etf', { sector: 'technology', themes: ['artificial-intelligence', 'semiconductors'], traits: ['sector'], region: 'us', catalogMaxWeightPct: 22, basePriority: 88 }),
  candidate('SMH', 'VanEck Semiconductor ETF', 'etf', { sector: 'technology', themes: ['semiconductors', 'artificial-intelligence'], traits: ['thematic'], catalogMaxWeightPct: 18, basePriority: 88 }),
  candidate('SOXX', 'iShares Semiconductor ETF', 'etf', { sector: 'technology', themes: ['semiconductors', 'artificial-intelligence'], traits: ['thematic'], catalogMaxWeightPct: 18, basePriority: 86 }),
  candidate('CIBR', 'First Trust Nasdaq Cybersecurity ETF', 'etf', { sector: 'technology', themes: ['cybersecurity'], traits: ['thematic'], catalogMaxWeightPct: 16, basePriority: 84 }),
  candidate('HACK', 'ETFMG Prime Cyber Security ETF', 'etf', { sector: 'technology', themes: ['cybersecurity'], traits: ['thematic'], catalogMaxWeightPct: 15, basePriority: 80 }),
  candidate('XLV', 'Health Care Select Sector SPDR Fund', 'etf', { sector: 'healthcare', themes: ['healthcare-innovation'], traits: ['sector'], region: 'us', catalogMaxWeightPct: 22, basePriority: 89 }),
  candidate('IHI', 'iShares U.S. Medical Devices ETF', 'etf', { sector: 'healthcare', themes: ['healthcare-innovation', 'robotics'], traits: ['thematic'], region: 'us', catalogMaxWeightPct: 16, basePriority: 82 }),
  candidate('XLF', 'Financial Select Sector SPDR Fund', 'etf', { sector: 'financials', themes: ['dividend-quality'], traits: ['sector'], region: 'us', catalogMaxWeightPct: 20, basePriority: 84 }),
  candidate('XLY', 'Consumer Discretionary Select Sector SPDR Fund', 'etf', { sector: 'consumer-discretionary', traits: ['sector'], region: 'us', catalogMaxWeightPct: 18, basePriority: 80 }),
  candidate('XLP', 'Consumer Staples Select Sector SPDR Fund', 'etf', { sector: 'consumer-staples', themes: ['dividend-quality'], traits: ['sector', 'defensive'], region: 'us', catalogMaxWeightPct: 20, basePriority: 84 }),
  candidate('XLI', 'Industrial Select Sector SPDR Fund', 'etf', { sector: 'industrials', themes: ['robotics', 'infrastructure'], traits: ['sector'], region: 'us', catalogMaxWeightPct: 20, basePriority: 82 }),
  candidate('XLE', 'Energy Select Sector SPDR Fund', 'etf', { sector: 'energy', themes: ['dividend-quality'], traits: ['sector'], region: 'us', catalogMaxWeightPct: 18, basePriority: 78 }),
  candidate('XLB', 'Materials Select Sector SPDR Fund', 'etf', { sector: 'materials', themes: ['infrastructure'], traits: ['sector'], region: 'us', catalogMaxWeightPct: 18, basePriority: 77 }),
  candidate('XLU', 'Utilities Select Sector SPDR Fund', 'etf', { sector: 'utilities', themes: ['dividend-quality', 'clean-energy'], traits: ['sector', 'defensive'], region: 'us', catalogMaxWeightPct: 18, basePriority: 82 }),
  candidate('XLRE', 'Real Estate Select Sector SPDR Fund', 'etf', { sector: 'real-estate', themes: ['dividend-quality', 'infrastructure'], traits: ['sector', 'income'], region: 'us', catalogMaxWeightPct: 16, basePriority: 76 }),
  candidate('XLC', 'Communication Services Select Sector SPDR Fund', 'etf', { sector: 'communication-services', themes: ['artificial-intelligence'], traits: ['sector'], region: 'us', catalogMaxWeightPct: 18, basePriority: 80 }),
  candidate('ICLN', 'iShares Global Clean Energy ETF', 'etf', { sector: 'utilities', themes: ['clean-energy'], traits: ['thematic'], catalogMaxWeightPct: 12, basePriority: 74 }),
  candidate('TAN', 'Invesco Solar ETF', 'etf', { sector: 'industrials', themes: ['clean-energy'], traits: ['thematic'], catalogMaxWeightPct: 10, basePriority: 69 }),
  candidate('BOTZ', 'Global X Robotics & Artificial Intelligence ETF', 'etf', { sector: 'industrials', themes: ['robotics', 'artificial-intelligence'], traits: ['thematic'], catalogMaxWeightPct: 14, basePriority: 80 }),
  candidate('ROBO', 'ROBO Global Robotics and Automation ETF', 'etf', { sector: 'industrials', themes: ['robotics', 'artificial-intelligence'], traits: ['thematic'], catalogMaxWeightPct: 13, basePriority: 76 }),
  candidate('PAVE', 'Global X U.S. Infrastructure Development ETF', 'etf', { sector: 'industrials', themes: ['infrastructure'], traits: ['thematic'], region: 'us', catalogMaxWeightPct: 16, basePriority: 81 }),
  candidate('IGF', 'iShares Global Infrastructure ETF', 'etf', { sector: 'industrials', themes: ['infrastructure', 'dividend-quality'], traits: ['thematic', 'income'], catalogMaxWeightPct: 16, basePriority: 80 }),

  // Public equities across the main sectors.
  candidate('AAPL', 'Apple', 'stock', { sector: 'technology', themes: ['artificial-intelligence'], traits: ['quality', 'large-cap'], region: 'us', catalogMaxWeightPct: 14, basePriority: 94 }),
  candidate('MSFT', 'Microsoft', 'stock', { sector: 'technology', themes: ['artificial-intelligence', 'cybersecurity'], traits: ['quality', 'large-cap'], region: 'us', catalogMaxWeightPct: 15, basePriority: 97 }),
  candidate('NVDA', 'NVIDIA', 'stock', { sector: 'technology', themes: ['artificial-intelligence', 'semiconductors'], traits: ['growth', 'large-cap'], region: 'us', catalogMaxWeightPct: 14, basePriority: 96 }),
  candidate('GOOGL', 'Alphabet', 'stock', { sector: 'communication-services', themes: ['artificial-intelligence'], traits: ['quality', 'large-cap'], region: 'us', catalogMaxWeightPct: 14, basePriority: 94 }),
  candidate('META', 'Meta Platforms', 'stock', { sector: 'communication-services', themes: ['artificial-intelligence'], traits: ['growth', 'large-cap'], region: 'us', catalogMaxWeightPct: 13, basePriority: 91 }),
  candidate('AMZN', 'Amazon', 'stock', { sector: 'consumer-discretionary', themes: ['artificial-intelligence'], traits: ['growth', 'large-cap'], region: 'us', catalogMaxWeightPct: 13, basePriority: 92 }),
  candidate('AVGO', 'Broadcom', 'stock', { sector: 'technology', themes: ['semiconductors', 'artificial-intelligence'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 12, basePriority: 91 }),
  candidate('AMD', 'Advanced Micro Devices', 'stock', { sector: 'technology', themes: ['semiconductors', 'artificial-intelligence'], traits: ['growth'], region: 'us', catalogMaxWeightPct: 10, basePriority: 84 }),
  candidate('ASML', 'ASML Holding', 'stock', { sector: 'technology', themes: ['semiconductors'], traits: ['quality'], region: 'europe', catalogMaxWeightPct: 11, basePriority: 89 }),
  candidate('TSM', 'Taiwan Semiconductor Manufacturing', 'stock', { sector: 'technology', themes: ['semiconductors', 'artificial-intelligence'], traits: ['quality'], region: 'asia', catalogMaxWeightPct: 11, basePriority: 89 }),
  candidate('ORCL', 'Oracle', 'stock', { sector: 'technology', themes: ['artificial-intelligence'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 10, basePriority: 82 }),
  candidate('CRM', 'Salesforce', 'stock', { sector: 'technology', themes: ['artificial-intelligence'], traits: ['growth'], region: 'us', catalogMaxWeightPct: 10, basePriority: 79 }),
  candidate('PANW', 'Palo Alto Networks', 'stock', { sector: 'technology', themes: ['cybersecurity'], traits: ['growth'], region: 'us', catalogMaxWeightPct: 9, basePriority: 83 }),
  candidate('CRWD', 'CrowdStrike', 'stock', { sector: 'technology', themes: ['cybersecurity'], traits: ['growth'], region: 'us', catalogMaxWeightPct: 8, basePriority: 79 }),
  candidate('FTNT', 'Fortinet', 'stock', { sector: 'technology', themes: ['cybersecurity'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 8, basePriority: 77 }),
  candidate('LLY', 'Eli Lilly', 'stock', { sector: 'healthcare', themes: ['healthcare-innovation'], traits: ['quality', 'growth'], region: 'us', catalogMaxWeightPct: 12, basePriority: 91 }),
  candidate('NVO', 'Novo Nordisk', 'stock', { sector: 'healthcare', themes: ['healthcare-innovation'], traits: ['quality', 'growth'], region: 'europe', catalogMaxWeightPct: 11, basePriority: 87 }),
  candidate('UNH', 'UnitedHealth Group', 'stock', { sector: 'healthcare', traits: ['quality'], region: 'us', catalogMaxWeightPct: 11, basePriority: 87 }),
  candidate('JNJ', 'Johnson & Johnson', 'stock', { sector: 'healthcare', themes: ['dividend-quality'], traits: ['defensive', 'income'], region: 'us', catalogMaxWeightPct: 11, basePriority: 87 }),
  candidate('ABBV', 'AbbVie', 'stock', { sector: 'healthcare', themes: ['healthcare-innovation', 'dividend-quality'], traits: ['income'], region: 'us', catalogMaxWeightPct: 10, basePriority: 84 }),
  candidate('ISRG', 'Intuitive Surgical', 'stock', { sector: 'healthcare', themes: ['healthcare-innovation', 'robotics'], traits: ['growth'], region: 'us', catalogMaxWeightPct: 9, basePriority: 84 }),
  candidate('TMO', 'Thermo Fisher Scientific', 'stock', { sector: 'healthcare', themes: ['healthcare-innovation'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 9, basePriority: 82 }),
  candidate('VRTX', 'Vertex Pharmaceuticals', 'stock', { sector: 'healthcare', themes: ['healthcare-innovation'], traits: ['quality', 'growth'], region: 'us', catalogMaxWeightPct: 8, basePriority: 80 }),
  candidate('JPM', 'JPMorgan Chase', 'stock', { sector: 'financials', themes: ['dividend-quality'], traits: ['quality', 'income'], region: 'us', catalogMaxWeightPct: 12, basePriority: 90 }),
  candidate('BAC', 'Bank of America', 'stock', { sector: 'financials', themes: ['dividend-quality'], traits: ['value', 'income'], region: 'us', catalogMaxWeightPct: 9, basePriority: 78 }),
  candidate('V', 'Visa', 'stock', { sector: 'financials', traits: ['quality', 'growth'], region: 'us', catalogMaxWeightPct: 11, basePriority: 91 }),
  candidate('MA', 'Mastercard', 'stock', { sector: 'financials', traits: ['quality', 'growth'], region: 'us', catalogMaxWeightPct: 11, basePriority: 90 }),
  candidate('BRK.B', 'Berkshire Hathaway Class B', 'stock', { sector: 'financials', traits: ['quality', 'diversified'], region: 'us', catalogMaxWeightPct: 13, basePriority: 91 }),
  candidate('PG', 'Procter & Gamble', 'stock', { sector: 'consumer-staples', themes: ['dividend-quality'], traits: ['defensive', 'income'], region: 'us', catalogMaxWeightPct: 10, basePriority: 87 }),
  candidate('KO', 'Coca-Cola', 'stock', { sector: 'consumer-staples', themes: ['dividend-quality'], traits: ['defensive', 'income'], region: 'us', catalogMaxWeightPct: 9, basePriority: 84 }),
  candidate('COST', 'Costco Wholesale', 'stock', { sector: 'consumer-staples', traits: ['quality', 'growth'], region: 'us', catalogMaxWeightPct: 10, basePriority: 88 }),
  candidate('WMT', 'Walmart', 'stock', { sector: 'consumer-staples', themes: ['dividend-quality'], traits: ['defensive', 'quality'], region: 'us', catalogMaxWeightPct: 10, basePriority: 87 }),
  candidate('TSLA', 'Tesla', 'stock', { sector: 'consumer-discretionary', themes: ['clean-energy', 'robotics', 'artificial-intelligence'], traits: ['growth', 'high-volatility'], region: 'us', catalogMaxWeightPct: 8, basePriority: 75 }),
  candidate('HD', 'Home Depot', 'stock', { sector: 'consumer-discretionary', themes: ['dividend-quality'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 9, basePriority: 82 }),
  candidate('MCD', "McDonald's", 'stock', { sector: 'consumer-discretionary', themes: ['dividend-quality'], traits: ['defensive', 'income'], region: 'us', catalogMaxWeightPct: 9, basePriority: 82 }),
  candidate('CAT', 'Caterpillar', 'stock', { sector: 'industrials', themes: ['infrastructure'], traits: ['cyclical', 'quality'], region: 'us', catalogMaxWeightPct: 9, basePriority: 83 }),
  candidate('GE', 'GE Aerospace', 'stock', { sector: 'industrials', themes: ['infrastructure'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 9, basePriority: 81 }),
  candidate('HON', 'Honeywell', 'stock', { sector: 'industrials', themes: ['robotics', 'infrastructure'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 9, basePriority: 84 }),
  candidate('ETN', 'Eaton', 'stock', { sector: 'industrials', themes: ['clean-energy', 'infrastructure'], traits: ['quality', 'growth'], region: 'us', catalogMaxWeightPct: 9, basePriority: 85 }),
  candidate('DE', 'Deere & Company', 'stock', { sector: 'industrials', themes: ['robotics', 'infrastructure'], traits: ['cyclical'], region: 'us', catalogMaxWeightPct: 8, basePriority: 78 }),
  candidate('LMT', 'Lockheed Martin', 'stock', { sector: 'industrials', themes: ['infrastructure'], traits: ['defensive', 'income'], region: 'us', catalogMaxWeightPct: 8, basePriority: 79 }),
  candidate('XOM', 'Exxon Mobil', 'stock', { sector: 'energy', themes: ['dividend-quality'], traits: ['income', 'cyclical'], region: 'us', catalogMaxWeightPct: 10, basePriority: 82 }),
  candidate('CVX', 'Chevron', 'stock', { sector: 'energy', themes: ['dividend-quality'], traits: ['income', 'cyclical'], region: 'us', catalogMaxWeightPct: 10, basePriority: 81 }),
  candidate('COP', 'ConocoPhillips', 'stock', { sector: 'energy', traits: ['cyclical'], region: 'us', catalogMaxWeightPct: 8, basePriority: 76 }),
  candidate('LIN', 'Linde', 'stock', { sector: 'materials', themes: ['clean-energy', 'infrastructure'], traits: ['quality'], region: 'global', catalogMaxWeightPct: 9, basePriority: 84 }),
  candidate('APD', 'Air Products and Chemicals', 'stock', { sector: 'materials', themes: ['clean-energy', 'dividend-quality'], traits: ['quality', 'income'], region: 'us', catalogMaxWeightPct: 8, basePriority: 78 }),
  candidate('NEM', 'Newmont', 'stock', { sector: 'materials', traits: ['gold-producer', 'cyclical'], region: 'us', catalogMaxWeightPct: 7, basePriority: 70 }),
  candidate('NEE', 'NextEra Energy', 'stock', { sector: 'utilities', themes: ['clean-energy', 'dividend-quality'], traits: ['income'], region: 'us', catalogMaxWeightPct: 8, basePriority: 80 }),
  candidate('SO', 'Southern Company', 'stock', { sector: 'utilities', themes: ['dividend-quality'], traits: ['defensive', 'income'], region: 'us', catalogMaxWeightPct: 8, basePriority: 77 }),
  candidate('DUK', 'Duke Energy', 'stock', { sector: 'utilities', themes: ['dividend-quality'], traits: ['defensive', 'income'], region: 'us', catalogMaxWeightPct: 8, basePriority: 76 }),
  candidate('AMT', 'American Tower', 'stock', { sector: 'real-estate', themes: ['infrastructure', 'dividend-quality'], traits: ['income'], region: 'us', catalogMaxWeightPct: 8, basePriority: 79 }),
  candidate('PLD', 'Prologis', 'stock', { sector: 'real-estate', themes: ['infrastructure', 'dividend-quality'], traits: ['quality', 'income'], region: 'us', catalogMaxWeightPct: 8, basePriority: 80 }),
  candidate('EQIX', 'Equinix', 'stock', { sector: 'real-estate', themes: ['infrastructure', 'artificial-intelligence'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 8, basePriority: 82 }),
  candidate('NFLX', 'Netflix', 'stock', { sector: 'communication-services', traits: ['growth'], region: 'us', catalogMaxWeightPct: 8, basePriority: 79 }),
  candidate('DIS', 'Walt Disney', 'stock', { sector: 'communication-services', traits: ['consumer-media'], region: 'us', catalogMaxWeightPct: 7, basePriority: 70 }),
  candidate('TMUS', 'T-Mobile US', 'stock', { sector: 'communication-services', themes: ['infrastructure'], traits: ['quality'], region: 'us', catalogMaxWeightPct: 8, basePriority: 78 }),

  // Fixed-income instruments are classified as bond for aggregate guardrails.
  candidate('BND', 'Vanguard Total Bond Market ETF', 'bond', { traits: ['core', 'aggregate-bond'], region: 'us', catalogMaxWeightPct: 35, basePriority: 94 }),
  candidate('AGG', 'iShares Core U.S. Aggregate Bond ETF', 'bond', { traits: ['core', 'aggregate-bond'], region: 'us', catalogMaxWeightPct: 35, basePriority: 93 }),
  candidate('BNDX', 'Vanguard Total International Bond ETF', 'bond', { traits: ['international-bond'], catalogMaxWeightPct: 25, basePriority: 83 }),
  candidate('TLT', 'iShares 20+ Year Treasury Bond ETF', 'bond', { traits: ['long-duration', 'government'], region: 'us', catalogMaxWeightPct: 25, basePriority: 84 }),
  candidate('IEF', 'iShares 7-10 Year Treasury Bond ETF', 'bond', { traits: ['intermediate-duration', 'government'], region: 'us', catalogMaxWeightPct: 28, basePriority: 89 }),
  candidate('SHY', 'iShares 1-3 Year Treasury Bond ETF', 'bond', { traits: ['short-duration', 'government'], region: 'us', catalogMaxWeightPct: 30, basePriority: 88 }),
  candidate('TIP', 'iShares TIPS Bond ETF', 'bond', { traits: ['inflation-linked', 'government'], region: 'us', catalogMaxWeightPct: 25, basePriority: 87 }),
  candidate('LQD', 'iShares iBoxx Investment Grade Corporate Bond ETF', 'bond', { traits: ['investment-grade', 'corporate'], region: 'us', catalogMaxWeightPct: 22, basePriority: 84 }),
  candidate('HYG', 'iShares iBoxx High Yield Corporate Bond ETF', 'bond', { traits: ['high-yield', 'corporate'], region: 'us', catalogMaxWeightPct: 14, basePriority: 70 }),
  candidate('EMB', 'iShares J.P. Morgan USD Emerging Markets Bond ETF', 'bond', { traits: ['emerging-markets', 'government'], catalogMaxWeightPct: 15, basePriority: 73 }),

  // Commodity exposures; exact product eligibility still requires resolution.
  candidate('GLD', 'SPDR Gold Shares', 'commodity', { traits: ['gold', 'precious-metals'], catalogMaxWeightPct: 22, basePriority: 94 }),
  candidate('IAU', 'iShares Gold Trust', 'commodity', { traits: ['gold', 'precious-metals'], catalogMaxWeightPct: 22, basePriority: 91 }),
  candidate('SLV', 'iShares Silver Trust', 'commodity', { traits: ['silver', 'precious-metals'], catalogMaxWeightPct: 12, basePriority: 77 }),
  candidate('DBC', 'Invesco DB Commodity Index Tracking Fund', 'commodity', { traits: ['broad-commodities'], catalogMaxWeightPct: 18, basePriority: 84 }),
  candidate('PDBC', 'Invesco Optimum Yield Diversified Commodity Strategy', 'commodity', { traits: ['broad-commodities'], catalogMaxWeightPct: 18, basePriority: 83 }),
  candidate('USO', 'United States Oil Fund', 'commodity', { traits: ['oil', 'high-volatility'], catalogMaxWeightPct: 8, basePriority: 65 }),
  candidate('DBA', 'Invesco DB Agriculture Fund', 'commodity', { traits: ['agriculture'], catalogMaxWeightPct: 9, basePriority: 68 }),
  candidate('COPX', 'Global X Copper Miners ETF', 'commodity', { themes: ['clean-energy', 'infrastructure'], traits: ['copper', 'miners'], catalogMaxWeightPct: 9, basePriority: 72 }),

  // Crypto tiers are policy taxonomy, not a live market-cap ranking.
  candidate('BTC', 'Bitcoin', 'crypto', { cryptoTier: 'large-cap', traits: ['crypto-core'], catalogMaxWeightPct: 20, basePriority: 100 }),
  candidate('ETH', 'Ethereum', 'crypto', { cryptoTier: 'large-cap', traits: ['crypto-core', 'smart-contracts'], catalogMaxWeightPct: 16, basePriority: 98 }),
  candidate('SOL', 'Solana', 'crypto', { cryptoTier: 'large-cap', traits: ['smart-contracts', 'high-volatility'], catalogMaxWeightPct: 10, basePriority: 90 }),
  candidate('BNB', 'BNB', 'crypto', { cryptoTier: 'large-cap', traits: ['exchange-ecosystem'], catalogMaxWeightPct: 8, basePriority: 82 }),
  candidate('XRP', 'XRP', 'crypto', { cryptoTier: 'large-cap', traits: ['payments'], catalogMaxWeightPct: 8, basePriority: 78 }),
  candidate('ADA', 'Cardano', 'crypto', { cryptoTier: 'mid-cap', traits: ['smart-contracts'], catalogMaxWeightPct: 7, basePriority: 75 }),
  candidate('AVAX', 'Avalanche', 'crypto', { cryptoTier: 'mid-cap', traits: ['smart-contracts', 'high-volatility'], catalogMaxWeightPct: 6, basePriority: 76 }),
  candidate('LINK', 'Chainlink', 'crypto', { cryptoTier: 'mid-cap', traits: ['oracle-network'], catalogMaxWeightPct: 6, basePriority: 80 }),
  candidate('DOT', 'Polkadot', 'crypto', { cryptoTier: 'mid-cap', traits: ['interoperability'], catalogMaxWeightPct: 5, basePriority: 70 }),
  candidate('LTC', 'Litecoin', 'crypto', { cryptoTier: 'mid-cap', traits: ['payments'], catalogMaxWeightPct: 5, basePriority: 68 }),
  candidate('DOGE', 'Dogecoin', 'crypto', { cryptoTier: 'mid-cap', meme: true, traits: ['meme', 'high-volatility'], catalogMaxWeightPct: 4, basePriority: 55 }),
  candidate('UNI', 'Uniswap', 'crypto', { cryptoTier: 'small-cap', traits: ['defi', 'high-volatility'], catalogMaxWeightPct: 4, basePriority: 69 }),
  candidate('AAVE', 'Aave', 'crypto', { cryptoTier: 'small-cap', traits: ['defi', 'high-volatility'], catalogMaxWeightPct: 4, basePriority: 68 }),
  candidate('SHIB', 'Shiba Inu', 'crypto', { cryptoTier: 'small-cap', meme: true, traits: ['meme', 'high-volatility'], catalogMaxWeightPct: 2, basePriority: 44 }),
  candidate('PEPE', 'Pepe', 'crypto', { cryptoTier: 'small-cap', meme: true, traits: ['meme', 'high-volatility'], catalogMaxWeightPct: 2, basePriority: 40 }),
  candidate('BONK', 'Bonk', 'crypto', { cryptoTier: 'small-cap', meme: true, traits: ['meme', 'high-volatility'], catalogMaxWeightPct: 2, basePriority: 38 }),
]);

const asSet = (value) => new Set(Array.isArray(value) ? value : []);
const intersects = (items, set) => items.some((item) => set.has(item));
const round = (value, digits = 4) => Math.round(value * (10 ** digits)) / (10 ** digits);

function requirePolicy(spec) {
  const policy = spec?.universePolicy;
  if (!policy || policy.mode !== 'policy-dynamic') {
    throw new TypeError('StrategySpec.universePolicy.mode deve essere policy-dynamic');
  }
  if (!Array.isArray(policy.assetClasses) || policy.assetClasses.length === 0) {
    throw new TypeError('StrategySpec.universePolicy.assetClasses deve contenere almeno una classe');
  }
  for (const assetClass of policy.assetClasses) {
    if (!ASSET_CLASSES.includes(assetClass)) throw new TypeError(`Classe asset non supportata: ${assetClass}`);
    const cap = Number(policy.assetClassCapsPct?.[assetClass]);
    if (!Number.isFinite(cap) || cap < 0 || cap > 100) throw new TypeError(`Cap non valido per la classe ${assetClass}`);
  }
  const instrumentCap = Number(spec?.diversification?.maxInstrumentWeightPct);
  if (!Number.isFinite(instrumentCap) || instrumentCap <= 0 || instrumentCap > 100) {
    throw new TypeError('StrategySpec.diversification.maxInstrumentWeightPct non valido');
  }
  for (const dimension of ['sectors', 'themes']) {
    const preference = policy[dimension];
    if (!preference || !['include', 'prefer', 'exclude'].every((key) => Array.isArray(preference[key]))) {
      throw new TypeError(`StrategySpec.universePolicy.${dimension} non valido`);
    }
  }
  const crypto = policy.crypto;
  if (!crypto || typeof crypto.enabled !== 'boolean' || typeof crypto.allowMeme !== 'boolean' || !Array.isArray(crypto.tiers)) {
    throw new TypeError('StrategySpec.universePolicy.crypto non valido');
  }
  for (const tier of crypto.tiers) {
    if (!CRYPTO_TIERS.includes(tier)) throw new TypeError(`Fascia crypto non supportata: ${tier}`);
  }
  const cryptoCap = Number(crypto.maxWeightPct);
  if (!Number.isFinite(cryptoCap) || cryptoCap < 0 || cryptoCap > 50) {
    throw new TypeError('StrategySpec.universePolicy.crypto.maxWeightPct non valido');
  }
  return policy;
}

function matchesTaxonomyPolicy(item, policy) {
  const sectorInclude = asSet(policy.sectors.include);
  const sectorExclude = asSet(policy.sectors.exclude);
  const themeInclude = asSet(policy.themes.include);
  const themeExclude = asSet(policy.themes.exclude);

  if (item.sector && sectorExclude.has(item.sector)) return false;
  if (intersects(item.themes, themeExclude)) return false;

  // Sector rules apply only to sector-specific equities. Broad/core ETFs,
  // bonds, commodities, and crypto remain eligible as neutral diversifiers.
  if (sectorInclude.size && item.sector && !sectorInclude.has(item.sector)) return false;

  // The same principle applies to tagged thematic products. Untagged assets
  // are neutral; tagged assets must match at least one explicit inclusion.
  if (themeInclude.size && item.themes.length && !intersects(item.themes, themeInclude)) return false;
  return true;
}

function candidateMaxWeightPct(item, spec, policy) {
  const classCap = Number(policy.assetClassCapsPct[item.class]);
  const instrumentCap = Number(spec.diversification.maxInstrumentWeightPct);
  const caps = [item.catalogMaxWeightPct, classCap, instrumentCap];
  if (item.class === 'crypto') caps.push(Number(policy.crypto.maxWeightPct));
  return Math.max(0, Math.min(...caps));
}

function preferenceScore(item, spec, policy) {
  const preferredSectors = asSet(policy.sectors.prefer);
  const includedSectors = asSet(policy.sectors.include);
  const preferredThemes = asSet(policy.themes.prefer);
  const includedThemes = asSet(policy.themes.include);
  let score = Number(item.basePriority) || 0;

  if (item.sector && includedSectors.has(item.sector)) score += 80;
  if (item.sector && preferredSectors.has(item.sector)) score += 32;
  score += item.themes.filter((theme) => includedThemes.has(theme)).length * 60;
  score += item.themes.filter((theme) => preferredThemes.has(theme)).length * 24;

  const styles = asSet(spec.objective?.styles);
  if (styles.has('broad-market') && item.themes.includes('broad-market')) score += 10;
  if (styles.has('dividend') && item.themes.includes('dividend-quality')) score += 12;
  if (styles.has('thematic') && item.themes.some((theme) => theme !== 'broad-market')) score += 5;
  if (styles.has('quality') && item.traits.includes('quality')) score += 6;
  if (styles.has('growth') && item.traits.includes('growth')) score += 6;
  if (styles.has('value') && item.traits.includes('value')) score += 6;
  if (styles.has('momentum') && item.traits.includes('momentum')) score += 6;

  return round(score, 2);
}

function preferenceMatches(item, policy) {
  const matches = [];
  if (item.sector && policy.sectors.include.includes(item.sector)) matches.push(`sector:include:${item.sector}`);
  if (item.sector && policy.sectors.prefer.includes(item.sector)) matches.push(`sector:prefer:${item.sector}`);
  for (const theme of item.themes) {
    if (policy.themes.include.includes(theme)) matches.push(`theme:include:${theme}`);
    if (policy.themes.prefer.includes(theme)) matches.push(`theme:prefer:${theme}`);
  }
  return matches;
}

/**
 * Returns every catalog entry allowed by the normalized StrategySpec, ranked
 * deterministically. No availability claim is made by this function.
 */
export function rankPolicyUniverse(spec, catalog = POLICY_CANDIDATE_CATALOG) {
  const policy = requirePolicy(spec);
  const allowedClasses = asSet(policy.assetClasses);
  const allowedCryptoTiers = asSet(policy.crypto.tiers);
  const seen = new Set();
  const ranked = [];

  for (const item of catalog) {
    if (!item || typeof item.symbol !== 'string' || seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    if (!allowedClasses.has(item.class)) continue;
    if (Number(policy.assetClassCapsPct[item.class]) <= 0) continue;
    if (!matchesTaxonomyPolicy(item, policy)) continue;

    if (item.class === 'crypto') {
      if (!policy.crypto.enabled || Number(policy.crypto.maxWeightPct) <= 0) continue;
      if (!allowedCryptoTiers.has(item.cryptoTier)) continue;
      if (item.meme && !policy.crypto.allowMeme) continue;
    }

    const maxWeightPct = candidateMaxWeightPct(item, spec, policy);
    if (maxWeightPct <= 0) continue;
    ranked.push({
      symbol: item.symbol,
      name: item.name,
      class: item.class,
      maxWeight: round(maxWeightPct / 100, 4),
      maxWeightPct: round(maxWeightPct, 2),
      assetClassCapPct: round(Number(policy.assetClassCapsPct[item.class]), 2),
      sector: item.sector,
      themes: [...item.themes],
      traits: [...item.traits],
      region: item.region,
      cryptoTier: item.cryptoTier,
      meme: Boolean(item.meme),
      policyScore: preferenceScore(item, spec, policy),
      preferenceMatches: preferenceMatches(item, policy),
      policyStatus: 'candidate-unverified',
      requiresAvailabilityResolution: true,
      buyEligible: true,
    });
  }

  ranked.sort((a, b) => b.policyScore - a.policyScore || a.symbol.localeCompare(b.symbol));
  return ranked.map((item, index) => ({ ...item, policyRank: index + 1 }));
}

function takeFirst(entries, chosen, predicate) {
  const match = entries.find((entry) => !chosen.has(entry.symbol) && predicate(entry));
  if (match) chosen.set(match.symbol, match);
}

/**
 * Selects a bounded shortlist while reserving representation for every
 * eligible asset class and explicitly requested sector/theme where possible.
 */
function selectDiverse(ranked, spec, limit) {
  if (ranked.length <= limit) return ranked;
  const policy = spec.universePolicy;
  const chosen = new Map();

  for (const assetClass of policy.assetClasses) {
    takeFirst(ranked, chosen, (entry) => entry.class === assetClass);
    if (chosen.size >= limit) break;
  }
  for (const sector of [...policy.sectors.include, ...policy.sectors.prefer]) {
    if (chosen.size >= limit) break;
    takeFirst(ranked, chosen, (entry) => entry.sector === sector);
  }
  for (const theme of [...policy.themes.include, ...policy.themes.prefer]) {
    if (chosen.size >= limit) break;
    takeFirst(ranked, chosen, (entry) => entry.themes.includes(theme));
  }

  // A dynamic universe should not become a de-facto mega-cap whitelist. When
  // room permits, reserve one representative for each eligible equity sector.
  const eligibleSectors = [...new Set(ranked.map((entry) => entry.sector).filter(Boolean))];
  const sectorCoverageBudget = Math.min(eligibleSectors.length, Math.floor(limit / 2));
  for (const sector of eligibleSectors.slice(0, sectorCoverageBudget)) {
    if (chosen.size >= limit) break;
    takeFirst(ranked, chosen, (entry) => entry.sector === sector);
  }

  const classCounts = {};
  const sectorCounts = {};
  for (const entry of chosen.values()) {
    classCounts[entry.class] = (classCounts[entry.class] ?? 0) + 1;
    if (entry.sector) sectorCounts[entry.sector] = (sectorCounts[entry.sector] ?? 0) + 1;
  }

  while (chosen.size < limit) {
    let best = null;
    let bestAdjustedScore = -Infinity;
    for (const entry of ranked) {
      if (chosen.has(entry.symbol)) continue;
      const classPenalty = (classCounts[entry.class] ?? 0) * 2.5;
      const sectorPenalty = entry.sector ? (sectorCounts[entry.sector] ?? 0) * 1.25 : 0;
      const adjustedScore = entry.policyScore - classPenalty - sectorPenalty;
      if (adjustedScore > bestAdjustedScore
        || (adjustedScore === bestAdjustedScore && best && entry.policyRank < best.policyRank)) {
        best = entry;
        bestAdjustedScore = adjustedScore;
      }
    }
    if (!best) break;
    chosen.set(best.symbol, best);
    classCounts[best.class] = (classCounts[best.class] ?? 0) + 1;
    if (best.sector) sectorCounts[best.sector] = (sectorCounts[best.sector] ?? 0) + 1;
  }

  return [...chosen.values()]
    .sort((a, b) => a.policyRank - b.policyRank)
    .map((entry, index) => ({ ...entry, shortlistRank: index + 1 }));
}

/**
 * Builds the pool consumed by the current pipeline. By default it returns at
 * least 32 candidates (when the policy permits them), comfortably above a
 * 20-position portfolio. Pass `limit: null` to keep every eligible entry.
 */
export function buildPolicyUniverse(spec, { catalog = POLICY_CANDIDATE_CATALOG, limit } = {}) {
  const ranked = rankPolicyUniverse(spec, catalog);
  const requested = limit === undefined
    ? Math.max(32, Math.min(60, Number(spec?.diversification?.maxPositions || 20) * 2))
    : limit;
  if (requested === null) return ranked;
  const safeLimit = Math.max(1, Math.floor(Number(requested) || 1));
  return selectDiverse(ranked, spec, Math.min(safeLimit, ranked.length));
}

function heldValues(heldEntries) {
  if (heldEntries instanceof Map) return [...heldEntries.values()];
  if (Array.isArray(heldEntries)) return heldEntries;
  if (heldEntries && typeof heldEntries === 'object') return Object.values(heldEntries);
  return [];
}

/**
 * Adds held instruments so the decision engine can manage or exit positions
 * that are no longer allowed for new purchases. Missing held instruments are
 * explicitly sell-only with maxWeight 0; this helper never silently expands
 * the buy universe.
 */
export function mergeHeldEntries(policyEntries, heldEntries) {
  const merged = new Map((policyEntries ?? []).map((entry) => [entry.symbol, { ...entry }]));
  const held = heldValues(heldEntries)
    .filter((entry) => entry && typeof entry.symbol === 'string' && entry.symbol.trim())
    .map((entry) => ({ ...entry, symbol: entry.symbol.trim().toUpperCase() }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  for (const holding of held) {
    const existing = merged.get(holding.symbol);
    if (existing) {
      merged.set(holding.symbol, { ...existing, held: true });
      continue;
    }
    merged.set(holding.symbol, {
      ...holding,
      name: holding.name || holding.symbol,
      class: ASSET_CLASSES.includes(holding.class) ? holding.class : 'stock',
      maxWeight: 0,
      maxWeightPct: 0,
      held: true,
      buyEligible: false,
      sellOnly: true,
      outsidePolicy: true,
      policyStatus: 'held-outside-policy',
      requiresAvailabilityResolution: !holding.instrumentId,
    });
  }
  return [...merged.values()];
}
