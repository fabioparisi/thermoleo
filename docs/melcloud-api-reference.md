# MELCloud API reference (cheat-sheet for the campomarino MELCloud client)

Distilled from the community library **[OlivierZal/melcloud-api](https://github.com/OlivierZal/melcloud-api)** (MIT, docs at <https://olivierzal.github.io/melcloud-api/>) — the canonical reverse-engineering of Mitsubishi's MELCloud "Classic" HTTP API. Used by `src/lib/melcloud/` (Phase 7). The library itself is Node ≥22 / Temporal-based and we do NOT vendor it; this file captures only the wire-level facts our own thin client needs, plus the error-handling model worth copying.

> Verified live 2026-06-21: `ClientLogin` returns a ContextKey for account `Fabio Parisi`; building **Appartamento Campomarino** (ID `622008`) exposes 3 ATA splits — Camera da letto `80980131`, Soggiorno `80981534`, Studio `80979947`.

## Base

- **Base URL:** `https://app.melcloud.com/Mitsubishi.Wifi.Client`
- **App version string** sent on login: a real one (lib uses `1.38.4.0`; our smoke test used `1.34.13.0` — either is accepted). Keep it plausible/current.
- All device types here are **ATA** (`DeviceType=0`, Air-to-Air = the reversible split heat-pumps). ATW (water) / ERV (ventilation) are out of scope.

## Auth

- **POST `/Login/ClientLogin`** (the lib's newest path is `/Login/ClientLogin3`; both work — we use `ClientLogin`, smoke-tested).
  - Body (JSON): `{ Email, Password, Language: 0, AppVersion: "1.34.13.0", Persist: true, CaptchaResponse: null }`
  - Success → response carries `LoginData.ContextKey` (a ~41-char token) + `LoginData.Name`. **Persist ONLY the ContextKey** (Supabase `tokens` provider `melcloud:campomarino`), never the password.
- **Auth header for every subsequent call:** `X-MitsContextKey: <ContextKey>`
- **401 → re-login.** The ContextKey expires; on any `unauthorized` re-run `ClientLogin` and retry once. (The lib pre-emptively refreshes the session a bit before expiry — `SESSION_REFRESH_AHEAD_MS`; we can just react to 401.)

## Endpoints we use

| Verb | Path | Purpose |
|---|---|---|
| POST | `/Login/ClientLogin` | auth → ContextKey |
| GET  | `/User/ListDevices` | full building/floor/area tree with embedded `Device` state — discover DeviceIDs + read temps |
| GET  | `/Device/Get?id=<DeviceID>&buildingID=<BID>` | single device current state |
| POST | `/Device/SetAta` | **actuation** — set power/mode/temp/fan on one ATA unit |
| POST | `/Device/Power` | power on/off only |

**ListDevices is nested.** Devices can sit at `building.Structure.Devices[]`, `…Floors[].Devices[]`, `…Floors[].Areas[].Devices[]`, or `…Areas[].Devices[]`. Flatten all four. Each entry has `DeviceID`, `DeviceName`, and a `Device` object with `RoomTemperature`, `Power`, `SetTemperature`, `OperationMode`, `OutdoorTemperature`, the `Min/MaxTemp*` clamp bounds, etc.

## Enums (numeric — these are the wire values)

**OperationMode** (`Device.OperationMode`, and what you send in SetAta):
| name | value |
|---|---|
| heat | `1` |
| dry  | `2` |
| cool | `3` |
| fan  | `7` |
| auto | `8` |

> Cooling-output modes: {auto, cool, dry}. Heating-output modes: {auto, heat}. Campomarino runs full **heat / cool / off** per-property (the splits are reversible heat pumps — heat is genuinely used when the family stays past September), exactly like Milano. `season:campomarino` is independent of Milano's.

**FanSpeed** (`SetFanSpeed`):
| name | value |
|---|---|
| auto | `0` |
| very_slow | `1` |
| slow | `2` |
| moderate | `3` |
| fast | `4` |
| very_fast | `5` |
| silent | `255` |

> Our agent's abstract fan level maps: auto→0, levels 1–5→1–5, "silent" profile→255.

**DeviceType:** Ata `0`, Atw `1`, Erv `3`.

**OperationModeState** (what the device REPORTS it's doing right now, `Device.OperationMode​State` on some payloads): idle `0`, dhw `1`, heating `2`, cooling `3`, defrost `5`, legionella `6`. Useful to tell "set to heat but actually idle/defrosting" apart.

## SetAta — the EffectiveFlags bitmask (the gotcha)

MELCloud's set-device payload only applies the fields whose bit is set in **`EffectiveFlags`**. Send the OR of the bits for every field you're changing, or the change is silently ignored.

**ATA EffectiveFlags:**
| field | bit |
|---|---|
| Power | `0x1` |
| OperationMode | `0x2` |
| SetTemperature | `0x4` |
| SetFanSpeed | `0x8` |
| VaneVertical | `0x10` |
| VaneHorizontal | `0x100` |

Example — set mode=cool + temp=26.5 + fan=auto + power on:
`EffectiveFlags = 0x1 | 0x2 | 0x4 | 0x8 = 0xF` (`15`), with `Power:true, OperationMode:3, SetTemperature:26.5, SetFanSpeed:0`.

Send `EffectiveFlags: 0` (`CLASSIC_FLAG_UNCHANGED`) only when you deliberately want "include all data, change nothing flagged" — not our path.

**SetTemperature clamping is per-mode.** The device exposes `MinTempCoolDry/MaxTempCoolDry`, `MinTempHeat/MaxTempHeat`, `MinTempAutomatic/MaxTempAutomatic`. Clamp the target to the range for the *requested* mode before sending (cool/dry share the CoolDry range; heat/fan share the Heat range). Don't send a heat setpoint clamped to cool bounds.

## Error handling model (worth copying)

The lib returns a `Result<T>` from best-effort getters (branch on failure class) and *throws* on mutations. Failure classes:

- **`network`** — transient; auto-retry with backoff.
- **`unauthorized`** (401) — re-authenticate (re-login → new ContextKey), then retry once.
- **`rate-limited`** (429) — honor the wait window. Structured: `error.retryAfterMs` (dependency-free ms) / `RateLimitError.retryAfter` (Temporal.Duration) / `.unblockAt` (absolute). **Respect it** — don't hammer.
- **`validation`** — bad payload shape; a bug in our code, don't retry.
- **`server`** (5xx) — transient; limited retry.

**Polling cadence:** the lib's default sync interval is **5 minutes** (`DEFAULT_SYNC_INTERVAL_MINUTES`) and its default retry window is **2 hours** (`DEFAULT_RETRY_HOURS`). Our agent cycle is every 10 min (pg_cron), comfortably under any MELCloud rate limit. Per-fetch `AbortSignal.timeout` must stay well under Vercel's 55s `maxDuration`.

## Our client's contract (Phase 7.1)

`src/lib/melcloud/{client,types}.ts`:
- `login()` → ContextKey, persisted to `tokens` provider `melcloud:campomarino`.
- `listDevices()` → flattened ATA device list with temps.
- `getDevice(deviceId, buildingId)` → current state.
- `setAta(deviceId, { power, mode, temperature, fan })` → builds EffectiveFlags + per-mode clamp.
- Re-login on 401; honor `Retry-After` on 429; `AbortSignal.timeout` per fetch.
- **Read-only until `actuation_enabled` is true** per campomarino room (gate off until the room's independent sensor — split thermometer now, Shelly later — is validated).
