#!/usr/bin/env node
//
// End-to-end test: does mudslide actually work over a proxychains -> local
// relay -> DataImpulse (city/zip targeted) -> WhatsApp chain?
//
// The relay (services/dataimpulseRelay.js) exists because global-agent
// (which mudslide's own --proxy flag depends on) mangles DataImpulse's
// city/zip targeting syntax — a literal ';' in the login string gets
// percent-encoded to '%3B' by Node's URL parser and never decoded back
// before being sent, so DataImpulse returns 503 NO_RAY. proxychains
// doesn't go anywhere near that code path (it intercepts connect() at the
// OS level), so pointing it at this relay sidesteps the bug entirely,
// without needing mudslide's --proxy flag at all.
//
// Usage:
//   npm run test-mudslide-proxy
//   npm run test-mudslide-proxy -- --country=in --zip=560010 --recipient=919538384545
//   npm run test-mudslide-proxy -- --city=newyork --country=us --relogin
//
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { startRelay } = require('../services/dataimpulseRelay');
const { SEND_CHECK_ARGS } = require('../services/mudslideService');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=');
      return [k, v === undefined ? true : v];
    })
);

const country = args.country || 'in';
const targetSuffix = args.zip ? `;zip.${args.zip}` : args.city ? `;city.${args.city}` : '';
const upstreamHost = process.env.DATAIMPULSE_HTTP_GATEWAY || 'gw.dataimpulse.com';
const upstreamPort = args.port || process.env.DATAIMPULSE_PORT || '10000';
const localPort = Number(args['local-port'] || 18080);
const recipient = args.recipient || '919538384545';
const message = args.message || 'Hello World from Watobot proxy POC';
const cacheDir = path.join(__dirname, '.mudslide-test-cache');
const confPath = path.join(os.tmpdir(), 'watobot-test-proxychains.conf');

const mudslideBin = process.env.MUDSLIDE_PATH || 'mudslide';
const proxychainsBin = process.env.PROXYCHAINS_PATH;

if (!proxychainsBin) {
  console.error('PROXYCHAINS_PATH not set in .env');
  process.exit(1);
}
if (!process.env.DATAIMPULSE_USERNAME || !process.env.DATAIMPULSE_PASSWORD) {
  console.error('DATAIMPULSE_USERNAME / DATAIMPULSE_PASSWORD not set in .env');
  process.exit(1);
}

if (args.relogin) {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}
fs.mkdirSync(cacheDir, { recursive: true });

// mudslide's own exit code is NOT a reliable success signal — it has been
// observed to exit 0 even when proxychains denied the underlying connection
// (i.e. the message never actually left the machine). So this also scans
// the captured proxychains output for a hard failure marker and treats that
// as a failure regardless of exit code.
function runProxychained(mudslideArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(proxychainsBin, ['-f', confPath, mudslideBin, '-c', cacheDir, ...mudslideArgs], {
      stdio: ['inherit', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', d => { output += d; process.stdout.write(d); });
    child.stderr.on('data', d => { output += d; process.stderr.write(d); });
    child.on('exit', code => {
      const denied = /<--denied|<--socket error/.test(output);
      if (code === 0 && !denied) resolve();
      else if (denied) reject(new Error('proxychains denied the connection — see log above'));
      else reject(new Error(`exit code ${code}`));
    });
    child.on('error', reject);
  });
}

function isLoggedIn() {
  return new Promise(resolve => {
    const child = spawn(proxychainsBin, ['-f', confPath, mudslideBin, '-c', cacheDir, 'me'], {
      stdio: 'ignore'
    });
    child.on('exit', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

(async () => {
  fs.writeFileSync(confPath, `strict_chain\nproxy_dns\n[ProxyList]\nhttp 127.0.0.1 ${localPort}\n`);

  const relay = await startRelay({
    country,
    targetSuffix,
    upstreamHost,
    upstreamPort,
    localPort,
    username: process.env.DATAIMPULSE_USERNAME,
    password: process.env.DATAIMPULSE_PASSWORD
  });

  console.log(`Relay: 127.0.0.1:${localPort} -> ${upstreamHost}:${upstreamPort} (country=${country}${targetSuffix})`);
  console.log(`Cache: ${cacheDir}\n`);

  try {
    if (await isLoggedIn()) {
      console.log('Already logged in (cached session found) — skipping QR step.\n');
    } else {
      console.log('Not logged in yet. Scan the QR code below with WhatsApp:');
      console.log('(Settings > Connected Devices > Connect Device)\n');
      runProxychained(['login']).catch(err => console.error('\nlogin process ended:', err.message));
      await waitForEnter('\nPress Enter once your phone shows the device linked...\n');
    }

    console.log(`Sending "${message}" to ${recipient}...`);
    await runProxychained(['send', recipient, message, ...SEND_CHECK_ARGS]);
    console.log('\n✅ Sent successfully through proxychains -> relay -> DataImpulse -> WhatsApp.');
  } catch (err) {
    console.error('\n❌ Failed:', err.message);
    process.exitCode = 1;
  } finally {
    relay.close();
  }
})();
