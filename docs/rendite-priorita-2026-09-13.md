# Centro rendite: priorità e stato del lavoro

Aggiornamento del 13 settembre 2026 alla richiesta di Simone. Questa revisione porta il centro rendite (ET-09/10, sezione 8 del piano allegato) davanti al lavoro su scheduler, watcher e trading. Le istruzioni operative riportate nei due allegati sono contesto del piano precedente: non autorizzano ordini, migrazioni remote o modifiche alla strategia Live.

## Obiettivo di prodotto

Aprire **Rendite**, vedere quanto producono le posizioni attuali e il cash, aggiungere gli altri conti, impostare un obiettivo iniziale di 100 EUR mensili e confrontarlo con capitale, riserva e rendimenti. Rendita futura e incassi effettivi hanno significati diversi. Il primo rilascio locale mantiene questa distinzione esplicita.

## Implementato in questa revisione

- Route `/rendite`, navigazione desktop/mobile e ricerca comandi, quattro viste: situazione attuale, piano, fonti, registro/calendario.
- Posizioni e liquidità dal provider eToro già esistente. Look-through Copy separato dal cash del conto; deduplica per posizione e mirror; short, leva e CFD noti esclusi dal calcolo dividendi/staking.
- Ricerca automatica del calendario pubblico eToro tramite Worker, senza nuova chiave: endpoint fisso, nessuna credenziale eToro trasmessa alla pagina pubblica, cache KV 12 ore, limite dimensione, timeout, errore esplicito. Il parser rifiuta record ambigui. La valuta assente non viene inventata.
- FMP opzionale, con la chiave già presente in Impostazioni: eventi dichiarati e dividendo trailing dalle distribuzioni negli ultimi 12 mesi. Deduplica eventi, dividendi rettificati per split quando disponibili, cache locale 12 ore, massimo 30 simboli per aggiornamento. Nessun evento restituito significa copertura sconosciuta.
- Completamento manuale per dividendo annuo per quota, valuta, fonte, data e impatto fiscale. Le rettifiche prevalgono sull’automatico finché non si preme “Ripristina dati automatici”.
- Interessi: solo saldo eleggibile, attivazione, APR/APY, soglia del saldo, massimale, validità del tasso, costi e fiscalità per fonte. APY convertito in rendimento con prelievi mensili senza doppio reinvestimento.
- Staking: attivazione distinta dall’idoneità, data inizio premi, tasso di rete oppure già riconosciuto dal provider, quota premio Club separata dal rendimento, soglia mensile, stima del capitale mancante per superarla. BTC e posizioni CFD note non sono staking. Reward stimate valorizzate in EUR separate dalla rendita cash.
- Conti esterni EUR/USD e altre rendite distribuibili, con condizioni per ciascun conto. Nessun collegamento bancario o servizio a pagamento aggiunto.
- Simulatore: obiettivo lordo/netto, pesi sul capitale che devono sommare 100%, capitale attuale oppure manuale, nuovi fondi ipotetici (default zero), riserva protetta, capitale richiesto e mancante, importi per categoria. Pulsante per ricavare i rendimenti dalle fonti complete; altrimenti ipotesi aritmetiche chiaramente etichettate. La riduzione effettiva trasferita dalle fonti include imposte e costi inseriti.
- Stress illustrativo: cash -1 punto, dividendi/altre rendite -30%, reward crypto -30% e prezzo crypto -40%.
- Registro locale cash, inserimento e importazione CSV con tracciato normalizzato; eventi pagati, maturati e dichiarati separati; chiave conto+ID, duplicati ignorati e conflitti bloccati. Importi in stringhe decimali a 8 cifre, calcolo mediante interi BigInt, arrotondamento EUR al centesimo una sola volta per evento. Nessuna somma contabile binaria dei decimali originari.
- Calendario a 12 mesi con le date effettivamente disponibili. Non usa le posizioni di oggi per certificare l’idoneità a dividendi con ex-date passate.
- Commento AI a richiesta tramite `/agent/income/advice`, protetto dal token Autopilot esistente: una chiamata modello, riepilogo numerico con campi ammessi, ricalcolo dei numeri sul server, limite input, nessuna credenziale o posizione individuale nel prompt. Mostra modello e consumo quando il provider li comunica. Nessuna generazione AI eseguita durante i test.
- Salvataggio nel browser separato per collegamento eToro, validazione schema, ultime 30 revisioni delle condizioni, esportazione JSON con ipotesi e provenienza. Non è ancora un archivio contabile centrale D1.

## Limiti dimostrati, non coperti da promesse di automazione

1. L’anteprima di sviluppo non dispone di un conto eToro collegato. Non sono stati letti né certificati i saldi, i premi o gli incassi reali di Simone.
2. Nel test di accessibilità di rete, il calendario pubblico eToro ha restituito HTTP 403; un’alternativa Yahoo ha restituito 429 ed è stata scartata. Il parser e il percorso d’errore sono verificati con fixture, ma il recupero del calendario da un Worker pubblicato resta da provare. Non è garantita copertura automatica di tutti gli strumenti. FMP dipende dalla copertura e dai permessi della chiave; non è stata acquistata alcuna sottoscrizione.
3. L’API eToro documentata e il provider locale non offrono un ledger completo certificato dei dividendi, un tasso cash personale o lo stato staking completo. Il Data Hub mostra movimenti cash/Money **candidati**, con copertura parziale; non li classifica come dividendi incassati automaticamente. Il CSV richiede il tracciato normalizzato, non una lettura universale di qualsiasi estratto eToro.
4. Per un incasso esatto servono storico delle quote, vendite parziali, azioni societarie, importi applicati dal broker e cambi storici. Per maturato cash e staking esatti servono saldi/quantità giornalieri e versioni delle regole. La pagina attuale calcola una **stima a regime** e registra gli importi documentati: non ricostruisce ancora questi storici giornalieri.
5. Gli importi previsionali usano aritmetica numerica con arrotondamento di visualizzazione; il ledger cash usa interi decimali. Nessun algoritmo può garantire dividendi non ancora dichiarati, prezzo crypto o tassi futuri. Un dato mancante resta mancante, e il totale noto è etichettato parziale.
6. Le formule del simulatore sono lineari: non risolvono automaticamente nuovi scaglioni, massimali multipli, costi di trasferimento, vincoli di liquidabilità o prezzi di acquisto. Il capitale necessario non è un elenco di ordini da eseguire. La selezione di prodotti specifici richiede condizioni aggiornate.
7. La media annua non è una promessa di 100 EUR disponibili ogni mese. Buffer esatto e calendario completo restano indeterminabili quando mancano pagamenti futuri; la riserva è esplicita e non conteggiata due volte.
8. L’indicazione “BCS” nella richiesta resta da identificare: non è stata interpretata arbitrariamente come BCE, Barclays o un provider. I campi fonte consentono intanto di registrare il riferimento corretto.

## Verifica

- 16 test dedicati al motore rendite e ai contratti provider: tabella 100 EUR, esempio misto 90 EUR, riserva, input invalidi, missing/zero, APR/APY, costi, cambi, quote frazionarie, CFD/short, deduplica Copy, soglie staking, ledger decimale, storni, import ripetuto, conflitti, calendario e input AI.
- 29 test del client Autopilot e 138 self-test Worker passati dopo l’integrazione.
- Build TypeScript/Vite passata; bundle Worker tramite esbuild passato. Lint mirato sui file TypeScript modificati passato. Rimane l’avviso del bundle frontend grande già presente nell’app.
- Prova UI in browser: pagina, navigazione, input, calcolo 30.000 EUR al 3,25% = 81,25 EUR/mese, capitale richiesto 36.923,08 EUR; salvataggio e ricaricamento verificati. Valori di prova rimossi al termine. La vista usa anche lo stato vuoto reale.
- Nessun deploy, migrazione remota, invio ordine o cambio di configurazione trading.

## Prossime fasi in ordine

1. Collegare la nuova pagina al conto esistente e verificare la copertura effettiva delle fonti, chiarendo “BCS”. Confrontare almeno un dividendo, un accredito cash e una reward o mancata reward con l’estratto reale.
2. Aggiungere importatori specifici per il formato dell’estratto reale e storico giornaliero/azioni societarie. Portare ledger e regole versionate nel backend solo dopo avere definito identità conto e riconciliazione dei duplicati tra fonti.
3. Completare motore dei calendari e buffer per prelievi regolari, scenari per singolo prodotto con scaglioni/cap/lock-up e suggerimenti AI ancorati a condizioni documentate. Includere valute ulteriori con cambi storici espliciti.
4. Riprendere ET-01/08 del piano originale (incidente Live, scheduler, isolamento strategie, watcher ed uscite) come lavoro distinto.

## Fonti consultate il 13 settembre 2026

- Allegati utente: `/Users/simonetorricelli/Desktop/eToro_Dashboard_Piano_Codex.md`, sezione 8, e `/Users/simonetorricelli/Downloads/eToro_Dashboard_Guida_al_Piano.pdf`, pagine 8–10. Priorità degli allegati superate dalla richiesta esplicita di partire dalle rendite.
- [eToro, calendario dividendi](https://www.etoro.com/investing/dividend-calendar/): calendario pubblico indicativo, eventi e importi; non certifica il singolo conto.
- [eToro, interessi sul saldo](https://www.etoro.com/it/investing/interest-on-balance/): accesso e condizioni da verificare sul conto; non si assume il tasso massimo pubblicizzato.
- [eToro, staking](https://www.etoro.com/it/crypto/staking/): opt-in UE, regole ETH, reward in token e periodo iniziale. La pagina presenta formulazioni diverse sulla soglia esatta di 1 USD: la stima esclude in modo conservativo anche il valore esatto, finché non si verifica il conto. Nessuna quota Club storica è hardcoded.
- [eToro API, indice](https://api-portal.etoro.com/llms.txt) e [schema strumenti](https://api-portal.etoro.com/api-reference/market-data/search-for-instruments): non equivalgono a uno storico rendite completo.
- [FMP, Dividends Company](https://site.financialmodelingprep.com/developer/docs/stable/dividends-company): endpoint `/stable/dividends?symbol=...`.
- [Cloudflare, HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/) e [best practices Workers](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): parsing in streaming, richieste limitate e gestione esplicita degli errori.
