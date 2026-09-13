import { fundReference } from '../../worker/lib/income-funds.js';
export function fundFixture(symbol = 'CNDX.L', overrides = {}) {
  const ref = fundReference(symbol);
  const points = { isin: { value: ref.isin }, baseCurrencyCode: { value: 'USD' }, useOfProfitsCode: { value: 'Accumulating' }, ...overrides };
  const component = (key, data) => {
    const props = { componentId: key, context: { productId: ref.productId }, containersByNameMap: { default: { dataPointsByNameMap: data } } };
    return `<walrus-render-on-client componentprops="${JSON.stringify(props).replaceAll('"', '&quot;')}" componentkey="${key}"></walrus-render-on-client>`;
  };
  return component('keyFundFacts', points) + component('listings', { ric: { value: [symbol] } });
}
export function goldFixture() {
  const ref = fundReference('8PSG.DE');
  return `<link rel="canonical" href="${ref.url}"><meta name="isin" content="${ref.isin}"/><meta name="accountName" content="Invesco Physical Gold ETC"/><meta name="legalForm" content="ETC"/><meta name="distribution" content="None"/>`;
}
export function statisticsFixture(symbol = 'CLSK', name = 'CleanSpark') {
  return `<link rel="canonical" href="https://stockanalysis.com/stocks/${symbol.toLowerCase()}/statistics/">data:{info:{ticker:"${symbol}",name:"${name}",curr:{main:"USD"}}},uses:{};dividends:{text:"${name} does not appear to pay any dividends at this time.",data:[{id:"dps",title:"Dividend Per Share",value:"n/a",hover:"n/a"}]}`;
}
