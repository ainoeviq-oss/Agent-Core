const FIXED_TUNNEL_ID = 'tunnel_6a90a177b2b88191aea826a10ed4ba58';
const PUBLIC_RUNTIME_KEY = 'codespace_public_v1_6a90a177b2b88191';
const OPENAI_ORIGIN = 'https://api.openai.com';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function allowedRoute(method, pathname) {
  const base = `/v1/tunnels/${FIXED_TUNNEL_ID}`;
  return (
    (method === 'GET' && pathname === base) ||
    (method === 'POST' && pathname === `${base}/poll`) ||
    (method === 'POST' && pathname === `${base}/response`)
  );
}

function publicKeyAccepted(request) {
  return request.headers.get('authorization') === `Bearer ${PUBLIC_RUNTIME_KEY}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json(200, {
        status: 'ok',
        service: 'codespace-control-plane',
        tunnel_id: FIXED_TUNNEL_ID,
        runtime_secret_configured: Boolean(env?.OPENAI_TUNNEL_RUNTIME_KEY),
      });
    }

    if (!allowedRoute(request.method, url.pathname)) {
      return json(404, { error: 'not_found' });
    }

    if (!publicKeyAccepted(request)) {
      return json(401, { error: 'unauthorized' });
    }

    const runtimeKey = env?.OPENAI_TUNNEL_RUNTIME_KEY;
    if (typeof runtimeKey !== 'string' || runtimeKey.length === 0) {
      return json(503, { error: 'runtime_secret_unavailable' });
    }

    const upstreamUrl = new URL(url.pathname + url.search, OPENAI_ORIGIN);
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${runtimeKey}`);
    headers.set('accept-encoding', 'identity');
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');
    headers.delete('cf-ray');
    headers.delete('x-forwarded-for');
    headers.delete('x-forwarded-proto');

    const upstream = await fetch(new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    }));

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set('cache-control', 'no-store');
    responseHeaders.set('x-codespace-control-plane', 'fixed-tunnel-proxy');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};
