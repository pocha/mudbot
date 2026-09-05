// Scenario 5: withSession's per-user queue must never stay permanently
// wedged behind a run() that's genuinely stuck for a reason nothing else
// protects against. run()'s own inner errorOnTimeout(doWork(), ...) already
// bounds a hung fn (the underlying mudslide spawn) at OPERATION_TIMEOUT_MS —
// so to exercise the NEW backstop specifically (not re-prove that existing
// mechanism), this simulates a hang in the surrounding cleanup instead: fn
// rejects quickly, but the mocked proxyRelayManager.releaseRelay() call in
// withSession's own catch block never resolves — exactly the shape of the
// real closeServer incident this backstop was built for, reproduced here at
// the mock level rather than needing real sockets.
//
// Deliberately uses real timers, not fake ones — jest.useFakeTimers()
// repeatedly failed to let real fs I/O + process.nextTick-scheduled mock
// behavior actually progress in this environment (see
// mudslideService.classification.test.js's own comment for the same
// lesson), silently stalling doWork() before it ever reached fn. withSession
// takes operationTimeoutMs/queueAdvanceTimeoutMs as independent optional
// overrides (both default to the real production constants for every real
// caller) specifically so this test can prove the backstop's behavior with
// small values instead of a real 75-second wait.
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { EventEmitter } = require('events');

jest.mock('child_process');
jest.mock('../services/proxyRelayManager');

const { spawn } = require('child_process');
const proxyRelayManager = require('../services/proxyRelayManager');
const mudslideService = require('../services/mudslideService');

const USERS_DIR = path.join(__dirname, '..', 'users');
const USER_DIR = 'queuehangtest';
const TOKEN = 'b'.repeat(64);

// Any `tar` invocation (decrypt's -xzf or encrypt's -czf) succeeds trivially
// — nothing in this test ever reads the extracted/tarred content for real.
spawn.mockImplementation(() => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: jest.fn(), end: jest.fn() };
  proc.kill = jest.fn();
  process.nextTick(() => proc.emit('close', 0));
  return proc;
});

beforeAll(async () => {
  // A real, validly-encrypted (arbitrary plaintext) .mudslide.enc so
  // isLoggedIn/decryptMudslideToTemp's crypto step succeeds for real — its
  // content doesn't matter since the mocked tar above never really extracts it.
  const key = crypto.createHash('sha256').update(TOKEN).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update('fake tar content'), cipher.final()]);
  await fs.mkdir(path.join(USERS_DIR, USER_DIR), { recursive: true });
  await fs.writeFile(path.join(USERS_DIR, USER_DIR, '.mudslide.enc'), Buffer.concat([iv, encrypted]));
});

afterAll(async () => {
  await fs.rm(path.join(USERS_DIR, USER_DIR), { recursive: true, force: true });
});

beforeEach(() => {
  proxyRelayManager.acquireRelay.mockResolvedValue(true);
  proxyRelayManager.takeLastRelayError.mockReturnValue(null);
});

test('a run() stuck in its own cleanup does not permanently wedge the queue for later ops', async () => {
  // The failure this reproduces: fn rejects quickly (so doWork()'s own inner
  // errorOnTimeout resolves for real, not via its own timeout), but
  // releaseRelay — called from withSession's catch block once relayHeld is
  // true — never resolves, same shape as a hung closeServer(). Only the
  // *first* call hangs — the second op's own cleanup (later in this test)
  // needs its own releaseRelay call to actually succeed, to prove the queue
  // unwedged rather than every future call now hanging identically.
  proxyRelayManager.releaseRelay.mockReturnValueOnce(new Promise(() => {}));
  proxyRelayManager.releaseRelay.mockResolvedValue();

  const OPERATION_TIMEOUT_MS = 500;
  const QUEUE_ADVANCE_TIMEOUT_MS = 300;

  const firstFn = jest.fn(() => { throw new Error('deliberate test failure'); });
  const firstResult = mudslideService.__test.withSession(
    USER_DIR, TOKEN, firstFn, 'firstOp', {}, true, undefined, OPERATION_TIMEOUT_MS, QUEUE_ADVANCE_TIMEOUT_MS
  );
  firstResult.catch(() => {}); // expected to never settle in this test — avoid an unhandled-rejection warning, don't await it

  // Let doWork() actually run and reach the hung releaseRelay call.
  await new Promise(r => setTimeout(r, 100));
  expect(firstFn).toHaveBeenCalledTimes(1);

  // Wait out the queue's own backstop — using the small override above
  // instead of the real 75-second production value.
  await new Promise(r => setTimeout(r, QUEUE_ADVANCE_TIMEOUT_MS + 100));

  // The backstop firing must leave a trace — otherwise a real occurrence of
  // this in production would be just as invisible as the original
  // closeServer incident was before checkpoint logging existed.
  const debugLog = await fs.readFile(path.join(USERS_DIR, USER_DIR, 'mudslide-debug.log'), 'utf8').catch(() => '');
  expect(debugLog).toContain('firstOp: queue-advance backstop fired');

  // A second op for the same user, queued behind the first, must still
  // actually run — proving the queue itself unwedged rather than staying
  // jammed forever behind the stuck first call.
  const secondFn = jest.fn(async () => 'second-result');
  const secondResult = await mudslideService.__test.withSession(
    USER_DIR, TOKEN, secondFn, 'secondOp', {}, true, undefined, OPERATION_TIMEOUT_MS, QUEUE_ADVANCE_TIMEOUT_MS
  );

  expect(secondFn).toHaveBeenCalledTimes(1);
  expect(secondResult).toBe('second-result');
});
