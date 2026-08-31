# GitHub Commit Details, OAuth Worker

A minimal Cloudflare Worker that proxies GitHub's OAuth Device Flow token
endpoints (`/login/device/code` and `/login/oauth/access_token`), injecting the
GitHub App's `client_secret` server-side.

This is what makes **token refresh** possible. GitHub requires `client_secret`
for every token exchange with a GitHub App, including refreshes, and that value
can't safely live in the unpacked extension source. This Worker is the only
place it's kept. There's no KV and no logging of tokens or secrets; each request
is simply forwarded to GitHub and the response passed straight back.

This is optional. Without it, the extension's device-flow sign-in still works
exactly as before (a direct browser-to-github.com exchange). It just can't renew
an access token before it lapses, so it will drop back to unauthenticated
requests every ~8 hours instead.

## Deploy your own

1. **Create a GitHub App** (or use the extension's built-in one, if you have
   access to it) at https://github.com/settings/apps. Enable **Device Flow**.
   Under **Generate a new client secret**, create one and copy it; you'll only
   see it once.
2. **Note the extension ID**: open `chrome://extensions`, turn on Developer
   mode, and copy the ID shown on the extension's card.
3. Edit `wrangler.toml`:
   - `CLIENT_ID`: the GitHub App's Client ID (not secret).
   - `ALLOWED_ORIGIN`: `chrome-extension://<your-extension-id>` from step 2.
4. Log in and set the secret:
   ```
   npx wrangler login
   npx wrangler secret put CLIENT_SECRET
   ```
   Paste the client secret from step 1 when prompted.
5. Deploy:
   ```
   npx wrangler deploy
   ```
   This prints a `*.workers.dev` URL.
6. In the extension's popup (or in-page panel), expand **Using a different
   GitHub App** and paste that URL into **Worker URL**.

## Local development

```
npx wrangler dev
```

Then exercise it manually, for example:

```
curl -X POST http://localhost:8787/device-code -H "Content-Type: application/json" -d "{}"
```

## Endpoints

- `POST /device-code`: proxies the initial device-code request.
- `POST /token`: proxies both the device-code-to-token exchange
  (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) and refreshes
  (`grant_type=refresh_token`). Only `grant_type`, `device_code`, and
  `refresh_token` are forwarded from the caller. `client_id` and
  `client_secret` are always injected server-side and never accepted from the
  request body.
