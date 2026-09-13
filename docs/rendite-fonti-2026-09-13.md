# Rendite: correzione delle fonti segnalate il 13 settembre 2026

## Problema e correzione

La produzione rispondeva HTTP 502 alle richieste dei dividendi e dei cambi: `redirect: 'error'` è rifiutato dal runtime workerd. I precedenti test con fetch Node non rilevavano questa incompatibilità. Il problema è stato riprodotto anche sull’endpoint pubblico AAPL prima del tentativo di rilascio.

Il recupero ora usa `redirect: 'manual'`, rifiuta esplicitamente ogni risposta 3xx e non ne visita la destinazione. Mantiene host fissi, timeout, limiti di dimensione e verifica dell’identità del titolo. Non inoltra credenziali o dati del conto alle fonti. Le nuove generazioni delle cache invalidano gli errori precedenti, senza eliminare configurazioni utente.

Sono aggiunti i mercati `.T` (Tokyo), `.NV` (Amsterdam) e il suffisso eToro `.US`; gli altri suffissi sconosciuti restano rifiutati. Il parser riconosce anche importi seguiti dalla valuta, ad esempio `35.00 JPY`.

In assenza della pagina dividendi (solo HTTP 404), la pagina statistiche può confermare una società senza distribuzioni correnti: devono coincidere ticker, URL canonico, nome della società e dichiarazione esplicita, insieme al campo dividendo per quota non applicabile. Un dato semplicemente mancante, un errore HTTP o un formato ambiguo non diventano zero. L’assenza esplicita di pagamenti negli ultimi dodici mesi viene distinta dall’assenza di storico; uno storico recente in conflitto fa fallire il recupero.

## ETF ed ETC identificati

Il catalogo associa le esatte quotazioni a ISIN e prodotto dell’emittente. La sola presenza nel catalogo non assegna un rendimento: la politica di distribuzione viene recuperata dal sito dell’emittente e controllata a ogni rinnovo della cache.

| Quotazione | ISIN | Fonte primaria | Trattamento dei proventi |
| --- | --- | --- | --- |
| CNDX.L | IE00B53SZB19 | [iShares NASDAQ 100](https://www.ishares.com/uk/individual/en/products/253741/CNDX?siteEntryPassthrough=true&switchLocale=y) | Accumulazione |
| CBU0.L | IE00B3VWN518 | [iShares Treasury 7–10 anni](https://www.ishares.com/uk/individual/en/products/253745/ishares-usd-government-bond-710-ucits-etf-acc-fund?siteEntryPassthrough=true&switchLocale=y) | Accumulazione |
| DTLA.L | IE00BFM6TC58 | [iShares Treasury 20+ anni](https://www.ishares.com/uk/individual/en/products/297191/ishares-treasury-bond-20%20yr-ucits-etf?siteEntryPassthrough=true&switchLocale=y) | Accumulazione |
| CSP1.L | IE00B5BMR087 | [iShares Core S&P 500](https://www.ishares.com/uk/professionals/en/products/253743/cspx?siteEntryPassthrough=true&switchLocale=y) | Accumulazione |
| 2B76.DE | IE00BYZK4552 | [iShares Automation & Robotics](https://www.ishares.com/uk/professionals/en/products/284219/ishares-automation-robotics-ucits-etf-usd-acc-fund?siteEntryPassthrough=true&switchLocale=y) | Accumulazione |
| 8PSG.DE | IE00B579F325 | [Invesco Physical Gold ETC](https://www.invesco.com/uk/en/financial-products/etfs/invesco-physical-gold-etc.html) | Nessuna distribuzione |

Per iShares si controllano i componenti strutturati `keyFundFacts` e `listings`: identificativo del prodotto, ISIN, RIC della quotazione, valuta e `Use of Income = Accumulating`. Il dividendo cash è zero perché i proventi rimangono nel fondo. Non è zero rendimento totale del fondo. Una diversa classe a distribuzione non supera il controllo.

Per Invesco si verificano URL canonico, ISIN, nome del prodotto, forma ETC e metadato `distribution = None`. L’associazione 8PSG/ISIN è documentata anche dalla [scheda ufficiale Invesco per Xetra](https://www.invesco.com/content/dam/invesco/emea/de/product-documents/etf/share-class/factsheet/IE00B579F325_factsheet_de.pdf). Lo zero cash è espresso in EUR, senza inventare una valuta di pagamento per un prodotto che non distribuisce.

L’interfaccia mostra la distinzione e il nome dell’emittente come fonte, anziché indicare sempre Stock Analysis. I dividendi annui pubblicati restano stime sulle quote attuali, separati dagli accrediti realmente ricevuti.

## Verifiche

- Recupero HTTP reale con il nuovo handler su tutti i **62 simboli identificabili nel testo segnalato: 62 risposte valide**, 44 con importo annuo positivo e 18 con assenza di distribuzioni confermata secondo i criteri sopra. Nessun importo mancante convertito per convenienza in zero.
- Cambi BCE disponibili, data di riferimento **11 settembre 2026**; conversioni comprendenti JPY, EUR, USD e GBP.
- **42 test Rendite**, **3 test nel runtime workerd**, **138 test Worker**, **27 test scheduler**, **30 test client Autopilot**: **240 superati**.
- I test workerd eseguono il Worker effettivo con la data di compatibilità di produzione. Il servizio remoto è sostituito da risposte controllate; `fetch` e la validazione dei redirect sono quelli reali del runtime. Nessun binding D1, KV, AI, cron o conto eToro nei test workerd.
- I tre test workerd coprono dividendi e BCE senza cache, mancato inseguimento dei redirect, fonti degli emittenti e fallback delle statistiche. Ora fanno parte dei controlli obbligatori del workflow di deploy.
- Build TypeScript/Vite, lint, controllo del diff e `wrangler deploy --dry-run` superati. Rimangono gli avvisi già presenti sulle dimensioni del bundle e sull’aggiornamento Browserslist.
- Nessun ordine o invocazione AI effettuati dalle verifiche. Le richieste reali usano soltanto dati pubblici.

## Stato del rilascio

La correzione è presente nel workspace e il bundle è pronto. Il 13 settembre 2026 il controllo automatico delle autorizzazioni ha rifiutato `wrangler deploy`: il Worker include anche scheduler e funzioni operative con D1/KV e richiede un consenso esplicito alla pubblicazione in produzione. Il comando non è stato eseguito. Il recupero 62/62 descritto sopra è una prova delle fonti reali tramite il nuovo handler locale, non una verifica della versione attualmente pubblicata. Dopo l’approvazione occorre pubblicare e ripetere il controllo sugli endpoint di produzione.
