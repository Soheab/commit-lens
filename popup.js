const BUILTIN_CLIENT_ID = 'Iv23liG7GALSPsp8xMrv';

const DEFAULT_SETTINGS = {
  showFilesChanged: true,
  showAdditions: true,
  showDeletions: true,
  showDiffBar: true,
  showVerified: true,
  showMergeIndicator: true,
  showCommentCount: true,
  showFileTooltip: true,
  showAvatar: true,
  showCommitTime: true,
  showSha: true,
  showCopyButton: true,
  showBrowseButton: true,
  useCustomCommitLine: false,
  commitLineTemplate: '{AVATAR} {AUTHOR} committed {TIMESTAMP}',
  formatNumbers: true,
  compactRows: false,
  showCommitCount: true,
  token: '',
  clientId: '',
  workerUrl: ''
};

const checkboxIds = [
  'showFilesChanged',
  'showAdditions',
  'showDeletions',
  'showDiffBar',
  'showVerified',
  'showMergeIndicator',
  'showCommentCount',
  'showFileTooltip',
  'formatNumbers',
  'showAvatar',
  'showCommitTime',
  'showSha',
  'showCopyButton',
  'showBrowseButton',
  'useCustomCommitLine',
  'compactRows',
  'showCommitCount'
];

const statusEl = document.getElementById('status');
const authStatusEl = document.getElementById('authStatus');
const signInBtn = document.getElementById('signInBtn');
const signOutBtn = document.getElementById('signOutBtn');
const cancelBtn = document.getElementById('cancelBtn');
const clientIdInput = document.getElementById('clientId');
const workerUrlInput = document.getElementById('workerUrl');
const tokenInput = document.getElementById('token');
const templateInput = document.getElementById('commitLineTemplate');

let statusTimer = null;
function flashStatus(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = ''), 1200);
}

function renderAuth({ token, clientId, flow }) {
  clientIdInput.value = clientId || '';

  authStatusEl.className = '';
  authStatusEl.innerHTML = '';

  if (flow && flow.status === 'pending') {
    signInBtn.style.display = 'none';
    signOutBtn.style.display = 'none';
    cancelBtn.style.display = 'block';
    authStatusEl.className = 'pending';
    const codeUrl = flow.verificationUriComplete || flow.verificationUri;
    authStatusEl.innerHTML = `Waiting for authorization…<div class="user-code" id="userCode">${flow.userCode}</div>Enter this code at <a href="${codeUrl}" target="_blank" rel="noopener">github.com/login/device</a> (a tab should already be open).`;
    return;
  }

  if (flow && flow.status === 'error') {
    signInBtn.style.display = 'block';
    signOutBtn.style.display = token ? 'block' : 'none';
    cancelBtn.style.display = 'none';
    authStatusEl.className = 'error';
    authStatusEl.textContent = flow.message || 'Sign-in failed.';
  } else if (token) {
    signInBtn.style.display = 'none';
    signOutBtn.style.display = 'block';
    cancelBtn.style.display = 'none';
    authStatusEl.className = 'success';
    authStatusEl.textContent = '✓ Signed in with GitHub';
  } else {
    signInBtn.style.display = 'block';
    signOutBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
  }

  signInBtn.disabled = false;
  signInBtn.title = '';
}

function refreshAuthUI() {
  chrome.storage.local.get(['token', 'clientId', 'ghcd_deviceFlow'], (stored) => {
    renderAuth({ token: stored.token, clientId: stored.clientId, flow: stored.ghcd_deviceFlow });
  });
}

chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  checkboxIds.forEach((id) => {
    document.getElementById(id).checked = settings[id];
  });
  tokenInput.value = settings.token || '';
  workerUrlInput.value = settings.workerUrl || '';
  templateInput.value = settings.commitLineTemplate || DEFAULT_SETTINGS.commitLineTemplate;
});
refreshAuthUI();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('ghcd_deviceFlow' in changes || 'token' in changes || 'clientId' in changes) {
    refreshAuthUI();
  }
  if ('token' in changes) {
    tokenInput.value = changes.token.newValue || '';
  }
  if ('commitLineTemplate' in changes && document.activeElement !== templateInput) {
    templateInput.value = changes.commitLineTemplate.newValue || DEFAULT_SETTINGS.commitLineTemplate;
  }
});

checkboxIds.forEach((id) => {
  document.getElementById(id).addEventListener('change', (e) => {
    chrome.storage.local.set({ [id]: e.target.checked }, () => flashStatus('Saved'));
  });
});

let tokenSaveTimer = null;
tokenInput.addEventListener('input', () => {
  clearTimeout(tokenSaveTimer);
  tokenSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ token: tokenInput.value.trim() }, () => flashStatus('Saved'));
  }, 400);
});

let templateSaveTimer = null;
templateInput.addEventListener('input', () => {
  clearTimeout(templateSaveTimer);
  templateSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ commitLineTemplate: templateInput.value }, () => flashStatus('Saved'));
  }, 400);
});

let clientIdSaveTimer = null;
clientIdInput.addEventListener('input', () => {
  clearTimeout(clientIdSaveTimer);
  clientIdSaveTimer = setTimeout(() => {
    const clientId = clientIdInput.value.trim();
    chrome.storage.local.set({ clientId }, () => {
      flashStatus('Saved');
      refreshAuthUI();
    });
  }, 400);
});

let workerUrlSaveTimer = null;
workerUrlInput.addEventListener('input', () => {
  clearTimeout(workerUrlSaveTimer);
  workerUrlSaveTimer = setTimeout(() => {
    const workerUrl = workerUrlInput.value.trim();
    chrome.storage.local.set({ workerUrl }, () => flashStatus('Saved'));
  }, 400);
});

signInBtn.addEventListener('click', () => {
  const clientId = clientIdInput.value.trim() || BUILTIN_CLIENT_ID;
  signInBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'GHCD_START_DEVICE_FLOW', clientId }, (res) => {
    signInBtn.disabled = false;
    if (!res || !res.ok) {
      authStatusEl.className = 'error';
      authStatusEl.textContent = (res && res.error) || 'Could not start sign-in.';
      return;
    }
    refreshAuthUI();
  });
});

cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GHCD_CANCEL_DEVICE_FLOW' }, () => refreshAuthUI());
});

signOutBtn.addEventListener('click', () => {
  chrome.storage.local.set({ token: '', ghcd_deviceFlow: null }, () => refreshAuthUI());
});

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'userCode') {
    navigator.clipboard.writeText(e.target.textContent.trim()).then(() => flashStatus('Code copied'));
  }
});
