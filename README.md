# Whatsapp Bot on cloud that sends message on your behalf

A self-hosted WhatsApp message automation platform built on [Mudslide](https://github.com/robvanderleek/mudslide). Connect your WhatsApp account via QR code, then schedule automated messages or trigger them on demand via a REST API.

All user data is encrypted in the repository using your personal auth token as the key. There is no shared server secret — even the server owner cannot read your data. Check watobot-dot-xyz for live implementation.

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

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/register` | Send magic link to email |
| `GET` | `/api/verify/:token` | Verify token, get user info |
| `POST` | `/api/apikey/generate` | Generate a permanent API key |
| `GET` | `/api/whatsapp/status` | Check WhatsApp connection status |
| `GET` | `/api/whatsapp/qr` | Get QR code for WhatsApp login |
| `POST` | `/api/whatsapp/login/confirm` | Confirm QR scan is complete |
| `POST` | `/api/whatsapp/logout` | Initiate WhatsApp disconnect |
| `POST` | `/api/whatsapp/logout/confirm` | Clean up session after manual device removal |
| `POST` | `/api/message` | Send a message immediately |
| `GET` | `/api/schedules` | List all schedules |
| `POST` | `/api/schedules` | Create a schedule |
| `GET` | `/api/schedules/:id` | Get a schedule |
| `PUT` | `/api/schedules/:id` | Update a schedule |
| `DELETE` | `/api/schedules/:id` | Delete a schedule |
| `GET` | `/api/schedules/:id/logs` | Get execution logs for a schedule |

### Send a message

```bash
curl -X POST http://localhost:3000/api/message \
  -H "x-api-key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"to": "919876543210", "message": "Hello!"}'
```

### Create a schedule

```bash
curl -X POST http://localhost:3000/api/schedules \
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
