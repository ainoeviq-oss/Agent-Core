const OAUTH_METADATA_PATHS = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]);

function resolveBackendUrl(env) {
  const raw = typeof env?.BACKEND_URL === 'string' ? env.BACKEND_URL.trim() : '';
  if (!raw) throw new Error('GATEWAY_BACKEND_UNCONFIGURED');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('GATEWAY_BACKEND_INVALID');
  }

  const allowed = url.protocol === 'https:'
    && url.hostname.endsWith('.app.github.dev')
    && !url.username
    && !url.password
    && !url.port
    && (url.pathname === '/' || url.pathname === '')
    && !url.search
    && !url.hash;
  if (!allowed) throw new Error('GATEWAY_BACKEND_INVALID');
  return url.origin;
}

function withGatewayHeaders(headers, backend) {
  const output = new Headers(headers);
  output.set('x-agent-core-gateway', 'cloudflare-worker');
  output.set('x-agent-core-backend-host', new URL(backend).hostname);
  return output;
}

async function proxy(request, env) {
  const incoming = new URL(request.url);
  const gateway = incoming.origin;
  const backend = resolveBackendUrl(env);
  const target = new URL(incoming.pathname + incoming.search, backend);
  const upstream = await fetch(new Request(target, request));
  const headers = withGatewayHeaders(upstream.headers, backend);

  const challenge = headers.get('www-authenticate');
  if (challenge) {
    headers.set('www-authenticate', challenge.replaceAll(backend, gateway));
  }

  if (OAUTH_METADATA_PATHS.has(incoming.pathname)) {
    const data = await upstream.json();
    if (incoming.pathname === '/.well-known/oauth-authorization-server') {
      data.issuer = gateway;
      data.authorization_endpoint = `${gateway}/oauth/authorize`;
      data.token_endpoint = `${gateway}/oauth/token`;
      data.registration_endpoint = `${gateway}/oauth/register`;
    } else {
      data.resource = `${gateway}/mcp`;
      data.authorization_servers = [gateway];
    }
    headers.delete('content-length');
    return new Response(JSON.stringify(data), { status: upstream.status, headers });
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request, env) {
    try {
      return await proxy(request, env);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'GATEWAY_ERROR';
      const status = code === 'GATEWAY_BACKEND_UNCONFIGURED' || code === 'GATEWAY_BACKEND_INVALID' ? 503 : 502;
      return Response.json({ error: 'gateway_unavailable', code }, {
        status,
        headers: {
          'cache-control': 'no-store',
          'x-agent-core-gateway': 'cloudflare-worker',
        },
      });
    }
  },
};
