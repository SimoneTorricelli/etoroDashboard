# Rendite — revisione del flusso del 13 settembre 2026

Questa revisione risponde al feedback sulla sezione Rendite e ha precedenza sulle parti del piano precedente che richiedevano la compilazione manuale di dividendi, attivazioni e date per ogni strumento. Il lavoro già presente sullo scheduler è conservato.

## Comportamento

- Quattro viste: Oggi e domani, Il mio piano, Conti e tassi, Dati e accrediti.
- Salva modifiche esplicito, indicatore della bozza e conferma con data e ora. Validazione dei campi e rilettura della chiave salvata prima della conferma. Il vecchio formato viene migrato conservando importi e conti; una cronologia danneggiata non impedisce più il salvataggio principale. Un originale non leggibile viene copiato nel backup prima della sostituzione.
- Salvataggio locale per il collegamento eToro, mantenendo lo scope precedente: non è sincronizzazione tra dispositivi. Avviso del browser in caso di uscita/ricaricamento con modifiche. Le scelte vanno salvate prima di navigare verso altre pagine dell'app.
- Lordo predefinito. Il netto richiede una sola percentuale fiscale ipotizzata; nessuna aliquota fiscale è assunta come applicabile al conto.
- Contante eToro letto dal portafoglio. Interessi considerati attivi sulla base dell'indicazione del titolare, con un solo tasso annuo lordo da inserire, valido finché modificato. Condizioni particolari facoltative e richiuse.
- Conti esterni: nome, saldo, tasso e valuta EUR/USD; categoria interessi o altra rendita sul capitale.
- Staking attuale a zero sulla base dell'indicazione già ricevuta, senza checklist per moneta. Eventuali premi futuri possono essere indicati come media mensile complessiva. Non si presenta come lettura dell'attivazione eToro: l'API consultata non espone un registro completo dei premi o quel flag.
- Registro degli accrediti separato dalle stime, con importazione CSV facoltativa, importi decimali e deduplicazione. Non è necessario per visualizzare il prospetto.

## Dividendi automatici

Nuovi endpoint pubblici GET `/api/income/dividend?symbol=...&kind=stock|etf` e `/api/income/fx`, anche nell'anteprima Vite attraverso lo stesso handler del Worker. Il recupero invia solo il simbolo; non inoltra credenziali, quantità o saldi. Due richieste alla volta sul client, cache pubblica di 12 ore, timeout di 15 secondi, dimensione delle risposte limitata. Nessuna chiave aggiuntiva richiesta.

La fonte è Stock Analysis: viene letto il dividendo annuo pubblicato, con ticker, mercato, URL canonico, valuta della distribuzione, data di lettura e storico. Non si moltiplica arbitrariamente un singolo pagamento per quattro. Le diverse pagine possono riportare valori annuali prospettici o storici: l'interfaccia esplicita questo limite. La valuta dei dividendi UK è distinta dai pence usati per le quotazioni.

Verifica HTTP reale, attraverso l'endpoint locale, il 13 settembre 2026:

| Strumento | Dividendo annuo pubblicato per quota | Esito |
| --- | --- | --- |
| [AAPL](https://stockanalysis.com/stocks/aapl/dividend/) | 1,08 USD | disponibile |
| [TSLA](https://stockanalysis.com/stocks/tsla/dividend/) | 0 USD | assenza esplicita di storico |
| [ENEL.MI](https://stockanalysis.com/quote/bit/ENEL/dividend/) | 0,49 EUR | disponibile |
| [SAP.DE](https://stockanalysis.com/quote/etr/SAP/dividend/) | 2,50 EUR | disponibile |
| [VOD.L](https://stockanalysis.com/quote/lon/VOD/dividend/) | 0,041 GBP | disponibile |
| [VTI](https://stockanalysis.com/etf/vti/dividend/) | 3,90 USD | disponibile |

Cambi [BCE](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml) recuperati, data riferimento 11 settembre 2026. Per USD/EUR viene preferito l'eventuale cambio recente già presente nella sessione. La provenienza è visibile nella pagina.

Le quote frazionarie e i portafogli copiati vengono inclusi; posizioni short, con leva o identificate come CFD sono escluse dal modello di dividendi azionari. Dati mancanti/ambigui o cambi del formato della fonte restano non disponibili, non diventano zeri. L'assenza esplicita di storico non è una promessa di dividendi futuri nulli. Il collegamento HTML non offre uno SLA: la copertura del portafoglio reale va verificata quando è disponibile, senza chiedere al titolare di calcolare i dividendi.

Riferimenti ufficiali: [API strumenti eToro](https://api-portal.etoro.com/api-reference/market-data/search-for-instruments), [staking eToro](https://www.etoro.com/it/crypto/staking/), [interessi sul contante](https://www.etoro.com/it/investing/interest-on-balance/). Il tasso pubblicitario degli interessi non viene usato come tasso personale.

## Proiezioni e piano

Grafico a 1, 2 e 5 anni con capitale, versamenti e scenario di rendimento ridotto del 30%. Reinvestimento dal 0 al 100%, contributi a fine mese, riserva senza rendimento e capitale aggiuntivo. Le somme prelevate restano separate dal capitale; i risultati futuri indicano anche la rendita mensile potenziale.

Il tasso del modello può derivare dalla situazione attuale o dal mix scelto. Modificare il mix seleziona lo scenario del piano. Il prospetto calcola capitale richiesto per l'obiettivo, capitale mancante e versamento mensile necessario entro l'orizzonte scelto. Il mix iniziale è un esempio dichiarato. Prezzi, cambi e rendimenti sono costanti; gli accrediti sono mensilizzati per il modello. Limiti di prodotto, soglie staking e costi di spostamento non sono una verifica di fattibilità del mix. La curva prudente non è un intervallo statistico.

L'AI viene chiamata soltanto dal pulsante di analisi già previsto: inserimenti, aggiornamenti delle fonti e grafico non consumano chiamate al modello.

## Verifica e rilascio

- 35 test Rendite, inclusi migrazione, storage bloccato, rilettura fallita, virgole, formule a 12/24/60 mesi, reinvestimento/prelievi, rata per l'obiettivo, valute e varianti delle fonti.
- 30 test client Autopilot, 27 scheduler e 138 Worker: totale 230 superati.
- Build TypeScript/Vite, lint e bundle Worker con `wrangler deploy --dry-run` superati.
- Prova UI con portafoglio fittizio isolato: quattro dividendi recuperati senza compilazione, tasso 2,5%, salvataggio e reload, blocco di testo non numerico, conto esterno da 10.000 EUR al 3%, netto con una sola aliquota, orizzonti e prelievi separati. Verifica a 390 px e desktop. Dati e pagina temporanei rimossi; dati del titolare non modificati dalla prova.
- Nessun ordine o chiamata AI eseguiti. Nessun deploy eseguito. L'ultimo accertamento del workflow di produzione e il problema di autenticazione Cloudflare sono documentati in `scheduler-stato-2026-09-13.md`.
