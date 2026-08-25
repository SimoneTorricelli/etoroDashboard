# Piano Autopilot multi-strategy

## Scopo e decisione

Questo documento definisce il passaggio dell'Autopilot da una sola strategia server-side a più strategie indipendenti, ognuna collegata a un diverso Agent Portfolio eToro e potenzialmente attiva in modalità live.

La modifica è fattibile, ma va trattata come una separazione completa dello stato operativo, non come una semplice duplicazione della schermata. Il target iniziale è:

- massimo **3 strategie live** contemporaneamente;
- relazione **uno-a-uno** tra strategia attiva e Agent Portfolio eToro;
- configurazione, token, capitale, drawdown, ledger, run e ordini isolati per strategia;
- **concorrenza globale pari a 1** per le pipeline automatiche e manuali;
- budget e circuit breaker condivisi per ciascun provider AI;
- stop individuale per strategia e stop globale;
- stato autorevole nel Worker/D1, disponibile da desktop e mobile;
- nessuna modifica al comportamento delle cadenze daily e monthly;
- giorno della settimana univoco soltanto per le strategie weekly attive.

Non rientrano nella prima versione:

- più strategie sullo stesso Agent Portfolio;
- più di tre strategie live;
- esecuzioni parallele;
- sincronizzazione automatica e indiscriminata delle vecchie bozze locali;
- modifica degli ordini già accettati da eToro.

## Stato attuale: perché è single-strategy

### Configurazione

La configurazione corrente è un unico documento JSON identificato dalla chiave `autopilot`. `loadConfig()` e `saveConfig()` leggono e riscrivono quella sola riga (`worker/lib/db.js`, `CONFIG_KEY`, righe 183-223).

Nello stesso oggetto convivono:

- StrategySpec, onboarding, nome e scenario;
- modalità `shadow`, `dry-run` o `live`;
- freeze e motivazione;
- cadenza e orario;
- Agent Portfolio attivo e fingerprint del token;
- capitale gestito e inizio del tracking;
- universo, guardrail, watcher e configurazione LLM.

Le evidenze principali sono in `worker/lib/db.js`, `DEFAULT_CONFIG`, righe 30-180. Di conseguenza una nuova attivazione guidata sostituisce la strategia precedente: `/agent/strategy/activate` salva i nuovi campi nello stesso documento e forza la modalità shadow (`worker/lib/api.js`, ramo `strategy/activate`, circa righe 975-1087).

### Vault e binding eToro

Il vault ammette un solo campo `etoroAgentToken` e un solo record interno `__etoroAgentBinding` (`worker/lib/vault.js`, righe 16-35). `saveVerifiedAgentToken()` sostituisce token, binding e portfolio attivo in un'unica operazione (`worker/lib/vault.js`, righe 115-154).

Questa soluzione è corretta per una sola strategia, ma il secondo token sostituirebbe il primo. La verifica usa inoltre la config globale per confrontare portfolio, fingerprint e data di verifica (`worker/lib/vault.js`, `hasVerifiedAgentBinding()`, righe 193-204).

Il client eToro è già tecnicamente capace di:

- elencare più Agent Portfolio (`worker/lib/etoro.js`, `agentPortfolios()`, righe 497-512);
- generare un user token per un portfolio scelto (`worker/lib/etoro.js`, `createAgentUserToken()`, righe 535-553).

La limitazione è quindi nel modello di persistenza e orchestrazione interno, non nell'astrazione eToro già presente.

### Pipeline e stato operativo

`runPipeline()` non riceve uno `strategyId`: carica la config globale, risolve un solo binding e costruisce un solo client operativo (`worker/lib/pipeline.js`, righe 526-587).

Anche lo stato persistito è globale:

- `runs` non contiene `strategy_id` (`worker/schema.sql`, righe 10-20);
- `equity_curve` usa il solo timestamp come primary key (`worker/schema.sql`, righe 89-95);
- `holdings_ledger` usa il solo simbolo come primary key (`worker/schema.sql`, righe 97-107);
- `watcher_events` non contiene `strategy_id` (`worker/schema.sql`, righe 109-124);
- storico, HWM, drawdown, conteggio ordini e cooldown vengono letti senza filtro strategia (`worker/lib/db.js`, funzioni `recordEquity`, `countOrdersToday`, `loadLedger`, `countOpportunisticThisWeek`, `equityHistory`).

Senza una migrazione, due strategie che possiedono lo stesso ticker condividerebbero erroneamente holding period, cooldown e mediazioni al ribasso. Anche drawdown e massimo storico si contaminerebbero.

### Scheduler

Il cron corrente si attiva ogni 15 minuti e interpreta l'orario in `Europe/Rome` (`wrangler.jsonc`, riga 19; `worker/lib/pipeline.js`, `romeParts()` e `decideKind()`, righe 183-224). Rebalance usa ora e minuto esatti; snapshot e heartbeat restano orari. La seconda occorrenza dell'ora duplicata al ritorno all'ora solare viene soppressa.

L'handler, però, carica ancora una sola config e lancia al massimo una pipeline (`worker/index.js`, `scheduled()`, righe 173-187). Il ramo corrente introduce già un lock/lease globale single-strategy nella tabella `pipeline_lock` (`worker/schema.sql`, righe 13-18; `worker/lib/db.js`, schema iniziale e funzioni `acquirePipelineLock()`, `renewPipelineLock()`, `releasePipelineLock()`, circa righe 8 e 185-266): è il primo mattone per impedire la sovrapposizione delle pipeline automatiche e manuali.

Questo lock globale non è però una coda multi-strategy: non rappresenta quale strategia sia dovuta, non rende idempotente la consegna cron e non conserva il lavoro pendente. Mancano ancora `schedule_occurrences` persistenti e un dispatcher strategy-aware. Il `runId` include inoltre una componente casuale (`worker/lib/pipeline.js`, circa riga 547), quindi due eventi equivalenti possono produrre run diverse se non vengono deduplicati a monte.

### API e UI

`GET /agent/state`, `/agent/config`, `/agent/mode`, `/agent/freeze`, `/agent/trigger`, `/agent/runs` e gli endpoint del watcher operano senza `strategyId` (`worker/lib/api.js`, da circa riga 809). Anche gli strumenti MCP sono riferiti a un unico Autopilot (`worker/lib/mcp.js`, definizione strumenti e `callTool()`).

La pagina React mantiene un solo `AutopilotState`, una sola modalità e una sola scheda strategia; il pannello attivo legge `config.strategyDraft` e `config.guidedOnboardingAnswers` (`src/pages/Autopilot.tsx`, componente `Autopilot`, tab Strategia).

Esiste già una UI con più “Portafogli strategici” nella pagina Agent, ma è un sistema distinto:

- le strategie sono in `localStorage` (`src/lib/agent/strategy-portfolios.ts`, righe 104 e 228-257, 344-349);
- i token operativi temporanei sono in `sessionStorage` (`src/lib/agent/etoro-agent-api.ts`, righe 49 e 98-109);
- i binding fra strategia locale e portfolio remoto restano nel browser;
- la stessa UI dichiara che bozze, pesi e regole sono locali e che l'operatività 24/7 richiede il Worker (`src/components/agent/StrategyPortfolioStudio.tsx`, righe 542-545).

Questa seconda UI non deve diventare un control plane concorrente dell'Autopilot live. Potrà essere trasformata in un importatore o convergere sulle nuove API server-side.

## Invarianti di sicurezza

L'implementazione deve mantenere sempre questi vincoli:

1. Una strategia live può essere collegata a un solo Agent Portfolio e un Agent Portfolio può essere collegato a una sola strategia non archiviata.
2. Il token della strategia A non deve essere risolvibile né usato dalla strategia B.
3. Ogni run conserva `strategy_id`, versione della configurazione e portfolio di destinazione.
4. Equity, HWM, drawdown, ledger, watcher, ordini giornalieri e cooldown sono calcolati per strategia.
5. Lo stop individuale blocca soltanto la strategia selezionata; lo stop globale blocca tutte le strategie.
6. Prima di ogni POST live verso eToro vengono riletti stop globale, mode/freeze della strategia e versione autorizzata. La protezione già presente nell'executor single-strategy (`worker/lib/executor.js`, `liveSafetyBlock()`, righe 50-68) diventa strategy-aware.
7. Un errore nella lettura dello stato di sicurezza blocca l'ordine: comportamento fail-closed.
8. Una risposta AI assente, budget provider esaurito o validazione incompleta non genera ordini.
9. Il Worker/D1 è la fonte autorevole. Nessuna decisione live dipende da `localStorage` o dalla presenza di un browser aperto.
10. La prima release non supera tre strategie live e non esegue due pipeline contemporaneamente.

## Architettura target

### Separazione globale/per-strategia

Restano globali:

- owner eToro API key e user key;
- chiavi OpenRouter, Gemini, Groq e fonti esterne;
- credenziali di notifica;
- catalogo provider e politica di routing predefinita;
- stop globale;
- concorrenza globale;
- budget provider e cooldown;
- cache di catalogo strumenti, candele e contesto di mercato.

Diventano per-strategia:

- StrategySpec, onboarding, scenario e collaborazione multi-modello;
- Agent Portfolio, mirror e token verificato;
- modalità, freeze e motivazione;
- cadenza e orario;
- capitale, tracking, equity curve, HWM e drawdown;
- universo, shortlist e guardrail;
- ledger, cooldown e watcher;
- run, proposte, validazioni e ordini.

### Flusso operativo

```text
Cron / comando manuale
        │
        ▼
calcolo strategie dovute + occurrence idempotente
        │
        ▼
coda D1 ──► lease globale (concorrenza 1)
        │
        ▼
caricamento StrategyContext immutabile
        │
        ├─► binding/token specifico
        ├─► snapshot/equity/ledger specifici
        ├─► budget provider globale
        └─► cache mercato condivisa
        │
        ▼
AI → validatore → ultimo gate di sicurezza
        │
        ▼
ordini sul solo Agent Portfolio collegato
        │
        ▼
riconciliazione e audit strategy-scoped
```

`StrategyContext` deve contenere almeno `strategyId`, `configVersion`, `portfolioId`, binding verificato, config normalizzata e tipo/occurrence della run. Va costruito una volta per le fasi analitiche, ma lo stato di sicurezza deve essere riletto prima di ogni ordine live.

## Schema D1 proposto

Lo schema seguente è una specifica logica; la sintassi definitiva andrà consegnata tramite migrazioni D1 numerate e testate.

### `strategies`

Campi principali:

```sql
id                    TEXT PRIMARY KEY
name                  TEXT NOT NULL
lifecycle_status      TEXT NOT NULL  -- draft | active | paused | archived
execution_mode        TEXT NOT NULL  -- shadow | dry-run | live
frozen                INTEGER NOT NULL DEFAULT 0
frozen_reason         TEXT NOT NULL DEFAULT ''
cadence               TEXT NOT NULL  -- daily | weekly | monthly
rebalance_weekday     INTEGER
rebalance_day_of_month INTEGER
rebalance_hour        INTEGER NOT NULL
rebalance_minute      INTEGER NOT NULL
live_slot             INTEGER UNIQUE -- NULL oppure 1, 2, 3
config_json           TEXT NOT NULL
config_version        INTEGER NOT NULL DEFAULT 1
created_at            INTEGER NOT NULL
updated_at            INTEGER NOT NULL
archived_at           INTEGER
```

Vincoli:

- `rebalance_minute IN (0, 15, 30, 45)`;
- `live_slot IN (1, 2, 3)` quando valorizzato;
- una strategia `active/live` deve possedere un `live_slot`;
- una strategia non live non trattiene uno slot;
- l'API assegna atomicamente il primo slot libero quando abilita il live;
- `UNIQUE(live_slot)` rende strutturale il cap iniziale di **3 live**, anche sotto richieste concorrenti.

Il giorno weekly va normalizzato in colonna, non nascosto soltanto in `config_json`, per poter applicare il vincolo race-safe:

```sql
CREATE UNIQUE INDEX uq_active_weekly_weekday
ON strategies (rebalance_weekday)
WHERE lifecycle_status = 'active'
  AND cadence = 'weekly'
  AND archived_at IS NULL;
```

Questa regola vale anche per una strategia attiva in shadow o dry-run: il giorno viene prenotato quando la strategia è attivata. Una bozza non lo prenota; pausa o archiviazione lo libera. Se la strategia viene riattivata e il giorno è stato occupato nel frattempo, l'API risponde `409 Conflict` senza modificare lo stato.

Non devono esistere indici unici analoghi per `daily` o `monthly`.

### `strategy_bindings`

```sql
strategy_id       TEXT PRIMARY KEY REFERENCES strategies(id)
portfolio_id      TEXT NOT NULL UNIQUE
portfolio_name    TEXT NOT NULL
mirror_id         TEXT NOT NULL
token_ciphertext  TEXT NOT NULL
token_hint        TEXT NOT NULL
token_fingerprint TEXT NOT NULL
verified_at       INTEGER NOT NULL
status            TEXT NOT NULL -- verified | revoked | invalid
updated_at        INTEGER NOT NULL
```

Il token resta cifrato con AES-GCM. La derivazione della chiave può restare globale, ma la cifratura deve usare dati autenticati aggiuntivi legati almeno a `strategy_id` e `portfolio_id`, così un ciphertext spostato su un'altra riga non diventa valido.

Owner key e chiavi provider restano nel vault globale. I token Agent non devono più essere membri di un unico blob che viene riscritto interamente.

### Run e artefatti

Aggiunte minime:

- `runs.strategy_id NOT NULL` dopo il backfill;
- `runs.config_version NOT NULL`;
- `runs.occurrence_key` per l'idempotenza dello scheduler;
- `audit.strategy_id` per gli eventi non associati a una run;
- facoltativamente `orders.strategy_id` e `orders.portfolio_id` denormalizzati per audit e query rapide.

`snapshots`, `features`, `proposals` e `validations` possono continuare a dipendere dal `run_id`, purché ogni accesso verifichi che la run appartenga alla strategia richiesta.

Le tabelle con chiave globale vanno sostituite o migrate:

```sql
strategy_equity_curve (
  strategy_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  equity_usd REAL NOT NULL,
  invested_usd REAL,
  cash_usd REAL,
  hwm_usd REAL,
  PRIMARY KEY (strategy_id, at)
)

strategy_holdings_ledger (
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  instrument_id INTEGER,
  first_bought_at INTEGER,
  last_bought_at INTEGER,
  last_sold_at INTEGER,
  average_down_count INTEGER NOT NULL DEFAULT 0,
  opportunistic INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (strategy_id, symbol)
)
```

`watcher_events` riceve `strategy_id`; i conteggi opportunistici diventano strategy-scoped. Il conteggio ordini deve avere due livelli:

- limite per strategia, derivato dai suoi guardrail;
- limite globale dell'account, configurato separatamente come fusibile aggregato.

### Scheduler, coda e lease

```sql
schedule_occurrences (
  strategy_id TEXT NOT NULL,
  due_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,       -- pending | running | completed | failed
  run_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  leased_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (strategy_id, due_key, kind)
)

pipeline_lock (             -- tabella globale già introdotta nel runtime corrente
  lock_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  leased_until INTEGER NOT NULL
)
```

`schedule_occurrences` è la parte nuova che rende la pianificazione persistente, idempotente e strategy-aware. `pipeline_lock`, invece, resta il meccanismo globale già avviato nel runtime single-strategy e va riutilizzato/evoluto, senza creare una seconda lease concorrente. Il record globale implementa la **concorrenza globale 1**: ogni dispatcher e ogni run manuale devono acquisirlo; se è occupato, l'occurrence resta `pending` oppure la richiesta manuale riceve `409/423` con lo stato corrente, senza partire in parallelo.

La chiave di idempotenza di un ordine automatico deve derivare da `strategy_id + due_key + kind + seq + symbol + side`. Il solo `runId` casuale non basta a proteggere due consegne dello stesso evento.

### Budget provider

La policy resta globale e configurabile, per non codificare quote che cambiano nel tempo:

```sql
provider_usage_windows (
  provider TEXT NOT NULL,
  window_kind TEXT NOT NULL, -- 15m | day
  window_key TEXT NOT NULL,
  calls INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, window_kind, window_key)
)
```

La config globale definisce per provider:

- massimo tentativi per run;
- massimo chiamate per finestra di 15 minuti;
- massimo chiamate giornaliere;
- cooldown dopo `429`, overload o errori consecutivi;
- eventuale budget separato per draft interattivi e pipeline schedulate.

Prima di ogni chiamata il router prenota atomicamente una unità. Se il budget è esaurito, passa a un provider disponibile; se nessun provider è disponibile, la run termina `blocked` e non produce ordini. Non è ammesso sforare il budget per “salvare” una run live.

Priorità suggerita, senza parallelismo:

1. riconciliazione e verifiche di sicurezza già in corso;
2. rebalance live schedulato;
3. rebalance shadow/dry-run;
4. watcher con anomalia verificata;
5. generazione interattiva e diagnostica.

## Scheduler multi-strategy

A ogni tick di 15 minuti:

1. convertire l'istante in `Europe/Rome` con la logica DST già presente;
2. leggere tutte le strategie `active`;
3. calcolare `rebalance`, `snapshot`, `heartbeat` o `null` per ciascuna;
4. inserire con `INSERT ... ON CONFLICT DO NOTHING` le occurrence dovute;
5. ordinare la coda per priorità e orario;
6. acquisire il `pipeline_lock` globale già esistente;
7. eseguire una pipeline alla volta;
8. rilasciare la lease o lasciarla scadere in caso di crash;
9. riprendere le occurrence pendenti al tick successivo.

Regole di calendario:

- `weekly`: ogni strategia attiva deve avere un giorno diverso; vincolo sia in API sia in D1;
- `daily`: comportamento invariato, lunedì-venerdì, senza unicità del giorno;
- `monthly`: comportamento invariato, senza unicità del giorno del mese;
- `snapshot` e `heartbeat`: restano orari;
- al ritorno all'ora solare non va eseguita due volte la stessa occurrence locale;
- nell'ora locale inesistente del passaggio primaverile non va inventata una run a un orario diverso; la UI deve evitare o segnalare gli orari domenicali coinvolti se diventano rilevanti.

Giorni weekly diversi distribuiscono i rebalance, ma non eliminano il costo di snapshot e watcher. Le letture owner, candele, news e classificazioni generiche delle anomalie vanno condivise/cacheate; snapshot Agent, decisione, validazione e azione restano specifici del portfolio.

## API target

### Collezione

- `GET /agent/strategies` — elenco con stato sintetico, binding, capitale, drawdown, prossima run e disponibilità giorni;
- `POST /agent/strategies` — crea una bozza server-side;
- `GET /agent/strategies/:strategyId` — dettaglio autorevole;
- `PATCH /agent/strategies/:strategyId` — modifica con optimistic concurrency su `configVersion`;
- `DELETE /agent/strategies/:strategyId` — solo archiviazione, mai cancellazione distruttiva di storico e ordini.

### Strategia guidata e binding

- `POST /agent/strategies/:strategyId/draft` e `/draft/stream`;
- `POST /agent/strategies/:strategyId/activate`;
- `POST /agent/strategies/:strategyId/binding/token`;
- `DELETE /agent/strategies/:strategyId/binding` — richiede strategia non live, freeze e conferma esplicita;
- `GET /agent/agent-portfolios` — resta globale, ma segnala quali portfolio sono già assegnati.

L'attivazione valida in una sola operazione logica:

- portfolio esistente e non assegnato;
- token verificato e fingerprint coerente;
- cap di tre live;
- giorno libero se weekly;
- shadow period richiesto;
- versione config ancora corrente.

### Controllo e osservabilità

- `GET /agent/strategies/:strategyId/state`;
- `GET /agent/strategies/:strategyId/runs`;
- `GET /agent/strategies/:strategyId/runs/:runId`;
- `POST /agent/strategies/:strategyId/mode`;
- `POST /agent/strategies/:strategyId/freeze`;
- `POST /agent/strategies/:strategyId/unfreeze`;
- `POST /agent/strategies/:strategyId/safe-stop`;
- `POST /agent/strategies/:strategyId/trigger`;
- `GET /agent/strategies/:strategyId/watcher`;
- `POST /agent/safe-stop-all`.

Il live richiede una conferma che identifichi anche strategia e portfolio, non una frase generica riutilizzabile per errore. Gli endpoint storici senza `strategyId` restano temporaneamente alias della strategia migrata primaria.

MCP deve diventare strategy-aware per letture, update, trigger shadow/dry-run e freeze. Come oggi, non deve esporre l'attivazione live.

## UI target

### Vista elenco

La pagina Autopilot apre su un elenco server-side di strategie. Ogni card mostra:

- nome e Agent Portfolio;
- stato `draft`, `shadow`, `dry-run`, `live`, `paused`, `frozen`;
- capitale reale, drawdown e ultima lettura;
- cadenza, giorno/orario e prossima run;
- ultima esecuzione e relativo esito;
- binding verificato;
- azioni `Apri`, `Dry-run`, `Stop`.

In alto restano sempre visibili:

- numero di strategie live, ad esempio `2/3`;
- stato della coda e pipeline eventualmente in corso;
- pulsante prominente **STOP ALL**;
- timestamp dell'ultimo refresh server.

### Dettaglio strategia

Il dashboard attuale viene riusato passando uno `strategyId`. Modalità, freeze, config, watcher, ledger, run e curva devono provenire dall'endpoint della strategia selezionata. L'identificativo va conservato nell'URL, non soltanto nello stato React, così refresh e link da mobile aprono sempre la strategia corretta.

Durante la creazione weekly:

- la UI riceve dal server i giorni occupati;
- disabilita quelli non disponibili mostrando nome della strategia che li usa;
- il server ripete comunque il controllo e può rispondere `409` in caso di race;
- daily e monthly non mostrano alcun blocco equivalente.

### Mobile e stop

La vista mobile deve consentire senza navigazione profonda:

- vedere tutte le strategie live;
- passare al dettaglio;
- portare una strategia in safe-stop;
- eseguire STOP ALL;
- vedere la conferma autorevole del Worker dopo il comando.

Il pulsante non deve limitarsi a cambiare lo stato locale. Dopo la risposta aggiorna subito la card e poi effettua un refresh in background. Se l'URL Worker o il token non sono verificati, non deve mostrare come riuscito un comando non confermato.

### Convergenza con la pagina Agent

Le strategie locali esistenti non vanno importate automaticamente, perché possono rappresentare template, binding o ordini iniziali diversi dall'Autopilot guidato.

Percorso sicuro:

1. offrire `Importa come bozza` dalla pagina Agent;
2. inviare al Worker soltanto dati non sensibili;
3. richiedere nuova validazione e binding server-side;
4. partire sempre in shadow;
5. dopo la migrazione, disabilitare le azioni live browser-only per le strategie gestite dal Worker.

## Migrazione

### Preflight

Prima della migrazione:

- esportare un backup D1;
- registrare conteggi per tutte le tabelle;
- verificare che il vault corrente sia decifrabile;
- registrare soltanto fingerprint/hint del token, mai il segreto nei log;
- congelare temporaneamente l'attivazione di nuove strategie;
- introdurre una tabella `schema_migrations` e migrazioni numerate.

### Strategia primaria legacy

La config corrente viene copiata in una strategia con id stabile, per esempio `primary`:

- `config_json` riceve tutti i campi strategy-scoped;
- modalità e freeze vengono conservati;
- portfolio, mirror e capitale vengono conservati;
- il token cifrato e il binding vengono copiati nella nuova riga senza rigenerazione;
- la fingerprint viene ricalcolata e confrontata prima di abilitare il nuovo path;
- tutte le run, curve, ledger e watcher esistenti vengono attribuiti a `primary`.

La migrazione non cancella il vecchio documento `autopilot` né il vecchio blob vault fino alla conclusione del canary.

### Compatibilità temporanea

Durante la transizione:

- gli endpoint senza `strategyId` leggono/scrivono `primary`;
- la vecchia UI continua a funzionare;
- il nuovo scheduler resta dietro feature flag;
- soltanto un scheduler, legacy o multi, può essere attivo nello stesso ambiente;
- eventuale dual-write riguarda solo metadati reversibili; token e ordini hanno una sola fonte autorevole.

### Rollback

Il rollback deve essere possibile senza perdere il token one-time:

1. attivare STOP ALL e attendere che non vi siano ordini in invio;
2. disabilitare il scheduler multi;
3. riportare tutte le strategie aggiuntive in shadow/frozen;
4. riattivare il scheduler legacy soltanto per `primary`;
5. usare config e vault legacy, mantenuti intatti;
6. non eliminare tabelle nuove né storico;
7. indagare e riprendere la migrazione con una nuova versione.

Le strategie create dopo la migrazione non possono essere gestite dal runtime legacy: durante un rollback restano congelate.

## Fasi di implementazione

### Fase 0 — contratto e feature flag

- fissare gli invarianti;
- classificare ogni campo config come globale o strategy-scoped;
- definire `StrategySummary`, `StrategyState` e codici errore API;
- aggiungere `MULTI_STRATEGY_ENABLED`, inizialmente disattivato;
- definire metriche e alert per strategia/provider.

Gate: revisione schema e threat/risk review completate.

### Fase 1 — schema e repository

- introdurre migrazioni numerate;
- creare strategie, binding, curve, ledger, occurrence e usage provider;
- preservare ed evolvere `pipeline_lock`, senza introdurre un secondo lock globale incompatibile;
- implementare repository con `strategyId` obbligatorio;
- migrare e verificare `primary`;
- mantenere endpoint legacy in compatibilità.

Gate: test di migrazione/rollback e confronti record-per-record superati.

### Fase 2 — pipeline isolata

- cambiare firma in `runPipeline({ env, strategyId, ... })`;
- propagare `strategyId` in ogni read/write;
- rendere token, HWM, ledger, watcher e conteggi strategy-scoped;
- rendere retry/improve vincolati alla stessa strategia;
- aggiornare idempotenza degli ordini;
- rendere il gate pre-ordine strategy-aware e global-stop-aware.

Gate: nessuna contaminazione in test con due strategie che possiedono gli stessi ticker.

### Fase 3 — scheduler e budget

- query di tutte le strategie dovute;
- occurrence persistenti;
- collegare la coda strategy-aware al `pipeline_lock` globale e mantenere concorrenza 1;
- vincolo weekly e cap di tre live;
- budget/cooldown provider;
- riuso delle cache e continuità dopo crash.

Gate: test duplicazione cron/manuale, collisioni daily/monthly, DST, lease scaduta e provider overload.

### Fase 4 — API e UI

- endpoint strategy-scoped;
- lista e dettaglio mobile-first;
- onboarding multiplo;
- giorni weekly disponibili;
- safe-stop individuale e STOP ALL;
- import locale solo come bozza;
- aggiornamento MCP in sola supervisione sicura.

Gate: E2E desktop e viewport mobile su due sessioni/browser contro lo stesso Worker.

### Fase 5 — soak shadow

- migrare `primary` ma mantenerla shadow/dry-run;
- creare altre due strategie in giorni weekly distinti;
- eseguire almeno l'intero periodo shadow configurato;
- confrontare snapshot, curve, ledger, run, chiamate provider e ordini simulati;
- eseguire fault injection su 401, 429, timeout, crash e D1 temporaneamente non disponibile.

Gate: zero cross-strategy leakage e nessuna occurrence duplicata.

### Fase 6 — canary live

1. attivare live soltanto su `primary`;
2. osservare almeno un ciclo completo e la riconciliazione;
3. attivare la seconda strategia in un giorno weekly diverso;
4. osservare un altro ciclo completo;
5. attivare la terza soltanto dopo metriche stabili;
6. mantenere il cap **3 live**, concorrenza **1** e STOP ALL disponibile;
7. rimuovere compatibilità legacy soltanto dopo un periodo operativo concordato.

Ogni incremento del canary richiede verifica manuale dei portfolio eToro, dei mirror, dei token e degli ultimi ordini.

## Piano di test

### Migrazione e dati

- migrazione da database vuoto;
- migrazione con config completa, token verificato, run e ordini storici;
- migrazione ripetuta idempotente;
- fingerprint uguale prima/dopo;
- nessun token in chiaro in DB, log o risposta API;
- rollback con `primary` ancora operativo;
- conteggi e somme equity coerenti.

### Isolamento

- due strategie con `SPY` hanno ledger e cooldown distinti;
- HWM e drawdown indipendenti;
- freeze per drawdown di A non congela B;
- 401 del token A non cancella il token B;
- query run di A non accetta un `runId` di B;
- stesso Agent Portfolio rifiutato sotto richieste concorrenti;
- richiesta eToro di A usa soltanto fingerprint/token di A.

### Scheduling

- due weekly attive sullo stesso giorno: `409` e vincolo D1;
- cambio giorno atomico;
- pausa/archiviazione libera il giorno;
- riattivazione fallisce se il giorno è stato occupato;
- daily contemporanee ammesse;
- monthly sullo stesso giorno ammesse;
- ora/minuto esatti sui quarti d'ora;
- cambio ora legale Europe/Rome;
- ora autunnale duplicata eseguita una sola volta;
- due consegne cron producono una sola occurrence;
- cron e trigger manuale non duplicano ordini.

### Concorrenza e provider

- massimo una pipeline `running` globalmente;
- seconda run accodata e ripresa;
- lease orfana recuperata dopo scadenza;
- contatori 15 minuti/giorno atomici;
- `429` imposta cooldown soltanto sul provider interessato;
- fallback rispetta budget residuo;
- budget totalmente esaurito blocca la run senza ordini;
- una strategia fallita non elimina le occurrence delle successive.

### Esecuzione e stop

- live senza binding verificato bloccato;
- quarta strategia live bloccata anche sotto race;
- safe-stop durante il piano impedisce tutti gli ordini successivi;
- STOP ALL interrompe ogni strategia non ancora in invio;
- errore nella rilettura sicurezza blocca la rete eToro;
- retry della stessa occurrence usa gli stessi idempotency key;
- crash dopo stato `intent` riconcilia prima di una nuova POST;
- divergenza congela solo la strategia interessata, salvo stop globale esplicito.

### API e UI

- authorization su ogni endpoint;
- optimistic concurrency con `configVersion` obsoleta restituisce `409`;
- lista e dettaglio coerenti dopo refresh;
- mobile 390×844: capitale, drawdown, mode, prossima run e stop visibili;
- stesso stato su desktop e telefono;
- URL Worker errato non mostra dati locali come server-authoritative;
- import locale crea solo una bozza shadow;
- errori e notifiche indicano sempre nome strategia e portfolio.

## Canary e osservabilità

Metriche minime per `strategy_id`:

- occurrence create, avviate, completate, fallite e duplicate evitate;
- durata e fase corrente della pipeline;
- provider/modello, tentativi, 429, timeout e budget residuo;
- letture e scritture eToro;
- ordini intent/sent/filled/failed/skipped;
- equity, HWM, drawdown e freeze;
- età della lease globale;
- profondità e anzianità della coda;
- esito della riconciliazione.

Alert bloccanti:

- più di una pipeline `running`;
- più di tre strategie live;
- stesso portfolio su due strategie;
- lease scaduta con ordine `intent` non riconciliato;
- token/binding mismatch;
- occurrence live in ritardo oltre la soglia concordata;
- STOP ALL non riflesso nello stato autorevole;
- divergenza oltre guardrail.

## Rischi principali e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Perdita del token Agent, restituito una sola volta | Migrazione per copia cifrata, verifica fingerprint, vecchio vault conservato fino a fine canary |
| Token usato sul portfolio errato | `portfolio_id UNIQUE`, binding strategy-scoped e verifica immediata prima del client |
| Due run equivalenti inviano ordini doppi | occurrence persistente e idempotency key non dipendente da un runId casuale |
| Stop richiesto mentre una run è già in corso | rilettura dello stato globale/per-strategia prima di ogni POST live |
| Tre strategie moltiplicano chiamate AI | concorrenza 1, budget provider, cooldown e cache condivise |
| Watcher moltiplica classificazioni | rilevamento/classificazione condivisi quando il contesto è identico; decisione finale per strategia |
| Stato locale e server divergono | Worker/D1 unica fonte autorevole; vecchia pagina Agent solo import/read-only per portfolio gestiti |
| Migrazione non reversibile | schema additivo, feature flag, config/vault legacy conservati, nuove strategie congelate in rollback |
| Race sul giorno weekly o sul quarto slot live | constraint/slot D1 oltre alla validazione applicativa |
| Una run lunga affama le successive | lease con timeout, coda osservabile, budget massimo per run e recupero al tick seguente |

## Criteri di completamento

La prima release multi-strategy è pronta soltanto quando:

- la strategia corrente è migrata senza rigenerare il token;
- tre strategie possono vivere in D1 con stato completamente separato;
- al massimo tre possono entrare in live;
- una sola pipeline può essere eseguita globalmente;
- due weekly attive non possono condividere il giorno;
- daily e monthly mantengono il comportamento attuale;
- stop individuale e STOP ALL sono verificati da mobile e riletti prima di ogni ordine;
- duplicate delivery e crash non producono doppi ordini;
- budget provider e cooldown sono osservabili e fail-closed;
- test di migrazione, isolamento, scheduling, fault injection ed E2E mobile sono verdi;
- il canary progressivo 1 → 2 → 3 live non evidenzia contaminazioni o riconciliazioni fuori soglia.
