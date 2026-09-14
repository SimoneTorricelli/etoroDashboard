# Guadagno effettivo

La homepage distingue il P&L del portafoglio eToro dal risultato economico del conto trading USD nel periodo coperto dagli estratti.

`guadagno = equity finale − equity iniziale + prelievi cumulati − versamenti cumulati − altri apporti netti`

Reinvestimenti, chiusure e nuovi acquisti non sono flussi esterni. Dividendi, interessi, commissioni e imposte già registrati nel conto si riflettono nell’equity: non vengono sommati una seconda volta. Trasferimenti di titoli e bonus di capitale si registrano tra gli altri apporti netti. Le spese e imposte fuori conto non sono incluse. Il perimetro esclude i conti eToro Money: i trasferimenti tra Money e trading attraversano quindi il confine del conto analizzato.

Il risultato già realizzato è `guadagno − P&L aperto finale + P&L aperto iniziale`. Un P&L aperto sconosciuto lascia questo risultato non disponibile. Il P&L di portafoglio restituito dall’API può includere profitti mirror chiusi: non viene usato come P&L aperto. Lo snapshot usa solo posizioni manuali e `activeUnrealizedPnl` dei copy.

## Uso

1. In homepage apri **Aggiungi storico** e indica l’anno iniziale. Se copri il conto dal primo versamento, seleziona la relativa casella: i valori iniziali sono zero. Altrimenti inserisci equity e, se noto, P&L aperto al 1° gennaio; il risultato è indicato come storico parziale.
2. Aggiungi un riepilogo per ogni anno, con tutti i flussi dal 1° gennaio alla data finale. Per gli anni intermedi serve il 31 dicembre. Buchi, duplicati, importi mancanti e date future bloccano il salvataggio.
3. Per l’ultimo anno puoi copiare equity e P&L aperto da uno snapshot eToro recente. Aggiorna manualmente i flussi fino alla medesima data e verifica prima di salvare. Il valore è uno snapshot persistito, non una serie live con flussi obsoleti.
4. Il grafico mostra risultato cumulato e realizzato disponibile; la tabella contiene anche il risultato di ciascun periodo annuale. I prelievi sono esposti come flussi, senza inventare una ripartizione tra utili e capitale.
5. Esporta/importa un backup JSON. L’importazione apre una bozza da verificare prima della sostituzione. I dati sono locali al browser, isolati tramite digest di proxy, ambiente e chiave utente. Cambiando questi parametri o dispositivo occorre reimportare il backup. Gli errori di storage non vengono ignorati.

Il componente resta in USD anche con dashboard EUR: convertire tutta la storia al cambio odierno non misura il guadagno storico in euro. La linea collega osservazioni annuali e non rappresenta oscillazioni intra-annuali.

## Limite dei dati attuali

Il provider esistente richiede 365 giorni di saldi; il data hub legge movimenti Cash limitati e non prova la copertura completa dei flussi del conto trading. Queste serie non vengono usate per inventare uno storico dall’apertura. Gli anni provengono dai riepiloghi verificati dall’utente; non è stato aggiunto un parser automatico dell’estratto conto.

Riferimenti: [equity eToro](https://api-portal.etoro.com/guides/calculate-equity), [P&L eToro](https://api-portal.etoro.com/guides/calculate-profit-loss), [estratto conto](https://www.etoro.com/documents/accountstatement).

Verifiche: `npm run test:profit`, `npm run build`; lint sui file modificati. I test verificano reinvestimenti, ritorno di capitale, versamenti aggiuntivi, prelievi superiori ai versamenti, perdite e costi, apporti esterni, baseline parziali, copertura cronologica, importi locali e persistenza.
