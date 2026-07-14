# Netatmo Inventory Completo

Dump generato 2026-05-25 da `/api/homesdata` (senza `gateway_types` filter, per vedere TUTTI i moduli sia BNS-tree che NLG-tree) e `/api/homestatus`.

## Home

- **ID**: `5dc07477777bfc8c6422ae15`
- **Name**: `Casa 7 Piano`
- **`temperature_control_mode`**: **`heating`** (campo critico — home configurata in modalità heating, NON cooling, anche se la stagione attuale è estiva)
- **`therm_mode`**: `schedule`
- **`cooling_mode`**: `schedule`
- **`therm_setpoint_default_duration`**: `30` (minuti)
- **`modes`**: `null`

## Schedule

Totale: 4 (3 therm + 1 cooling). Due hanno `selected:true` (uno per type).

| ID | Name | Type | Selected | Default | away_temp | hg_temp | Note |
|---|---|---|---|---|---|---|---|
| `5dc07478777bfc8c6422ae16` | Default | therm | null | false | 12 | 7 | Schedule di sistema |
| `691cb933953d4a056c07ac4e` | Schedule | therm | null | false | 18 | 12 | Inverno standard |
| `69a6bce13f361ac7cd0155d2` | **Offset** | therm | **true** | false | 12 | 7 | Selected; 4 zone, setpoint reali 25.5-27.5°C (uso "estivo" sopra `temperature_control_mode=heating` — l'utente forza set alti per spegnere i radiatori) |
| `6916236c851feae5ef0dd37a` | _(null)_ | **cooling** | **true** | true | – | – | Cooling schedule **esiste**, 3 zone, 25 timetable entries, `cooling_away_temp: 30`. Nome non impostato. |

**Risposta diretta: SÌ, uno schedule di tipo `cooling` è definito** (id `6916236c851feae5ef0dd37a`, default+selected), ma `temperature_control_mode` a livello home è ancora `heating` — quindi il sistema globalmente sta operando in modalità heating e lo schedule cooling non è attivo come driver.

## Rooms (14)

| Room ID | Name (IT) | Type | Module IDs |
|---|---|---|---|
| 3304643527 | Camera da letto | bedroom | – |
| 815666668 | Bagno Vasca | bathroom | `09:00:00:22:d1:e0` (NRV) |
| 3528549383 | Salone | livingroom | – |
| 57604598 | Studio Lida | home_office | – |
| 2926603397 | Libera | custom | – |
| 1636005927 | Ingresso | custom | – |
| 3258171081 | Cucina | kitchen | – |
| 2220668919 | Bagno Doccia | toilets | `09:00:00:22:d0:fa` (NRV) |
| 3330164908 | Corridoio | corridor | – |
| 2844123254 | Cabina Armadio | custom | – |
| 2911535074 | Balcone Grande | outdoor | – |
| 2138131162 | Studio Fabio | home_office | – |
| 4035799819 | Balcone Camera da Letto | outdoor | – |
| 2171004425 | **Termostato** | livingroom | `00:03:50:dd:5f:e0` (BNS Smarther) |

Solo 3 stanze hanno `module_ids` popolato; le altre hanno moduli associati via `room_id` lato modulo (luci, tapparelle).

## Rooms state (`homestatus`)

| Room | measured °C | setpoint °C | mode | heat_req | open_window |
|---|---|---|---|---|---|
| Bagno Doccia (2220668919) | 26.5 | 7 | manual | 0 | false |
| Bagno Vasca (815666668) | 27.0 | 7 | manual | 0 | false |
| Termostato/Salone (2171004425) | 23.3 (RH 64%) | 30 | manual | 0 | false |

Note: solo 3 stanze appaiono in `homestatus.rooms` perché solo loro hanno moduli HVAC (Smarther + 2 NRV). Le altre 11 stanze sono "puramente domotica" (luci + tapparelle). `heating_power_request` ovunque a 0 → caldaia ferma. `cooling_power_request` **non presente** in nessun room (campo assente quando home è in `temperature_control_mode=heating`).

## Modules (36 totali)

### HVAC tree (bridge BNS, gateway termico)

| ID | Name (IT) | Type | Bridge | Room | Stato live |
|---|---|---|---|---|---|
| `00:03:50:dd:5f:e0` | **Termostato** | **BNS** | – (gateway) | Termostato | wifi 63, boiler_status=true, cooler_status=false, comfort_boost=false |
| `09:00:00:22:d1:e0` | Radiatore Bagno Vasca | **NRV** | BNS | Bagno Vasca | battery full 3011mV, rf 57 |
| `09:00:00:22:d0:fa` | Radiatore Bagno Doccia | **NRV** | BNS | Bagno Doccia | battery full 3066mV, rf 47 |

**Smarther 2** = `00:03:50:dd:5f:e0` type **BNS**, room `2171004425` ("Termostato"). Unico modulo BNS.

**NRV (radiator valves)** = 2, entrambi nei bagni (Bagno Vasca + Bagno Doccia). Nessun altro NRV nelle altre stanze.

### Domotica tree (bridge NLG, gateway Living Now)

| ID | Name (IT) | Type | Room | Stato |
|---|---|---|---|---|
| `00:04:74:46:94:d2` | Gateway | NLG | Ingresso | wifi 59, firmware 1303 |
| `00:04:74:00:00:cc:88:f5` | Home Away | NLT | Ingresso | NLT (presence?) battery full |
| `00:04:74:00:00:cc:69:91` | Tapparelle Wifi Salone Sinistra | NLT | Salone | battery full, reachable=false |
| `00:04:74:00:00:cc:69:73` | Tapparelle Wifi Studio Fabio Sinistra | NLT | Studio Fabio | battery full |
| `00:04:74:00:00:cc:9d:15` | Tapparella Wifi Camera da letto | NLT | Camera da letto | battery full 2900mV |
| `00:04:74:00:00:cc:9d:da` | Tapparella Wifi Cucina | NLT | Cucina | battery full, reachable=false |
| `00:04:74:00:00:cc:69:5c` | Tapparella Wifi Studio Lida | NLT | Studio Lida | battery full |
| `00:04:74:00:00:cc:69:63` | Tapparella Wifi Salone Destra | NLT | Salone | battery full 3100mV |
| `00:04:74:00:00:cc:9d:29` | Tapparella Wifi Studio Fabio Destra | NLT | Studio Fabio | battery full, reachable=false |
| `00:04:74:00:01:48:98:80` | Tapparella Cucina | **NLLV** | Cucina | pos 43/43 |
| `00:04:74:00:01:48:97:f5` | Tende Salone Sinistra | NLLV | Salone | pos 50/50 |
| `00:04:74:00:01:48:68:27` | Tapparelle Bagno Vasca | NLLV | Bagno Vasca | pos 100/100 |
| `00:04:74:00:01:48:68:98` | Tapparelle Salone Sinistra | NLLV | Salone | pos 0/0 |
| `00:04:74:00:01:48:68:b4` | Tapparelle Camera da Letto | NLLV | Camera da letto | pos 23/23 |
| `00:04:74:00:01:48:98:e4` | Tapparelle Studio Lida | NLLV | Studio Lida | pos 55/55 |
| `00:04:74:00:01:48:68:ca` | Tapparelle Studio Fabio Sinistra | NLLV | Studio Fabio | pos 52/52 |
| `00:04:74:00:01:48:98:0e` | Tapparelle Studio Fabio Destra | NLLV | Studio Fabio | pos 100/100 |
| `00:04:74:00:01:48:68:30` | Tende Salone Destra | NLLV | Salone | pos 0/0 |
| `00:04:74:00:01:48:97:82` | Tapparelle Salone Destra | NLLV | Salone | pos 100/100 |
| `00:04:74:00:01:5e:b6:f5` | Corridoio (luce) | NLL | Corridoio | off |
| `00:04:74:00:01:5e:bb:8b` | Bagno Doccia (luce) | NLL | Bagno Doccia | off |
| `00:04:74:00:01:5e:b7:8f` | Luce Bagno Vasca | NLL | Bagno Vasca | off |
| `00:04:74:00:01:5e:bb:a7` | Luce Studio Lida | NLL | Studio Lida | off |
| `00:04:74:00:01:5e:ba:f1` | Luce Cabina Armadio | NLL | Cabina Armadio | off |
| `00:04:74:00:01:5e:b6:fb` | Luce Balcone | NLL | Balcone Grande | off |
| `00:04:74:00:01:5e:b6:eb` | Luce Cucina | NLL | Cucina | off |
| `00:04:74:00:01:5e:b6:d9` | Luce Penisola | NLL | Cucina | off |
| `00:04:74:00:01:5e:bb:83` | Luce Studio Fabio | NLL | Studio Fabio | off |
| `00:04:74:00:01:5e:bb:bd` | Luce Ingresso | NLL | Ingresso | off |
| `00:04:74:00:01:5e:b6:91` | Luce Balcone Camera da Letto | NLL | Balcone Camera | off |
| `00:04:74:00:01:72:79:7e` | Luce Tavolo | NLFN | Salone | off, dim 8 |
| `00:04:74:00:01:72:79:4a` | Luce Camera da Letto | NLFN | Camera da letto | off, dim 100 |
| `00:04:74:00:00:cc:69:6a` | _(senza nome)_ | **NLunknown** | – | firmware 0xFFFFFFFF, no room |

### Type legend

- **BNS** = Smarther 2 boiler controller (1 device)
- **NRV** = radiator valve termostatica (2 device, solo bagni)
- **NLG** = Living Now Gateway (1 device, in Ingresso)
- **NLT** = Wireless tapparella controller (8 device) — pairing wifi
- **NLLV** = Wired venetian/shutter actuator (10 device)
- **NLL** = Light switch (11 device)
- **NLFN** = Dimmer light (2 device)
- **NLunknown** = 1 modulo non identificato (firmware uint max, no room) — probabilmente un dispositivo orfano da decommissionare

## Risposte alle domande critiche

1. **Schedule cooling esiste?** SÌ — id `6916236c851feae5ef0dd37a`, type `cooling`, selected+default, ma con `name: null` (nessun label utente). 3 zone, 25 timetable entries, `cooling_away_temp:30°C`.
2. **`temperature_control_mode`**: **`heating`** — home globalmente in heating, schedule cooling presente ma non è il driver attivo della logica boiler/cooler. Per andare in cooling vero serve `POST /setthermmode` (o equivalente Bticino) per cambiare il mode.
3. **NLLV totali**: 10. Tutti tapparelle/tende (Salone x4, Studio Fabio x2, Studio Lida, Camera da letto, Cucina, Bagno Vasca). Nessun NLLV su HVAC.
4. **Smarther 2**: `00:03:50:dd:5f:e0` (type BNS), room `2171004425` ("Termostato", type livingroom). Stato live: `boiler_status:true` (relè caldaia chiamato ma `heating_power_request:0` → contraddizione minore, probabile lag), `cooler_status:false`, wifi 63.
5. **NRV bagni**: 2 — Bagno Vasca (`09:00:00:22:d1:e0`) e Bagno Doccia (`09:00:00:22:d0:fa`). Entrambi battery full, reachable, RF 47-57. Setpoint 7°C (antigelo) entrambi → caloriferi spenti.
6. **Altri HVAC**: nessuno. Sotto il bridge BNS solo Smarther + 2 NRV. Tutto il resto è domotica (NLG tree).

## Caveat

- Il modulo `00:04:74:00:00:cc:69:6a` type `NLunknown` non lo so identificare con certezza dai dati API — verificare in app Bticino se è ancora paired.
- `cooling_power_request` non compare in `homestatus.rooms[]`: assenza coerente con `temperature_control_mode:heating`. Per leggere il cooling-side bisogna prima switchare il mode.
- Il campo `selected` su due schedule contemporaneamente (uno therm + uno cooling) è normale: Netatmo tiene un selected per type, e il driver attivo dipende da `temperature_control_mode`.
