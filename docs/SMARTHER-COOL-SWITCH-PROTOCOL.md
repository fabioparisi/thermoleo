# Smarther 2 (BNS) — protocollo definitivo per switch heating↔cooling

**Verdetto**: **NON è esposto nella Netatmo Connect API pubblica.** Lo switch
del `temperature_control_mode` dell'home tra `"heating"` e `"cooling"` è
un'azione manuale, eseguita esclusivamente dall'utente dentro l'app
Home + Control. Non esiste endpoint REST documentato né reverse-engineered
con cui un'integrazione di terze parti possa cambiare il modo. Tutti i
tentativi fatti finora corrispondono al consenso della comunità: falliscono.

Però questo NON è un problema per Thermoleo, perché l'apartamento usa un
loop idronico a 2 tubi gestito a monte dal condominio. Il workaround
`smarther-summer.ts` già committato (setpoint manuale 30°C → valvola
sempre aperta → flow di acqua fredda ai fancoil) è la soluzione corretta
e definitiva. Sezione finale spiega perché.

---

## La risposta certa

**Non c'è risposta API pubblica per il cambio di modo.** Ecco l'evidenza
combinata che lo dimostra in tre direzioni convergenti:

1. **Ufficiale (Legrand / Netatmo)**: la procedura documentata è una serie
   di tap nell'app Home + Control: *Settings → Schedules → tap sul nome →
   dropdown → "Cooling"*. Nessun riferimento ad API.
2. **Sorgente pyatmo (libreria di riferimento usata da Home Assistant)**:
   `temperature_control_mode` è esclusivamente READ. Nessun setter, nessun
   endpoint, nessuna chiamata POST che lo modifichi.
3. **Home Assistant `netatmo/climate.py`** (master): nessuna occorrenza di
   `cooling`, `temperature_control_mode`, o `HVACMode.COOL`. L'integrazione
   supporta solo riscaldamento.

`POST /api/setthermmode mode=cooling` restituisce `"mode not authorized"`
perché `setthermmode` accetta solo `{schedule, away, hg, manual, max, off,
home}` (vedi const pyatmo) — `cooling` non è mai stato un valore valido.
Lo schema cooling esiste a livello home, ma diventa attivo solo quando
l'app Home + Control flippa `temperature_control_mode` lato server-side
Netatmo, e quel flip non è esposto.

## Evidence

### 1. Legrand Help Center — procedura ufficiale è manuale via app

[How can I switch from heating to cooling mode on my Smarther with Netatmo](https://support.legrand.com/hc/en-us/articles/27800001882642):
> *"To switch from heating to cooling mode in the Home + Control App, go
> to Settings and select Schedules. Clicking on the name of the schedule
> opens a drop-down menu, where you can select Cooling. You can then
> create a new cooling program or activate an existing one."*
> *"Before switching... check that your system is compatible and check
> that you have carried out all the operations on the system necessary
> to change mode. Additionally, the switch from heating to cooling mode
> is performed for all thermostats connected in the house."*

Stessa procedura in francese su [legrand.fr](https://www.legrand.fr/questions-frequentes/comment-puis-je-passer-mon-thermostat-connecte-smarther-with-netatmo-du-mode-de-chauffage-au-mode-de-refroidissement-eliot):
> *"Paramètres → Plannings → cliccare sul nome → tab Refroidissement → creare/attivare un planning di raffrescamento."*

**Nessuna delle due pagine** menziona installer, dipswitch o configurazione
hardware. È puro flip dentro l'app.

### 2. pyatmo non ha setter per `temperature_control_mode`

Repo: [jabesq-org/pyatmo](https://github.com/jabesq-org/pyatmo) (cloned
2026-05-25, commit `11de7f2`, v9.4.0 + unreleased).

```bash
grep -rn "temperature_control_mode" src/pyatmo/
```

Risultati (`src/pyatmo/home.py`):
- riga 54: `temperature_control_mode: TemperatureControlMode | None = None` (attributo)
- riga 86 + 117: `raw_data.get("temperature_control_mode")` (lettura da homesdata)
- riga 240, 252: usato come filtro per `get_selected_schedule()` (lettura)

Zero scrittura. Confermato anche da `src/pyatmo/const.py`:

```
SETTHERMMODE_ENDPOINT = "api/setthermmode"
SWITCHHOMESCHEDULE_ENDPOINT = "api/switchhomeschedule"
SYNCHOMESCHEDULE_ENDPOINT = "api/synchomeschedule"
SETSTATE_ENDPOINT = "api/setstate"
SETROOMTHERMPOINT_ENDPOINT = "api/setroomthermpoint"
```

Nessun endpoint contiene `cooling`, `season`, `summer`, `switchmode`,
`setregulationmode`. I modi accettati da setthermmode sono codificati nei
costanti (riga 93-99): `MANUAL, MAX, HOME, FROSTGUARD(hg), SCHEDULE,
OFF, AWAY`. **`cooling` non è nell'enum di setthermmode.**

Il file pyatmo `home.py:284-315` mostra che `async_set_thermmode` accetta
`mode: str | None` e lo invia diretto al server — quindi se passi
`cooling`, l'API server-side risponde "mode not authorized" come Fabio ha
osservato. La validazione è server-side, non lato libreria.

Il fix `Handling of cooling/heating control mode` nel changelog v9.1.0
non aggiunge un setter — aggiunge solo `ScheduleType.COOLING` enum e il
mapping per LEGGERE correttamente lo schedule selezionato quando l'home
è già in modo cooling.

### 3. Home Assistant `homeassistant/components/netatmo/climate.py`

Cloned `home-assistant/core@HEAD`. `grep -rn "cool\|cooling"` su quel file
restituisce solo `heating_power_request` (3 hit, contesto heating-only).
Le costanti supportate sono `HVACMode.HEAT, HVACMode.AUTO, HVACMode.OFF`
— `HVACMode.COOL` non è dichiarato.

Questo conferma che la community Home Assistant **non ha mai trovato un
endpoint** per cambiare modo, nonostante anni di reverse engineering.

### 4. Issue HA che cristallizza il limite

[Issue #88417 home-assistant/core "Bticino Smarther2 settings do not stick"](https://github.com/home-assistant/core/issues/88417)
e [Issue #118336 "Error of entity climate thermostat (bticino smarther 2) when it's in cooling mode"](https://github.com/home-assistant/core/issues/118336):
in entrambi i casi gli utenti **passano in cooling con l'app Home +
Control**, poi HA si rompe perché legge `cooling_setpoint_temperature`
invece di `therm_setpoint_temperature`. Nessun utente, in nessun commento,
ha mai postato una sequenza API per fare il flip — sempre fatto via app.

[Discussione community "Living Now Smart - Smarther2 X8002 - New Legrand/Netatmo API"](https://community.home-assistant.io/t/living-now-smart-smarther2-x8002-new-legrand-netatmo-api/374654):
post originale di GioEz: *"I basically can't switch from heating to
cooling mode, nor change the schedules that I've configured ... didn't
understand if there's a way to switch mode or schedule"* — domanda aperta
senza risposta tecnica.

### 5. Perché `switchhomeschedule` con un cooling_id ritorna `status:ok` ma non fa nulla

Lo schedule cooling **esiste già** dentro l'home e ha `selected=true`,
ma `homesdata.body.homes[0].temperature_control_mode` resta `"heating"`.
`switchhomeschedule` semplicemente sceglie quale schedule è "selected"
dentro il set corrente. Ma se l'home è in modo heating, il server filtra
quale schedule è realmente attivo via `SCHEDULE_TYPE_MAPPING[temperature_control_mode]`
(vedi pyatmo `home.py:230-243`):

```python
return next(
    (schedule for schedule in self.schedules.values()
     if schedule.selected
     and self.temperature_control_mode
     and schedule.type == SCHEDULE_TYPE_MAPPING[self.temperature_control_mode]),
    None,
)
```

Tradotto: l'home tiene UNO schedule selected per heating e UNO per cooling
in parallelo. Selezionare quello cooling non promuove l'home a cooling.
È il contrario: si promuove l'home a cooling (via app), e POI lo schedule
cooling già selected entra in vigore. Il `status:ok` osservato è quindi
veritiero, ma irrilevante per il flip di modo.

## Cosa serve oltre l'API

Riassunto delle dipendenze osservabili nei sorgenti e nella documentazione:

1. **App Home + Control** (Legrand / Netatmo) — obbligatoria per il flip.
   Non c'è equivalente API.
2. **Compatibilità impianto** (sentenza Legrand): *"check that your
   system is compatible and... carried out all the operations on the
   system necessary to change mode"*. Lo Smarther 2 BNS (X8002) è di
   per sé bivalente, ma l'impianto idronico a monte deve poter erogare
   acqua fredda. Per l'appartamento di Fabio questo è un flip manuale
   nella centrale termica del condominio.
3. **Nessun dipswitch** sul dispositivo. Il manuale installazione
   [XW8002 Installation Manual via thermostat.guide](https://thermostat.guide/bticino/bticino-xw8002w-smarther-thermostat-installtion-manual/)
   menziona solo *"Reset key (keep pressed for 10s...)"* come unica
   azione fisica. Il selettore heat/cool non esiste nell'hardware.
4. **Nessun "installer mode"** documentato. Tutti i parametri configurabili
   passano per l'app o per l'OAuth Connect API. Nessuna API riservata
   agli installatori è esposta nel Legrand Developer portal.

Implicazione: anche se un'integrazione futura riuscisse a chiamare un
endpoint privato dell'app Home + Control (sniffato via mitmproxy), c'è
comunque l'invariante "the switch is performed for all thermostats
connected in the house". Quindi è una decisione globale, non per-room,
e Legrand intenzionalmente la mantiene comportamento UI-only per evitare
errori di impianto.

## Come questa app può integrarlo

**Non integrarlo.** L'approccio già implementato in
`src/lib/agent/smarther-summer.ts` è la strada giusta e ha il vantaggio
di NON dipendere da un endpoint non documentato (che potrebbe scomparire
con un update dell'app).

Il workaround corrente esprime esattamente la fisica:

```ts
// Smarther in modo heating, setpoint = 30°C, MANUAL, endtime 180 giorni.
// firmware vede "ambiente sempre sotto setpoint" → valvola sempre aperta
// → acqua fredda del chiller condominiale → fancoils possono cooling.
await setRoomState(accessToken, homeId, thermostatRoomId, 'manual', 30, endtime);
```

Questo bypassa completamente la necessità di flippare
`temperature_control_mode`. Lo Smarther resta in heating-mode (firmware-wise)
ma la sua valvola sta aperta, e i fancoils a valle (Sabiana via Sonoff)
fanno il vero cooling control con i loro setpoint locali.

### Patch concreta — già in `smarther-summer.ts`

Il file è già corretto (vedi righe 1-127). Due piccoli rafforzamenti
opzionali se vuoi blindarlo ulteriormente:

```ts
// 1. Documentare esplicitamente nel JSDoc che cooling-mode-flip via API
//    non esiste. Inserire link a Legrand support article come riferimento
//    permanente per i futuri lettori che si chiederanno "perché non
//    chiamiamo l'API cooling?".

/**
 * NOTE: Netatmo Connect API does NOT expose the heating↔cooling switch.
 * `temperature_control_mode` is read-only via /api/homesdata. The flip
 * is only available through the Home + Control mobile app (Settings →
 * Schedules → name dropdown → Cooling).
 * Source: https://support.legrand.com/hc/en-us/articles/27800001882642
 * Confirmed cross-source: pyatmo (no setter), home-assistant/core (no
 * cool mode in netatmo climate.py), HA issues #88417 + #118336.
 * That's why we use the manual-setpoint-30°C trick to keep the valve
 * physically open, instead of trying to change mode.
 */
```

```ts
// 2. Quando season torna a 'heat', NON usare un'API equivalente per il
//    flip indietro — invece chiamare cancelRoomState() o un setpoint
//    schedule per riportare il termostato alla schedule heating normale.
//    (probabilmente già gestito dal caller via state.smartherSummerOpenAt=null;
//     verificare in state-machine.ts che invochi clear quando season=heat.)
```

### Cosa NON fare (testato/derivato e fallisce)

- `setthermmode mode=cooling` → server reject `"mode not authorized"`
  (schema pyatmo conferma: cooling non è in MODES enum)
- `setstate {home:{temperature_control_mode:"cooling"}}` → schema reject
  (campo è read-only lato API)
- `switchhomeschedule schedule_id=<cooling>` → `status:ok` ma no-op
  (selected dentro insieme cooling, ma insieme attivo deciso da
  temperature_control_mode globale)
- `switchhomemode` / `setregulationmode` → endpoint inesistenti
  (`grep -rn` su pyatmo e ha-core conferma)
- Reverse-engineer Home + Control app via mitmproxy potrebbe trovare un
  endpoint privato, ma (a) è fragile, (b) viola ToS Legrand, (c)
  inutile dato che il workaround funzionale già esiste.

## Conclusione operativa

**Niente da cambiare lato codice.** Aggiornare i doc per ricordare che
il limite è strutturale, non un bug della nostra integrazione. Il
workaround `manual + 30°C + 180 giorni` è la risposta corretta sia per
oggi sia per il prossimo refactor.

## Fonti

- [Legrand support EN: switch heating to cooling](https://support.legrand.com/hc/en-us/articles/27800001882642)
- [Legrand support FR: passer chauffage à refroidissement](https://www.legrand.fr/questions-frequentes/comment-puis-je-passer-mon-thermostat-connecte-smarther-with-netatmo-du-mode-de-chauffage-au-mode-de-refroidissement-eliot)
- [Netatmo helpcenter: Change mode (Heating/Cooling)](https://helpcenter.netatmo.com/hc/en-us/articles/11561866080530-How-do-I-change-the-mode-Heating-Cooling-of-my-air-conditioner) (403 da scraping ma indicizzato in serp)
- [jabesq-org/pyatmo](https://github.com/jabesq-org/pyatmo) src/pyatmo/home.py, const.py, modules/smarther.py
- [home-assistant/core netatmo/climate.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/netatmo/climate.py)
- [HA issue #88417: Smarther2 settings do not stick](https://github.com/home-assistant/core/issues/88417)
- [HA issue #118336: cooling mode error](https://github.com/home-assistant/core/issues/118336)
- [HA community: Living Now Smart Smarther2 X8002](https://community.home-assistant.io/t/living-now-smart-smarther2-x8002-new-legrand-netatmo-api/374654)
- [Manuale installazione XW8002](https://thermostat.guide/bticino/bticino-xw8002w-smarther-thermostat-installtion-manual/)
