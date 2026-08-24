# Unofficial/free multi tenant whatsapp messaging API with user-controlled encryption & account ban mitigation

A self-hosted WhatsApp message automation platform built using [Mudslide](https://github.com/robvanderleek/mudslide). Connect your WhatsApp account via QR code, then schedule automated messages or trigger them on demand via a REST API.

All user data is encrypted using your personal auth token as the key. There is no shared server secret — even the server owner cannot read your data. 

The server routes your connection through a residential IP in your city and queues messages sequentially, reducing ban risks.

Live website: [watobot.xyz](https://watobot.xyz) . The website is running on a 4GB RAM AWS VM & is fully functional. You can signup, use the API to send messages, schedule automated recurring messages to any of your groups & even create FAQ from chat backup of a whatsapp group. Logging out of account disconnect your whatsapp & removes encrypted auth data. 

![Watobot.xyz](http://pocha.fyi/assets/img/projects/watobot-hero.png)

P.S. there will be 15-20 seconds delay in connecting your account & sending messages due to Residential Proxy setup & encryption + decryption on every request. The whatsapp device adding via QR code step takes a few iterations sometime. 

---

> **Disclaimer:** This project is for **educational purposes only**. The author takes no liability for WhatsApp banning your account or the accounts of your users if you choose to deploy this as a public web service. Use of unofficial WhatsApp automation may violate WhatsApp's Terms of Service. You assume all responsibility for how you use this software.

---

---

## How it works

- **Auth:** passwordless magic link sent to your email. Your email is never stored. Clicking the link gives you a 64-character hex auth token that lives only in your browser (`localStorage`).
- **Storage:** all user data lives under `users/` as AES-256 encrypted files. The token is the encryption key — the server only holds a one-way hash of it (`sha256(token)`) for authentication.
- **Scheduling:** cron jobs invoke `scripts/run-schedule.js`, which carries a self-contained encrypted payload in the cron entry itself. No secrets need to be present on the server at run time beyond what is already in `users/`.
- **WhatsApp session:** after QR scan, the `.mudslide/` credentials directory is AES-256 encrypted into `.mudslide.enc` using `sha256(token)`. The plaintext directory is immediately deleted.

---

## Security model

| What | Stored as | Who can read it |
|------|-----------|-----------------|
| Your email | Never stored | Nobody |
| Auth token | Browser `localStorage` only | Only you |
| `token_hash` (`sha256(token)`) | `users/<dir>/token_hash` | Public-safe — one-way hash, useless without the token |
| Schedule files (`schedule.json`) | AES-256, key = token | Only you (token required to decrypt) |
| WhatsApp session (`.mudslide.enc`) | AES-256, key = `sha256(token)` | Only you |
| Cron payload | AES-256, key = `token_hash`, embedded in system crontab | Only accessible with server shell access |
| API key hash (`api_key_hash`) | `sha256(apiKey)` | Public-safe — one-way hash |
| Calendly OAuth tokens (`calendly.json`) | AES-256, key = token | Only you (token required to decrypt) — never touches Firestore |
| `calendly_key_hash` (`sha256(calendlyKey)`) | `users/<dir>/calendly_key_hash` | Public-safe — one-way hash, useless without the key |
| Calendly connection status + meetings (`calendlyConfig` field, Firestore) | Plaintext, access-controlled by Firestore Security Rules | Only you — the VM holds no Firebase credential at all; see [Calendly Integration](#calendly-integration) |
| Leads (`users/{userDir}/leads` Firestore subcollection) | Plaintext, access-controlled by Firestore Security Rules | Only you — same as above |

The entire `users/` directory — including `token_hash`, encrypted schedules, and the encrypted WhatsApp session — can be committed to a public repository safely. There is no `SERVER_SECRET`. There is no `tokens.json`. Nothing in the repo can be used to decrypt user data without the token that only the user holds.

> **Re-registering with the same email** generates a new token and overwrites `token_hash`. The old token is immediately invalidated and old encrypted files become inaccessible. You will need to re-link your WhatsApp account.

---

## Prerequisites

- Linux or macOS (Windows not supported)
- Node.js 18+
- `curl` available on the system

---

## Installation

```bash
git clone https://github.com/pocha/mudbot
cd watobot
chmod +x install.sh
./install.sh
```

`install.sh` will:
1. Install Node.js + npm if not present
2. Install project dependencies (`npm install`)
3. Download and install the `mudslide` binary to `/usr/local/bin/mudslide`
4. Create `.env` with default values if one does not exist

---

## Configuration

Edit `.env` after installation:

```env
PORT=3000

# SMTP settings for magic link emails
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=noreply@watobot.local
BASE_URL=http://localhost:3000

# Path to the mudslide binary
MUDSLIDE_PATH=/usr/local/bin/mudslide
```

For **production**, point `SMTP_*` at a real mail provider (e.g. SendGrid, SES) and set `BASE_URL` to your public domain.

For **local development**, MailDev is started automatically by the test suite (see [Running tests](#running-tests)).

---

## Account Ban Protection Techniques

WhatsApp flags accounts that behave like bots or spam operations — both by where a connection comes from and by how messages are sent. Watobot addresses both angles: a residential proxy so linked devices look like real phones on home networks, and a per-account message queue so sends never fire in the kind of rapid-fire bursts that trip spam detection.

### Residential Proxy (strongly recommended for production)

When multiple users connect WhatsApp from the same server IP, WhatsApp can detect that many accounts share one IP address and flag them as bots or spam operations. To prevent this, Watobot routes each user's WhatsApp connection through a **dedicated residential IP address** near their geographic location.

#### Why this matters

- **Server IP protection:** Your server's real IP is never exposed to WhatsApp. If WhatsApp blacklists a residential IP, only that one user is affected — your server IP stays clean.
- **Account authenticity:** WhatsApp sees a local residential connection (like a home router) rather than a data-centre IP. This makes the linked device look like a real phone on a home network.
- **Per-user isolation:** Each user is assigned a unique proxy port, so no two users share the same residential IP. One user's behaviour cannot affect another's account standing.

#### Setup with DataImpulse

1. Sign up at [dataimpulse.com](https://dataimpulse.com) and purchase a **premium** residential proxy plan (city/ZIP-level targeting is gated behind premium — the free/standard tier only supports country-level targeting).
2. Add the following to your `.env`:

```env
DATAIMPULSE_USERNAME=your_username
DATAIMPULSE_PASSWORD=your_password
DATAIMPULSE_HTTP_GATEWAY=gw.dataimpulse.com
DATAIMPULSE_GATEWAY=74.81.81.81   # legacy, unused now that traffic routes through the relay
DATAIMPULSE_PORT=10000            # Starting port — each user gets the next port in sequence
```

3. Ensure `proxychains4` is installed (the install script handles this automatically).
4. Set `PROXYCHAINS_PATH` in `.env` to the proxychains4 binary path (the install script fills this in).

When `DATAIMPULSE_USERNAME` is not set, Watobot falls back to unproxied connections — all features still work, but WhatsApp connections originate from your server's IP.

#### Country + city detection

Instead of asking users for a PIN/postal code, Watobot auto-detects their country and city from their IP address on first connect (shown to them, with a "not right? change it" link for VPN users or misdetections). Both the geolocation lookup (`ipwho.is`) and, for manual overrides, city validation (OpenStreetMap's Nominatim) happen directly in the browser rather than server-side — this reflects the user's real IP rather than the server's view of it, and Nominatim's canonical resolved city name is used rather than whatever the user typed, since DataImpulse's own city database doesn't recognize aliases/old names (e.g. "Bangalore" vs "Bengaluru"). This gets stored per-user and used to target DataImpulse's proxy to a matching residential IP.

#### The local relay — why it exists

DataImpulse's city/ZIP targeting syntax embeds a literal `;` in the proxy login string (e.g. `user__cr.in;city.bengaluru`). Node's `URL` parser — used internally by `global-agent`, which `mudslide`'s own `--proxy` flag depends on — silently percent-encodes that `;` into `%3B` before it ever reaches DataImpulse, corrupting the targeting request. `services/dataimpulseRelay.js` sits between `proxychains` and DataImpulse, building the `Proxy-Authorization` header itself from the raw, un-encoded credential string, sidestepping the bug entirely. It also retries once with country-only targeting if DataImpulse can't find a match for the requested city (city/ZIP-level availability is intermittent even on premium plans).

`services/proxyRelayManager.js` manages one relay per active user, started lazily on their first mudslide operation and stopped once they have no more queued jobs — mirroring the existing per-user job queue in `services/mudslideService.js`. Nothing needs installing or supervising separately; it's part of the running app process.

To sanity-check the whole chain (proxychains → relay → DataImpulse → WhatsApp) independent of the running app:

```bash
npm run test-mudslide-proxy -- --country=in --city=bengaluru --recipient=<your-number>
```

#### How port allocation works

DataImpulse maps each port in the range 10000–20000 to a distinct sticky residential session. Watobot allocates one port per user at registration time (stored in their encrypted `proxy.json`) — the local relay reuses that same port number bound to `127.0.0.1` (no collision, since one is a loopback bind and the other is remote). The allocation counter is persisted in `users/.proxy_port_counter`.

### Message Queueing

Sending several messages back-to-back in rapid succession is a pattern WhatsApp's spam detection watches for, independent of where the connection comes from. Watobot serializes all outgoing operations (`sendMessage`, `sendMedia`, group fetches, disconnects) per WhatsApp account through a strict, promise-chained queue (`withSession` in `services/mudslideService.js`) — so a user's messages are always sent one at a time, never concurrently, no matter how many requests hit the API at once (a burst of scheduled sends, several manual API calls, etc.).

This queue also drives the lifecycle of the per-user proxy relay and WhatsApp session cache: both are lazily acquired the moment the first job for a user starts, and released the moment their queue drains back to zero — so a user with no pending work has no lingering open connections.

---

## Calendly Integration

Connect your Calendly account and Watobot will automatically send a WhatsApp message to every person who books a meeting through it. The dashboard's Calendly page presents this as two connected boxes, Zapier-style — a **Calendly** box (connect your account, pick which calendars to wire up, verify the integration end-to-end) and a **Watobot** box (connect WhatsApp, configure the message per calendar, test it) — each opening a step-by-step popup on click.

Your Calendly OAuth app (in the [Calendly developer console](https://developer.calendly.com/)) needs the `scheduled_events:read` and `event_types:read` scopes — the former to look up booking/invitee details when a lead comes in, the latter for both the dashboard's calendar picker and phone-field detection (below). No write scopes are needed: nothing is ever created or modified on Calendly's side.

**Phone-number detection is automatic**, not manually typed. Calendly's Event Type API exposes each event type's custom questions with a real `type` field — including a dedicated `phone_number` type — and a `required` flag. The dashboard checks for a question with `type: "phone_number"` on each calendar you add; if none exists, it tells you to add one (and mark it required) in that event type's settings before you can proceed. This also means the whole onboarding flow is *gated*: you can't get past the "select calendars" step until every calendar you've added has a usable phone field, and the final step of the Calendly box only turns green after you've pasted the real embed snippet on your live site, made a real (dummy) booking, and the dashboard has confirmed a lead actually landed — not just that the OAuth connection is valid.

Once a calendar is added, embed its one-line script on that event type's booking page, before your existing Calendly embed code (each calendar has its own snippet, shown in the dashboard):

```html
<script src="https://<domain>/api/calendly/code?token=<your-calendly-key>&meetingId=<meeting-id>"></script>
```

The `<your-calendly-key>` is a separate integration key (not your API key or auth token) generated the first time you connect Calendly — it's scoped only to the Calendly runtime script and webhook-style route, so a leaked key can't be used against `/api/message` or any other endpoint. Every confirmed booking on that page then triggers a WhatsApp message automatically, using that calendar's message template — configurable per calendar in the Watobot box, along with a toggle for whether to send automatically at all. A booking on a calendar with auto-send off still gets logged as a lead (`status: "pending"`) for manual follow-up.

### How Calendly data is stored and accessed

**Calendly's OAuth tokens never leave the VM.** `accessToken`/`refreshToken`/`expiresAt` (plus the connected account's own URIs, used for an ownership check on each booking) live in the same AES-256-encrypted, token-keyed local file every other per-user secret in this app uses (`calendly.json` — see the Security model table above) — this is deliberate: it preserves the zero-knowledge property those files already have (the server owner can't read them without your live session token) that moving them into Firestore would have quietly given up.

**Everything else about a Calendly connection is not secret**, and lives directly in Firestore instead — connection status, the embed-script `calendlyKey`, and each calendar's config (event type, detected phone question, message template, auto-send toggle), all under one document per user, `users/{userDir}` (with `leads` as a subcollection underneath, `users/{userDir}/leads/{leadId}`). The dashboard reads and writes this data **directly**, governed by `firestore.rules` (access is scoped by the `{userDir}` path segment itself, matched against a custom claim on your Firebase Auth token — not a field trusted inside each document). There's no VM route for any of this (no meeting CRUD endpoints, no leads endpoints) — it's exactly as debuggable as opening the Firebase console.

Getting a Firebase identity to sign in with works the same way for any of this:

1. Your browser calls `GET /api/firebase-token` with your normal session token.
2. The VM verifies that token exactly as it does for every other authenticated route (`userService.verifyToken`), then calls a Cloud Function, `mintFirebaseToken`, to mint a Firebase custom token — **the VM itself holds no Firebase credential**, only the Function does.
3. Your browser signs in to Firebase with that token and talks to Firestore directly from then on.

Two things genuinely can't move to the frontend, because they need something only the VM has: the Calendly **client secret** (shared across all users of this app, can never reach a browser) is needed to exchange an OAuth `code` for tokens and to refresh an expired access token — so `GET /api/calendly/authorize`, the OAuth callback, `GET /api/calendly/event-types`, and the WhatsApp test-send action all stay VM routes. And the Calendly **webhook** itself (`POST /api/calendly/:meetingId/lead`, called by the embedded script on a real booking) has no legitimate browser session behind it at all — it's fired by whoever's booking the meeting, not you — so it can't use your Firestore Security Rules the way every other lead-management action does. For that one case, the VM reads a calendar's config server-side via a third, **read-only** Cloud Function, `getCalendlyMeetingConfig`. All three Cloud Functions live in `functions/` and are restricted to only accept requests from the VM's static IP (`ALLOWED_VM_IP` in `functions/.env` — see `functions/.env.example`), rather than GCP IAM: simpler to operate, and gives the same practical protection for this threat model (it stops outside callers; like IAM, it does not protect against the VM itself being compromised, since compromised code there would still originate from the allowed IP).

The Watobot box's "Test Message" action reuses this exact webhook route rather than a separate test endpoint — same `calendlyKey` auth the real embed script uses, an added `test: true` flag that sends to your own WhatsApp (`'me'`) instead of the prospect and skips the Firestore write entirely, so a repeat test can never overwrite a real lead's send history.

### Deploying the Firebase side

Before the Calendly integration works, the Cloud Functions, Firestore Security Rules, and Firestore indexes all need to be deployed to the `wato-bot` Firebase project:

```bash
npm install -g firebase-tools   # if you don't already have it
firebase login
cd functions && cp .env.example .env   # then fill in ALLOWED_VM_IP with the VM's static IP
cd ..
firebase deploy --only functions,firestore:rules,firestore:indexes
```

This deploys all three Cloud Functions (`mintFirebaseToken`, `createLead`, `getCalendlyMeetingConfig`) together. Re-run `firebase deploy --only functions` after any change to `functions/index.js` or `functions/.env`, and `firebase deploy --only firestore:rules` (or `firestore:indexes`) after editing `firestore.rules` / `firestore.indexes.json` — none of these are picked up automatically, unlike the VM's own code.

### Local Cloud Functions emulation

The three Cloud Functions above are IP-allowlisted to the production VM's static address (`ALLOWED_VM_IP`) — deliberately, since it's the security boundary that lets the VM hold zero Firebase credentials of its own. That also means anything on the dashboard needing a Firebase sign-in (which is most of it) gets a `502` when run from a local machine (`npm start`), since the local server's calls to those functions get rejected.

`npm start` works around this automatically for local dev: it starts the Cloud Functions emulator (`firebase emulators:start --only functions`) and points `mintFirebaseToken`/`createLead`/`getCalendlyMeetingConfig` calls at it instead — the *real*, deployed functions and their IP allowlist are untouched. One-time setup:

1. Firebase Console → Project Settings → Service Accounts → **Generate new private key**, for the `wato-bot` project.
2. Save it as `functions/.serviceAccountKey.json` (gitignored — this is a real credential, keep it local).

With that key present, `npm start` picks it up automatically: `createCustomToken` signs locally using the key's real private key (no IAM `signBlob` call needed — see the comment on `mintFirebaseToken` in `functions/index.js` for why that matters), and the resulting tokens/Firestore access are indistinguishable from the real deployed functions', since it's the same project's real credential — just running the function code on your machine instead of Google's. No Firestore or Auth emulation involved; local runs read/write the real Firestore.

Without that key present, `npm start` just logs a warning and falls back to the real deployed functions (so local dev still works for everything *not* needing a Firebase sign-in). Never runs in production (`NODE_ENV=production` skips it entirely) or if `SKIP_FUNCTIONS_EMULATOR=true` is set.

### Testing the Calendly integration

`npm test` doesn't cover Calendly at all — see [Running tests](#running-tests) below for why. Instead, `test/calendly.e2e.js` (`npm run test-calendly-e2e`) drives the *real* app server against a *real* Calendly account, so it's testing actual behavior rather than a hand-built guess at Calendly's API shape.

This test talks to whatever `BASE_URL`/`PORT` your own `.env` already configures — same as `npm start` — rather than a special test-only port; if a server is already running there, it reuses it directly instead of starting a second one, which is what makes it safe to run against a real, persistently-running server too.

**One-time setup:**
1. Create a second Calendly OAuth app (e.g. "Watobot-test") in the [developer console](https://developer.calendly.com/) — don't reuse your production app's credentials. Environment type **Production** (not Sandbox — Sandbox's real-account behavior is unconfirmed), redirect URI `<your .env's BASE_URL>/api/calendly/oauth/callback` (e.g. `https://localhost/api/calendly/oauth/callback` if `BASE_URL=https://localhost`) — this test reuses the app's own real OAuth callback route, not a separate one, so the path has to match it exactly (Calendly also requires HTTPS here even for `localhost`).
2. Make sure local HTTPS certs exist: `certs/localhost.pem` / `certs/localhost-key.pem` (generate with `mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1` if missing — `mkcert -install` first if you've never used mkcert on this machine). Binding to port 443 does *not* require root on macOS.
3. Point your local `.env.calendly` (see `.env.calendly.example`) at that test app — `CALENDLY_CLIENT_ID`/`CALENDLY_CLIENT_SECRET` from it, and `CALENDLY_REDIRECT_URI` matching step 1. This is the same file `server.js` loads for normal local dev, so local `npm start` will also use the test app's credentials — that's expected, since this file never leaves your machine (the deployed VM has its own separate `.env.calendly`).

**Running it:** `npm run test-calendly-e2e`. The first run registers a dedicated, persistent test user and prints a Calendly authorize URL — open it and approve access once. Every run after that reuses the cached session (`test/.calendly-e2e-tokens.json`, gitignored) and Calendly's own token refresh, so no further manual steps are needed unless that refresh token goes stale.

**What it checks, against your real account:** `GET /api/calendly/event-types`'s phone-detection fields (validates the `custom_questions`/`phone_number`/`required` assumption against real data, not a guess), and — reading directly via `services/calendlyService.js` in-process, not through the VM's REST surface — a real past booking's invitee data run through the same phone-extraction logic the webhook uses. It deliberately does **not** exercise the Cloud Function boundary (`getCalendlyMeetingConfig`/`createLead` are IP-allowlisted to the VM and unreachable from a dev machine) or send a real WhatsApp message — those stay outside this test's scope on purpose.

---

## Running the app

```bash
npm start
```

Server starts on `http://localhost:3000` (or the `PORT` in `.env`).

---

## Connecting WhatsApp

1. Open `http://localhost:3000` and click **Try Now**
2. Enter your email — you'll receive a one-time magic link (your email is not stored)
3. Click the link to open your dashboard
4. Click **Connect WhatsApp** to generate a QR code
5. Scan the QR code with WhatsApp on your phone (**Linked Devices → Link a Device**)
6. Wait until a new device named **Google Chrome** appears in your Linked Devices list, then click **Continue**
7. Your WhatsApp session is encrypted and stored — you're ready to schedule or send messages

---

## API

All endpoints (except `/api/register` and `/api/verify/:token`) require authentication via:

```
Authorization: Bearer <token>
```
or
```
x-api-key: <api-key>
```

Generate an API key from the dashboard. The API key embeds the same user directory as the token, so it resolves to the same account.

**API keys expire after 1 hour** and are intended for testing. To make a key permanent, the server owner SSHes in and runs:

```bash
echo "permanent" > users/<userDir>/api_key_expiry
```

The `userDir` is the 10-character prefix shown in the dashboard's API key section. Users should email the server owner with their use case to request a permanent key.

### User Management

Registration, login, API key, and WhatsApp connection lifecycle.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/register` | Send magic link to email |
| `GET` | `/api/verify/:token` | Verify token, get user info |
| `POST` | `/api/apikey/generate` | Generate a 1-hour API key |
| `GET` | `/api/apikey/status` | Check if a key exists and whether it has expired |
| `GET` | `/api/whatsapp/status` | Check WhatsApp connection status |
| `GET` | `/api/whatsapp/qr` | Get QR code for WhatsApp login |
| `POST` | `/api/whatsapp/login/confirm` | Confirm QR scan is complete |
| `POST` | `/api/whatsapp/logout` | Initiate WhatsApp disconnect |
| `POST` | `/api/whatsapp/logout/confirm` | Clean up session after manual device removal |

### Send Message

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/message` | Send a message immediately |
| `GET` | `/api/whatsapp/groups` | List WhatsApp groups linked to your connected account |

Send a message to an individual:

```bash
curl -X POST https://<domain>/api/message \
  -H "x-api-key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"to": "919876543210", "message": "Hello!"}'
```

To message a WhatsApp group instead, first fetch your groups to get its JID, then send to that JID:

```bash
curl https://<domain>/api/whatsapp/groups \
  -H "x-api-key: <your-api-key>"
# => {"groups": [{"name": "Family", "id": "919876543210-1234567890@g.us"}, ...]}

curl -X POST https://<domain>/api/message \
  -H "x-api-key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"to": "919876543210-1234567890@g.us", "message": "Hello, everyone!"}'
```

### Create Schedule

Schedules are automated, recurring messages sent at a time you specify — set one up once and it keeps firing on its own (daily, weekly, monthly, or a single future date), with no need to keep anything running yourself.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/schedules` | List all schedules |
| `POST` | `/api/schedules` | Create a schedule |
| `GET` | `/api/schedules/:id` | Get a schedule |
| `PUT` | `/api/schedules/:id` | Update a schedule |
| `DELETE` | `/api/schedules/:id` | Delete a schedule |
| `GET` | `/api/usage/logs` | Get recent send logs, including scheduled runs |

```bash
curl -X POST https://<domain>/api/schedules \
  -H "x-api-key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily reminder",
    "recipients": ["919876543210"],
    "message": "Good morning!",
    "timezone": "Asia/Kolkata",
    "localTime": "09:00",
    "frequency": "Daily"
  }'
```

The backend converts `localTime` + `timezone` to a UTC cron expression automatically. Supported `frequency` values: `Daily`, `Weekly`, `Monthly`, `Once` (requires `localDate: "YYYY-MM-DD"`).

### Calendly

Meeting (calendar) CRUD, connection status, and leads are all **direct Firestore access** from the dashboard now — no REST surface for any of that (see [How Calendly data is stored and accessed](#how-calendly-data-is-stored-and-accessed)). The remaining VM routes cover only what needs the Calendly client secret, the account's access token, or the WhatsApp session — none of which the frontend can hold. All of these require the regular `Authorization: Bearer <token>` / `x-api-key` auth **except** `POST /api/calendly/:meetingId/lead`, which is authenticated separately via an `x-calendly-key` header or a `?token=` query param (the integration key from `calendlyConfig.calendlyKey` in Firestore) — this is deliberately scoped so a leaked key can't be used against any other endpoint.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/calendly/authorize` | Get the Calendly OAuth consent URL to start connecting |
| `GET` | `/api/calendly/oauth/callback` | OAuth redirect target — completes the connection, no auth (session comes from a pending-connect nonce) |
| `GET` | `/api/calendly/status` | Get `{connected, calendlyKey}` from the VM's local encrypted store, so the dashboard can self-heal its Firestore mirror of these two fields |
| `GET` | `/api/calendly/event-types` | List the connected account's Calendly event types, each with phone-detection fields (`phoneQuestionName`, `phoneDetectionStatus`) computed from that event type's `custom_questions` |
| `POST` | `/api/calendly/disconnect` | Disconnect the linked Calendly account |
| `GET` | `/api/calendly/code` | Serves the embeddable runtime script for one calendar |
| `POST` | `/api/calendly/:meetingId/lead` | Called by the embedded script on every real booking; sends the WhatsApp message and records a lead. Also reused by the dashboard's "Test Message" action with `test: true` in the body — sends to your own WhatsApp instead, and skips the lead write |

```bash
curl https://<domain>/api/calendly/status \
  -H "x-api-key: <your-api-key>"
# => {"connected": true, "calendlyKey": "<calendly-key>"}

curl https://<domain>/api/calendly/event-types \
  -H "x-api-key: <your-api-key>"
# => {"eventTypes": [{"uri": "...", "name": "30 Minute Meeting", "schedulingUrl": "...", "phoneQuestionName": "WhatsApp number", "phoneDetectionStatus": "found_required"}]}

curl -X POST https://<domain>/api/calendly/<meetingId>/lead \
  -H "x-calendly-key: <your-calendly-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "event_uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
    "invitee_uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/BBBBBBBBBBBBBBBB"
  }'
# => {"success": true, "status": "sent"}
```

`status` in the response is one of `sent`, `failed` (send attempted but errored), `no_phone` (no phone number on this booking), or `pending` (auto-send is off for this calendar — the lead is still logged). A request for an unknown `:meetingId`, or for an event that doesn't belong to the connected Calendly account, returns `404`/`403` respectively instead of a body with `status`. Every successful non-test call to `POST /api/calendly/:meetingId/lead` also writes/updates a lead in Firestore.

### Leads

Every real Calendly booking is recorded as a lead. Listing, editing notes, deleting, and manually adding leads all happen **client-side**, directly against Firestore (see [How Calendly data is stored and accessed](#how-calendly-data-is-stored-and-accessed)) — there's no `/api/leads` REST surface for that. One small server route remains:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/firebase-token` | Mint a Firebase custom token + return your `userDir`, so the dashboard can sign in to Firestore directly |

```bash
curl https://<domain>/api/firebase-token \
  -H "x-api-key: <your-api-key>"
# => {"firebaseToken": "...", "userDir": "..."}
```

Sending a WhatsApp message to a lead on demand (the dashboard's "Send" button) reuses the existing `POST /api/message` endpoint (see [above](#api)) — no dedicated leads-send route.

---

## Running tests

MailDev is started and stopped automatically by the test suite — no manual setup needed.

```bash
npm test
```

The test suite (`test/flow.test.js`, run via `npm test`) covers:
- Register → verify → API key generation
- Token structure (`token.slice(0,10) === sha256(email).slice(0,10)`)
- `token_hash` written to disk; `tokens.json` does not exist
- Schedule CRUD with timezone-aware cron expression assertion
- Encrypted-at-rest verification (schedule files are not plaintext)
- Re-registration: new token, same user directory, old token invalidated

**Calendly is deliberately not covered here.** Its actual behavior depends on Calendly's real API responses (custom question types, event/invitee shapes) in ways a hand-built mock can drift out of sync with silently — this app previously had a heavily-mocked Jest suite for it, since removed in favor of `test/calendly.e2e.js`: a separate, manually-invoked script (`npm run test-calendly-e2e`) that drives the real app server against a real Calendly test account. See [Testing the Calendly integration](#testing-the-calendly-integration) for setup and what it does and doesn't cover.

---

## Migrating to a new server

Because all secrets are derived from the user's token (which only they hold), moving to a new server is straightforward:

1. Copy the `users/` directory to the new server
2. Start the app — no `.env` changes needed beyond SMTP and `BASE_URL`
3. Each user's first dashboard load after migration will automatically re-register their cron jobs via `syncCronJobs`

No data loss. No re-encryption. No secret rotation.
