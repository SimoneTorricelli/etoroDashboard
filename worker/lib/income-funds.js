// Exact listing -> share class. Primary-source evidence is recorded in
// docs/rendite-fonti-2026-09-13.md. The distribution policy is fetched afresh;
// membership in this catalogue alone must never produce a zero dividend.
const ISHARES = {
  'CNDX.L': ['253741', 'IE00B53SZB19', 'individual', 'CNDX'],
  'CBU0.L': ['253745', 'IE00B3VWN518', 'individual', 'ishares-usd-government-bond-710-ucits-etf-acc-fund'],
  'DTLA.L': ['297191', 'IE00BFM6TC58', 'individual', 'ishares-treasury-bond-20%20yr-ucits-etf'],
  'CSP1.L': ['253743', 'IE00B5BMR087', 'professionals', 'cspx'],
  '2B76.DE': ['284219', 'IE00BYZK4552', 'professionals', 'ishares-automation-robotics-ucits-etf-usd-acc-fund'],
};
export function fundReference(symbol) {
  if (Object.hasOwn(ISHARES, symbol)) {
    const [productId, isin, audience, slug] = ISHARES[symbol];
    return { productId, isin, provider: 'iShares / BlackRock', url: `https://www.ishares.com/uk/${audience}/en/products/${productId}/${slug}?siteEntryPassthrough=true&switchLocale=y` };
  }
  if (symbol === '8PSG.DE') return { isin: 'IE00B579F325', provider: 'Invesco', url: 'https://www.invesco.com/uk/en/financial-products/etfs/invesco-physical-gold-etc.html' };
  return null;
}
function decodeAttribute(text) {
  return text.replace(/&quot;/g, '"').replace(/&#(?:34|x22);/gi, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
export function parseFundReference(html, symbol, ref, now = Date.now()) {
  let currency; let method;
  if (ref.provider === 'iShares / BlackRock') {
    const components = {};
    for (const tag of html.matchAll(/<walrus-render-on-client\b[^>]+>/g)) {
      const key = tag[0].match(/\bcomponentkey="(keyFundFacts|listings)"/)?.[1];
      if (!key) continue;
      if (components[key]) throw new Error('Dati emittente ambigui');
      const raw = tag[0].match(/\bcomponentprops="([^"]+)"/)?.[1];
      if (!raw || raw.length > 200000) throw new Error('Struttura dei dati emittente cambiata');
      components[key] = JSON.parse(decodeAttribute(raw));
      if (components[key].componentId !== key || components[key].context?.productId !== ref.productId) throw new Error('Identità del fondo non confermata');
    }
    const facts = components.keyFundFacts?.containersByNameMap?.default?.dataPointsByNameMap;
    const listings = components.listings?.containersByNameMap?.default?.dataPointsByNameMap;
    if (facts?.isin?.value !== ref.isin || !Array.isArray(listings?.ric?.value) || !listings.ric.value.includes(symbol)) throw new Error('ISIN o quotazione del fondo non confermati');
    if (facts.useOfProfitsCode?.value !== 'Accumulating') throw new Error('Il fondo non risulta ad accumulazione: distribuzioni da aggiornare');
    currency = facts.baseCurrencyCode?.value;
    method = 'accumulating';
  } else if (ref.provider === 'Invesco') {
    const meta = name => html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]+)"\\s*/?>`))?.[1];
    const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1];
    if (canonical !== ref.url || meta('isin') !== ref.isin || meta('accountName') !== 'Invesco Physical Gold ETC' || meta('legalForm') !== 'ETC') throw new Error('Identità dell’ETC non confermata');
    if (meta('distribution') !== 'None') throw new Error('Politica di distribuzione dell’ETC non confermata');
    // No payout currency exists for a non-distributing instrument. Report the
    // zero cash flow in EUR; never infer a currency for a nonzero payment.
    currency = 'EUR'; method = 'non_distributing';
  } else throw new Error('Emittente non supportato');
  if (!/^[A-Z]{3}$/.test(currency ?? '')) throw new Error('Valuta del fondo non confermata');
  return { symbol, isin: ref.isin, currency, annualPerShare: 0, frequency: null, status: 'available', method,
    source: ref.url, provider: ref.provider, asOf: now, sourceUpdatedAt: null, rows: [] };
}
