// Public reference data only. Never forwards account credentials to this page.
export const DIVIDEND_CALENDAR_URL = 'https://www.etoro.com/investing/dividend-calendar/';

export function parseCalendarRows(tableRows) {
  const rows = [];
  for (const row of tableRows) {
    const cells = row.cells.map(c => c.trim().replace(/\s+/g, ' '));
    const exIndex = cells.findIndex(c => /^\d{4}-\d{2}-\d{2}$/.test(c));
    if (exIndex < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[exIndex + 1] ?? '')) continue;
    const symbol = row.symbol?.toUpperCase();
    const annual = cells[exIndex + 2];
    const periodic = cells[exIndex + 3];
    if (!symbol || !/^[A-Z0-9.^-]{1,30}$/.test(symbol) || !/^\d+(\.\d+)?$/.test(annual ?? '') || !/^\d+(\.\d+)?$/.test(periodic ?? '')) continue;
    rows.push({ symbol, exDate: cells[exIndex], paymentDate: cells[exIndex + 1], annualPerShare: Number(annual), amountPerShare: Number(periodic), currency: null });
  }
  // Conflicting records are not silently resolved by picking a larger yield.
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.symbol}:${row.exDate}`;
    if (!seen.has(key)) seen.set(key, row);
    else if (JSON.stringify(seen.get(key)) !== JSON.stringify(row)) seen.set(key, null);
  }
  return [...seen.values()].filter(Boolean);
}

export async function publicDividendCalendar(request, env) {
  const response = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': status === 200 ? 'public, max-age=3600' : 'no-store' } });
  if (request.method !== 'GET') return response({ error: 'Metodo non consentito' }, 405);
  const cacheKey = 'income:public-calendar:v1';
  try {
    const cached = await env.STATE?.get(cacheKey, 'json');
    if (cached?.asOf && Date.now() - cached.asOf < 12 * 3600000) return response(cached);
    const upstream = await fetch(DIVIDEND_CALENDAR_URL, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!upstream.ok) throw new Error(`Calendario eToro non accessibile (HTTP ${upstream.status})`);
    if (!upstream.headers.get('content-type')?.includes('text/html')) throw new Error('Formato calendario inatteso');
    const tableRows = [];
    let current = null;
    let cellIndex = -1;
    let bytes = 0;
    const limit = new TransformStream({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 2500000) throw new Error('Calendario troppo grande');
      controller.enqueue(chunk);
    } });
    const parsed = new HTMLRewriter()
      .on('table tr', { element(e) { current = { cells: [], symbol: null }; cellIndex = -1; const row = current; e.onEndTag(() => { tableRows.push(row); current = null; }); } })
      .on('table tr td', { element() { if (current) { current.cells.push(''); cellIndex = current.cells.length - 1; } }, text(t) { if (current && cellIndex >= 0) current.cells[cellIndex] += t.text; } })
      .on('table tr td a[href]', { element(e) { const symbol = e.getAttribute('href')?.match(/\/markets\/([^/?#]+)/i)?.[1]; if (current && symbol && !current.symbol) current.symbol = symbol; } })
      .transform(new Response(upstream.body.pipeThrough(limit)));
    // Drain without buffering the rewritten HTML.
    await parsed.body.pipeTo(new WritableStream({ write() {} }));
    const rows = parseCalendarRows(tableRows);
    if (!rows.length) throw new Error('Calendario non leggibile: formato cambiato o dati non disponibili');
    const result = { rows, asOf: Date.now(), source: DIVIDEND_CALENDAR_URL, coverage: 'partial', note: 'Calendario pubblico indicativo. Valuta non esposta: confermarla prima del calcolo. Un simbolo assente non implica dividendo zero.' };
    await env.STATE?.put(cacheKey, JSON.stringify(result), { expirationTtl: 43200 });
    return response(result);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : 'Calendario non disponibile', source: DIVIDEND_CALENDAR_URL }, 502);
  }
}
