# Homey Web API — OAuth2 Protocol (canonical reference)

Verified against the official Athom sources on 2026-05-25:

- Homey Web API HTTP spec: <https://api.developer.homey.app/http-and-socket.io/http-specification>
- `node-homey-api` SDK reference (Athom official): <https://athombv.github.io/node-homey-api/AthomCloudAPI.html>
- `AthomCloudAPI.Token` class: <https://athombv.github.io/node-homey-api/AthomCloudAPI.Token.html>
- `AthomCloudAPI.User` class: <https://athombv.github.io/node-homey-api/AthomCloudAPI.User.html>
- Homey Apps SDK OAuth2 guide: <https://apps.developer.homey.app/cloud/oauth2>
- `node-homey-oauth2app` (Athom official OAuth2 helper for apps): <https://github.com/athombv/node-homey-oauth2app>
- Third-party walkthrough that mirrors SDK behavior: <https://homey.solweb.no/advanced-api-usage/bearertoken>

## Endpoints definitivi

### `accounts.athom.com` vs `api.athom.com`

- `accounts.athom.com` — user-facing **login + consent UI only** (`/login`, `/authorise` confirmation page).
- `api.athom.com` — **canonical OAuth2 + REST host**. Token endpoint, refresh, all REST APIs.
- The legacy URL `https://accounts.athom.com/oauth2/authorise` still works and is what the current `src/lib/homey/client.ts` uses. The SDK and HTTP spec use `https://api.athom.com/oauth2/authorise`. Both resolve to the same flow; **`api.athom.com` is the canonical one** per the HTTP spec.

### Authorization
- **URL:** `https://api.athom.com/oauth2/authorise`
- **Method:** `GET` (browser redirect)
- **Query params:**
  - `client_id` (required)
  - `response_type=code` (required)
  - `redirect_uri` (required, must match the one registered at `developer.athom.com/api/projects`)
  - `state` (recommended, CSRF token)
  - `scope` (optional; Athom controls which scopes are actually granted on consent — this is the broken step from HANDOFF-2026-04-23.md §2.3)

### Token exchange (authorization_code grant)
- **URL:** `https://api.athom.com/oauth2/token`
- **Method:** `POST`
- **Content-Type:** `application/x-www-form-urlencoded`
- **Body params:**
  - `grant_type=authorization_code`
  - `client_id`
  - `client_secret`
  - `code` (from the `?code=` query param on the callback)
  - `redirect_uri` (must match the authorize call exactly)
- **Response (`200 OK`, JSON):**
  ```json
  {
    "access_token": "string",
    "refresh_token": "string",
    "token_type": "bearer",
    "expires_in": 3600,
    "grant_type": "authorization_code"
  }
  ```
- The SDK's `Token` class explicitly exposes `access_token`, `refresh_token`, `token_type`, `expires_in`, `grant_type`. The `scope` field is **not guaranteed** in the response (the docs don't list it on the Token class), which matches what we've seen in production. Treat `scope` as optional.
- `access_token` lifetime: **1 hour** (`expires_in: 3600`).
- `refresh_token` lifetime: never expires unless the user revokes consent OR no API call has been made for 6 months.

### Token refresh (refresh_token grant)
- **URL:** `https://api.athom.com/oauth2/token` (same endpoint)
- **Method:** `POST`
- **Content-Type:** `application/x-www-form-urlencoded`
- **Body params:**
  - `grant_type=refresh_token`
  - `client_id`
  - `client_secret`
  - `refresh_token`
- **Response:** identical shape to code exchange. **Both `access_token` AND `refresh_token` may rotate**, so always persist the entire new payload — the docs and the SDK explicitly warn about this.

### API calls — Cloud
- **Base URL:** `https://api.athom.com`
- **Auth header:** `Authorization: Bearer <access_token>`
- **Discovering the user's Homey(s):** `GET https://api.athom.com/user/me` returns the user profile plus an array of Homeys, each with `id`, `name`, `localUrl`, `localUrlSecure`, and `remoteUrl` (the `<cloudId>.connect.athom.com` cloud relay).
- The SDK's `User` class methods `getFirstHomey()`, `getHomeys()`, `getHomeyById(id)` all wrap this endpoint.

### API calls — Local LAN / cloud relay (the bit our old code got wrong)
The cloud `access_token` **does NOT directly authorize** calls to a specific Homey's REST API. You need a **per-Homey session token**:

1. `POST https://api.athom.com/delegation/token?audience=homey`
   - Header: `Authorization: Bearer <cloud_access_token>`
   - Response: a short-lived **delegation token** for that Homey.
2. `POST <homeyUrl>/api/manager/users/login`
   - `<homeyUrl>` is `localUrlSecure` (preferred, HTTPS on LAN) → `localUrl` → `remoteUrl` (`https://<cloudId>.connect.athom.com`) as fallback chain.
   - Body: `{ "token": "<delegation_token>" }`
   - Response: a **Homey session token** (bearer).
3. All subsequent calls (`/api/manager/devices/device/...`, flows, zones, etc.) use that session token:
   ```
   GET <homeyUrl>/api/manager/devices/device/
   Authorization: Bearer <homey_session_token>
   ```

URL pattern summary:
- Cloud relay: `https://<cloudId>.connect.athom.com/api/manager/...`
- LAN direct: `http://192.168.1.x/api/manager/...` (must still do the delegation → session dance, or pre-create a Personal Access Token in Homey settings — but PATs are user-issued, not OAuth-issued).

## Persistence pattern raccomandato

Mirror the working Netatmo pattern (`src/lib/netatmo/client.ts`):

- Single Supabase `tokens` row: `provider='homey'`, JSON column with
  ```ts
  {
    access_token: string;
    refresh_token: string;
    expires_at: number; // Date.now() + expires_in*1000
    token_type: 'bearer';
    homey_id?: string;       // captured on first /user/me
    homey_url?: string;      // localUrlSecure || localUrl || remoteUrl
  }
  ```
- Refresh logic: when `Date.now() >= expires_at - 60_000` → call `refreshTokens()` → overwrite the row with the **entire** new response (refresh_token may have rotated).
- No separate row for the Homey session token: it's short-lived; mint it on demand from the cloud access token, cache in-memory for ~10 min, then re-mint.

## Cosa va cambiato in `src/lib/homey/client.ts`

The file is currently a deliberate placeholder (see comment lines 1–21). To revive cloud reads after Athom fixes the scope grant:

1. **Restore real types** — drop the `SonoffReading` shim; export a `HomeyTokens` interface that mirrors `NetatmoTokens` (`access_token`, `refresh_token`, `expires_at`, `token_type`, `homey_id`, `homey_url`).
2. **Change authorize URL to canonical** — line 47: `https://accounts.athom.com/oauth2/authorise` → `https://api.athom.com/oauth2/authorise` (per HTTP spec).
3. **Change token endpoint** — line 68: `https://accounts.athom.com/oauth2/token` → `https://api.athom.com/oauth2/token`.
4. **`exchangeCodeForTokens` must return tokens, not a boolean.** Parse the JSON, build a `HomeyTokens` object (same shape as `NetatmoTokens`), persist to Supabase. Match `Netatmo.exchangeCode` signature.
5. **Add `refreshTokens(refresh_token)`** — copy `Netatmo.refreshTokens` verbatim, swap URL + scopes. Persist the full new payload (refresh may rotate).
6. **Add `getUserMe(access_token)`** — `GET https://api.athom.com/user/me`, capture the first Homey's `id` + best URL into the token row.
7. **Add `getHomeySession(access_token, homeyUrl)`** — two-step: delegation token → `POST <homeyUrl>/api/manager/users/login` → cache the session token in module-level memory with a 10-minute TTL.
8. **Add `homeyGet(path)` helper** — auto-refreshes cloud token if expired, mints session if missing, retries on 401 (session expired).
9. **Replace `checkHomeyHealth()` stub** — actually call `homeyGet('/api/manager/devices/device/')` and count devices. Drop the `cloud_client_disabled_use_bridge` short-circuit once the scope issue is resolved.
10. **`seedHomeyTokens()`** — keep as no-op (legacy callers); real persistence happens inside `exchangeCodeForTokens`.

## Cosa va cambiato in `src/app/api/auth/homey/callback/route.ts`

1. **Treat `exchangeCodeForTokens` as returning tokens**, not a boolean. The current `if (!exchanged)` branch becomes `try/catch` around the call — surface the actual error message (currently just speculation in the HTML).
2. **After successful exchange, immediately call `getUserMe`** with the fresh access_token to capture `homey_id` + `homey_url` and persist them in the same Supabase row. This avoids a later "which Homey?" lookup and is the cheapest way to verify the token actually works end-to-end.
3. **Run `checkHomeyHealth()` only after the user/me call succeeds** — currently it runs unconditionally and always returns `ok:false` from the stub.
4. **Pass the real reason on failure** — replace the hard-coded "Likely a missing scope, wrong redirect URI, or expired authorization code" string with the actual error response from Athom (capture `error` + `error_description` from the JSON body when `res.ok === false`).
5. **State validation** — the current `start` route should set a CSRF `state` cookie; the callback must compare `url.searchParams.get('state')` against it and 400 on mismatch. (Currently absent — pure code-exchange, no state check.)

Sources cited inline above. Word count: ~1180.
