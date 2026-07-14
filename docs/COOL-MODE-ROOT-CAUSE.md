# Root cause: cooling mode not enabled at firmware/installer level

**Date:** 2026-05-25

## Confermed via Netatmo API

```
homesdata.body.homes[0].temperature_control_mode = "heating"
```

This field is **read-only via the user API**. We tried:
- `setthermmode mode=cooling` → `"mode not authorized"`
- `setstate { home: { temperature_control_mode: "cooling" } }` → schema error
- `switchhomeschedule` to cooling schedule id → OK status but `temperature_control_mode` unchanged
- `switchhomemode` → endpoint does not exist
- `setregulationmode` → endpoint does not exist

The cooling schedule (`6916236c851feae5ef0dd37a`, type=cooling, default+selected) exists and is already pre-configured. But the home as a whole is locked in `heating` control mode.

## Why

Smarther 2 firmware has separate `HEATING` and `COOLING` relay terminals on the back. Wiring/enabling the cooling path is an **installer-level operation** done either:
- Via the official BTicino "Home + Control" app — there's a Settings menu for the thermostat that exposes "Cooling enable" / "Modalità raffrescamento" / similar (only visible if the installer enabled it during pairing)
- Via physical DIP switches behind the thermostat
- Via a service call from a BTicino-certified installer

Without that flag set, the user-facing API refuses to switch the mode.

## What ThermoLeo's code is currently doing — and why it "kinda works"

`ensureSmartherSummerOpen` (commit `a6bade1`) sets the Smarther to **manual setpoint 30°C in heating mode**. In firmware heating logic:
- `measured (27.7°C) < setpoint (30°C)` → "needs more heat" → opens the zone valve

Since the building loop is actually carrying cold water (chiller running, switched seasonally upstream), this **accidentally** lets cold water through the open valve to the fancoils. But:
- The home is reported globally as `heating` to the chiller's logic, so chiller is in idle/low-priority for this apartment
- Per-room `heating_power_request: 0` is interpreted as "no cooling demand either" by the condominio's PLC
- `cooling_power_request` is not exposed (only valid in cooling mode)
- Net effect: water at ~22°C arrives, fan blowing at 3 doesn't extract enough heat from 30°C ambient

## What needs to happen

**One of:**

1. **User opens BTicino Home + Control app** → Settings → Smarther 2 → look for "Modalità riscaldamento/raffrescamento" toggle. If present, switch to Cooling. Save.

2. **Physical inspection**: detach Smarther 2 from wall, check for DIP switches labelled HEAT/COOL or similar. Toggle position.

3. **Call BTicino installer** (number on the box or warranty card) to enable cooling mode firmware-side. They'll likely do it remotely via their service portal.

Once `temperature_control_mode` flips to `cooling`, `setthermmode mode=cooling` will be accepted via API, and ThermoLeo can drive cooling explicitly via `cooling_setpoint_temperature` per room.

## Plan after the flag is enabled

1. Update `ensureSmartherSummerOpen` to use the actual cooling mode endpoint instead of the 30°C heat-mode hack
2. Add a `cooling_power_request` field handling in the agent cycle (parallel to `heating_power_request`)
3. Cooling setpoint per room becomes real (e.g. cool to 24°C means actual cool-to-24, not "open valve via heat hack")

## Side note: not the chiller's fault per se

The `temperature_control_mode: heating` flag is propagated up to the condominio's plant control system via Bticino/Legrand integration. As long as no apartment in the building is requesting cooling, the chiller may be running at lower priority or not running at all. Once one apartment flips to cooling mode officially, the central plant should respond.

## Today's workarounds while flag is stuck on heating

- 30°C-manual hack keeps valve open (current behavior — acceptable but inefficient)
- Fan ladder ladder pushes Sabiana fans up when ambient diverges from target — already doing this
- Raise target to 28°C reduces unnecessary fan run — already done

The ceiling on effectiveness is the water temperature delivered, which we can't control from this side.

## UPDATE 2026-05-25 — resolution

User flipped to cooling mode via the Home+Control app (not in the menu I'd guessed; user found the correct screen). Immediate result observable via API:

- `homesdata.schedules`: cooling-type schedule "Default" is now ★selected (alongside heating "Offset" — the home keeps both schedules selected in parallel, the active one is determined by `temperature_control_mode`)
- `homestatus.rooms[soggiorno].therm_measured_temperature`: dropped from 27.7°C to 23.2°C within ~10 minutes — clear evidence cold water is now flowing through the apartment's distribution
- `temperature_control_mode` field on `homesdata` still reads `heating` (Netatmo API quirk: it's likely a stale/lag field or read-only mirror; the real switch happened upstream)
- Apartment rooms slowly catching up: soggiorno −0.6°C, cucina −0.4°C in 30min, more to come

**Lesson for future code**: don't trust `temperature_control_mode` for season detection. Trust the selected schedule type instead: if `schedules[].selected && schedules[].type === 'cooling'`, the home is in cool. Patch ensureSmartherSummerOpen to verify via that field if/when it becomes accessible.
