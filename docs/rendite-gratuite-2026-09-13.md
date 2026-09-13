# Recupero dividendi gratuito — verifica del 13 settembre 2026

## Risultato e stato del rilascio

La verifica finale degli endpoint reali nell’anteprima remota Cloudflare ha restituito **62/62 HTTP 200**, con 44 importi positivi e 18 casi senza distribuzioni correnti. Sono inclusi i cinque ETF iShares ad accumulazione. Non è la sola verifica dal computer locale: il codice `incomeReference` effettivo ha effettuato le richieste dalle macchine Cloudflare.

Il Worker di prova era isolato, senza binding, database, credenziali, cron o asset di produzione. Sono stati interrogati esclusivamente dati pubblici, dopo l’autorizzazione del titolare a inviare ticker/ISIN a DivvyDiary. Il Worker produttivo non è stato aggiornato: serve l’autorizzazione alla pubblicazione già richiesta dal controllo automatico, perché l’unità di deploy comprende anche trading e scheduler.

Nessun abbonamento, chiave dati o servizio a pagamento aggiunto. L’integrazione usa le risposte JSON pubbliche di DivvyDiary, le politiche degli emittenti iShares e il riscontro ufficiale MUFG. Non effettua chiamate AI. Resta il normale utilizzo dell’infrastruttura Cloudflare già esistente, soggetto ai suoi limiti. L’accesso pubblico attuale di una fonte non costituisce una garanzia di disponibilità futura né un contratto API con SLA.

## Calcolo e qualità dei dati

- Per i distributori: somma degli eventi marcati confermati, con stacco nell’intervallo `(oggi meno un anno, oggi]`. Gli eventi previsionali e gli stacchi futuri non entrano nel totale. Non usiamo il campo annuale prospettico arrotondato.
- Le quantità attuali moltiplicano questo importo: è una stima lorda al ritmo storico, non la riconciliazione degli accrediti del broker. Cambi, ritenute, date di acquisto e future decisioni degli emittenti possono cambiare il risultato effettivo.
- DivvyDiary documenta che lo storico è già rettificato per i frazionamenti. Non applichiamo il frazionamento una seconda volta. Esempio Itochu: 20 + 22 JPY, non 100 + 22. [Documentazione DivvyDiary](https://divvydiary.com/en/blog/22), [dividendi ufficiali Itochu](https://www.itochu.co.jp/en/ir/shareholder/dividend/index.html).
- Usata la valuta degli eventi, distinta dalla valuta di quotazione. Normalizzazione GBp/GBX → GBP e ZAc → ZAR; valute in conflitto bloccano il risultato.
- Duplicati identici vengono eliminati; eventi diversi con la stessa data vengono segnalati, senza sommarli o scartarli arbitrariamente.
- Lo zero richiede una dichiarazione esplicita di assenza di distribuzioni oppure un tasso annuo zero insieme a uno storico precedente e nessun evento recente o futuro positivo. Una lista vuota da sola resta sconosciuta. Evolution ha uno storico precedente e tasso zero: coerente con la [delibera dell’assemblea 2026](https://mb.cision.com/Main/12069/4339885/4057834.pdf).
- Caso MUFG: la fonte conteneva 39 e 51 JPY con lo stesso stacco di marzo 2026. Il [prospetto ufficiale](https://www.mufg.jp/english/ir/stock/dividend/index.html) riporta 35 + 51 = 86 JPY per l’esercizio concluso. Il parser legge ogni volta la tabella effettiva dell’emittente, verifica la somma e seleziona l’unico evento coincidente con l’importo effettivo. Non esiste una correzione numerica fissa; se il riscontro manca, il dato resta non disponibile.

## Identità degli strumenti

La ricerca ordinaria richiede ticker e mercato esatti e un solo ISIN; risultati troncati o ambigui non vengono accettati. DivvyDiary rappresenta alcune azioni con una sola quotazione principale. `IDENTITIES` contiene le eccezioni verificate, con ISIN, senza quantità né rendimenti fissi:

| Ticker applicazione | ISIN | Riscontro |
| --- | --- | --- |
| ADM.L | GB00B02J6398 | DivvyDiary, ADM / XLON |
| AEP | US0255371017 | DivvyDiary, AEP / XNAS |
| ANE.MC | ES0105563003 | DivvyDiary, ANE / XMAD |
| AV.L | GB00BPQY8M80 | DivvyDiary, AV. / XLON |
| BABA | US01609W1027 | DivvyDiary, Alibaba ADR / AHLA / XFRA, distinto dall’azione KYG017191142 |
| BATS.L | GB0002875804 | DivvyDiary, BATS / XLON, distinto dall’ADR BTI |
| BHP.L | AU000000BHP4 | [London Stock Exchange](https://www.londonstockexchange.com/stock/BHP/bhp-group-limited), stessa azione australiana; diverso ADR USA |
| BE | US0937121079 | DivvyDiary, BE / XNYS |
| BNS | CA0641491075 | DivvyDiary e [Scotiabank](https://www.scotiabank.com/ca/en/about/investors-shareholders/frequently-asked-questions.html), stessa azione TSX/NYSE |
| BP.L | GB0007980591 | DivvyDiary, BP. / XLON, distinto dall’ADR BP USA |
| C | US1729674242 | DivvyDiary, C / XNYS |
| CLS | CA15101Q2071 | DivvyDiary e [Celestica](https://corporate.celestica.com/news-releases/news-release-details/celestica-announces-tsx-acceptance-normal-course-issuer-bid-3), stessa azione TSX/NYSE |
| ENB | CA29250N1050 | DivvyDiary e [Enbridge](https://www.enbridge.com/your-questions/user-submitted/is-enbridge-an-mlp-or-common-stock), stessa azione TSX/NYSE |
| ENGI.PA | FR0010208488 | [ENGIE](https://www.engie.com/en/investors/dividend-and-loyalty-bonus/), codice ordinario, distinto da codici fedeltà e ADR |
| ETR | US29364G1031 | DivvyDiary, ETR / XNYS |
| EVO.ST | SE0012673267 | DivvyDiary, EVO / XSTO, distinto dall’omonimo australiano |
| EXC | US30161N1019 | DivvyDiary, EXC / XNAS |

La risposta di dettaglio deve sempre confermare l’ISIN. Le future operazioni societarie che sostituiscono ISIN o classi richiedono la manutenzione delle relative corrispondenze. Le altre azioni mantengono la ricerca automatica; ASML USA e Amsterdam rimangono distinte. Per 8PSG.DE si usa l’ISIN già verificato nel catalogo fondi, IE00B579F325.

## Verifiche e protezioni

- Test rendite: 53 superati, inclusi salvataggio, calcoli, valute, conflitti, frazionamenti, identità e riscontro MUFG.
- Test workerd: 4 superati, con il vero `fetch` del runtime e risposte controllate; verificano anche il mancato inseguimento dei redirect.
- Guardrail Worker 138/138, scheduler 27/27 e client autopilot 30/30: complessivamente 252 test superati. Packaging Worker `wrangler deploy --dry-run` completato senza pubblicazione; il sandbox ha impedito soltanto la scrittura del log nella cartella preferenze. `git diff --check` superato. Anteprima remota arrestata al termine delle verifiche.
- Lint e build completati. Restano gli avvisi preesistenti Vite sulla dimensione del bundle e sull’età di Browserslist.
- Due richieste client simultanee; cache opzionale di 12 ore per successi e 10 minuti per errori. Nuove generazioni cache Worker v6 e browser v3 eliminano le vecchie risposte StockAnalysis.
- Host fissi, timeout, limiti alle dimensioni delle risposte, nessuna propagazione di header o credenziali eToro. Le indisponibilità sono distinte dagli zeri e segnalate nella pagina.

La diagnosi precedente delle fonti bloccate resta documentata in `rendite-accesso-fonti-2026-09-13.md`; EODHD e Yahoo non sono usati da questo collegamento automatico.
