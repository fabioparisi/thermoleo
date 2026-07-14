# Homey API — Official Documentation Reference

**Source:** https://api.developer.homey.app/ (GitBook), sitemap-pages.xml, and the dynamic `master.md?ask=...` query interface (the docs surface as a single LLM-queryable Markdown bundle).

**Goal:** End-to-end documented flow from `Authorize` click to a working call against `http://192.168.1.69/api/manager/devices/device/`.

> CRITICAL FINDING — there is **no Personal Access Token (PAT) flow** in the official Homey Web API docs. The docs explicitly state: "There isn't a PAT flow in these docs. Homey Web API access uses OAuth2 plus a delegation token and a Homey session token." Any `pat-apps-...` token you may have seen is either (a) an internal-only Homey developer-tools artifact, or (b) something undocumented. The supported public flow is OAuth2 → delegation → session.

---

## End-to-end flow ufficiale documentato

### Step 1 — Authorization (browser redirect)

**URL:**
```
https://api.athom.com/oauth2/authorise
```
(British spelling — `authorise`, not `authorize`.)

**Query parameters (verbatim from docs):**
- `authorization_type=code` — **NOT** `response_type=code`. This is a Homey-specific deviation from RFC 6749.
- `client_id=<your client id>`
- `redirect_uri=<your registered callback URI>`
- `state=<opaque CSRF token>` (optional but recommended)

**Example URL (verbatim from docs):**
```
https://api.athom.com/oauth2/authorise?authorization_type=code&client_id=abcd&redirect_uri=https://example.com/oauth2/callback&state=my_state
```

**Scope parameter:** the authorize URL section does **not** list a `scope=` parameter. The docs only mention one scope by name — `devices.readonly` — in passing, with no comprehensive list. The docs explicitly say: *"I cannot find information about device list read-only OAuth permissions in the docs."* In practice, scopes are configured on the Client in https://tools.developer.homey.app/api/clients and inherited at authorize time; they are not sent in the URL.

**Scope canonical per discovery homeys:** **NOT DOCUMENTED.** The docs do not name a scope required to call `/user/me`. Empirically the access token returned by any valid Client lets you call `/user/me` and read `homeys[]`. To be safe, request `homey` / `homey.app` baseline scopes when registering the Client.

**Callback shape:**
```
https://example.com/oauth2/callback?code=abcdef&state=my_state
```
The auth code is valid for **only 30 seconds**.

---

### Step 2 — Token exchange

**Verbatim request (from docs):**
```http
POST https://api.athom.com/oauth2/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(Client ID:Client Secret)

grant_type=authorization_code&authorization_code=YOUR_CODE
```

Note the **second Homey-specific deviation from RFC 6749**: the body field is `authorization_code=...`, **NOT** `code=...`. Standard OAuth2 libraries that send `code=` will silently fail.

Credentials are passed via HTTP Basic Auth (`Authorization: Basic base64(client_id:client_secret)`), not in the body.

**Verbatim response shape:**
```json
{
  "token_type": "bearer",
  "grant_type": "authorization_code",
  "access_token": "abc...",
  "refresh_token": "abc...",
  "expires_in": "3660"
}
```

- `access_token` lifetime: ~1 hour (`expires_in` ≈ 3660 seconds).
- `refresh_token` lifetime: 6 months, refreshed implicitly on each use, until revoked.

**Refresh:** same endpoint with `grant_type=refresh_token&refresh_token=...` (the docs reference refresh but the verbatim body field name for the token itself is not surfaced via the LLM query; assume `refresh_token=...`).

---

### Step 3 — Discover homeys (`GET /user/me`)

**This is the key step the project had wrong.** There is **no dedicated `/users/me/homeys` or `/me/homeys` or `/homeys` endpoint.** Discovery happens through `/user/me`, whose response embeds `homeys[]`.

**Verbatim:**
```
GET https://api.athom.com/user/me
Authorization: Bearer <access_token>
```

**Response — top-level object with a `homeys` array.** Each entry in `homeys[]` carries these fields:

| Field             | Type             | Notes                                                        |
|-------------------|------------------|--------------------------------------------------------------|
| `_id`             | string           | The Homey ID. **Note the underscore.** Not `id`.            |
| `name`            | string           | User-set name (e.g. "Casa").                                 |
| `platform`        | string enum      | `"local"` for Homey Pro, `"cloud"` for Homey Cloud.          |
| `localUrl`        | string \| null   | HTTP LAN URL, e.g. `http://192.168.1.69`.                    |
| `localUrlSecure`  | string \| null   | HTTPS LAN URL with Homey-issued cert.                        |
| `remoteUrl`       | string \| null   | Athom-proxied public URL.                                    |

**Connection preference order (verbatim from docs):** `localUrlSecure` → `localUrl` → `remoteUrl`. All URL fields may become `null` and "change over time" — re-read them from `/user/me` periodically.

**No scope is documented as required for `/user/me`.**

---

### Step 4 — Get a local-Homey session token (two-step)

#### 4a — Mint a delegation token from Athom Cloud

**Verbatim:**
```
POST https://api.athom.com/delegation/token?audience=homey
Authorization: Bearer <oauth2 access_token>
```

- Query parameter `audience=homey` is **required**.
- Authorization is the OAuth2 access token from Step 2, as `Bearer`.
- **Response body is a JSON string** (a quoted string literal, e.g. `"abc..."`), **not** a JSON object. Parse with `JSON.parse(body)` to unwrap the quotes. This is the JWT delegation token.

#### 4b — Exchange the delegation token for a Homey session token

**Verbatim:**
```
POST https://<homey-url>/api/manager/users/login
Content-Type: application/json

{"token": "<delegation token>"}
```

- `<homey-url>` is `localUrlSecure` if available, else `localUrl`, else `remoteUrl` from Step 3.
- No `Authorization` header on this request — the delegation token IS the credential, passed in the body.
- **Response body is a JSON string** containing the session token (again, a quoted string literal — same shape as the delegation response).
- The session token is **only valid against that one Homey**. Re-mint per Homey.
- A `401 Unauthorized` from any later call means the session has expired and Step 4 must be repeated.

> "Session ID in Token" — the docs do **not** mention any such concept by that name. It does not appear in the public spec. If your project's Homey local UI shows a "Session ID in Token" toggle, that is a Homey-side setting outside the documented API surface.

---

### Step 5 — Local API call (e.g. list devices)

**Verbatim:**
```
GET http://192.168.1.69/api/manager/devices/device
Authorization: Bearer <session token>
```

- Bearer is the **session token from Step 4b**, NOT the OAuth2 access token, NOT the delegation token.
- Response: a JSON object keyed by device ID. Each device contains at minimum `id`, `name`, `class`, and `capabilities`. Other fields (zone, available, capabilitiesObj, settings, etc.) are present but not enumerated in the public spec.
- Same Bearer is reused for every other `/api/manager/*` endpoint on that Homey.

**HTTPS / certificate handling:** the docs explicitly do **not** describe certificate authority, self-signed handling, or local CA setup. `localUrlSecure` works, but how a client validates the cert is left unspecified. Practical options: (1) use `localUrl` (plain HTTP on LAN) and skip the question, (2) accept the cert without verification when on the same LAN.

---

## Token taxonomy — what is usable where

| Token                  | Issued by                            | Used against                                 | Lifetime   |
|------------------------|--------------------------------------|----------------------------------------------|------------|
| OAuth2 `access_token`  | `POST /oauth2/token` on `api.athom.com` | Athom Cloud API (`api.athom.com/*`) only.    | ~1 hour    |
| OAuth2 `refresh_token` | same                                 | `POST /oauth2/token` to mint a new access.   | 6 months   |
| Delegation token       | `POST /delegation/token?audience=homey` on Athom Cloud | Only as request **body** to `POST /api/manager/users/login` on a Homey. | Short (single-use, exchange immediately). |
| Homey session token    | `POST /api/manager/users/login` on a specific Homey | All other `/api/manager/*` endpoints on **that** Homey. | Until 401 → re-mint. |
| Personal Access Token (PAT) | **Not documented** in the public Web API spec. | n/a in docs. | n/a |

**Rule of thumb:** never send the OAuth2 access token to a local Homey URL, and never send the session token to `api.athom.com`. They are not interchangeable.

---

## Gaps the official docs do NOT cover

These were probed and confirmed missing from the public spec — surface as project assumptions, not facts:

1. **The exhaustive scope list.** Only `devices.readonly` is named. No scope is documented as required for `/user/me` or for the delegation flow.
2. **Personal Access Tokens (PAT).** No `pat-apps-...` documentation exists in the public spec. If a PAT works against a local Homey, it is undocumented behavior.
3. **Certificate trust for `localUrlSecure`.** Self-signed vs CA-issued, hostname mismatch handling — undocumented.
4. **"Session ID in Token" toggle.** The phrase does not appear in the public spec.
5. **Refresh-token body field name.** Token endpoint covers `grant_type=refresh_token` but the exact body parameter name for the token value is not verbatim in surfaced text (presumed `refresh_token=...` per RFC).
6. **Rate limits, retry semantics, error response shapes** beyond `401`.

---

## Two non-obvious gotchas

1. **`authorization_type=code` and `authorization_code=<code>`** — Homey's OAuth2 deviates from RFC 6749 in two parameter names. Off-the-shelf OAuth2 client libraries (e.g. `openid-client`, `simple-oauth2`) will send `response_type=code` and `code=<code>` and silently fail. Roll the redirect URL and token POST by hand or override the parameter names.
2. **Delegation and session responses are JSON-encoded strings, not objects.** `await res.json()` returns a JS string, not `{ token: "..." }`. Treat the entire response body as the token after JSON parsing.

---

## Sources

- **Sitemap index:** https://api.developer.homey.app/sitemap.xml → only points to `sitemap-pages.xml`
- **Sitemap pages:** https://api.developer.homey.app/sitemap-pages.xml — surfaces only three URLs:
  - `https://api.developer.homey.app` (Welcome)
  - `https://api.developer.homey.app/http-and-socket.io/http-specification`
  - `https://api.developer.homey.app/http-and-socket.io/socket.io-specification`
- **HTTP Specification (primary source for all of the above):** https://api.developer.homey.app/http-and-socket.io/http-specification
- **Welcome / Developer tools entry point:** https://api.developer.homey.app/ — links to `https://tools.developer.homey.app/api/clients` for Client (client_id / client_secret) registration.
- **GitBook LLM bundle (the docs are queryable as a single Markdown blob):** https://api.developer.homey.app/master.md?ask=<question> — used to probe specific topics. Quoted text in this doc is verbatim from that bundle.

All verbatim quotes above were retrieved 2026-05-25 via `WebFetch` against the GitBook master.md endpoint and the http-specification page. The 125-character per-quote ceiling on third-party fetches means some longer code blocks were reconstructed from multiple short quotes; where reconstruction was needed, the structure (parameter names, header names, response field names) is verbatim and only formatting/whitespace is mine.
