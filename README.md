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
| Calendly config (`calendly.json`) | AES-256, key = token | Only you (token required to decrypt) |
| `calendly_key_hash` (`sha256(calendlyKey)`) | `users/<dir>/calendly_key_hash` | Public-safe — one-way hash, useless without the key |

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

Connect your Calendly account (standard OAuth — click Connect in the dashboard, approve access, done) and Watobot will automatically send a WhatsApp message to every person who books a meeting through it.

This requires one thing on the Calendly side: add a **custom question** to the event type you want covered, asking for the invitee's phone number. The exact question label is configurable per meeting in the Watobot dashboard (it's matched against `phoneQuestionName`), and it's strongly recommended you mark the question **required** — a booking without a phone number is logged as a lead with `status: "no_phone"` but no message is sent.

Once a meeting is configured, embed its one-line script on that event type's booking page, before your existing Calendly embed code (each configured meeting has its own snippet, shown in the dashboard):

```html
<script src="https://<domain>/api/calendly/code?token=<your-calendly-key>&meetingId=<meeting-id>"></script>
```

The `<your-calendly-key>` is a separate integration key (not your API key or auth token) generated the first time you connect Calendly — it's scoped only to the Calendly runtime script and webhook-style route, so a leaked key can't be used against `/api/message` or any other endpoint. Every confirmed booking on that page then triggers a WhatsApp message automatically, using the message template and phone-number question configured for that meeting.

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

Endpoints for connecting Calendly, configuring which event types trigger a WhatsApp message, and the runtime endpoint the embedded script calls on every booking. All of these require the regular `Authorization: Bearer <token>` / `x-api-key` auth **except** `POST /api/calendly/:meetingId/lead`, which is authenticated separately via an `x-calendly-key` header or a `?token=` query param (the integration key from `GET /api/calendly/config`) — this is deliberately scoped so a leaked key can't be used against any other endpoint.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/calendly/authorize` | Get the Calendly OAuth consent URL to start connecting |
| `GET` | `/api/calendly/config` | Get connection status, integration key, and configured meetings |
| `POST` | `/api/calendly/config` | Create or update a meeting's message template / phone question |
| `DELETE` | `/api/calendly/config/:meetingId` | Delete a meeting's configuration |
| `POST` | `/api/calendly/disconnect` | Disconnect the linked Calendly account |
| `POST` | `/api/calendly/:meetingId/lead` | Called by the embedded script on every booking for that meeting; sends the WhatsApp message |

```bash
curl https://<domain>/api/calendly/config \
  -H "x-api-key: <your-api-key>"
# => {"connected": true, "calendlyKey": "<calendly-key>", "meetings": {"<meetingId>": {...}}}

curl -X POST https://<domain>/api/calendly/config \
  -H "x-api-key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "eventTypeUri": "https://api.calendly.com/event_types/AAAAAAAAAAAAAAAA",
    "eventTypeName": "30 Minute Meeting",
    "messageTemplate": "Hi {{name}}, thanks for booking {{eventName}}!",
    "phoneQuestionName": "WhatsApp number"
  }'
# => {"success": true, "meeting": {"id": "<meetingId>", ...}}

curl -X POST https://<domain>/api/calendly/<meetingId>/lead \
  -H "x-calendly-key: <your-calendly-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "event_uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
    "invitee_uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/BBBBBBBBBBBBBBBB"
  }'
# => {"success": true, "status": "sent"}
```

`status` in the response is one of `sent`, `failed` (send attempted but errored), or `no_phone` (the configured custom question had no answer on this booking). A request for an unknown `:meetingId`, or for an event that doesn't belong to the connected Calendly account, returns `404`/`403` respectively instead of a body with `status`. Every successful call to `POST /api/calendly/:meetingId/lead` also writes/updates a lead — see below.

### Leads

Every Calendly booking that runs through `POST /api/calendly/:meetingId/lead` is recorded as a lead, editable from the dashboard.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/leads` | List leads (`?limit=` and `?cursor=` for pagination, default limit 50) |
| `PATCH` | `/api/leads/:id` | Update a lead's notes |
| `DELETE` | `/api/leads/:id` | Delete a lead |

```bash
curl https://<domain>/api/leads?limit=20 \
  -H "x-api-key: <your-api-key>"
# => {"leads": [{"id": "...", "name": "...", "phone": "...", "status": "sent", ...}]}

curl -X PATCH https://<domain>/api/leads/<lead-id> \
  -H "x-api-key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"notes": "Followed up by phone"}'
# => {"success": true, "lead": {...}}
```

---

## Running tests

MailDev is started and stopped automatically by the test suite — no manual setup needed.

```bash
npm test
```

The test suite (`test/flow.test.js`) covers:
- Register → verify → API key generation
- Token structure (`token.slice(0,10) === sha256(email).slice(0,10)`)
- `token_hash` written to disk; `tokens.json` does not exist
- Schedule CRUD with timezone-aware cron expression assertion
- Encrypted-at-rest verification (schedule files are not plaintext)
- Re-registration: new token, same user directory, old token invalidated

---

## Migrating to a new server

Because all secrets are derived from the user's token (which only they hold), moving to a new server is straightforward:

1. Copy the `users/` directory to the new server
2. Start the app — no `.env` changes needed beyond SMTP and `BASE_URL`
3. Each user's first dashboard load after migration will automatically re-register their cron jobs via `syncCronJobs`

No data loss. No re-encryption. No secret rotation.
