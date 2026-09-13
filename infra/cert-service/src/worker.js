// Cloudflare Worker — token-gated distribution of the shared device certificate.
//
// Serves the current cert bundle to tesla-pi devices from Workers KV. The
// Cloudflare API token that issues certs never touches this Worker (or any
// device) — issuance happens in CI (.github/workflows/renew-cert.yml), or
// manually with the same certbot container, and writes the artefacts here.
//
// Routes (all GET, all require `Authorization: Bearer <DEVICE_TOKEN>`):
//   /cert/version        -> {"version":N,"not_after":"..."}  (cheap; devices poll)
//   /cert/fullchain.pem  -> raw PEM
//   /cert/privkey.pem    -> raw PEM
//
// KV rather than R2: the payload is a few KB of text, KV is included in the free
// Workers plan (R2 needs a payment method on file), and KV's eventual
// consistency (~60 s) is irrelevant for a cert that rotates every ~60 days.
//
// The privkey is a secret: this endpoint must stay token-gated and rate-limited
// (see README — the rate limit is a WAF rule, enforced in front of the Worker).

const OBJECTS = {
  '/cert/version': { key: 'version.json', type: 'application/json' },
  '/cert/fullchain.pem': { key: 'fullchain.pem', type: 'application/x-pem-file' },
  '/cert/privkey.pem': { key: 'privkey.pem', type: 'application/x-pem-file' },
}

// Constant-time string compare — avoids leaking the token a byte at a time.
// Compares hashes so differing lengths don't short-circuit.
async function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const va = new Uint8Array(ha)
  const vb = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i]
  return diff === 0
}

function deny(status, msg) {
  return new Response(msg + '\n', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } })
    }

    const target = OBJECTS[url.pathname]
    if (!target) return deny(404, 'not found')

    if (!env.DEVICE_TOKEN) return deny(500, 'server misconfigured: DEVICE_TOKEN unset')

    // `Authorization: Bearer <token>`
    const header = request.headers.get('Authorization') || ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!(await tokensMatch(presented, env.DEVICE_TOKEN))) {
      return deny(401, 'unauthorized')
    }

    const { value, metadata } = await env.CERTS.getWithMetadata(target.key, 'text')
    if (value == null) return deny(503, 'no certificate published yet')

    return new Response(value, {
      headers: {
        'Content-Type': target.type,
        // Devices poll /cert/version; never let an edge cache mask a rotation.
        'Cache-Control': 'no-store',
        'X-Cert-Version': metadata?.version ?? '',
      },
    })
  },
}
