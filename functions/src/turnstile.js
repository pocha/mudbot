// Verifies a Cloudflare Turnstile token server-side. This is what stands
// between the unauthenticated publishFaq endpoint and a scripted abuser who'd
// otherwise be able to push arbitrary HTML into the live site's repo on
// repeat.

async function verifyTurnstileToken(token, secretKey, remoteIp) {
  if (!token) return false;

  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body
  });

  if (!res.ok) return false;
  const data = await res.json();
  return !!data.success;
}

module.exports = { verifyTurnstileToken };
