// GitHub OAuth Device Flow, run entirely client-side.
// host_permissions for github.com exempts extension-page fetches (this
// service worker) from CORS, which lets us call these endpoints directly
// with no backend and no client secret.
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const ALARM_NAME = 'ghcd-device-flow-poll';

async function startDeviceFlow(clientId) {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: '' })
  });
  const data = await res.json();
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
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: minutes });
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
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: flow.clientId,
        device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    });
    const data = await res.json();

    if (data.access_token) {
      await chrome.storage.local.set({
        token: data.access_token,
        ghcd_deviceFlow: { status: 'success' }
      });
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollDeviceFlow();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GHCD_START_DEVICE_FLOW') {
    startDeviceFlow(msg.clientId)
      .then((flow) => sendResponse({ ok: true, flow }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === 'GHCD_CANCEL_DEVICE_FLOW') {
    chrome.alarms.clear(ALARM_NAME);
    chrome.storage.local.remove('ghcd_deviceFlow').then(() => sendResponse({ ok: true }));
    return true;
  }
});

// If the service worker was killed mid-flow and just woke back up, resume
// polling instead of leaving it stuck until the next alarm (which may have
// been lost along with the worker).
chrome.storage.local.get('ghcd_deviceFlow').then(({ ghcd_deviceFlow: flow }) => {
  if (flow && flow.status === 'pending' && Date.now() < flow.expiresAt) {
    schedulePoll(flow.interval);
  }
});
