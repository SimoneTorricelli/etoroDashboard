export const appleIdentity = { symbol: 'AAPL', isin: 'US0378331005', exchange: 'XNAS' };
export function freeSearch(identity = appleIdentity) { return { symbols: [identity], total: 1 }; }
export function freeData(identity = appleIdentity, noCurrent = false, now = Date.now()) {
  const date = daysAgo => new Date(now - daysAgo * 86400000).toISOString().slice(0, 10);
  return { ...identity, dividendFrequency: noCurrent ? 'none' : 'quarterly', dividendRate: noCurrent ? null : 1.1, dividendCurrency: noCurrent ? null : 'USD',
    dividends: noCurrent ? [] : [10, 100, 190, 280, 400].map((age, i) => ({ id: i, exDate: date(age), payDate: date(age - 3), amount: i < 2 ? .27 : .26, currency: 'USD', forecast: false })), splits: [] };
}
