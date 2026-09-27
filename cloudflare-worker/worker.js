const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowedOrigin = env.ALLOWED_ORIGIN;
    const corsHeaders = origin === allowedOrigin
      ? { 'Access-Control-Allow-Origin': allowedOrigin, 'Vary': 'Origin' }
      : {};

    if (request.method === 'OPTIONS' && url.pathname === '/claim') {
      if (origin !== allowedOrigin) {
        return jsonResponse({ ok: false, message: 'Origin not allowed.' }, 403);
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (url.pathname === '/claim' && request.method === 'POST') {
      if (origin !== allowedOrigin) {
        return jsonResponse({ ok: false, message: 'Origin not allowed.' }, 403, corsHeaders);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, message: 'Invalid JSON body.' }, 400, corsHeaders);
      }

      const playerName = typeof body.playerName === 'string' ? body.playerName.trim() : '';
      if (!/^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{2,15})$/.test(playerName)) {
        return jsonResponse({ ok: false, message: 'Bitte gib einen gültigen Minecraft-Namen ein.' }, 400, corsHeaders);
      }

      const queue = env.CLAIMS.get(env.CLAIMS.idFromName('skyhaven-claims'));
      const response = await queue.fetch('https://queue/website-claim', {
        method: 'POST',
        headers: {
          'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || 'unknown',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ playerName })
      });
      return new Response(response.body, {
        status: response.status,
        headers: { ...corsHeaders, 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    if (!env.CLAIM_SECRET || request.headers.get('Authorization') !== `Bearer ${env.CLAIM_SECRET}`) {
      return jsonResponse({ ok: false, message: 'Unauthorized.' }, 401, corsHeaders);
    }

    const queue = env.CLAIMS.get(env.CLAIMS.idFromName('skyhaven-claims'));
    if (url.pathname === '/claim' && request.method === 'GET') {
      return queue.fetch('https://queue/next');
    }

    if (url.pathname === '/ack' && request.method === 'POST') {
      return queue.fetch('https://queue/ack', { method: 'POST', body: request.body });
    }

    if (url.pathname === '/defer' && request.method === 'POST') {
      return queue.fetch('https://queue/defer', { method: 'POST', body: request.body });
    }

    return jsonResponse({ ok: false, message: 'Not found.' }, 404, corsHeaders);
  }
};

export class ClaimsQueue {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/website-claim' && request.method === 'POST') {
      const { playerName } = await request.json();
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const now = Date.now();
      const result = await this.state.storage.transaction(async (transaction) => {
        const queue = await transaction.get('queue') || [];
        const rateKey = `rate:${ip}`;
        const recentRequests = (await transaction.get(rateKey) || []).filter((timestamp) => now - timestamp < 60_000);

        if (recentRequests.length >= 5) {
          return { status: 429, data: { ok: false, message: 'Zu viele Versuche. Bitte warte eine Minute.' } };
        }
        recentRequests.push(now);
        await transaction.put(rateKey, recentRequests);

        if (queue.some((claim) => claim.playerName.toLowerCase() === playerName.toLowerCase())) {
          return { status: 409, data: { ok: false, message: 'Für diesen Namen ist bereits eine Anfrage offen.' } };
        }
        if (queue.length >= 1000) {
          return { status: 503, data: { ok: false, message: 'Die Bonus-Warteschlange ist gerade voll.' } };
        }

        queue.push({
          id: crypto.randomUUID(),
          playerName,
          amount: 50000,
          createdAt: now,
          availableAt: now
        });
        await transaction.put('queue', queue);
        return { status: 202, data: { ok: true, queued: true, playerName, amount: 50000 } };
      });

      return jsonResponse(result.data, result.status);
    }

    if (url.pathname === '/next' && request.method === 'GET') {
      const queue = await this.state.storage.get('queue') || [];
      const claim = queue.find((entry) => entry.availableAt <= Date.now());
      return jsonResponse(claim
        ? { ok: true, queued: true, claimId: claim.id, playerName: claim.playerName, amount: claim.amount }
        : { ok: true, queued: false });
    }

    if ((url.pathname === '/ack' || url.pathname === '/defer') && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, message: 'Invalid JSON body.' }, 400);
      }
      if (typeof body.claimId !== 'string') {
        return jsonResponse({ ok: false, message: 'Missing claim ID.' }, 400);
      }

      const updated = await this.state.storage.transaction(async (transaction) => {
        const queue = await transaction.get('queue') || [];
        const index = queue.findIndex((entry) => entry.id === body.claimId);
        if (index === -1) {
          return false;
        }
        if (url.pathname === '/ack') {
          queue.splice(index, 1);
        } else {
          const retrySeconds = Number.isInteger(body.retryAfterSeconds)
            ? Math.max(30, Math.min(body.retryAfterSeconds, 3600))
            : 60;
          queue[index].availableAt = Date.now() + retrySeconds * 1000;
        }
        await transaction.put('queue', queue);
        return true;
      });

      return jsonResponse({ ok: true, updated });
    }

    return jsonResponse({ ok: false, message: 'Not found.' }, 404);
  }
}
