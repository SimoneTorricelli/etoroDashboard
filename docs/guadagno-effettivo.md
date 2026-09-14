# Guadagno effettivo automatico

La homepage legge automaticamente lo storico reale eToro, senza moduli di inserimento, riepiloghi manuali o importazioni richieste all’utente. Il precedente archivio manuale non viene più usato né modificato.

## Dati e calcolo

- `GET /api/v1/trading/info/trade/history`: richiesta dal 2000, `pageSize=500`, lettura di tutte le pagine fino alla prima pagina vuota, anche se la dimensione è limitata silenziosamente dal broker. La data iniziale precede l’attività della piattaforma; non viene confusa con la data di apertura del conto. La UI mostra la prima chiusura effettivamente ricevuta.
- Se eToro rifiuta esplicitamente il range con 400/422, ripiega sui 364 giorni precedenti e rende evidente che il periodo è limitato. Errori di autenticazione, rete o quota non attivano un falso fallback riuscito.
- Il risultato realizzato è la somma di `netProfit`, comprese le perdite. L’investimento iniziale non entra nel calcolo. Commissioni non sottratte una seconda volta. Gli utili restano nel risultato anche dopo reinvestimenti o prelievi, perché resta la chiusura che li ha generati.
- Le chiusure parziali sono distinte tramite posizione, timestamp, ordine e unità. Le sovrapposizioni tra pagine sono deduplicate; conflitti, pagine ripetute, dati invalidi o interruzioni impediscono di pubblicare un totale parziale come riuscito.
- `GET /api/v1/trading/info/real/pnl`: somma esclusivamente il P&L delle posizioni aperte manuali e dei mirror, senza aggiungere `closedPositionsNetProfit` già presente nello storico. Dati mancanti restano non disponibili.
- Grafico mensile/annuale dei profitti realizzati cumulati e tabella annuale manuali/copy. Il P&L aperto attuale non viene retrodatato.

Sincronizzazione ogni cinque minuti mentre la homepage è aperta, cache pagine di un minuto tramite RequestManager, abort alla navigazione/cambio conto. Dopo la prima lettura completa, il provider conserva lo storico in memoria e rilegge l’intervallo recente, con un giorno di sovrapposizione: le operazioni di quell’intervallo vengono sostituite per recepire correzioni senza duplicati. Il pulsante Aggiorna richiede una nuova lettura completa. Una pagina già in volo è condivisa senza ereditare il segnale annullato da un remount React StrictMode. Il P&L aperto viene letto dallo stesso endpoint eToro a ogni sincronizzazione, senza usare aggregati mirror che potrebbero contenere profitti chiusi. Errori di aggiornamento rendono visibile la data della precedente sincronizzazione. Nessuna chiave viene registrata nel risultato o nei log.

## Copertura e limite economico

Il profitto delle operazioni NON certifica da solo il guadagno economico completo del conto. Dividendi, interessi, staking, bonus, commissioni e imposte fuori dai trade potrebbero non essere inclusi in `netProfit`. La UI lo indica vicino ai KPI. Le API Money/Cash sono relative al conto cash, non una prova del registro completo del conto trading: non vengono usate per inventare depositi/prelievi o contare due volte proventi.

La documentazione dei saldi limita la disponibilità ai dodici mesi recenti. Lo storico trade ha indicazioni restrittive sul lookback: l’app verifica la risposta effettiva e segnala i rifiuti. L’accettazione di una richiesta dal 2000 non prova da sola l’assenza di una troncatura silenziosa del broker; viene mostrata la prima data restituita, senza dichiarare una copertura dall’apertura.

Importi in USD, senza applicare retroattivamente il cambio odierno. Non è una misura del risultato storico in EUR o del profitto fiscale.

## Sviluppo e verifiche

L’anteprima Vite dispone di un relay locale limitato a due endpoint GET (storico chiusure e P&L reale), destinazione fissa public-api.etoro.com, controllo dell’origine e timeout. Non espone azioni di trading e non modifica il proxy di produzione.

`npm run test:profit` verifica paginazione, deduplica, chiusure parziali, reinvestimenti, perdite, copy, range negati, autenticazione, errori a metà lettura, cancellazione, campi mancanti e aggregazioni temporali. `npm run build` verifica i tipi e la build.

Fonti: [storico trade](https://api-portal.etoro.com/api-reference/trading--real/list-trading-history), [saldi storici](https://api-portal.etoro.com/api-reference/balances/get-historical-balances-by-account-type), [movimenti Cash](https://api-portal.etoro.com/api-reference/cash-accounts/list-cash-account-transactions-paginated).
