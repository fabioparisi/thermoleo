# Smarther 2 cooling mode — operative guide for ThermoLeo

## TL;DR

ThermoLeo today thinks Smarther 2 is heating-only. **It isn't.** The device has a real cooling mode in firmware, but the only way to enter it is sending a `mode: "cooling"` flag to the home or its schedule via the BNS API. Without that flag, every setpoint we push is interpreted as a *heating* setpoint, the firmware compares `measured < setpoint`, and the zone valve stays open in the wrong sense for summer. The 30°C trick "works" by accident in heating mode but doesn't actually engage the cooling pipeline.

## Findings

### 1. Smarther 2 has a native cooling mode (firmware level)

The official Italian datasheet (X8000W / SX8000W, doc `ST-00000298-IT`) shows two distinct relay groups on the back of the device: `HEATING NC/C/NO` and `COOLING NC/C/NO`. Indicator 10 on the front display is literally called "Indicatore raffrescamento acceso". The thermal-protection setpoint is 7°C in heating and **35°C in cooling**. Quote, page 3:

> La funzione raffrescamento è attivabile solo da App.

Cooling is a real firmware mode, not a workaround, but it must be turned on from the app (Home + Control). Source: [Bticino ST-00000298 datasheet](https://dar.bticino.it/asset/Documents/ST_00000298_IT.pdf).

### 2. The user-facing switch lives in Home + Control → Settings → Schedules

Legrand support article: "In the Home + Control App, go to **Settings → Schedules**. Clicking on the name of the schedule opens a drop-down menu, where you can select **Cooling**." This change is global to the home and applies to every Smarther + NLLV in it. Source: [Legrand support 27800001882642](https://support.legrand.com/hc/en-us/articles/27800001882642-How-can-I-switch-from-heating-to-cooling-mode-on-my-Smarther-with-Netatmo-smart-thermostat).

### 3. API surface (BNS / Smarther with Netatmo)

`pyatmo` ≥ 9.1.0 added explicit cooling handling. Confirmed via `src/pyatmo/enums.py`:

```python
class ScheduleType(StrEnum):
    THERM = "therm"
    COOLING = "cooling"
    ...
class TemperatureControlMode(StrEnum):
    HEATING = "heating"
    COOLING = "cooling"
```

Endpoints used (verbatim from `src/pyatmo/const.py`):

- `POST /api/setstate` — per-room setpoint (ThermoLeo already uses this).
- `POST /api/setthermmode` — home-level mode (away / hg / schedule).
- `POST /api/switchhomeschedule` — activates a specific `schedule_id`.
- `POST /api/synchomeschedule` — creates/edits a schedule including `type: "cooling"`.

The schedule object itself carries the cooling vs heating attribute. `pyatmo/schedule.py` reads `raw_data.get("type", ScheduleType.THERM)` and exposes a `cooling_away_temp` alongside the heating `away_temp` — meaning each home has TWO parallel schedule trees and switching seasons means activating the cooling-typed one. Source: [jabesq-org/pyatmo](https://github.com/jabesq-org/pyatmo).

### 4. Community confirmation that things break in cooling

GitHub issue [home-assistant/core#118336](https://github.com/home-assistant/core/issues/118336): when a user flips the Home + Control app to cooling, the entire HA Netatmo climate entity goes "unavailable" until the integration is reloaded — because the official HA climate integration is hard-coded for heating only (`HVAC_MAP_NETATMO` only maps AUTO / HEAT / OFF — no COOL). Same symptom Fabio is seeing on ThermoLeo: the home is in cooling but our agent talks to it as if it were heating.

### 5. `heating_power_request: 0` in cool — yes, that's correct

In cooling mode, NLLV valves still report `heating_power_request` because the field name is legacy. Bticino reseller training confirms that v.37 firmware on Smarther + v.97 on NRV/NLLV "manage the valves" but Netatmo never renamed the field. There is **no confirmed `cooling_power_request` field** in published payloads (I haven't seen one in any open-source reference). The valve opening percentage in cool is inferred from setpoint vs measured but inverted: in cooling, `measured > setpoint` opens the valve. **Not confirmed via Netatmo docs** — inferred from pyatmo source.

## What ThermoLeo does today

`src/lib/agent/smarther-summer.ts` calls `setRoomState(home_id, thermostat_room_id, mode='manual', temp=30, endtime=+180d)`. Idempotency keyed on `state.smartherSummerOpenAt`. The comment in the file is candid: "force Smarther into manual mode with a setpoint HIGHER than any realistic indoor temperature. The firmware perpetually 'wants more heat', so the zone valve stays open." That is exactly what we *don't* want: it keeps the device in heating mode and asks for heat. The valve does open, but the home is logically still heating, and downstream Netatmo logic that switches between heating/cooling pipelines never fires.

`src/lib/netatmo/client.ts:163` `setRoomState` never sends a `mode: "cooling"` or `schedule_type` field. Our season flag (`'heat' | 'cool' | 'off'` in `season.ts`) is purely a Supabase local concept, not pushed to Netatmo.

## What is probably going wrong right now

1. **Home is still in heating schedule on Netatmo side.** Even if Fabio toggled `season=cool` in Supabase, no API call was sent to flip the Netatmo home schedule type to cooling. So Smarther 2's firmware is still applying the heating logic (measured < setpoint = valve open) and the NLLVs follow the same convention.
2. **Setpoint 30°C in heating mode = "always demanding heat"**, not "always demanding cooling". In a 2-pipe system that's now physically full of cold water, the valve opens but the meaning is reversed — the firmware thinks it's serving heat that doesn't arrive. The 10 NLLVs you're seeing modulate between 0% and 100% are obeying their *individual* room schedules (still heating-typed), reaching satisfied at random based on each room's setpoint vs ambient.
3. **`heating_power_request: 0` is consistent** with the system being in cool from the chiller side but heating from the firmware's belief — the relay is closed because no NLLV is asking for heat-mode-water; chilled water flowing through is invisible to the heating-power calculation.
4. **`waterTemp=22°C` on the Sabiana**: this is the temperature reaching the fancoil coil. 22°C is way too warm to actually cool air at 30°C ambient — fancoils want roughly 7–12°C inlet water to do real sensible cooling. Either the condominio chiller is not fully cold yet (very plausible — late May, just commissioned), or the apartment zone valve isn't passing enough chilled water (because Smarther is in heating mode and only opens its main valve briefly). Both compound.

## Action items (in priority order)

1. **Add `setHomeMode(homeId, mode: 'heating' | 'cooling')`** to `src/lib/netatmo/client.ts`. Implementation: try `POST /api/synchomeschedule` with `{ home_id, schedule_id, type: 'cooling' }`, or activate a pre-existing cooling-typed schedule via `POST /api/switchhomeschedule`. Reference: `pyatmo/home.py async_switch_schedule(schedule_id)`.
2. **Inspect what schedules already exist on the home.** Call `GET /api/homesdata?home_id=...` and inspect `home.schedules[]` — each entry has a `type` field. Likely Fabio has one heating schedule (the default Bticino installs) and no cooling schedule yet. If no cooling schedule exists, the only way to create one is the Home + Control app (the synchomeschedule endpoint can `type: 'cooling'` but accepts only existing schedule_ids by default). **Not confirmed** — needs live API probe.
3. **Have Fabio open Home + Control → Settings → Schedules → "+" → choose Cooling**, name it "ThermoLeo cool", set every room to e.g. 24°C. This creates the cooling-typed schedule on the cloud. Then ThermoLeo can `switchhomeschedule` to it whenever `season=cool` and back to the heating schedule when `season=heat`.
4. **Replace `ensureSmartherSummerOpen` with `ensureSmartherSeasonMode`**. Logic: when `season=cool`, switch home to the cooling schedule (and optionally push manual 24°C setpoint per-room with `setpoint_mode='manual'` — in cooling mode this means "valve opens until room reaches 24°C", the *right* sense). Drop the 30°C hack.
5. **Verify the new `heating_power_request` (or `cooling_power_request`) field shape** by capturing one live `/api/homestatus` payload from the home after the cooling schedule is activated. Diff against the heating payload. Update `response-types.ts`.
6. **Independently verify the chiller water temp**. If the loop is at 22°C, no software change will cool the apartment. Ask the building admin for chiller commissioning status; check Sabiana waterTemp daily.

## Open questions (need a human source)

- Does the Netatmo cloud auto-reject `setstate` calls when the home is in cooling mode but a room's `therm_setpoint_*` was created under a heating schedule? Inferring "yes, with 406 Not Acceptable" from issue #79627 but unconfirmed for the cooling flip.
- Is there a hidden `cooling_power_request` field in `homestatus` when the home is in cooling? No source mentions it explicitly — must be observed empirically.
- The wiring diagram "Riscaldamento e raffrescamento con sistemi differenti" shows both relays used independently. In Fabio's 2-pipe apartment is only ONE relay wired (the heating one), in which case cooling-mode commands may not even drive the apartment zone valve electrically. **Verify the installer wiring** before relying on firmware cooling mode — ask Bticino installer or open the wall panel and check whether the `COOLING NC/C/NO` terminals are populated.
- Does Bticino Italy support have an installer-mode parameter for "2-pipe change-over" systems where a single relay should drive both heating and cooling water requests? Worth one support ticket.

## Sources

- [Bticino Smarther datasheet ST-00000298-IT](https://dar.bticino.it/asset/Documents/ST_00000298_IT.pdf)
- [Legrand support — heating to cooling switch](https://support.legrand.com/hc/en-us/articles/27800001882642-How-can-I-switch-from-heating-to-cooling-mode-on-my-Smarther-with-Netatmo-smart-thermostat)
- [Legrand developer forum — firmware v.37 + NRV v.97](https://developer.legrand.com/forums/topic/smarther-2-firmware/)
- [pyatmo source — enums, schedule, home](https://github.com/jabesq-org/pyatmo)
- [home-assistant/core#118336 — entity breaks in cooling](https://github.com/home-assistant/core/issues/118336)
- [home-assistant/core#79627 — setstate 406 on NRV](https://github.com/home-assistant/core/issues/79627)
- [Bticino thermostat installation manual mirror](https://thermostat.guide/bticino/bticino-xw8002w-smarther-thermostat-installtion-manual/)

---

## Update 2026-05-26 — fix shipped

Live test against this house (homeId `5dc07477777bfc8c6422ae15`, thermostat room `2171004425`):

```
POST /api/setstate
  home: { id: ..., rooms: [{
    id: 2171004425,
    cooling_setpoint_mode: 'manual',
    cooling_setpoint_temperature: 16,
    cooling_setpoint_end_time: <epoch_sec + 30d>
  }] }
→ { status: ok }

GET /api/homestatus → room shows:
  cooling_setpoint_temperature: 16
  cooling_setpoint_mode: manual
  cooling_setpoint_end_time: <+30d>
  therm_measured_temperature: 21.3
```

Logic: `measured (21.3) > cooling_setpoint (16)` ⇒ "ancora troppo caldo" ⇒ valve OPEN. Confirmed in production.

### Changes

- `src/lib/netatmo/client.ts` — added `setRoomCoolingState(homeId, roomId, mode, temp, endTimeEpochSec)`. Writes `cooling_setpoint_*` triple instead of `therm_setpoint_*`.
- `src/lib/agent/smarther-summer.ts` — rewritten. `ensureSmartherSummerOpen` now:
  - Pushes `cooling_setpoint_temperature = 16`, `cooling_setpoint_mode = 'manual'`, 180-day endtime.
  - Refresh window cut from 120 days to 60 minutes so a user touching the Smarther via Home + Control is corrected within 1h.
- The 30°C trick described in the old smarther-summer.ts header is OBSOLETE. It worked only when the home was still in heating mode (which made the firmware mis-interpret a hot setpoint as "always asking for heat"). Once `temperature_control_mode = "cooling"` is active, 30°C on `therm_setpoint_temperature` does nothing (the cooling pipeline ignores heating setpoints) and the valve obeys the `cooling_setpoint_temperature` value — which without override defaults to the user's cooling schedule and closes the valve as soon as soggiorno crosses it.

### Caveats still open

- `synchomeschedule` / `switchhomeschedule` to toggle the home between heating and cooling MODE is still not exposed in the public API. User must flip it once per season in Home + Control. The agent assumes the user has done this and the override above relies on the home already being in cooling mode.
- `cooling_power_request` field is still not observed in homestatus payloads; we infer valve state from setpoint vs measured comparison only.
