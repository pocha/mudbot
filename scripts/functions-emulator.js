const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = 5001;
const PROJECT_ID = 'wato-bot';
const REGION = 'asia-south1';
const SERVICE_ACCOUNT_KEY_PATH = path.join(__dirname, '..', 'functions', '.serviceAccountKey.json');

function emulatorBaseUrl() {
  return `http://${EMULATOR_HOST}:${EMULATOR_PORT}/${PROJECT_ID}/${REGION}`;
}

async function waitForEmulator(retries = 20, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      // Any HTTP response (even a 404, since no path is given) means the
      // emulator's server is up and routing — that's all this needs to know.
      await fetch(`http://${EMULATOR_HOST}:${EMULATOR_PORT}/`);
      return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// Starts the Cloud Functions emulator for local dev, and points this
// process's CLOUD_FUNCTIONS_BASE_URL at it — mintFirebaseToken, createLead,
// and getCalendlyMeetingConfig calls (services/calendlyService.js,
// routes/api.js) then go there instead of the real deployed project. The
// real, deployed versions of these functions are IP-allowlisted to the
// production VM's static address and otherwise unreachable from a dev
// machine at all (see functions/index.js: isAllowedVmCaller) — this is what
// makes local testing of anything needing a Firebase sign-in possible.
//
// Never runs in production. If it can't start for any reason (firebase-tools
// missing, no local service account key, port conflict), this logs a
// warning and falls back to the real deployed Cloud Functions rather than
// blocking server startup — CLOUD_FUNCTIONS_BASE_URL is simply left unset.
async function startFunctionsEmulatorIfNeeded() {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.SKIP_FUNCTIONS_EMULATOR === 'true') return;

  if (!fs.existsSync(SERVICE_ACCOUNT_KEY_PATH)) {
    console.warn(
      '[functions-emulator] functions/.serviceAccountKey.json not found — ' +
      'skipping local emulation, using the real deployed Cloud Functions instead ' +
      '(anything needing Firebase sign-in will 502 unless run from the production VM).'
    );
    return;
  }

  console.log('[functions-emulator] Starting local Cloud Functions emulator...');
  const emulatorProcess = spawn(
    'firebase', ['emulators:start', '--only', 'functions', '--project', PROJECT_ID],
    {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: SERVICE_ACCOUNT_KEY_PATH },
      stdio: 'pipe'
    }
  );
  emulatorProcess.stderr.on('data', d => process.stderr.write(`[functions-emulator] ${d}`));
  emulatorProcess.on('error', err => {
    console.warn(`[functions-emulator] Failed to start (${err.message}) — using real deployed Cloud Functions instead.`);
  });
  process.on('exit', () => emulatorProcess.kill());

  const up = await waitForEmulator();
  if (!up) {
    console.warn('[functions-emulator] Did not come up in time — using real deployed Cloud Functions instead.');
    emulatorProcess.kill();
    return;
  }

  process.env.CLOUD_FUNCTIONS_BASE_URL = emulatorBaseUrl();
  console.log(`[functions-emulator] Running locally at ${emulatorBaseUrl()}`);
}

module.exports = { startFunctionsEmulatorIfNeeded };
