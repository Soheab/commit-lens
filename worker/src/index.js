// Thin proxy for GitHub's OAuth Device Flow token endpoints, holding the
// GitHub App's client_secret so it never has to live in the extension source.
// Stateless: every request is forwarded to GitHub and the response passed
// back through, nothing is stored or logged.

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
}

async function proxy(url, body, env) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET })
  });
  const data = await res.text();
  return new Response(data, {
    status: res.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) }
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(env) });
    }

    if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
      return new Response(JSON.stringify({ error: 'server_misconfigured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    if (pathname === '/device-code') {
      return proxy(DEVICE_CODE_URL, { scope: body.scope || '' }, env);
    }

    if (pathname === '/token') {
      // Only forward the fields the caller actually needs to pass; client_id
      // and client_secret are injected server-side, never accepted from the
      // caller, so a compromised extension can't be tricked into leaking
      // requests to a different app's credentials.
      const allowed = ['grant_type', 'device_code', 'refresh_token'];
      const forwarded = {};
      for (const key of allowed) {
        if (body[key] != null) forwarded[key] = body[key];
      }
      return proxy(TOKEN_URL, forwarded, env);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders(env) });
  }
};
