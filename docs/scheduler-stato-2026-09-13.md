# Ribilanciamenti: registro persistente e recupero

Primo blocco del resto del piano, sviluppato dopo la sezione Rendite su richiesta di Simone. Base: `e61024517a3d2ae373e2ed95a837f6f11c5f9c6d`. Le prescrizioni degli allegati restano contesto di progetto; la richiesta attuale autorizza lo sviluppo, senza trasformare gli esempi finanziari in ordini da inviare.

## Stato

- **ET-01, parziale:** verificati codice e stato della pipeline di rilascio. La causa dell’incidente storico di lunedì resta non dimostrata: mancano configurazione D1 storica, log e ordini del conto. Il 31 agosto è ancora una data candidata, non confermata.
- **ET-02, primo blocco:** il pannello “Pianificazione e recupero” in Autopilot mostra prossima scadenza calcolata sul server, ultimo tick ricevuto, recupero, tentativi, motivi e collegamento alla run. Distingue run conclusa da ordini effettivi; segnala cron non recente, configurazione da recepire, backlog ed esiti incerti.
- **ET-03, implementazione locale:** calendario civile, journal D1, recupero del lavoro non ancora iniziato, claim atomico sotto il lock globale esistente, riconciliazione degli esiti persistiti. Non è ancora verificato sul Worker di produzione.

## Comportamento

Il cron diventa `* * * * *`. I tick vuoti interrogano D1, senza chiamare modelli, provider di mercato o la pipeline. I tick giornalieri passano da 96 a 1.440: il costo dei controlli D1 aumenta, senza moltiplicare per 15 le analisi AI. Snapshot e heartbeat restano orari; il rebalance mantiene la cadenza scelta.

`schedule_state` conserva versione attiva, fingerprint di calendario/strategia/binding/safety, attivazione, cursore, timestamp del cron e ricezione effettiva. `schedule_occurrences` conserva identità univoca `(strategy_id, schedule_version, kind, due_at_utc)`, ora locale, deadline, tentativi, claim, conclusione, codice motivo e run. `strategy_id = primary` corrisponde all’unica strategia attiva supportata dall’executor attuale.

Ogni salvataggio esplicito del calendario incrementa atomicamente `scheduleRevision` e registra `scheduleChangedAt` nella configurazione. Anche A→B→A fra due tick invalida le vecchie attese. Le scritture di sola telemetria non incrementano questa revisione. I campi interni non sono modificabili dal client e non invalidano, da soli, il fingerprint di una decisione finanziaria riutilizzabile.

Il primo avvio comincia dall’istante di attivazione, senza inventare osservazioni o recuperare acquisti anteriori al rilascio. Successivamente le scadenze dall’ultimo cursore sono inserite insieme all’avanzamento del cursore in un batch transazionale. Un’interruzione lunga viene scandita in lotti di 24 ore, senza eliminare il backlog. Una modifica del calendario salvata prima dell’orario resta applicabile alla scadenza imminente, anche se il primo tick che la osserva arriva dopo.

Il recupero del rebalance è di **60 minuti**, configurabile da 1 a 180. Snapshot: 5 minuti; heartbeat: 2 minuti. Il dispatcher dà precedenza al rebalance e avvia al massimo una pipeline per tick. Lock occupato o indisponibile lascia la scadenza pendente. La deadline e la configurazione sono ricontrollate sotto lock prima del claim. Una scadenza scaduta resta visibile come `expired`.

Il claim associa una sola run alla scadenza **prima** dell’avvio della pipeline. Se il processo cade prima del claim, il tick successivo può riprovare; se cade dopo, non viene assegnata una seconda run. Se `runs.finished_at` esiste, il journal ne recupera l’esito; altrimenti, terminato il lease, registra `needs_review`. Un esito incerto o parziale non genera un nuovo invio automatico della stessa scadenza. I controlli esistenti di safety, recovery, consenso Live e fencing dell’executor restano autorevoli.

Europe/Rome è esplicito: il ritorno all’ora solare usa una sola occorrenza; un orario inesistente nel passaggio all’ora legale viene registrato come saltato. Per quel record, che non corrisponde a un vero istante locale, `due_at_utc` è un marcatore sintetico un millisecondo prima del candidato dopo il salto, distinto dagli slot eseguibili; `local_due` conserva l’orario richiesto. Un giorno mensile 29–31 assente viene portato all’ultimo giorno del mese. Il daily esclude sabato e domenica.

## Limiti intenzionali del blocco

- Festività, sessioni effettive e mercato chiuso vengono valutati dalla pipeline esistente. Un blocco di mercato resta terminale per quella scadenza: non è ancora implementato `waiting_market` con nuova validazione all’apertura. Nessun rilancio automatico di generici errori o violazioni per tentare di aggirarle.
- Modifiche alla strategia o allo stato di sicurezza invalidano le scadenze pendenti; il registro non cambia modalità né riattiva Live.
- Deduplica dimostrata al confine scheduler/pipeline, non una nuova garanzia universale “exactly once” del broker. ET-06 (intenti condivisi, prenotazioni, recovery completa) resta una fase successiva. Le prove di POST/partial sono simulazioni locali; nessuna transazione eToro è stata inviata.
- Mancano la verifica D1 remota e l’osservazione di un cron reale dopo il rilascio. Non sono stati pubblicati codice, migrazioni o cambi di calendario remoto in questa sessione.
- Watcher continuo, feed streaming, multi-strategia, gestione uscite e ulteriori approfondimenti Rendite restano nel piano successivo. Il lavoro qui non li dichiara completati.

## Verifiche

- 27 test scheduler su SQLite reale tramite adapter D1: orari 09:00/09:30/fuori griglia, ritardi, busy, replay, claim concorrenti, scadenza esatta, crash prima/dopo claim e dopo finishRun, ordine parziale simulato, DST, mesi corti, weekend/festività, cambio calendario A→B→A, modifica prima della scadenza, batch fallito, backlog e stato API autenticato.
- 30 test client Autopilot, incluso il nuovo contratto del journal; 138 self-test Worker; 16 test Rendite.
- Build TypeScript/Vite, lint mirato e bundle tramite `wrangler deploy --dry-run`.
- Verifica visuale del pannello in browser con una fixture temporanea esplicitamente simulata (attesa, blocco mercato, esito incerto). Fixture rimossa; nessun dato del conto usato.
- Restano gli avvisi frontend preesistenti su bundle grande e database Browserslist datato.

## Rilascio e audit ET-01

Il workflow [Deploy Worker del commit Rendite](https://github.com/SimoneTorricelli/etoroDashboard/actions/runs/34763090094) ha superato test e build ma è fallito nel deploy: `CLOUDFLARE_API_TOKEN` non era disponibile all’azione. Anche Wrangler locale non dispone dell’autenticazione Cloudflare. Quel workflow non certifica pertanto un aggiornamento della produzione. Eventuali pubblicazioni effettuate tramite altri canali non sono state verificate.

Per il rilascio occorre rendere disponibile il secret in [GitHub Actions → Secrets](https://github.com/SimoneTorricelli/etoroDashboard/settings/secrets/actions), verificare anche `CLOUDFLARE_ACCOUNT_ID`, quindi eseguire il normale workflow. Non incollare il token nei documenti o nel repository. Il workflow ora include anche test scheduler, client e Rendite.

Al deploy, `migrate()` applicherà le due tabelle e gli indici aggiuntivi al primo accesso API/cron; `worker/schema.sql` contiene le stesse definizioni. Le impostazioni Live persistite non vengono modificate. La propagazione del nuovo cron può richiedere fino a 15 minuti secondo Cloudflare. Il primo tick attiva il journal, poi `/agent/state.scheduler` consente di verificare la ricezione e il prossimo orario.

La debolezza statica del vecchio codice è confermata: confronto dell’ora/minuto esatti e abbandono del tentativo se il lock è occupato, senza journal o recupero. **Questo non prova la causa dell’incidente storico.** Il vecchio codice già usava `event.scheduledTime`, quindi la sola consegna tardiva di un tick non dimostra un errore di minuto. Il default resta lunedì **09:30**, distinto dall’aspettativa delle **09:00** citata negli allegati: non è stato cambiato arbitrariamente.

Per chiudere ET-01 servono data esatta, configurazione effettiva all’epoca, run/audit nella finestra interessata, cron/deploy attivi e confronto con gli ordini broker. La query allegata `incidents/et01-readonly.sql` proietta solo i campi pertinenti; non legge vault o credenziali.

## Riferimenti tecnici

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/): cron UTC, sintassi al minuto, propagazione e test locali.
- [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/): prepared statements e batch.
- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/): controllo e dry-run del rilascio.
