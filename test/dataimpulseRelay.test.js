// Scenario 6: the DataImpulse CONNECT tunnel itself failing (accepted at the
// TCP level, then never responds) — a different code path and a different
// diagnostic message than the proxy-unreachable-via-diagnostic-curl cases in
// mudslideService.classification.test.js. No process spawning involved here,
// so no child_process mocking — just a real local TCP server standing in for
// DataImpulse's own gateway.
const net = require('net');
const http = require('http');
const { startRelay } = require('../services/dataimpulseRelay');

function listenOnFreePort(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('upstream gateway accepts the connection but never responds → onError fires with the real "did not respond" message', async () => {
  // Stands in for DataImpulse's gateway: accepts the TCP connection (so this
  // isn't a plain ECONNREFUSED) and then simply never writes anything back —
  // exactly the "gateway can accept the TCP connection and then simply never
  // respond" case attemptConnect's own comment describes.
  const upstreamSockets = new Set();
  const fakeUpstream = net.createServer(socket => {
    socket.on('error', () => {}); // ignore the eventual destroy() from our side
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  const upstreamPort = await listenOnFreePort(fakeUpstream);

  let capturedError = null;
  const relayServer = await startRelay({
    country: 'in',
    upstreamHost: '127.0.0.1',
    upstreamPort,
    localPort: 0,
    username: 'testuser',
    password: 'testpass',
    onError: message => { capturedError = message; }
  });
  const relayPort = relayServer.address().port;
  let req;

  try {
    // Drive a real CONNECT request through the relay's own local port, same
    // as proxychains would. We only need the server's own 'connect' handler
    // to start running — not any particular client-side outcome (a CONNECT
    // request that gets back a plain 502 response, rather than an upgrade,
    // doesn't reliably fire 'connect' or 'error' on the client), so this
    // doesn't wait on any specific client-side event at all.
    req = http.request({
      host: '127.0.0.1',
      port: relayPort,
      method: 'CONNECT',
      path: 'web.whatsapp.com:443'
    });
    req.on('error', () => {}); // expected once the server eventually closes the socket
    req.end();

    // attemptConnect's own timeout (PROXY_CONNECT_TIMEOUT_MS, 3000ms) is what
    // actually produces this message — not parameterized per-call, so this
    // one test genuinely waits it out rather than faking it.
    await new Promise(r => setTimeout(r, 3200));

    expect(capturedError).toMatch(new RegExp(`Residential IP did not respond on port ${upstreamPort}`));
  } finally {
    // Same shape as proxyRelayManager's own forceDropRelay: destroy
    // everything forcefully and fire-and-forget close() rather than await
    // its callback — a CONNECT socket that never got upgraded doesn't
    // reliably make that callback fire at all (real production behavior,
    // not something this test's own cleanup needs to wait on).
    req?.destroy();
    relayServer.destroyActiveTunnels?.();
    relayServer.closeAllConnections?.();
    relayServer.close(() => {});
    for (const socket of upstreamSockets) socket.destroy();
    fakeUpstream.close(() => {});
  }
}, 10000);
