# Netatmo NLLV Valve Map — Casa 7 Piano (home_id 5dc07477777bfc8c6422ae15)

**Created**: 2026-05-25 — investigation triggered by summer cooling failure (acqua non fredda al fancoil).

## TL;DR — The 10 "valves" are NOT water valves

The 10 `NLLV` modules with `current_position` 0-100% are **Netatmo Legrand "Living Light/Shutter" actuators** for **tapparelle (electric roller shutters) and tende (motorized curtains)**. They have NOTHING to do with the hydronic loop. `current_position` is the shutter open/close percentage.

The two devices that actually move water in this apartment are the two `NRV` (Netatmo Radiator Valve) modules sitting on the BNS (Smarther 2) bridge — one per bathroom radiator. There is **no Netatmo valve on the fancoil hydronic loop**. The chiller cold water reaches the fancoils through the building riser, the apartment manifold, and the on/off zone valve commanded by the **Smarther 2 (BNS, MAC `xx:xx:xx:xx:xx:e0`)**.

**Implication for the current cooling problem**: nothing in the NLLV list is making your fancoils warm. The fancoils are blowing tepid air because the cold water source upstream is not actually cold. Investigate the chiller / zone-valve / Smarther 2 BNS, not the NLLV shutters.

## Topology pulled live from `/api/homesdata`

Home: `Casa 7 Piano`, id `5dc07477777bfc8c6422ae15`. 14 rooms, ~35 modules.

### The 10 NLLV (shutter actuators), each mapped to its room

| MAC (last bytes) | Full MAC | NLLV friendly name | Netatmo room id | Room name | Live position |
|---|---|---|---|---|---|
| `98:80` | `xx:xx:xx:xx:xx:48:98:80` | Tapparella Cucina | `3258171081` | Cucina | 43% |
| `97:f5` | `xx:xx:xx:xx:xx:48:97:f5` | Tende Salone Sinistra | `3528549383` | Salone | 50% |
| `68:27` | `xx:xx:xx:xx:xx:48:68:27` | Tapparelle Bagno Vasca | `815666668` | Bagno Vasca (bagno1) | 100% |
| `68:98` | `xx:xx:xx:xx:xx:48:68:98` | Tapparelle Salone Sinistra | `3528549383` | Salone | **0%** (chiusa) |
| `68:b4` | `xx:xx:xx:xx:xx:48:68:b4` | Tapparelle Camera da Letto | `3304643527` | Camera da letto | 23% |
| `98:e4` | `xx:xx:xx:xx:xx:48:98:e4` | Tapparelle Studio Lida | `57604598` | Studio Lida | 55% |
| `97:82` | `xx:xx:xx:xx:xx:48:97:82` | Tapparelle Salone Destra | `3528549383` | Salone | 100% |
| `68:ca` | `xx:xx:xx:xx:xx:48:68:ca` | Tapparelle Studio Fabio Sinistra | `2138131162` | Studio Fabio | 52% |
| `98:0e` | `xx:xx:xx:xx:xx:48:98:0e` | Tapparelle Studio Fabio Destra | `2138131162` | Studio Fabio | 100% |
| `68:30` | `xx:xx:xx:xx:xx:48:68:30` | Tende Salone Destra | `3528549383` | Salone | **0%** (chiusa) |

The two NLLV at 0% are **Tende Salone Sinistra and Tende Salone Destra (le tende motorizzate del salone, non le tapparelle)**. Domestic curtains. Closed because nobody pulled them open. They have zero impact on water temperature.

### The actual hydronic actuators

| Device | MAC | Type | Room | Role |
|---|---|---|---|---|
| Termostato (Smarther 2) | `xx:xx:xx:xx:xx:e0` | BNS | `2171004425` Termostato (livingroom) | Commands the apartment-level zone valve that gates ALL chilled/hot water entering the manifold. Forced to manual 30°C/180d in summer by `ensureSmartherSummerOpen` so the valve stays open. Live: `boiler_status=true`, `cooler_status=false` — **see open question #1**. |
| Radiatore Bagno Vasca | `xx:xx:xx:xx:xx:e0` | NRV | `815666668` Bagno Vasca (bagno1) | Bathroom radiator valve. Forced manual 7°C/180d antifreeze in summer (so radiator stays closed and doesn't condense humidity). |
| Radiatore Bagno Doccia | `xx:xx:xx:xx:xx:fa` | NRV | `2220668919` Bagno Doccia (bagno2) | Same. Forced 7°C/180d antifreeze. |

The 5 Sabiana fancoils (leone, soggiorno, camera, studio, cucina) do not have an NLLV or NRV on their water side — they have a built-in 3-way valve commanded over Sabiana Cloud, fed by whatever water the building riser delivers downstream of the Smarther's zone valve.

### Smarther rooms cross-check

| Smarther room id | netatmo_room_map slug (Supabase) | Netatmo name | Live setpoint |
|---|---|---|---|
| `815666668` | `bagno1` | Bagno Vasca | 7°C manual (antifreeze) |
| `2220668919` | `bagno2` | Bagno Doccia | 7°C manual (antifreeze) |
| `2171004425` | `soggiorno` | Termostato | 30°C manual (sentinel summer-open) |

All three match what `ensureSmartherSummerOpen` and `bathroom-antifreeze` are supposed to do. The summer override IS being applied — `cooler_status=false` is the real problem.

## Final mapping by ThermoLeo room

| ThermoLeo room | NLLV (shutters) | Hydronic valve | Notes |
|---|---|---|---|
| leone | none (Netatmo doesn't manage this room's shutter) | none — Sabiana fancoil internal valve | Fancoil only |
| soggiorno (Salone, 3528549383) | 4× NLLV: 2 tapparelle + 2 tende | Smarther 2 zone valve (commands whole apartment) | Heavy NLLV presence here because it's the biggest room |
| camera (Camera da letto, 3304643527) | 1× NLLV (Tapparelle) | none — Sabiana fancoil | DISABLED room in ThermoLeo |
| studio (Studio Fabio, 2138131162) | 2× NLLV | none — Sabiana fancoil | |
| cucina (Cucina, 3258171081) | 1× NLLV | none — Sabiana fancoil | |
| bagno1 (Bagno Vasca, 815666668) | 1× NLLV | 1× NRV (Radiatore Bagno Vasca) | Radiator valve forced 7°C in summer |
| bagno2 (Bagno Doccia, 2220668919) | none (no NLLV here, just radiator) | 1× NRV (Radiatore Bagno Doccia) | Radiator valve forced 7°C in summer |
| Studio Lida (57604598) | 1× NLLV | nothing — guest room without ThermoLeo fancoil mapping | |

## Open questions

> ⚠️ **Storico — risolto 2026-05-26**. Le ipotesi qui sotto erano basate su un decoder Sabiana sbagliato: i campi `supplyTemp` e `waterTemp` NON esistono in `lastData` (erano i setpoint heat/auto del Modbus register, vedi `skill-thermoleo/references/lessons-learned.md` #27). La radice del problema cooling era duplice: (a) Smarther 2 in `temperature_control_mode=heating` → fix con `setRoomCoolingState(cooling_setpoint=16 manual 180d)`; (b) tmb soggiorno con AL9 dovuto a T2-1/T3-2 troppo bassi sul T-MB2 → fix sul pannello fisico alzando le soglie. Documento tenuto per memoria storica.

1. **`cooler_status=false` on the BNS** despite the user being in summer mode. Either (a) the BNS firmware reports `cooler_status` only when the Smarther actively commands the chiller call (and in this two-pipe building the call is delegated to the condominio chiller, not the apartment Smarther), or (b) the chiller isn't running at the building level. `boiler_status=true` is suspicious in summer — verify whether this field is just "is there a heat/cool source attached" rather than "is it currently calling".
2. **Is the Smarther 2 zone valve actually OPEN?** The Smarther is set 30°C / measured 27.2°C, so its firmware (heating-mode) thinks "wants more heat" → valve should be open. But there is no telemetry confirming the physical valve position.
3. **`heating_power_request: 0` on all 3 Smarther rooms** — likely normal in cool mode (field is heating-only) but Netatmo docs don't confirm. If they expose a `cooling_power_request` we don't read it.
4. ~~**Sabiana waterTemp = 22°C**~~ — **FALSO**. La nostra lettura `bytes[16-17]` non era T3 acqua: era il setpoint AUTO Modbus register (vedi lesson #27). Sabiana non espone T3 nel cloud API.
5. **No `cooling`/`hg` mode support in our `setRoomState`** — only `home`/`manual`/`max`/`hg`. BNS may accept a `therm_mode: 'cool'` on the home object, not the room. Worth checking the Netatmo dev docs Control reference.

## Next steps (in priority order)

1. **Building-side check**: confirm with the amministratore that the condominial chiller is actively serving the riser today. If not, no amount of valve juggling will help. Sabiana's 22°C waterTemp is the smoking gun — that's roughly ambient.
2. **Probe BNS for a cool-mode flag**: call `GET /api/homestatus` parsing the top-level `home` object for `therm_mode`, `mode`, `cooling_status` fields beyond what our types capture; also try `POST /api/setstate { home: { id, therm_mode: 'cool' } }` and observe whether `cooler_status` flips to true. The Smarther 2 has an explicit Heating/Cooling firmware setting accessible from the Home+Control app — verify it is set to Cooling for summer on the physical device or via the app.
3. **NLLV is a red herring — close that line of investigation.** Confirm by trying `POST /api/setstate { home: { id, modules: [{ id: "xx:xx:xx:xx:xx:48:68:98", target_position: 50 }] }}` — you'll see the salone left curtain physically slide open. That confirms NLLV = shutters and removes them from suspect list.
4. **Smarther zone-valve manual override**: if `cooler_status` won't flip, try forcing the Smarther into `therm_setpoint_mode='max'` (boost) — should physically open the valve regardless of the cool/heat firmware setting. If water at the fancoil still doesn't get cold, the problem is upstream of the Smarther.
5. **Check NRV bathroom valves haven't accidentally been put on the fancoil loop manifold** — visually inspect the manifold cabinet. We assume NRV are on the bathroom radiators only, but if the installer put one inline on the cold-water riser by mistake, a 7°C antifreeze setpoint in summer would explain everything (valve thinks "room is at 27°C, I'm satisfied at 7°C, close"). Very unlikely but cheap to verify.
6. **Long-term**: extend `response-types.ts` to capture `cooler_status`, `boiler_status`, and any `therm_mode` / `cooling_*` fields on the home object. Then expose them in `/api/netatmo/status` so this kind of investigation is one curl away next time.

## Code/data references

- `src/lib/netatmo/client.ts:130-185` — `getHomeStatus` / `setRoomState` (BNS path).
- `src/lib/netatmo/context.ts` — `loadNetatmoContext()` returns `{ homeId, roomMap }` from Supabase `tokens` row.
- `src/lib/agent/smarther-summer.ts` — `ensureSmartherSummerOpen` (the 30°C / 180-day pin).
- `src/lib/agent/bathroom-antifreeze.ts` — bathroom NRV → 7°C / 180-day pin.
- Supabase `tokens` row `provider='netatmo_room_map'`: `{bagno1: 815666668, bagno2: 2220668919, soggiorno: 2171004425}`.
- Live status snapshot: https://your-deployment.vercel.app/api/netatmo/status.
