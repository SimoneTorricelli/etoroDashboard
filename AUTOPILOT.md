# Torri Autopilot — recap del progetto

Documento di sintesi di tutto ciò che è stato costruito sopra la dashboard eToro
esistente. Aggiornato al 25 agosto 2026.

---

## 1. Il problema di partenza

L'app aveva già una sezione **Agent** con portafogli precompilati e un motore a
regole (`src/lib/agent/engine.ts`), ma con un limite strutturale: **girava nel
browser**. Chiudendo la scheda, l'agente smetteva di esistere. Le regole erano
statiche (soglia di prezzo, RSI, calo percentuale) e non reagivano al contesto
di mercato.

L'obiettivo: un sistema che si muova da solo, a computer spento, che legga
notizie e indicatori, che decida in modo motivato — e che non possa fare danni.

### La correzione architetturale iniziale

MCP (Model Context Protocol) sembrava la strada, ma non lo è: è un protocollo
che collega un LLM **interattivo** a degli strumenti. Non ha scheduler, non ha
cron, non si sveglia da solo. Se chiudi la finestra di Claude, non esiste più
nulla.

La risposta corretta è un **backend schedulato** che chiama la eToro Public API
direttamente e, in un punto preciso del flusso, chiede un parere a un LLM via
HTTP. MCP resta utile, ma nel verso opposto: è il *nostro* backend a esporsi
come server MCP per la supervisione conversazionale.

---

## 2. Architettura

```
Cron orario (Cloudflare Workers)
   │
   ├─ 1. COLLECTOR      eToro API + prezzi + macro + news
   ├─ 2. FEATURE ENGINE calcolo deterministico, nessuna AI
   ├─ 3. SCREENING      pool → shortlist (solo in modalità dinamica)
   ├─ 4. BRAIN          LLM: propone un'allocazione target
   ├─ 5. VALIDATOR      guardrail deterministici, diritto di veto
   ├─ 6. EXECUTOR       ordini idempotenti su Agent Portfolio
   ├─ 7. RECONCILE      rilettura e confronto con l'atteso
   └─ 8. AUDIT          tutto persistito su D1
```

### Il principio non negoziabile

**L'LLM non emette mai ordini.** Produce solo un'allocazione percentuale
desiderata, in JSON. Il codice deterministico la trasforma in ordini e ha
diritto di veto assoluto. Questo separa nettamente ciò che può sbagliare (il
giudizio) da ciò che non deve sbagliare (i limiti di rischio).

### Perché Cloudflare

- **Cron Triggers** inclusi nel piano gratuito
- **D1** (SQLite) per stato e audit
- **KV** per cache di serie storiche e contesto esterno
- **Workers AI** come binding interno: LLM senza chiavi e senza subrequest
- Lo stesso Worker serve già la SPA: un solo deploy, un solo dominio

---

## 3. Inventario del codice

### Backend — `worker/` (~4.600 righe)

| File | Ruolo |
|---|---|
| `index.js` | Entry point: proxy eToro, `/agent/*`, `/mcp`, handler `scheduled()` |
| `lib/db.js` | Schema D1, configurazione tipizzata, audit, registro posizioni |
| `lib/vault.js` | Vault credenziali cifrato AES-GCM |
| `lib/etoro.js` | Client eToro server-side |
| `lib/sources.js` | Fonti dati esterne gratuite + sentiment lessicale |
| `lib/features.js` | Feature engine deterministico |
| `lib/screening.js` | Screening del pool e costruzione shortlist |
| `lib/profiles.js` | Profili di strategia |
| `lib/llm.js` | Astrazione multi-provider AI |
| `lib/brain.js` | Prompt, parsing e cascata dei modelli |
| `lib/churn.js` | Disciplina anti-rotazione |
| `lib/validator.js` | Guardrail con diritto di veto |
| `lib/executor.js` | Esecuzione idempotente e riconciliazione |
| `lib/watcher.js` | Scan orario e classificazione contestuale |
| `lib/pipeline.js` | Orchestratore |
| `lib/diagnose.js` | Diagnostica delle credenziali |
| `lib/notify.js` | Telegram e webhook |
| `lib/api.js` | Control API autenticata |
| `lib/mcp.js` | Remote MCP server |
| `schema.sql` | Schema D1 per migrazione manuale |
| `lib/strategy.js` | Contratto versionato onboarding → StrategySpec + scenari deterministici |
| `lib/universe-policy.js` | Catalogo tassonomico e policy dell’universo dinamico |
| `selftest.mjs` e `*-selftest.mjs` | 77 test deterministici e di regressione |

### Frontend — `src/`

| File | Ruolo |
|---|---|
| `pages/Autopilot.tsx` | Pannello di controllo, sei tab |
| `lib/agent/autopilot-api.ts` | Client tipizzato |
| `components/autopilot/HowItWorks.tsx` | Glossario e spiegazione della pipeline |
| `components/autopilot/ProfileSelector.tsx` | Scelta del profilo di strategia |
| `components/autopilot/GuardrailsEditor.tsx` | Editor di tutti i parametri |
| `components/autopilot/CredentialsSection.tsx` | Gestione credenziali |
| `components/autopilot/AgentTokenGenerator.tsx` | Generazione token Agent Portfolio |
| `components/autopilot/InstrumentSearch.tsx` | Ricerca nel catalogo eToro |
| `components/autopilot/ModelPicker.tsx` | Provider e modelli AI |
| `components/autopilot/DiagnosticsPanel.tsx` | Diagnostica |
| `components/autopilot/WatcherPanel.tsx` | Storico eventi del watcher |
| `components/autopilot/StrategyOnboarding.tsx` | Onboarding in quattro passi e revisione visuale |

---

## 4. I guardrail

Nessuno è aggirabile dal modello. Ognuno è coperto da almeno un test.

### Limiti strutturali

| Guardrail | Comportamento |
|---|---|
| Whitelist / pool | Simbolo fuori lista ⇒ proposta scartata integralmente |
| Cap per strumento | Peso eccedente ⇒ ridotto e rinormalizzato |
| Cap per classe | Classe eccedente ⇒ scalata proporzionalmente |
| Numero di posizioni | Oltre il massimo ⇒ si tengono i pesi più alti |
| Cassa min/max | Riserva protetta dagli acquisti |
| Turnover per run | Piano scalato proporzionalmente |
| Ordini per run / 24h | Si tengono gli scostamenti maggiori |
| Importo min/max ordine | Sotto il minimo si scarta, sopra il massimo si taglia |
| Banda morta | Sotto soglia non si agisce |
| Confidence minima | Sotto soglia la run è bloccata |

### Disciplina anti-rotazione

| Guardrail | Comportamento |
|---|---|
| Detenzione minima | Non si vende prima di N giorni, salvo stop loss |
| Cooldown di rientro | Non si ricompra prima di M giorni dalla vendita |
| Soglia di sostituzione | Il candidato deve battere l'uscente di N punti |
| Costo di transazione | Se il beneficio atteso non supera lo spread, non si opera |

### Sicurezza operativa

| Guardrail | Comportamento |
|---|---|
| Circuit breaker | Drawdown oltre soglia ⇒ freeze automatico + notifica |
| Riconciliazione | Divergenza oltre tolleranza ⇒ freeze |
| Idempotenza | `x-request-id` = SHA-256 di (runId, seq, simbolo, lato) |
| Fail-fast | Al primo errore gli ordini successivi diventano `skipped` |
| Freeze manuale | Blocco immediato di qualsiasi esecuzione |

### Le tre modalità

- **shadow** — il ciclo gira ma si ferma prima di costruire ordini
- **dry-run** — ordini costruiti e validati su eToro, mai inviati
- **live** — ordini reali; richiede il token e una conferma letterale

---

## 5. Profili di strategia

| | Difensivo | Bilanciato | Dinamico | Aggressivo |
|---|---|---|---|---|
| Volatilità target | <8% | 8–14% | 14–22% | >22% |
| Orizzonte | 3+ anni | 1–3 anni | 6–18 mesi | 3–12 mesi |
| Posizioni max | 6 | 8 | 10 | 12 |
| Crypto | 0% | 12% | 20% | 30% |
| Cassa minima | 10% | 5% | 3% | 2% |
| Turnover max | 12% | 20% | 28% | 35% |
| Stop drawdown | 10% | 15% | 20% | 28% |
| Detenzione minima | 30gg | 21gg | 14gg | 7gg |
| Watcher | no | sì | sì | sì |

Applicare un profilo riscrive in blocco quindici parametri correlati; restano
tutti modificabili singolarmente dopo.

---

## 6. Universo dinamico

Due modalità:

- **fissa** — l'AI riceve la whitelist e decide solo i pesi
- **dinamica** — l'AI sceglie anche *quali* strumenti tenere

L'imbuto risolve il vincolo che un LLM non può ragionare su 150 titoli:

```
Pool (fino a 200 strumenti)
  → screening deterministico
      momentum composito, forza relativa vs S&P, trend su medie 50/200,
      penalità volatilità fuori target, drawdown 3m, ipercomprato,
      penalità correlazione con le posizioni aperte
  → shortlist (~18, con tetto per classe)
  → l'AI sceglie e pesa
```

Le **posizioni aperte entrano sempre in shortlist**, con qualunque punteggio:
il modello deve poterle mantenere o vendere, non solo comprare altro.

Con l’onboarding guidato l’utente non sceglie una lista rigida di ticker:
definisce macro-aree, settori/temi, fascia crypto, consenso separato per meme
coin, volatilità e concentrazione. Da queste risposte nasce una `StrategySpec`
versionata; il catalogo genera fino a 60 candidati e lo screening decide nel
tempo quali portare al modello. Le posizioni già aperte ma fuori policy restano
visibili e diventano **sell-only**.

Il prompt include i **vincoli temporali** dal registro posizioni, così l'AI non
propone operazioni che verrebbero comunque bloccate.

---

## 7. Watcher orario

Il pezzo che reagisce agli eventi fra un ribilanciamento e l'altro.

```
Ogni ora: scan deterministico (gratuito)
   crollo giornaliero · discesa prolungata · rialzo esplosivo ·
   volatilità anomala · posizione sotto stop
        │
        ├─ nessuna anomalia (99% dei casi) → fine, costo zero
        │
        └─ anomalia → notizie mirate → AI classifica:
              rottura strutturale | eccesso tecnico | non determinabile
                    │
                    ├─ strutturale  → nessun acquisto
                    ├─ non chiaro   → si osserva
                    └─ eccesso tecnico + stabilizzazione → acquisto entro budget
```

**Regole non negoziabili:**

- non si compra mai *dentro* il movimento: servono N chiusure senza nuovi minimi
- mai su `structural_break`: se i fondamentali sono rotti, il calo continua
- mai su `spike`: non si insegue un rialzo esplosivo
- confidence sotto soglia ⇒ si osserva soltanto
- budget opportunistico separato e piccolo, tetto settimanale, mediazione al
  ribasso limitata
- lo stesso tetto percentuale per ordine, la riserva di cassa, il massimo
  posizioni, i cap di classe e l’eligibility eToro valgono anche nel watcher

Costo stimato: 2–5 chiamate AI al mese invece di 720.

---

## 8. Provider AI

L'ordine predefinito è `workers-ai → gemini → groq → openrouter`: si usa il
primo che risponde con una proposta valida.

| Provider | Chiave | Costo | Note |
|---|---|---|---|
| **Cloudflare Workers AI** | nessuna | incluso nel piano Workers | Binding interno: non consuma subrequest |
| Google Gemini | gratuita | free tier generoso | `aistudio.google.com` |
| Groq | gratuita | free tier a rate limit | `console.groq.com` |
| OpenRouter | gratuita | catalogo in contrazione | riserva |

**Perché non solo OpenRouter:** durante lo sviluppo si è visto che le varianti
`:free` vengono ritirate progressivamente (`"This model is unavailable for
free"`). Costruire su un catalogo che si svuota non è sostenibile.

### Ottimizzazione del prompt

Il modello non riceve mai dati grezzi: il feature engine calcola tutto in codice
e li rende come tabella a larghezza fissa invece che JSON. Risultato misurato
dai test: **prompt sotto i 6.000 caratteri, circa 1.400 token**.

---

## 9. Fonti dati

Tutte gratuite, ognuna isolata con timeout: un errore degrada il contesto ma non
blocca la run.

| Fonte | Chiave | Cosa fornisce |
|---|---|---|
| eToro Public API | sì | portafoglio, posizioni, candele 260gg, tassi, eligibility |
| Frankfurter | no | EUR/USD ufficiale BCE |
| Stooq | no | S&P 500, Nasdaq 100, VIX, Treasury 10Y e 2Y, oro |
| CoinGecko | no | market cap crypto, dominance, variazione 24h |
| Alternative.me | no | Fear & Greed crypto |
| RSS ×5 | no | CNBC, MarketWatch, Yahoo Finance, CoinDesk, Fed |
| Finnhub / Marketaux / FMP | opzionale | news e fondamentali aggiuntivi |

Il contesto esterno è **cachato su KV per 3 ore** (60 secondi sul
ribilanciamento), per rispettare il budget di subrequest del Worker.

---

## 10. Sicurezza

### Vault credenziali

Il cron gira senza browser: le credenziali devono stare lato server. Sono
cifrate **AES-GCM** su D1, con chiave derivata via SHA-256 da `VAULT_KEY`.

- risoluzione: **vault → Worker Secret**
- i valori non tornano mai indietro: l'API espone solo presenza, provenienza e
  ultime quattro cifre
- configurabili dalla dashboard senza redeploy
- il live accetta solo token creati e verificati dal flusso Agent: segreto,
  portfolio e fingerprint SHA-256 vengono salvati come un’unica tupla atomica
- sostituire, revocare o far ricadere il token su un Worker Secret invalida il
  binding e riporta automaticamente l’esecuzione in `shadow`

### Modifiche difensive al Worker

| Prima | Dopo |
|---|---|
| `Access-Control-Allow-Origin: *` | Solo origini in `ALLOWED_ORIGINS` + same-origin |
| Proxy inoltrava anche senza credenziali | 401 se mancano `x-api-key`/`x-user-key` |
| Chiavi eToro nel browser | Worker Secrets o vault cifrato |
| — | `CONTROL_TOKEN` con confronto a tempo costante |
| — | `X-Content-Type-Options`, `Referrer-Policy` su ogni risposta |
| — | Config API con whitelist chiavi e validazione dei range |

### Secret richiesti

```bash
npx wrangler secret put CONTROL_TOKEN   # openssl rand -base64 32
npx wrangler secret put VAULT_KEY       # diverso dal precedente
```

> Se `VAULT_KEY` non è impostato si ripiega su `CONTROL_TOKEN`, ma ruotare la
> password renderebbe illeggibile il vault. Meglio due secret distinti.

---

## 11. Control API

Tutte le rotte richiedono `Authorization: Bearer <CONTROL_TOKEN>`.

| Metodo | Rotta | Funzione |
|---|---|---|
| GET | `/agent/state` | Stato, equity, drawdown, credenziali, ultime run |
| GET | `/agent/runs` · `/agent/runs/:id` | Storico e dettaglio completo |
| GET/PUT | `/agent/config` | Configurazione validata |
| GET | `/agent/profiles` · POST `/agent/profile` | Profili di strategia |
| POST | `/agent/mode` | Cambio modalità (live richiede conferma letterale) |
| POST | `/agent/freeze` · `/agent/unfreeze` | Interruttore di emergenza |
| POST | `/agent/trigger` | Run manuale |
| POST | `/agent/diagnose` | Diagnostica completa |
| POST | `/agent/notify-test` | Test canali di notifica |
| GET/PUT/DELETE | `/agent/credentials` | Vault |
| POST | `/agent/agent-token` | Genera token e lo salva nel vault |
| POST | `/agent/strategy/draft` | Genera e valida la StrategySpec, senza ticker né ordini |
| POST | `/agent/strategy/activate` | Lega la strategia al portfolio verificato e parte in shadow |
| GET | `/agent/agent-portfolios` | Elenco Agent Portfolio |
| GET | `/agent/instruments?q=` | Ricerca nel catalogo eToro |
| GET | `/agent/models` | Provider e modelli disponibili |
| GET | `/agent/watcher` · `/agent/ledger` | Eventi e vincoli temporali |

### Remote MCP server

`/mcp` espone 10 tool JSON-RPC 2.0. Include `search` e `fetch`, richiesti dai
connector ChatGPT. `trigger_run` accetta solo `shadow` e `dry-run`:
l'attivazione live **non è esposta a nessun client MCP**, per scelta.

Per ChatGPT, che non permette header personalizzati, il token si passa nel
path: `/mcp/<CONTROL_TOKEN>`.

---

## 12. Notifiche

Telegram e webhook generico, entrambi opzionali e non bloccanti.

| Evento | Livello |
|---|---|
| Run completata con ordini | info, con rationale ed elenco |
| Nessuna proposta valida | warn |
| Run fallita | warn |
| Cambio modalità | critical se live |
| Freeze da drawdown | critical |
| Freeze da riconciliazione | critical |
| Evento watcher operativo | info / warn |

---

## 13. Bug significativi risolti

| Bug | Causa | Effetto |
|---|---|---|
| Test Telegram sempre "riuscito" | `post()` ignorava la risposta; Telegram usa 200 con `ok:false` | Falso positivo su token errato |
| Strumenti mai risolti | Parser cercava l'array solo in `instruments`/`data` | 0/7 simboli risolti |
| Agent Portfolio vuoti | `searchRows` non controllava `agentPortfolios` | Lista vuota nonostante 3 esistenti |
| `Too many subrequests` | 3 formati × 8 modelli + 16 fonti + eToro > 50 | Ogni fetch falliva a metà run |
| Modelli musicali in lista | Filtro solo sul prezzo, non sulla modalità | `lyria-3-pro-preview` fra i candidati |
| 400 sul token | Payload `{name}` invece di `{userTokenName, scopeNames}` | Generazione impossibile |
| Segreto token non trovato | Lista fissa di chiavi | Token creato ma non recuperabile |
| Token Agent in 401 immediato | Il parser prendeva `userTokenId` (UUID) prima di `userToken` | Ora accetta solo il segreto ufficiale, lo collauda e non usa fallback GET |
| Token e portfolio potevano divergere | Segreto e metadata salvati separatamente | Tupla atomica con fingerprint; mismatch bloccato prima dello snapshot |
| Modalità corrotta poteva inviare ordini | L’executor simulava solo due stringhe e trattava il resto come reale | Fail-closed: solo `live` esatto raggiunge gli endpoint di trading |
| Riconciliazione congelava piani scalati | Confrontava il target teorico invece degli importi realmente ordinati | Peso atteso ricostruito dagli ordini del piano |
| Autopilot muto su mobile | `sessionStorage` fallisce su Safari iOS, errore ingoiato, `refresh()` usciva in silenzio | Schermata vuota senza spiegazione |
| Autopilot invisibile su mobile | Voce solo in sidebar desktop | Pagina irraggiungibile sotto 768px |
| Artefatti wrangler nel repo | `.gitignore` con tre righe | `.wrangler/tmp/` committato |

---

## 14. Test

77 test complessivi, tutti senza rete reale:

- 38 in `worker/selftest.mjs` per feature, guardrail, watcher, executor e
  riconciliazione
- 18 in `worker/strategy-selftest.mjs` per onboarding, consenso e StrategySpec
- 11 in `worker/universe-policy-selftest.mjs` per universo dinamico e sell-only
- 10 in `worker/token-selftest.mjs` per parsing, 401, fingerprint e atomicità

Coprono: indicatori tecnici, coerenza delle feature, compattezza del prompt,
estrazione JSON tollerante, normalizzazione delle proposte, tutti i guardrail,
i quattro profili, le regole anti-churn, lo screening e i sette cancelli del
watcher.

---

## 15. Comandi

```bash
npm run dev             # dashboard in locale
npm run build           # build di produzione
npm run test:worker     # 38 test del motore deterministico
npm run worker:dev      # Worker in locale
npm run db:migrate      # schema su D1 remoto
npm run deploy          # build + deploy su Cloudflare
```

Deploy automatico su push (`main`/`master`) con
`.github/workflows/deploy-worker.yml`. Richiede su GitHub i secret
`CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`.

---

## 16. Stato e prossimi passi

### Funzionante

Infrastruttura, feature engine, screening, profili, anti-churn, watcher,
guardrail, executor, riconciliazione, audit, control API, MCP, notifiche,
diagnostica, vault, UI completa.

### Da verificare sul campo

- risoluzione dei simboli dopo la correzione del parser
- generazione e verifica reale di un nuovo token sul portfolio 0405bc2a
- prima run shadow con una proposta reale
- comportamento della chiusura parziale su eToro (`action: 'close'` con
  `amount`) — non documentato con certezza, da validare in dry-run

### Percorso verso il live

1. **Shadow, 4–6 settimane** — leggere ogni run, valutare se le decisioni
   avrebbero avuto senso, tarare whitelist e cap
2. **Dry-run** — ordini costruiti con importi reali e pre-check di
   ammissibilità, senza invio
3. **Live con budget minimo** — 200–300 EUR, drawdown stop aggressivo,
   notifiche su ogni ordine

---

## 17. Avvertenza

Questo sistema esegue automaticamente ordini con denaro reale su una piattaforma
con leva e criptovalute. Un LLM **non è un consulente finanziario** e sbaglierà:
allucinerà correlazioni, sovrastimerà notizie, farà overfitting sul rumore.

L'unica cosa che rende accettabile il rischio sono i guardrail deterministici e
un budget limitato. Considerare l'intero capitale allocato come potenzialmente
perso, e verificare i Termini API di eToro sull'automazione prima di attivare la
modalità live.
