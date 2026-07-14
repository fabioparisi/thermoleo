# Topologia idronica appartamento Fabio

**Built**: 2026-05-25. **Aggiornato 2026-05-26**: la sezione "Perché waterTemp è 22°C" è basata sull'assunzione errata che il decoder Sabiana esponesse T3 acqua nei bytes 16-17 — in realtà sono il setpoint AUTO Modbus register (vedi `skill-thermoleo/references/lessons-learned.md` #27). Sabiana NON espone T2/T3 nel cloud API. Le hypotheses ranked qui sotto sono mantenute per archivio storico ma vanno lette con quel caveat.

**Sources**: `netatmo-valves-map.md`, `smarther-cool-mode.md`, `src/lib/sabiana/client.ts`, Sabiana CB-Touch installation manual ([archiexpo PDF](https://pdf.archiexpo.com/pdf/sabiana/fan-coil-control-range/51461-385611.html)), manuale T-MB2 ufficiale 9066994E ([manualslib](https://www.manualslib.com/manual/2970013/Sabiana-T-Mb2.html)).

## Diagramma (ricostruito, NON verificato fisicamente)

```
                  COLONNA CONDOMINIALE (riser 2 tubi)
                  ┌─────── chiller estate / caldaia inverno ───────┐
                  │            (switch stagionale centralizzato)    │
                  └────────────────┬───────────────┬────────────────┘
                          MANDATA  │               │ RITORNO
                                   │               │
                          ┌────────▼───────────────▼────────┐
                          │  INGRESSO APPARTAMENTO (7° p)    │
                          │  + contatore termico             │
                          │  + Smarther 2 BNS zone valve     │  ← ON/OFF unica
                          │  (xx:xx:xx:xx:xx:e0)             │
                          └────────┬───────────────┬─────────┘
                                   │               │
                          ┌────────▼───────────────▼─────────┐
                          │   COLLETTORE INTERNO (probabile, │
                          │   non confermato — cabinet?)     │
                          │   T+R, 7 derivazioni              │
                          └─┬──┬──┬──┬──┬───────┬──────┬─────┘
                            │  │  │  │  │       │      │
              ┌─────────────┘  │  │  │  │       │      └──── Rad. Bagno Vasca
              │      ┌─────────┘  │  │  │       └─────────── Rad. Bagno Doccia
              │      │      ┌─────┘  │  │                    (entrambi con NRV
              │      │      │     ┌──┘  │                     forzato 7°C in cool)
              │      │      │     │     │
            FC      FC      FC   FC    FC
          leone  soggiorno camera studio cucina
        (Sabiana CB-Touch, 3-way internal, T1/T2/T3)
```

I 5 fancoil hanno valvola 3-vie **interna** controllata da Sabiana Cloud, in parallelo sul collettore. Nessuna NRV/NLLV sui rami fancoil.

## Componenti identificati

| Component | Position | Control | Notes |
|---|---|---|---|
| Riser condominiale 2 tubi | Colonna palazzo | Centralizzata, switch stagionale | chiller estate / caldaia inverno |
| Smarther 2 BNS zone valve | Ingresso appartamento | Netatmo cloud + relè HEATING/COOLING | Singola valvola ON/OFF apartment-level, no per-zone modulation |
| Collettore di distribuzione | Probabile, in cassetta tecnica | Passivo | Da verificare fisicamente — cabinet del distributore non documentato |
| Fancoil Sabiana CB-Touch x5 | Una per stanza | Sabiana Cloud (3-way valve + ECM motor) | leone/soggiorno/camera/studio/cucina |
| NRV bagno1 (Vasca) | Sul radiatore | Netatmo (forzato 7°C antifreeze in cool) | MAC xx:xx:xx:xx:xx:e0 |
| NRV bagno2 (Doccia) | Sul radiatore | Netatmo (forzato 7°C antifreeze in cool) | MAC xx:xx:xx:xx:xx:fa |

## Valvole reali (escluso tapparelle)

| ID | Tipo | Ruolo idraulico | Stato attuale |
|---|---|---|---|
| Smarther 2 BNS | Zone valve elettrica (probabile servovalvola NC/NO) | Gate ALL flow entrante | Forzata manual 30°C/180d → firmware "wants heat" → valvola aperta (in heating logic) |
| NRV Vasca | TRV motorizzata radiatore | Apre/chiude radiatore bagno1 | manual 7°C → chiusa (antifreeze) |
| NRV Doccia | TRV motorizzata radiatore | Apre/chiude radiatore bagno2 | manual 7°C → chiusa (antifreeze) |
| Sabiana 3-way x5 | Valvola interna fancoil | Apre/chiude flusso a coil | Comandate via Sabiana Cloud, modo cool attivo |

**Lo Smarther 2 BNS NON modula per zona — è un singolo relè ON/OFF apartment-level.** Datasheet conferma 2 gruppi relè (HEATING/COOLING) NC/C/NO, no PWM, no multi-zone. La modulazione apparente arriva dalle valvole 3-way Sabiana a valle.

## Perché waterTemp è 22°C (RANKED per probabilità)

**Fatto chiave nuovo (datasheet Sabiana)**: il sensore T3 è collocato **TRA LE ALETTE DEL COIL**, non sulla mandata. Misura la temperatura dello scambiatore stesso, non del tubo upstream. Tutti e 5 i fancoil leggono identico 22.0°C → vedi ipotesi.

1. **Acqua stagnante nel coil + equilibrio termico con l'ambiente (~60%)**. Se il flusso al coil è bassissimo (valvola 3-way Sabiana in bypass, o portata insufficiente dal collettore), l'acqua nel coil si scalda fino alla T ambiente. Media stanze ~28-30°C, T3=22°C suggerisce flusso minimo ma esistente — un po' di acqua fredda passa, ma resta nel coil il tempo necessario a riscaldarsi. **Identical 22.0°C su tutti 5 fancoil = sensore in equilibrio con qualcosa di condiviso a monte (collettore tiepido) o con simile pattern di flusso bypass.**
2. **Chiller condominiale fermo o setpoint alto (~25%)**. Tarda primavera, impianto appena commissionato, schedule pomeridiano. 22°C è circa la temperatura del riser non raffreddato. Verifica: tocca tubo montante.
3. **Smarther zone valve parzialmente chiusa (~10%)**. Il firmware in heating mode oscilla ON/OFF su misura<setpoint=30 → valvola apre ma per finestre brevi. Acqua nel collettore staziona e si scalda tra un'apertura e l'altra. Spiegherebbe anche la T3 identica (tutto downstream è tiepido uniformemente).
4. **Errore sensore o valore congelato (~5%)**. 5 fancoil che leggono lo stesso valore esatto a una cifra decimale è statisticamente strano. Verifica: campiona T3 a 2 cicli separati, cerca varianza ≥ 0.1°C.

## Le 10 NLLV — confermate tapparelle/tende

`netatmo-valves-map.md` ha già fatto il cross-check completo: tutti i 10 NLLV mappano a tapparelle elettriche e tende motorizzate per stanza (4 in salone, 2 studio Fabio, 1 ciascuna cucina/camera/studio Lida/bagno Vasca). Zero NLLV sul circuito idronico. Conferma empirica suggerita: POST `target_position: 50` su MAC `xx:xx:xx:xx:xx:48:68:98` (Tapparelle Salone Sinistra) → osservare tapparella muoversi fisicamente.

## Action concrete (in priorità)

1. **Apri la cassetta tecnica** (probabile in ingresso o ripostiglio): conferma esistenza collettore, conta derivazioni (attese: 7 = 5 fancoil + 2 radiatori bagno), verifica se ci sono ulteriori valvole intermedie (detentori, valvole di taratura). Fotografa per documentazione.
2. **Tocca il tubo montante** subito dopo Smarther: freddo (≤15°C) → chiller ok, problema downstream; tiepido (~22°C) → chiama amministratore.
3. **Verifica targhe relè Smarther**: aprire scatola Smarther 2 e controllare se i morsetti `COOLING NC/C/NO` sono cablati o vuoti. Se solo `HEATING` è cablato in un impianto 2-tubi change-over, la modalità cool firmware non aziona nulla elettricamente.
4. **Campiona T3 a 5min di intervallo su 30min**: se resta 22.0°C fissa → sensore congelato o flusso zero; se oscilla 21.5-22.5 → flusso lento esistente, chiller debole.
5. **Force fan=4 + sp 18°C su soggiorno per 15min**: se T3 scende e T2 (supply air) scende → c'è acqua fresca disponibile, agent stava solo under-driving; se T3 non si muove → blocco upstream confermato.
6. **Chiama amministratore** per orario start chiller + temperatura mandata attuale al riser.

Sources:
- [Sabiana CB-Touch fan coil control range PDF](https://pdf.archiexpo.com/pdf/sabiana/fan-coil-control-range/51461-385611.html)
- [Sabiana general catalogue 2020 (ABB mirror)](https://new.abb.com/docs/librariesprovider8/air-conditioning-systems/general-ctlg-sabiana-2020.pdf)
- Internal: `docs/netatmo-valves-map.md`, `docs/smarther-cool-mode.md`, `docs/cool-diagnostic-snapshot.md`, `src/lib/sabiana/client.ts:94`
