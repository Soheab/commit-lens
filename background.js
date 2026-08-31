// GitHub OAuth Device Flow.
//
// Without a Worker URL configured, this runs entirely client-side: host_permissions
// for github.com exempts extension-page fetches (this service worker) from CORS,
// letting us call GitHub's endpoints directly with no backend and no client secret.
// That path can't refresh an expiring token, since GitHub requires client_secret
// for every token exchange (including refreshes) with a GitHub App.
//
// With a Worker URL configured (see worker/README.md), requests go through that
// proxy instead, which injects the secret server-side. That unlocks silent token
// refresh via a second alarm, scheduled shortly before the access token expires.
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const POLL_ALARM = 'ghcd-device-flow-poll';
const REFRESH_ALARM = 'ghcd-token-refresh';
const REFRESH_LEAD_SECONDS = 300; // refresh 5 minutes before expiry

async function getWorkerUrl() {
  const { workerUrl } = await chrome.storage.local.get('workerUrl');
  return workerUrl ? workerUrl.replace(/\/+$/, '') : '';
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { res, data };
}

async function requestDeviceCode(clientId, workerUrl) {
  if (workerUrl) return postJson(`${workerUrl}/device-code`, { scope: '' });
  return postJson(DEVICE_CODE_URL, { client_id: clientId, scope: '' });
}

async function exchangeToken(body, clientId, workerUrl) {
  if (workerUrl) return postJson(`${workerUrl}/token`, body);
  return postJson(TOKEN_URL, { ...body, client_id: clientId });
}

async function startDeviceFlow(clientId) {
  const workerUrl = await getWorkerUrl();
  const { res, data } = await requestDeviceCode(clientId, workerUrl);
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || `Request failed (${res.status})`);
  }

  const flow = {
    status: 'pending',
    clientId,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete || null,
    interval: data.interval || 5,
    expiresAt: Date.now() + (data.expires_in || 900) * 1000
  };
  await chrome.storage.local.set({ ghcd_deviceFlow: flow });

  chrome.tabs.create({ url: flow.verificationUriComplete || flow.verificationUri });
  schedulePoll(flow.interval);

  return flow;
}

// Alarms below 1 minute are clamped in packed extensions, but Chrome allows
// them for unpacked/dev extensions (which is how this is loaded), so we can
// poll at roughly GitHub's own suggested cadence instead of once a minute.
function schedulePoll(intervalSeconds) {
  const minutes = Math.max(intervalSeconds, 5) / 60;
  chrome.alarms.create(POLL_ALARM, { delayInMinutes: minutes });
}

function storeTokenResult(data) {
  const stored = { token: data.access_token };
  if (data.refresh_token) {
    stored.refreshToken = data.refresh_token;
    stored.refreshTokenExpiresAt = data.refresh_token_expires_in
      ? Date.now() + data.refresh_token_expires_in * 1000
      : null;
  }
  if (data.expires_in) {
    stored.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  } else {
    stored.accessTokenExpiresAt = null;
  }
  return chrome.storage.local.set(stored).then(() => {
    if (stored.accessTokenExpiresAt) scheduleRefresh(stored.accessTokenExpiresAt);
    else chrome.alarms.clear(REFRESH_ALARM);
  });
}

async function pollDeviceFlow() {
  const { ghcd_deviceFlow: flow } = await chrome.storage.local.get('ghcd_deviceFlow');
  if (!flow || flow.status !== 'pending') return;

  if (Date.now() > flow.expiresAt) {
    await chrome.storage.local.set({
      ghcd_deviceFlow: { status: 'error', message: 'Code expired, click Sign in again.' }
    });
    return;
  }

  try {
    const workerUrl = await getWorkerUrl();
    const { data } = await exchangeToken(
      {
        device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      },
      flow.clientId,
      workerUrl
    );

    if (data.access_token) {
      await storeTokenResult(data);
      await chrome.storage.local.set({ ghcd_deviceFlow: { status: 'success' } });
      return;
    }

    if (data.error === 'authorization_pending') {
      schedulePoll(flow.interval);
      return;
    }
    if (data.error === 'slow_down') {
      const nextInterval = (data.interval || flow.interval) + 5;
      await chrome.storage.local.set({ ghcd_deviceFlow: { ...flow, interval: nextInterval } });
      schedulePoll(nextInterval);
      return;
    }

    // expired_token, access_denied, incorrect_client_credentials, etc.
    await chrome.storage.local.set({
      ghcd_deviceFlow: {
        status: 'error',
        message: data.error_description || data.error || 'Authorization failed.'
      }
    });
  } catch (e) {
    // Transient network error, retry on the normal cadence rather than giving up.
    schedulePoll(flow.interval);
  }
}

function scheduleRefresh(accessTokenExpiresAt) {
  const fireAt = accessTokenExpiresAt - REFRESH_LEAD_SECONDS * 1000;
  chrome.alarms.create(REFRESH_ALARM, { when: Math.max(fireAt, Date.now() + 1000) });
}

async function refreshAccessToken() {
  const { refreshToken, clientId } = await chrome.storage.local.get(['refreshToken', 'clientId']);
  const workerUrl = await getWorkerUrl();

  // Refreshing requires client_secret, which only the Worker path has. Without
  // a Worker configured there's nothing to do here; content.js's 401 handling
  // covers the token simply expiring in that case.
  if (!refreshToken || !workerUrl) return;

  try {
    const { data } = await exchangeToken(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      clientId,
      workerUrl
    );

    if (data.access_token) {
      await storeTokenResult(data);
      return;
    }

    // Refresh token itself expired/revoked: drop everything and let the user
    // sign in again next time they notice stats are unauthenticated.
    await chrome.storage.local.remove(['token', 'refreshToken', 'refreshTokenExpiresAt', 'accessTokenExpiresAt']);
  } catch (e) {
    // Transient network error: try again on the normal poll-free cadence by
    // retrying shortly rather than leaving the token to expire silently.
    chrome.alarms.create(REFRESH_ALARM, { delayInMinutes: 1 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) pollDeviceFlow();
  if (alarm.name === REFRESH_ALARM) refreshAccessToken();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GHCD_START_DEVICE_FLOW') {
    startDeviceFlow(msg.clientId)
      .then((flow) => sendResponse({ ok: true, flow }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === 'GHCD_CANCEL_DEVICE_FLOW') {
    chrome.alarms.clear(POLL_ALARM);
    chrome.storage.local.remove('ghcd_deviceFlow').then(() => sendResponse({ ok: true }));
    return true;
  }
});

// If the service worker was killed mid-flow and just woke back up, resume
// polling instead of leaving it stuck until the next alarm (which may have
// been lost along with the worker). Same for a pending token refresh.
chrome.storage.local.get(['ghcd_deviceFlow', 'accessTokenExpiresAt', 'refreshToken']).then((stored) => {
  const { ghcd_deviceFlow: flow, accessTokenExpiresAt, refreshToken } = stored;
  if (flow && flow.status === 'pending' && Date.now() < flow.expiresAt) {
    schedulePoll(flow.interval);
  }
  if (refreshToken && accessTokenExpiresAt) {
    scheduleRefresh(accessTokenExpiresAt);
  }
});
