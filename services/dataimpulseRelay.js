// Local, unauthenticated relay between proxychains and DataImpulse.
//
// It builds the upstream Proxy-Authorization header itself from the raw
// (un-encoded) username/password string, bypassing the WHATWG URL parser
// entirely. That parser percent-encodes ';' into '%3B', which is how
// DataImpulse's own client libraries (e.g. global-agent, which mudslide
// depends on for --proxy) silently corrupt city/zip targeting — DataImpulse
// never sees the real ';city.x' / ';zip.x' suffix, just returns 503 NO_RAY.
// curl and proxychains don't round-trip the login string through a URL
// object, so this relay avoids the bug by doing the same: raw string in,
// raw bytes out.
//
// City/zip-level DataImpulse targeting is intermittently unavailable even
// on paid plans (their own "NO_RAY" error — no matching proxy right now),
// while country-only targeting has proven solid every time. So on a denied
// upstream CONNECT, this relay retries once with country-only targeting
// before giving up, rather than silently losing the request.
const net = require('net');
const http = require('http');

// A live-measured CONNECT round trip through this gateway (5 trials against
// web.whatsapp.com:443) came back at 773-878ms every time — well under 1
// second. ~3.5x that observed worst case for error margin, not a guess.
const PROXY_CONNECT_TIMEOUT_MS = 3000;

function buildAuthHeader(username, country, targetSuffix, password) {
  const upstreamUser = `${username}__cr.${country}${targetSuffix}`;
  return 'Basic ' + Buffer.from(`${upstreamUser}:${password}`).toString('base64');
}

// Attempts a single upstream CONNECT with the given auth header. Resolves
// with { statusCode, socket, leftover } on any HTTP response (caller decides
// success/failure), or rejects on a transport-level error or timeout.
// DataImpulse's gateway can accept the TCP connection and then simply never
// respond — with no timeout that hangs forever, so the socket is destroyed
// and this rejects with a specific, actionable message on the same timer.
function attemptConnect({ upstreamHost, upstreamPort, targetHost, targetPort, authHeader, timeoutMs = PROXY_CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(upstreamPort, upstreamHost, () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Proxy-Authorization: ${authHeader}\r\n` +
        `\r\n`
      );
    });

    let buffered = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Residential IP did not respond on port ${upstreamPort}`));
    }, timeoutMs);

    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const text = buffered.toString('latin1');
      const headerEnd = text.indexOf('\r\n\r\n');
      if (headerEnd === -1) return; // wait for more data

      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      const statusLine = text.split('\r\n')[0];
      const match = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine);
      resolve({ statusCode: match ? Number(match[1]) : 0, socket, leftover: buffered.slice(headerEnd + 4) });
    };

    socket.on('data', onData);
    socket.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
  });
}

function startRelay({ country, targetSuffix = '', upstreamHost, upstreamPort, localPort, username, password, onError }) {
  const primaryAuthHeader = buildAuthHeader(username, country, targetSuffix, password);
  const fallbackAuthHeader = targetSuffix ? buildAuthHeader(username, country, '', password) : null;

  // CONNECT-tunneled sockets (see the 'connect' handler below) — tracked so
  // they can be force-destroyed on shutdown. server.close() only waits for
  // connections to end on their own and explicitly does not reach sockets
  // upgraded via CONNECT, so this is the only way to actually free them if
  // one doesn't close cleanly (e.g. the process using it was killed).
  const activeTunnels = new Set();

  // Plain HTTP absolute-form requests (used by our own diagnostics, e.g.
  // getProxiedIpInfo's curl call) — retried the same way as CONNECT below.
  const server = http.createServer((clientReq, clientRes) => {
    const doRequest = authHeader => new Promise((resolve, reject) => {
      const upstreamReq = http.request({
        host: upstreamHost,
        port: upstreamPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: { ...clientReq.headers, 'Proxy-Authorization': authHeader },
        timeout: PROXY_CONNECT_TIMEOUT_MS
      }, upstreamRes => resolve(upstreamRes));
      upstreamReq.on('timeout', () => upstreamReq.destroy(new Error(`Residential IP did not respond on port ${upstreamPort}`)));
      upstreamReq.on('error', reject);
      clientReq.pipe(upstreamReq);
    });

    doRequest(primaryAuthHeader)
      .then(upstreamRes => {
        if (upstreamRes.statusCode >= 400 && fallbackAuthHeader) {
          upstreamRes.resume(); // discard, we're retrying
          return doRequest(fallbackAuthHeader);
        }
        return upstreamRes;
      })
      .then(upstreamRes => {
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      })
      .catch(err => {
        onError?.(err.message);
        clientRes.writeHead(502);
        clientRes.end('Bad gateway: ' + err.message);
      });
  });

  server.on('connect', async (req, clientSocket, head) => {
    const [targetHost, targetPort] = req.url.split(':');
    const opts = { upstreamHost, upstreamPort, targetHost, targetPort: targetPort || 443 };

    try {
      let result = await attemptConnect({ ...opts, authHeader: primaryAuthHeader });

      if ((result.statusCode < 200 || result.statusCode >= 300) && fallbackAuthHeader) {
        result.socket.destroy();
        result = await attemptConnect({ ...opts, authHeader: fallbackAuthHeader });
      }

      if (result.statusCode >= 200 && result.statusCode < 300) {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) result.socket.write(head);
        if (result.leftover.length) clientSocket.write(result.leftover);
        activeTunnels.add(clientSocket);
        activeTunnels.add(result.socket);
        const untrack = () => { activeTunnels.delete(clientSocket); activeTunnels.delete(result.socket); };
        clientSocket.once('close', untrack);
        result.socket.once('close', untrack);
        result.socket.pipe(clientSocket);
        clientSocket.pipe(result.socket);
      } else {
        result.socket.destroy();
        clientSocket.end(`HTTP/1.1 ${result.statusCode || 502} Upstream CONNECT failed\r\n\r\n`);
      }
    } catch (err) {
      onError?.(err.message);
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }

    clientSocket.on('error', () => {});
  });

  server.destroyActiveTunnels = () => {
    for (const socket of activeTunnels) socket.destroy();
    activeTunnels.clear();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(localPort, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startRelay };