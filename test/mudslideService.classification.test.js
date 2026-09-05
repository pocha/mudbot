// Unit-level "chaos" tests for mudslideService's failure classification —
// each scenario controls exactly what a mocked mudslide/proxychains child
// process prints and when, and asserts on the *real* runMudslide (via the
// __test export — see services/mudslideService.js) rather than going
// through the full public API, so each test isolates one mechanism.
//
// Deliberately uses real timers throughout, with small millisecond values
// standing in for the real 30-60s production constants, and schedules each
// fake process's behavior via process.nextTick from *inside* the spawn
// mock implementation — that guarantees correct ordering relative to when
// spawnWithTimeout actually attaches its listeners (spawn() is called
// asynchronously, after an internal `await proxyConfPath(...)`, so emitting
// on a pre-built fake process from outside the mock is a real race).
const { EventEmitter } = require('events');

jest.mock('child_process');
jest.mock('../services/proxyRelayManager');

function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: jest.fn(), end: jest.fn() };
  proc.kill = jest.fn();
  return proc;
}

const USER_DIR = 'testuser01';
const TOKEN = 'a'.repeat(64);

describe('runMudslide classification (no proxy configured)', () => {
  // With PROXYCHAINS_PATH/DATAIMPULSE_USERNAME unset, userService.proxyConfPath
  // resolves to null on its own (see services/userService.js) and
  // checkProxyReachable's own guard short-circuits — neither scenario below
  // needs the proxy diagnostic to run at all, so no extra mocking for it.
  const { spawn } = require('child_process');
  const proxyRelayManager = require('../services/proxyRelayManager');
  const mudslideService = require('../services/mudslideService');

  beforeAll(() => {
    proxyRelayManager.acquireRelay.mockResolvedValue(true);
    proxyRelayManager.releaseRelay.mockResolvedValue();
    proxyRelayManager.takeLastRelayError.mockReturnValue(null);
  });

  test('device-unlinked marker: rejects with the exact marker text', async () => {
    const proc = fakeProc();
    spawn.mockImplementationOnce(() => {
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('Cache folder: /tmp/mudbot-testuser01/.mudslide\n'));
        proc.stdout.emit('data', Buffer.from('✖  error     Device unlinked from WhatsApp\n'));
        proc.emit('close', 1);
      });
      return proc;
    });

    await expect(mudslideService.__test.runMudslide(['me'], 5000, USER_DIR, TOKEN, 'me'))
      .rejects.toThrow('Device unlinked from WhatsApp');
  });

  test('not-registered marker: kills the process almost immediately instead of waiting out the full timeout', async () => {
    const proc = fakeProc();
    const TIMEOUT_MS = 5000; // deliberately large — the assertion below proves the kill happens nowhere near this
    spawn.mockImplementationOnce(() => {
      // Emits the marker and then deliberately never emits 'close' — this is
      // the real unattended-pairing hang: the process just sits there
      // forever unless killOn's fast-path kills it.
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('{"level":30,"msg":"not logged in, attempting registration..."}\n'));
      });
      return proc;
    });

    const runPromise = mudslideService.__test.runMudslide(['me'], TIMEOUT_MS, USER_DIR, TOKEN, 'me');
    // Attached immediately, synchronously — the rejection can arrive as
    // early as the very next microtask (via the nextTick-scheduled emit
    // above), and leaving runPromise unhandled even briefly makes Jest
    // report it as an unhandled rejection against whichever test happens to
    // be running when Node notices, instead of surfacing as this test's own
    // assertion result.
    let error;
    let settled = false;
    runPromise.then(() => { settled = true; }, e => { settled = true; error = e; });

    // Real, short wait — proves the kill fires almost immediately, nowhere
    // near TIMEOUT_MS, without needing fake timers at all.
    await new Promise(r => setTimeout(r, 50));
    expect(proc.kill).toHaveBeenCalledTimes(1);

    // The process doesn't actually die until the kill takes effect.
    proc.emit('close', null);
    await new Promise(r => setTimeout(r, 10));
    expect(settled).toBe(true);
    expect(error && error.message).toContain('Device unlinked from WhatsApp');
  });
});

describe('runMudslide classification (proxy diagnostic path)', () => {
  // These two need checkProxyReachable to actually run, so the proxy env
  // guard and userService.proxyConfPath both need to resolve truthy.
  // CONFIG.PROXYCHAINS_PATH is captured once at module-load time, so this
  // needs its own isolated module registry — resetModules(), THEN re-require
  // child_process/proxyRelayManager fresh too (their top-level counterparts
  // in the describe block above are stale references to a different module
  // instance than the one this freshly-required mudslideService will
  // actually call internally).
  let spawn;
  let proxyRelayManager;
  let mudslideService;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../services/userService', () => ({
      proxyConfPath: jest.fn().mockResolvedValue('/tmp/fake-proxychains.conf'),
      getNotifyEmail: jest.fn().mockResolvedValue(null)
    }));
    process.env.PROXYCHAINS_PATH = '/usr/bin/proxychains4';

    spawn = require('child_process').spawn;
    proxyRelayManager = require('../services/proxyRelayManager');
    proxyRelayManager.acquireRelay.mockResolvedValue(true);
    proxyRelayManager.releaseRelay.mockResolvedValue();
    proxyRelayManager.takeLastRelayError.mockReturnValue(null);

    mudslideService = require('../services/mudslideService');
  });

  afterAll(() => {
    delete process.env.PROXYCHAINS_PATH;
  });

  // Distinguishes the "real" mudslide invocation from checkProxyReachable's
  // own diagnostic curl by inspecting argv — both go through the same
  // mocked spawn(). The real call never emits 'close' at all — it's meant
  // to genuinely time out via spawnWithTimeout's own real (small) timer, not
  // be resolved by us — that's what "proxy not responding" actually means.
  function mockSpawnForDiagnosticTest({ diagnosticOk }) {
    spawn.mockImplementation((bin, args) => {
      const proc = fakeProc();
      if (args.includes('curl') && args.some(a => a.includes('web.whatsapp.com'))) {
        process.nextTick(() => {
          if (diagnosticOk) proc.stdout.emit('data', Buffer.from('200'));
          proc.emit('close', 0);
        });
      }
      return proc;
    });
  }

  test('proxy not responding: real call times out AND the diagnostic curl also fails → classified as proxy_unreachable', async () => {
    mockSpawnForDiagnosticTest({ diagnosticOk: false });

    const TIMEOUT_MS = 100; // small real timeout so the "real" call's own spawnWithTimeout genuinely fires quickly
    let error;
    await mudslideService.__test.runMudslide(['me'], TIMEOUT_MS, USER_DIR, TOKEN, 'me').catch(e => { error = e; });

    expect(mudslideService.isProxyUnreachableError(error)).toBe(true);
    // Jest's default 5000ms per-test timeout is tight against this
    // describe block's own beforeAll overhead (resetModules + re-requiring
    // several modules) — bumped below, not a sign anything here is slow by
    // design.
  }, 15000);

  test('proxy responding but WhatsApp unreachable: real call times out but the diagnostic curl succeeds → NOT classified as proxy_unreachable', async () => {
    mockSpawnForDiagnosticTest({ diagnosticOk: true });

    const TIMEOUT_MS = 100;
    let error;
    await mudslideService.__test.runMudslide(['me'], TIMEOUT_MS, USER_DIR, TOKEN, 'me').catch(e => { error = e; });

    // This is the real, previously-discussed gap: a proxy that's basically
    // fine but whose WhatsApp connection specifically failed reads as an
    // ambiguous, unlabeled failure — not proxy_unreachable — because
    // checkProxyReachable's own curl happened to succeed. Documented here
    // as a tripwire, not (yet) a bug this test is asserting should change.
    expect(mudslideService.isProxyUnreachableError(error)).toBe(false);
  }, 15000);
});
