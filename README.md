# eToro Command Center — "Torino"

Dashboard personale per eToro: portfolio analytics, mercati globali in tempo reale, agente di investimento automatizzato con limiti di capitale, modulo EUR/USD per decidere quando prelevare in euro.

**Strumento non affiliato ad eToro. Non costituisce consulenza finanziaria. Il trading comporta rischio di perdita del capitale.**

## Funzionalità

- **Panoramica** — KPI portfolio, grafico P&L con benchmark, watchlist live, suggerimenti e next step, esposizione valutaria, stato Agent.
- **Mercati** — quote in tempo reale (azioni, ETF, crypto, FX, indici), heatmap settoriale, top movers, drawer con grafico a candele e ordini.
- **Portfolio** — score di diversificazione, allocazione per asset class/settore/valuta, P&L per posizione, heatmap mensile, suggerimenti di ribilanciamento.
- **Agent** — regole di investimento automatico (calo %, soglia prezzo, RSI), **gruppi con limite di capitale** (es. "Importantissimo" max €X), esecuzione con conferma oppure **automatica senza conferma** (toggle, default OFF), kill switch, log, backtest-lite.
- **FX (EUR/USD)** — tasso live, advisor "quando prelevare" USD→EUR, calcolatore costi di conversione (pips eToro), alert su soglie.
- **Impostazioni** — chiavi API eToro (solo nel browser), guida proxy Cloudflare Worker, import CSV Account Statement.

## Modalità dati

1. **Demo** (default): dati simulati realistici, tutto funziona senza chiavi.
2. **Live**: inserisci `x-api-key` + `x-user-key` (da eToro → Settings > Trading) e l'URL di un proxy CORS. Le chiavi restano **solo nel localStorage del tuo browser**.
3. **CSV**: importa l'Account Statement eToro per analisi storiche.

### Perché serve un proxy?

L'API pubblica eToro (`https://public-api.etoro.com/api/v1` e `/api/v2`) non supporta CORS: un sito statico non può chiamarla direttamente dal browser. La pagina Impostazioni include lo script completo di un **Cloudflare Worker gratuito** che conserva la versione dell'endpoint e fa da relay: lo deployi sul tuo account Cloudflare e incolli l'URL nelle Impostazioni.

## Deploy su GitHub Pages

Il progetto è già configurato per GitHub Pages (`base: './'` in `vite.config.ts`, `public/404.html` per il routing SPA, basename runtime in `main.tsx`).

1. Fai push di questo repo su GitHub (es. `tuonome/etoro-dashboard`).
2. Build e deploy della cartella `dist`:

   ```bash
   npm install
   npm run build
   npx gh-pages -d dist   # oppure: npm i -g gh-pages
   ```

   Oppure con GitHub Actions (`.github/workflows/deploy.yml`):

   ```yaml
   name: Deploy
   on: { push: { branches: [master] } }
   permissions: { pages: write, id-token: write, contents: read }
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 20 }
         - run: npm install && npm run build
         - uses: actions/upload-pages-artifact@v3
           with: { path: dist }
     deploy:
       needs: build
       runs-on: ubuntu-latest
       environment: { name: github-pages }
       steps:
         - uses: actions/deploy-pages@v4
   ```

3. Abilita Pages in repo Settings → Pages (branch `gh-pages` o GitHub Actions).
4. Apri `https://tuonome.github.io/etoro-dashboard/`.

Per una user/organization page (`tuonome.github.io`) funziona senza modifiche; per project page il `base: './'` relativo gestisce già il sottopercorso.

## Sviluppo locale

```bash
npm install
npm run dev
```

## Sicurezza

- Le chiavi API non lasciano mai il browser (localStorage). Non usare chiavi Write/Real su dispositivi non tuoi.
- La modalità auto-esecuzione senza conferma è **disattivata di default** e richiede presa visione esplicita. Il kill switch interrompe tutte le regole (non chiude le posizioni aperte).
