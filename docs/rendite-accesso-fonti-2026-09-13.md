# Rendite: blocchi delle fonti dalla rete Cloudflare

> Aggiornamento: la successiva integrazione gratuita ha superato il controllo reale Cloudflare sui 62 strumenti. Vedere [verifica e soluzione gratuita](rendite-gratuite-2026-09-13.md). Il seguito conserva la diagnosi precedente; la necessità prospettata di una chiave EODHD è superata.

## Evidenza del nuovo problema

Dopo la pubblicazione del commit `b245e1b`, gli endpoint di produzione AAPL e 6758.T rispondono 502 con errore upstream 403 da Stock Analysis. CNDX.L risponde 200 tramite iShares e il cambio BCE risponde 200. L’ETC 8PSG.DE incontra invece un 406 da Invesco. Non è un errore di autenticazione eToro.

La prova precedente 62/62 riguardava richieste reali eseguite dal computer locale. I test workerd verificavano il runtime con risposte controllate. Nessuna delle due prove dimostrava che la rete del fornitore accettasse gli IP Cloudflare: il recupero in produzione rimane incompleto.

## Prove di accesso alternative

È stata avviata e poi arrestata un’anteprima temporanea `wrangler dev --remote` con un Worker separato, privo di binding, cron, asset, database o credenziali eToro. Questa anteprima non sostituisce il Worker produttivo.

- Yahoo Finance chart: 200 dal computer locale; 429 da Cloudflare su AAPL, 6758.T, VOD.L, ASML.AS, EFA e 8PSG.DE. Non introdotto come fallback nella dashboard.
- API demo ufficiale EODHD: 200 da Cloudflare per AAPL.US, con quattro dividendi in USD nel periodo 13/09/2025–13/09/2026 e date di pagamento. La somma storica restituita è 1,06 USD per quota. Differisce dall’importo annuo pubblicato di 1,08 USD perché rappresenta i pagamenti degli ultimi dodici mesi; non vanno mescolati senza etichetta.
- La demo non verifica copertura o accuratezza degli altri 61 strumenti: servono una chiave personale e controlli sulle singole quotazioni e valute.

Riferimenti: [sviluppo remoto Cloudflare](https://developers.cloudflare.com/workers/local-development/), [API dividendi EODHD](https://eodhd.com/financial-apis/api-splits-dividends), [piani EODHD](https://eodhd.com/pricing). La documentazione indica 20 richieste giornaliere gratuite e limitazioni sui dati accessibili. Non sono sufficienti per interrogare 62 titoli individualmente in un solo giorno. Il piano All World e la copertura necessaria vanno verificati prima di acquistare. Nessun servizio sottoscritto e nessun costo ricorrente autorizzato.

## Correzione locale della diagnosi

Il Worker distingue accesso negato (403/406), limite richieste (429) e indisponibilità generica. Il client interpreta anche i vecchi errori già in cache. La pagina mostra un avviso complessivo sul recupero bloccato, conserva i dati mancanti come sconosciuti e non propone di riprovare ogni riga bloccata. Rimossa la promessa incondizionata di non aver bisogno di altre chiavi.

L’utente ha confermato di non avere un servizio dati dedicato. Il recupero completo resta da risolvere tramite una fonte accessibile e una scelta sui limiti/costi; la sola correzione dei messaggi non risolve il 403. Nessun nuovo deploy di produzione eseguito in questa sessione.
