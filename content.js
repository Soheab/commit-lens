(function () {
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
    compactRows: false,
    showCommitCount: true,
    useCustomCommitLine: false,
    commitLineTemplate: '{AVATAR} {AUTHOR} committed {TIMESTAMP}',
    formatNumbers: true,
    token: '',
    workerUrl: ''
  };

  let settings = { ...DEFAULT_SETTINGS };
  const statsCache = new Map(); // "owner/repo@sha" -> Promise<stats>
  const rowInfo = new WeakMap(); // li -> { info, badge, domValues, attributionRow, customLineEl }

  // ---------------------------------------------------------------------
  // Lightweight in-memory log, surfaced in the panel's Logs section so
  // "stats unavailable" is debuggable without opening devtools.
  // ---------------------------------------------------------------------
  const LOG_LIMIT = 200;
  const logs = [];
  let logListeners = [];

  function addLog(level, message, detail) {
    logs.push({ time: Date.now(), level, message, detail: detail || null });
    if (logs.length > LOG_LIMIT) logs.shift();
    logListeners.forEach((fn) => fn());
  }
  const log = {
    info: (msg, detail) => addLog('info', msg, detail),
    warn: (msg, detail) => addLog('warn', msg, detail),
    error: (msg, detail) => addLog('error', msg, detail),
    request: (msg, detail) => addLog('request', msg, detail)
  };

  function applyToggleClasses() {
    const cl = document.documentElement.classList;
    cl.toggle('ghcd-hide-avatar', !settings.showAvatar);
    cl.toggle('ghcd-hide-time', !settings.showCommitTime);
    cl.toggle('ghcd-hide-sha', !settings.showSha);
    cl.toggle('ghcd-hide-copy', !settings.showCopyButton);
    cl.toggle('ghcd-hide-browse', !settings.showBrowseButton);
    cl.toggle('ghcd-hide-attribution', !!settings.useCustomCommitLine || !!settings.compactRows);
    cl.toggle('ghcd-compact', !!settings.compactRows);
  }

  function loadSettings(cb) {
    chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
      settings = { ...DEFAULT_SETTINGS, ...stored };
      applyToggleClasses();
      cb && cb();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let changed = false;
    for (const key in changes) {
      if (key in settings) {
        settings[key] = changes[key].newValue;
        changed = true;
      }
    }
    if (changed) {
      applyToggleClasses();
      refreshAllBadges();
      refreshAllCustomLines();
      refreshAllCompactLines();
      refreshPanelToggles();
    }
    if ('token' in changes || 'clientId' in changes || 'ghcd_deviceFlow' in changes) {
      refreshPanelAuth();
    }
  });

  function parseRow(li) {
    const link = li.getAttribute('data-commit-link');
    if (!link) return null;
    const m = link.match(/^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]+)/i);
    if (!m) return null;
    return { owner: m[1], repo: m[2], sha: m[3] };
  }

  async function requestCommit(owner, repo, sha, useToken) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`;
    const headers = { Accept: 'application/vnd.github+json' };
    if (useToken && settings.token) headers.Authorization = `Bearer ${settings.token}`;
    log.request(`GET ${owner}/${repo}@${sha.slice(0, 7)} (${useToken && settings.token ? 'authed' : 'unauthed'})`, { url });
    const res = await fetch(url, { headers });
    log.request(`← ${res.status} ${owner}/${repo}@${sha.slice(0, 7)}`, {
      status: res.status,
      remaining: res.headers.get('x-ratelimit-remaining'),
      limit: res.headers.get('x-ratelimit-limit'),
      reset: res.headers.get('x-ratelimit-reset')
    });
    return res;
  }

  function fetchStats(owner, repo, sha) {
    const key = `${owner}/${repo}@${sha}`;
    if (statsCache.has(key)) return statsCache.get(key);
    const p = (async () => {
      let res = await requestCommit(owner, repo, sha, true);

      if (res.status === 401 && settings.token) {
        log.warn('Token rejected (401), clearing it and retrying unauthenticated', { owner, repo, sha });
        settings.token = '';
        chrome.storage.local.set({ token: '' });
        res = await requestCommit(owner, repo, sha, false);
      }

      if (!res.ok) {
        if (res.status === 403 || res.status === 429) {
          const msg = 'Rate limited (add a token in the extension popup)';
          log.error(msg, { owner, repo, sha, status: res.status });
          throw new Error(msg);
        }
        if (res.status === 404 && settings.token) {
          showPanelAuthWarning('Your token may be expired or missing access to this repo (GitHub returns 404 for private repos when auth fails). Try signing in again.');
        }
        const msg = `GitHub API ${res.status}`;
        log.error(msg, { owner, repo, sha });
        throw new Error(msg);
      }
      if (res.status === 200 && settings.token && panelAuthWarning) {
        panelAuthWarning = null;
        refreshPanelAuth();
      }
      const data = await res.json();
      return {
        files: Array.isArray(data.files) ? data.files.length : null,
        additions: data.stats ? data.stats.additions : null,
        deletions: data.stats ? data.stats.deletions : null,
        verified: data.commit?.verification?.verified ?? null,
        verificationReason: data.commit?.verification?.reason ?? null,
        commentCount: data.commit?.comment_count ?? null,
        isMerge: Array.isArray(data.parents) && data.parents.length > 1,
        fileNames: Array.isArray(data.files) ? data.files.map((f) => f.filename) : []
      };
    })();
    statsCache.set(key, p);
    return p;
  }

  function makeBadge() {
    const el = document.createElement('div');
    el.className = 'ghcd-badge';
    el.textContent = 'Loading stats…';
    return el;
  }

  // GitHub lays out each row with CSS grid (hashed module classnames), so we
  // locate the metadata cell by its computed grid-area rather than a class name.
  function findMetadataContainer(li) {
    return Array.from(li.children).find((c) =>
      getComputedStyle(c).gridArea.replace(/\s/g, '').startsWith('metadata')
    );
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatNumber(n) {
    return settings.formatNumbers ? n.toLocaleString('en-US') : String(n);
  }

  function makeDiffBar(additions, deletions) {
    const total = additions + deletions;
    if (total <= 0) return '';
    const addPct = Math.max((additions / total) * 100, additions > 0 ? 8 : 0);
    const delPct = Math.max((deletions / total) * 100, deletions > 0 ? 8 : 0);
    return `<span class="ghcd-diffbar" title="+${additions} -${deletions}"><span class="ghcd-diffbar-add" style="width:${addPct}%"></span><span class="ghcd-diffbar-del" style="width:${delPct}%"></span></span>`;
  }

  function renderStats(el, stats) {
    if (!stats) {
      el.innerHTML = '';
      el.classList.add('ghcd-badge--empty');
      return;
    }
    const parts = [];

    if (settings.showMergeIndicator && stats.isMerge) {
      parts.push(`<span class="ghcd-merge" title="Merge commit">⑂ Merge</span>`);
    }
    if (settings.showVerified && stats.verified) {
      parts.push(`<span class="ghcd-verified" title="Signature verified (${escapeHtml(stats.verificationReason || 'valid')})">✓ Verified</span>`);
    }
    if (settings.showFilesChanged && stats.files != null) {
      parts.push(`<span class="ghcd-files">${formatNumber(stats.files)} file${stats.files === 1 ? '' : 's'} changed</span>`);
    }
    if (settings.showAdditions && stats.additions != null) {
      parts.push(`<span class="ghcd-additions">+${formatNumber(stats.additions)}</span>`);
    }
    if (settings.showDeletions && stats.deletions != null) {
      parts.push(`<span class="ghcd-deletions">-${formatNumber(stats.deletions)}</span>`);
    }
    if (settings.showDiffBar && stats.additions != null && stats.deletions != null) {
      parts.push(makeDiffBar(stats.additions, stats.deletions));
    }
    if (settings.showCommentCount && stats.commentCount) {
      parts.push(`<span class="ghcd-comments" title="${stats.commentCount} commit comment${stats.commentCount === 1 ? '' : 's'}">💬 ${formatNumber(stats.commentCount)}</span>`);
    }

    el.innerHTML = parts.join('');
    el.classList.toggle('ghcd-badge--empty', parts.length === 0);
    el.classList.remove('ghcd-badge--error');

    if (settings.showFileTooltip && stats.fileNames.length) {
      const shown = stats.fileNames.slice(0, 20);
      const extra = stats.fileNames.length - shown.length;
      el.title = shown.join('\n') + (extra > 0 ? `\n… and ${extra} more` : '');
    } else {
      el.removeAttribute('title');
    }
  }

  // Reads what's already on the page (avatar, author, message, timestamp)
  // before anything gets hidden, so {PLACEHOLDER}s work even once the
  // native attribution row is hidden by useCustomCommitLine.
  function readDomValues(li, info) {
    // GitHub renders two different shapes depending on author count: a
    // single author uses [data-testid="author-avatar"] (one avatar + name
    // link together); co-authored commits use an AvatarStack plus one
    // [data-testid="author-link"] div per author instead.
    const avatarImg = li.querySelector('[data-testid="commit-stack-avatar"], [data-testid="author-avatar"] img');
    const authorLinks = Array.from(
      li.querySelectorAll('[data-testid="author-avatar"] a[aria-label^="commits by"], [data-testid="author-link"] a[aria-label^="commits by"]')
    );
    const authors = authorLinks
      .map((a) => a.getAttribute('aria-label').replace(/^commits by\s*/i, '').trim())
      .filter(Boolean);
    const relTime = li.querySelector('relative-time');
    const messageLink = li.querySelector('h4 a[href*="/commit/"]');
    // The link's title/text can be the full multi-line commit message; only
    // the first line (the summary) belongs in a single-line display.
    const fullMessage = messageLink ? messageLink.getAttribute('title') || messageLink.textContent.trim() : '';
    return {
      AVATAR: avatarImg ? avatarImg.src : '',
      AUTHOR: authors[0] || '',
      AUTHOR_EXTRA_COUNT: Math.max(authors.length - 1, 0),
      TIMESTAMP_ISO: relTime ? relTime.getAttribute('datetime') || '' : '',
      DATE: relTime ? relTime.getAttribute('title') || '' : '',
      COMMIT_MESSAGE: fullMessage,
      COMMIT_MESSAGE_SUMMARY: fullMessage.split('\n')[0].trim(),
      SHA: info.sha.slice(0, 7),
      REPO: `${info.owner}/${info.repo}`
    };
  }

  // Timestamp formatting: {TIMESTAMP} or {TIMESTAMP:STYLE}, styles
  // t/T/d/D/f/F/s/S/R. Default style (no suffix) is R, relative.
  function formatRelativeTime(date) {
    const diffMs = date.getTime() - Date.now();
    const diffSec = Math.round(diffMs / 1000);
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    const thresholds = [
      ['year', 31536000],
      ['month', 2592000],
      ['week', 604800],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
      ['second', 1]
    ];
    for (const [unit, secs] of thresholds) {
      if (Math.abs(diffSec) >= secs || unit === 'second') {
        return rtf.format(Math.round(diffSec / secs), unit);
      }
    }
    return rtf.format(0, 'second');
  }

  function formatTimestamp(iso, style) {
    if (!iso) return '';
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';

    const shortTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
    const mediumTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date);
    const shortDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const longDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);

    switch (style) {
      case 't': return shortTime;
      case 'T': return mediumTime;
      case 'd': return shortDate;
      case 'D': return longDate;
      case 'f': return `${longDate} at ${shortTime}`;
      case 'F': return `${weekday}, ${longDate} at ${shortTime}`;
      case 's': return `${shortDate}, ${shortTime}`;
      case 'S': return `${shortDate}, ${mediumTime}`;
      case 'R':
      default:
        return formatRelativeTime(date);
    }
  }

  function renderTemplate(container, template, values) {
    container.innerHTML = '';
    const re = /\{(\w+)(?::([a-zA-Z]))?\}/g;
    let lastIndex = 0;
    let match;
    while ((match = re.exec(template))) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(template.slice(lastIndex, match.index)));
      }
      const key = match[1];
      const style = match[2];
      if (key === 'AVATAR' && values.AVATAR) {
        const img = document.createElement('img');
        img.src = values.AVATAR;
        img.alt = '';
        img.className = 'ghcd-custom-avatar';
        container.appendChild(img);
      } else if (key === 'TIMESTAMP') {
        container.appendChild(document.createTextNode(formatTimestamp(values.TIMESTAMP_ISO, style || 'R')));
      } else if (key in values) {
        container.appendChild(document.createTextNode(values[key]));
      } else {
        container.appendChild(document.createTextNode(match[0]));
      }
      lastIndex = re.lastIndex;
    }
    if (lastIndex < template.length) {
      container.appendChild(document.createTextNode(template.slice(lastIndex)));
    }
  }

  function applyCustomLine(li, entry, stats) {
    const attributionRow = entry.attributionRow;
    if (!attributionRow) return;

    if (!settings.useCustomCommitLine) {
      if (entry.customLineEl) {
        entry.customLineEl.remove();
        entry.customLineEl = null;
      }
      return;
    }

    if (!entry.customLineEl) {
      const el = document.createElement('div');
      el.className = 'ghcd-custom-line';
      attributionRow.insertAdjacentElement('afterend', el);
      entry.customLineEl = el;
    }

    const values = {
      ...entry.domValues,
      FILES_CHANGED: stats && stats.files != null ? formatNumber(stats.files) : '…',
      ADDITIONS: stats && stats.additions != null ? formatNumber(stats.additions) : '…',
      DELETIONS: stats && stats.deletions != null ? formatNumber(stats.deletions) : '…'
    };
    renderTemplate(entry.customLineEl, settings.commitLineTemplate || DEFAULT_SETTINGS.commitLineTemplate, values);
  }

  // Compact mode: GitHub's row is a CSS grid with the message, the author/
  // time attribution, and our stats badge in separate grid areas, so it
  // can't be squeezed onto one line by resizing text alone. Instead this
  // builds one purpose-built line (message — author — time) and hides the
  // native message/attribution elements, leaving the existing stats badge
  // (already placed in the metadata area) to sit alongside it.
  function applyCompactLine(li, entry) {
    const messageLink = li.querySelector('h4 a[href*="/commit/"]');
    if (!entry.compactLineEl) {
      if (!messageLink) return;
      const el = document.createElement('div');
      el.className = 'ghcd-compact-line';
      messageLink.closest('h4').insertAdjacentElement('afterend', el);
      entry.compactLineEl = el;
    }

    if (!settings.compactRows) {
      entry.compactLineEl.hidden = true;
      // Hand the badge back to its original grid cell.
      if (entry.badge && entry.badgeHome && entry.badge.parentElement !== entry.badgeHome) {
        entry.badgeHome.appendChild(entry.badge);
      }
      // Hand the show-description button back to its original spot.
      if (entry.descButton && entry.descButtonPlaceholder && entry.descButton.previousSibling !== entry.descButtonPlaceholder) {
        entry.descButtonPlaceholder.after(entry.descButton);
      }
      return;
    }
    entry.compactLineEl.hidden = false;

    const { COMMIT_MESSAGE, COMMIT_MESSAGE_SUMMARY, AUTHOR, AUTHOR_EXTRA_COUNT, TIMESTAMP_ISO } = entry.domValues;
    // The "show description" (…) button is a sibling of the message h4 in
    // GitHub's markup; move it (rather than clone it, so its click handler
    // keeps working) to the front of the compact line instead of leaving it
    // on its own row below the message.
    entry.compactLineEl.innerHTML = '';
    if (entry.descButton) {
      entry.compactLineEl.appendChild(entry.descButton);
    }
    const msg = document.createElement('span');
    msg.className = 'ghcd-compact-message';
    msg.textContent = COMMIT_MESSAGE_SUMMARY;
    msg.title = COMMIT_MESSAGE;
    entry.compactLineEl.appendChild(msg);
    if (AUTHOR) {
      const sep = document.createElement('span');
      sep.className = 'ghcd-compact-sep';
      sep.textContent = '—';
      entry.compactLineEl.appendChild(sep);
      const author = document.createElement('span');
      author.className = 'ghcd-compact-author';
      author.textContent = AUTHOR_EXTRA_COUNT > 0 ? `${AUTHOR} +${AUTHOR_EXTRA_COUNT}` : AUTHOR;
      entry.compactLineEl.appendChild(author);
    }
    const date = settings.showCommitTime && TIMESTAMP_ISO ? new Date(TIMESTAMP_ISO) : null;
    if (date && !isNaN(date.getTime())) {
      const sep = document.createElement('span');
      sep.className = 'ghcd-compact-sep';
      sep.textContent = '—';
      entry.compactLineEl.appendChild(sep);
      const time = document.createElement('span');
      time.className = 'ghcd-compact-time';
      time.textContent = formatRelativeTime(date);
      time.title = entry.domValues.DATE;
      entry.compactLineEl.appendChild(time);
    }
    // Pull the stats badge into this same flex line so message, author,
    // time, and stats are all genuinely on one row rather than relying on
    // GitHub's own (unknown, hashed) grid-area placement for the badge.
    if (entry.badge) {
      entry.compactLineEl.appendChild(entry.badge);
    }
  }

  function refreshAllCompactLines() {
    document.querySelectorAll('li[data-testid="commit-row-item"][data-ghcd-processed]').forEach((li) => {
      const entry = rowInfo.get(li);
      if (entry) applyCompactLine(li, entry);
    });
  }

  function refreshAllCustomLines() {
    document.querySelectorAll('li[data-testid="commit-row-item"][data-ghcd-processed]').forEach((li) => {
      const entry = rowInfo.get(li);
      if (!entry) return;
      const key = `${entry.info.owner}/${entry.info.repo}@${entry.info.sha}`;
      const cached = statsCache.get(key);
      if (cached && typeof cached.then === 'function') {
        cached.then((s) => applyCustomLine(li, entry, s)).catch(() => applyCustomLine(li, entry, null));
      } else {
        applyCustomLine(li, entry, null);
      }
    });
  }

  async function processRow(li) {
    li.removeAttribute('data-ghcd-queued');
    if (li.hasAttribute('data-ghcd-processed')) return;
    li.setAttribute('data-ghcd-processed', 'true');
    const info = parseRow(li);
    if (!info) return;
    const container = findMetadataContainer(li) || li;
    const badge = makeBadge();
    container.appendChild(badge);

    // Marks the show-description button's original spot so it can be moved
    // back there when compact mode is turned off.
    const descButton = li.querySelector('button[data-testid="commit-row-show-description-button"]');
    let descButtonPlaceholder = null;
    if (descButton) {
      descButtonPlaceholder = document.createComment('ghcd-desc-button-home');
      descButton.before(descButtonPlaceholder);
    }

    // The attribution block (avatar(s) + author name(s) + "committed" +
    // relative-time) has no stable data-testid of its own, but either
    // [data-testid="author-avatar"] (single author) or the first
    // [data-testid="author-link"] (co-authored) is a direct child of it.
    const attributionRow = li.querySelector('[data-testid="author-avatar"], [data-testid="author-link"]')?.parentElement || null;
    const domValues = readDomValues(li, info);
    const entry = {
      info,
      badge,
      badgeHome: container,
      domValues,
      attributionRow,
      customLineEl: null,
      compactLineEl: null,
      descButton,
      descButtonPlaceholder
    };
    rowInfo.set(li, entry);
    applyCustomLine(li, entry, null);
    applyCompactLine(li, entry);

    try {
      const stats = await fetchStats(info.owner, info.repo, info.sha);
      renderStats(badge, stats);
      applyCustomLine(li, entry, stats);
    } catch (e) {
      badge.textContent = 'Stats unavailable';
      badge.classList.add('ghcd-badge--error');
      badge.title = e.message;
      log.error(`Stats unavailable for ${info.owner}/${info.repo}@${info.sha.slice(0, 7)}: ${e.message}`);
    }
  }

  function refreshAllBadges() {
    document.querySelectorAll('li[data-testid="commit-row-item"][data-ghcd-processed]').forEach((li) => {
      const entry = rowInfo.get(li);
      if (!entry) return;
      const key = `${entry.info.owner}/${entry.info.repo}@${entry.info.sha}`;
      const cached = statsCache.get(key);
      if (cached && typeof cached.then === 'function') {
        cached.then((s) => renderStats(entry.badge, s)).catch(() => {});
      }
    });
  }

  function computeDayCounts() {
    const rows = document.querySelectorAll('li[data-testid="commit-row-item"]');
    const byDay = new Map(); // 'YYYY-MM-DD' -> count
    rows.forEach((li) => {
      const iso = li.querySelector('relative-time')?.getAttribute('datetime');
      if (!iso) return;
      const day = iso.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    });
    const days = Array.from(byDay.keys()).sort().reverse();
    return { total: rows.length, byDay, days };
  }

  function dayLabel(day) {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }

  // GitHub groups each day's commits under a heading like "Commits on Sep 12,
  // 2026". Matched by text content rather than a class name, since those are
  // hashed and change across deploys.
  function findDateHeadings() {
    return Array.from(document.querySelectorAll('h3, h2')).filter((h) =>
      /^Commits on /i.test(h.textContent.trim())
    );
  }

  let lastCountsSignature = null;

  function updateCommitCounts() {
    const countsEl = panelEl && panelEl.querySelector('#ghcd-p-counts');

    if (!settings.showCommitCount) {
      if (lastCountsSignature !== null) {
        document.querySelectorAll('.ghcd-day-count').forEach((el) => el.remove());
        lastCountsSignature = null;
      }
      if (countsEl) countsEl.innerHTML = '';
      return;
    }

    const { total, byDay, days } = computeDayCounts();

    // Skip touching the DOM entirely when nothing changed: adding/removing
    // the .ghcd-day-count chips is itself a mutation, and this runs from a
    // MutationObserver callback, so a no-op guard is required to avoid an
    // infinite scan -> mutate -> scan loop.
    const signature = `${total}|${days.map((d) => `${d}:${byDay.get(d)}`).join(',')}`;
    if (signature === lastCountsSignature) return;
    lastCountsSignature = signature;

    document.querySelectorAll('.ghcd-day-count').forEach((el) => el.remove());

    const headings = findDateHeadings();
    headings.forEach((heading) => {
      // Count rows between this heading and the next one (or end of list).
      let node = heading.nextElementSibling;
      let count = 0;
      while (node && !headings.includes(node)) {
        count += node.querySelectorAll('li[data-testid="commit-row-item"]').length;
        node = node.nextElementSibling;
      }
      if (count > 0) {
        const chip = document.createElement('span');
        chip.className = 'ghcd-day-count';
        chip.textContent = `${formatNumber(count)} commit${count === 1 ? '' : 's'}`;
        heading.appendChild(chip);
      }
    });

    if (countsEl) {
      const dayRows = days
        .map((day) => `<div class="ghcd-count-row"><span>${dayLabel(day)}</span><span>${formatNumber(byDay.get(day))}</span></div>`)
        .join('');
      countsEl.innerHTML = `
        <div class="ghcd-count-row ghcd-count-total"><span>Total shown</span><span>${formatNumber(total)}</span></div>
        ${dayRows}`;
    }
  }

  // Process new rows in small batches rather than firing every row's fetch
  // at once: a full commits page can have 50+ unprocessed rows on first
  // load, and that many concurrent requests at once is unnecessary load.
  const SCAN_BATCH_SIZE = 8;
  const SCAN_BATCH_DELAY_MS = 150;
  let scanQueue = [];
  let scanTimer = null;

  function runScanBatch() {
    scanTimer = null;
    const batch = scanQueue.splice(0, SCAN_BATCH_SIZE);
    batch.forEach(processRow);
    updateCommitCounts();
    if (scanQueue.length > 0) {
      scanTimer = setTimeout(runScanBatch, SCAN_BATCH_DELAY_MS);
    }
  }

  function scan() {
    const rows = document.querySelectorAll(
      'li[data-testid="commit-row-item"]:not([data-ghcd-processed]):not([data-ghcd-queued])'
    );
    if (rows.length === 0) {
      updateCommitCounts();
      return;
    }
    rows.forEach((li) => {
      li.setAttribute('data-ghcd-queued', 'true');
      scanQueue.push(li);
    });
    if (!scanTimer) runScanBatch();
  }

  // ---------------------------------------------------------------------
  // Draggable in-page settings panel. The toolbar popup closes the instant
  // you click elsewhere, which makes it awkward to compare toggles against
  // the page; this floating panel stays open and can be dragged clear of
  // the commit list. Closed by default on every load so it never covers
  // content unasked.
  // ---------------------------------------------------------------------

  const STATS_TOGGLES = [
    ['showFilesChanged', 'Files changed'],
    ['showAdditions', 'Additions (+)'],
    ['showDeletions', 'Deletions (-)'],
    ['showDiffBar', 'Diff bar'],
    ['showVerified', 'Verified badge'],
    ['showMergeIndicator', 'Merge indicator'],
    ['showCommentCount', 'Comment count'],
    ['showFileTooltip', 'File list on hover'],
    ['formatNumbers', 'Format numbers (8,900)']
  ];
  const ELEMENT_TOGGLES = [
    ['showAvatar', 'Author avatar'],
    ['showCommitTime', 'Commit time'],
    ['showSha', 'Short SHA button'],
    ['showCopyButton', 'Copy SHA button'],
    ['showBrowseButton', 'Browse files button']
  ];

  const TEMPLATE_PLACEHOLDERS = [
    'AVATAR', 'AUTHOR', 'TIMESTAMP', 'DATE', 'COMMIT_MESSAGE', 'SHA', 'REPO',
    'FILES_CHANGED', 'ADDITIONS', 'DELETIONS'
  ];

  const TIMESTAMP_STYLES = [
    ['(none)', 'Relative (default), e.g. "3 hours ago"'],
    ['t', 'Short Time: 16:20'],
    ['T', 'Medium Time: 16:20:30'],
    ['d', 'Short Date: 04/20/2021'],
    ['D', 'Long Date: April 20, 2021'],
    ['f', 'Long Date, Short Time: April 20, 2021 at 16:20'],
    ['F', 'Full Date, Short Time: Tuesday, April 20, 2021 at 16:20'],
    ['s', 'Short Date, Short Time: 04/20/2021, 16:20'],
    ['S', 'Short Date, Medium Time: 04/20/2021, 16:20:30'],
    ['R', 'Relative, same as no style']
  ];

  let panelEl = null;
  let panelAuthStatusEl = null;

  function toggleRowHtml([id, label]) {
    const checked = settings[id] ? 'checked' : '';
    return `
      <div class="ghcd-toggle-row">
        <label for="ghcd-p-${id}">${label}</label>
        <span class="ghcd-switch">
          <input type="checkbox" id="ghcd-p-${id}" data-setting="${id}" ${checked} />
          <span class="ghcd-track"></span><span class="ghcd-thumb"></span>
        </span>
      </div>`;
  }

  function refreshPanelToggles() {
    if (!panelEl) return;
    [...STATS_TOGGLES, ...ELEMENT_TOGGLES, ['compactRows'], ['showCommitCount']].forEach(([id]) => {
      const input = panelEl.querySelector(`#ghcd-p-${id}`);
      if (input) input.checked = !!settings[id];
    });
    updateCommitCounts();
    const useCustomInput = panelEl.querySelector('#ghcd-p-useCustomCommitLine');
    if (useCustomInput) useCustomInput.checked = !!settings.useCustomCommitLine;
    const templateInput = panelEl.querySelector('#ghcd-p-template');
    if (templateInput && document.activeElement !== templateInput) {
      templateInput.value = settings.commitLineTemplate || DEFAULT_SETTINGS.commitLineTemplate;
    }
  }

  function clampPanelPosition(x, y) {
    const w = panelEl.offsetWidth || 300;
    const h = panelEl.offsetHeight || 200;
    return {
      x: Math.min(Math.max(x, 8), window.innerWidth - w - 8),
      y: Math.min(Math.max(y, 8), window.innerHeight - h - 8)
    };
  }

  function setPanelPosition(x, y, persist) {
    const c = clampPanelPosition(x, y);
    panelEl.style.left = `${c.x}px`;
    panelEl.style.top = `${c.y}px`;
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
    if (persist) chrome.storage.local.set({ ghcd_panelPos: c });
  }

  function initDrag(handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return; // let header buttons (e.g. close) handle their own clicks
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      const rect = panelEl.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setPanelPosition(origX + (e.clientX - startX), origY + (e.clientY - startY), false);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      const rect = panelEl.getBoundingClientRect();
      setPanelPosition(rect.left, rect.top, true);
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  let panelAuthWarning = null;

  function showPanelAuthWarning(message) {
    panelAuthWarning = message;
    refreshPanelAuth();
  }

  function renderPanelAuth({ token, clientId, flow }) {
    if (!panelAuthStatusEl) return;
    const signInBtn = panelEl.querySelector('#ghcd-p-signin');
    const signOutBtn = panelEl.querySelector('#ghcd-p-signout');
    const cancelBtn = panelEl.querySelector('#ghcd-p-cancel');
    panelEl.querySelector('#ghcd-p-clientid').value = clientId || '';

    panelAuthStatusEl.className = 'ghcd-auth-status';
    panelAuthStatusEl.innerHTML = '';

    if (flow && flow.status === 'pending') {
      signInBtn.style.display = 'none';
      signOutBtn.style.display = 'none';
      cancelBtn.style.display = 'block';
      panelAuthStatusEl.classList.add('pending');
      const codeUrl = flow.verificationUriComplete || flow.verificationUri;
      panelAuthStatusEl.innerHTML = `Waiting for authorization…<div class="ghcd-usercode">${flow.userCode}</div>Enter this code at <a href="${codeUrl}" target="_blank" rel="noopener">github.com/login/device</a>.`;
      return;
    }

    if (flow && flow.status === 'error') {
      signInBtn.style.display = 'block';
      signOutBtn.style.display = token ? 'block' : 'none';
      cancelBtn.style.display = 'none';
      panelAuthStatusEl.classList.add('error');
      panelAuthStatusEl.textContent = flow.message || 'Sign-in failed.';
    } else if (token) {
      signInBtn.style.display = 'none';
      signOutBtn.style.display = 'block';
      cancelBtn.style.display = 'none';
      if (panelAuthWarning) {
        panelAuthStatusEl.classList.add('error');
        panelAuthStatusEl.textContent = panelAuthWarning;
      } else {
        panelAuthStatusEl.classList.add('success');
        panelAuthStatusEl.textContent = 'Signed in with GitHub';
      }
    } else {
      signInBtn.style.display = 'block';
      signOutBtn.style.display = 'none';
      cancelBtn.style.display = 'none';
      panelAuthWarning = null;
    }
  }

  function refreshPanelAuth() {
    if (!panelEl) return;
    chrome.storage.local.get(['token', 'clientId', 'ghcd_deviceFlow'], (stored) => {
      renderPanelAuth({ token: stored.token, clientId: stored.clientId, flow: stored.ghcd_deviceFlow });
    });
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'ghcd-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="ghcd-panel-header" id="ghcd-panel-drag">
        <span>Commit Details</span>
        <button type="button" id="ghcd-panel-close" aria-label="Close">&times;</button>
      </div>
      <div class="ghcd-panel-body">
        <div class="ghcd-panel-section">
          <h3>Commit stats</h3>
          ${STATS_TOGGLES.map(toggleRowHtml).join('')}
        </div>
        <div class="ghcd-panel-section">
          <h3>Existing GitHub elements</h3>
          ${ELEMENT_TOGGLES.map(toggleRowHtml).join('')}
        </div>
        <div class="ghcd-panel-section">
          <h3>Layout</h3>
          ${toggleRowHtml(['compactRows', 'Compact rows'])}
        </div>
        <div class="ghcd-panel-section">
          <h3>Commit counts</h3>
          ${toggleRowHtml(['showCommitCount', 'Show counts'])}
          <div id="ghcd-p-counts" class="ghcd-counts"></div>
        </div>
        <div class="ghcd-panel-section">
          <h3>Commit line</h3>
          <div class="ghcd-toggle-row">
            <label for="ghcd-p-useCustomCommitLine">Custom template</label>
            <span class="ghcd-switch">
              <input type="checkbox" id="ghcd-p-useCustomCommitLine" data-setting="useCustomCommitLine" ${settings.useCustomCommitLine ? 'checked' : ''} />
              <span class="ghcd-track"></span><span class="ghcd-thumb"></span>
            </span>
          </div>
          <textarea id="ghcd-p-template" rows="2" spellcheck="false">${escapeHtml(settings.commitLineTemplate || DEFAULT_SETTINGS.commitLineTemplate)}</textarea>
          <p class="ghcd-hint">Placeholders: ${TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}</p>
          <details class="ghcd-details">
            <summary>{TIMESTAMP} format codes</summary>
            <table class="ghcd-style-table">
              ${TIMESTAMP_STYLES.map(([code, desc]) => `<tr><td>${code === '(none)' ? '{TIMESTAMP}' : `{TIMESTAMP:${code}}`}</td><td>${desc}</td></tr>`).join('')}
            </table>
          </details>
        </div>
        <div class="ghcd-panel-section">
          <h3>Sign in</h3>
          <p class="ghcd-hint">Raises the API limit from 60/hour to 5000/hour.</p>
          <button type="button" class="ghcd-btn ghcd-btn-primary" id="ghcd-p-signin">Sign in with GitHub</button>
          <button type="button" class="ghcd-btn ghcd-btn-secondary" id="ghcd-p-signout" style="display:none;">Sign out</button>
          <button type="button" class="ghcd-btn ghcd-btn-secondary" id="ghcd-p-cancel" style="display:none;">Cancel</button>
          <div class="ghcd-auth-status" id="ghcd-p-authstatus"></div>
          <details class="ghcd-details">
            <summary>Using a different GitHub App</summary>
            <input type="text" id="ghcd-p-clientid" placeholder="Ov23li... (optional)" autocomplete="off" spellcheck="false" />
          </details>
          <details class="ghcd-details">
            <summary>Worker URL (enables silent token refresh)</summary>
            <p class="ghcd-hint">Optional: a self-hosted OAuth proxy Worker (see worker/README.md). Without it, sign-in drops back to unauthenticated requests when the token expires instead of refreshing silently.</p>
            <input type="text" id="ghcd-p-workerurl" placeholder="https://your-worker.workers.dev (optional)" autocomplete="off" spellcheck="false" />
          </details>
          <details class="ghcd-details">
            <summary>Paste a token manually instead</summary>
            <p class="ghcd-hint">Create a <strong>classic</strong> token at
              <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener">github.com/settings/tokens/new</a>.
              No scopes needed for public repos, leave every checkbox unchecked. Set
              <strong>Expiration</strong> to "No expiration" (or note the date and re-paste when
              it lapses). A <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener">fine-grained token</a>
              works too, but those always expire (90 days max) and need read-only "Contents" repo access.</p>
            <input type="text" id="ghcd-p-token" placeholder="ghp_... or github_pat_..." autocomplete="off" spellcheck="false" />
          </details>
        </div>
        <div class="ghcd-panel-section">
          <details class="ghcd-details" id="ghcd-p-logs-details">
            <summary>Logs <span id="ghcd-p-log-count" class="ghcd-log-count"></span></summary>
            <div class="ghcd-toggle-row">
              <label for="ghcd-p-verbose">Verbose (include requests)</label>
              <span class="ghcd-switch">
                <input type="checkbox" id="ghcd-p-verbose" />
                <span class="ghcd-track"></span><span class="ghcd-thumb"></span>
              </span>
            </div>
            <div class="ghcd-log-actions">
              <button type="button" class="ghcd-btn ghcd-btn-secondary" id="ghcd-p-log-copy">Copy</button>
              <button type="button" class="ghcd-btn ghcd-btn-secondary" id="ghcd-p-log-clear">Clear</button>
            </div>
            <div id="ghcd-p-log-list" class="ghcd-log-list"></div>
          </details>
        </div>
      </div>`;
    document.body.appendChild(panel);
    panelEl = panel;
    panelAuthStatusEl = panel.querySelector('#ghcd-p-authstatus');

    panel.querySelectorAll('input[type="checkbox"][data-setting]').forEach((input) => {
      input.addEventListener('change', () => {
        chrome.storage.local.set({ [input.dataset.setting]: input.checked });
      });
    });

    panel.querySelector('#ghcd-panel-close').addEventListener('click', () => {
      panel.hidden = true;
    });

    const templateInput = panel.querySelector('#ghcd-p-template');
    let templateTimer = null;
    templateInput.addEventListener('input', () => {
      clearTimeout(templateTimer);
      templateTimer = setTimeout(() => {
        chrome.storage.local.set({ commitLineTemplate: templateInput.value });
      }, 400);
    });

    const clientIdInput = panel.querySelector('#ghcd-p-clientid');
    let clientIdTimer = null;
    clientIdInput.addEventListener('input', () => {
      clearTimeout(clientIdTimer);
      clientIdTimer = setTimeout(() => {
        chrome.storage.local.set({ clientId: clientIdInput.value.trim() });
      }, 400);
    });

    const workerUrlInput = panel.querySelector('#ghcd-p-workerurl');
    workerUrlInput.value = settings.workerUrl || '';
    let workerUrlTimer = null;
    workerUrlInput.addEventListener('input', () => {
      clearTimeout(workerUrlTimer);
      workerUrlTimer = setTimeout(() => {
        chrome.storage.local.set({ workerUrl: workerUrlInput.value.trim() });
      }, 400);
    });

    const tokenInput = panel.querySelector('#ghcd-p-token');
    tokenInput.value = settings.token || '';
    let tokenTimer = null;
    tokenInput.addEventListener('input', () => {
      clearTimeout(tokenTimer);
      tokenTimer = setTimeout(() => {
        chrome.storage.local.set({ token: tokenInput.value.trim() });
      }, 400);
    });

    panel.querySelector('#ghcd-p-signin').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const clientId = clientIdInput.value.trim() || BUILTIN_CLIENT_ID;
      btn.disabled = true;
      chrome.runtime.sendMessage({ type: 'GHCD_START_DEVICE_FLOW', clientId }, (res) => {
        btn.disabled = false;
        if (!res || !res.ok) {
          panelAuthStatusEl.className = 'ghcd-auth-status error';
          panelAuthStatusEl.textContent = (res && res.error) || 'Could not start sign-in.';
          return;
        }
        refreshPanelAuth();
      });
    });
    panel.querySelector('#ghcd-p-cancel').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'GHCD_CANCEL_DEVICE_FLOW' }, () => refreshPanelAuth());
    });
    panel.querySelector('#ghcd-p-signout').addEventListener('click', () => {
      chrome.storage.local.set({ token: '', ghcd_deviceFlow: null });
    });
    panel.addEventListener('click', (e) => {
      if (e.target && e.target.classList.contains('ghcd-usercode')) {
        navigator.clipboard.writeText(e.target.textContent.trim()).catch(() => {});
      }
    });

    initDrag(panel.querySelector('#ghcd-panel-drag'));
    refreshPanelAuth();
    initLogsUI(panel);
    return panel;
  }

  function formatLogTime(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
  }

  function initLogsUI(panel) {
    const listEl = panel.querySelector('#ghcd-p-log-list');
    const countEl = panel.querySelector('#ghcd-p-log-count');
    const verboseInput = panel.querySelector('#ghcd-p-verbose');
    const detailsEl = panel.querySelector('#ghcd-p-logs-details');

    let verbose = false;

    function render() {
      const visible = verbose ? logs : logs.filter((l) => l.level !== 'request');
      countEl.textContent = logs.length ? `(${logs.length})` : '';
      if (!detailsEl.open) return; // skip DOM work while collapsed
      listEl.innerHTML = visible
        .slice()
        .reverse()
        .map((l) => {
          const detail = l.detail ? ` ${escapeHtml(JSON.stringify(l.detail))}` : '';
          return `<div class="ghcd-log-row ghcd-log-${l.level}"><span class="ghcd-log-time">${formatLogTime(l.time)}</span><span class="ghcd-log-msg">${escapeHtml(l.message)}${detail ? `<span class="ghcd-log-detail">${detail}</span>` : ''}</span></div>`;
        })
        .join('') || '<div class="ghcd-log-empty">No logs yet.</div>';
    }

    logListeners.push(render);
    detailsEl.addEventListener('toggle', () => {
      if (detailsEl.open) render();
    });
    verboseInput.addEventListener('change', () => {
      verbose = verboseInput.checked;
      render();
    });
    panel.querySelector('#ghcd-p-log-clear').addEventListener('click', () => {
      logs.length = 0;
      render();
    });
    panel.querySelector('#ghcd-p-log-copy').addEventListener('click', () => {
      const text = logs
        .map((l) => `[${formatLogTime(l.time)}] ${l.level.toUpperCase()} ${l.message}${l.detail ? ' ' + JSON.stringify(l.detail) : ''}`)
        .join('\n');
      navigator.clipboard.writeText(text).catch(() => {});
    });

    render();
  }

  function buildToggleButton() {
    const btn = document.createElement('button');
    btn.id = 'ghcd-toggle-btn';
    btn.type = 'button';
    btn.textContent = 'GC';
    btn.title = 'Commit Details settings';
    btn.addEventListener('click', () => {
      if (!panelEl) buildPanel();
      updateCommitCounts();
      if (panelEl.hidden) {
        chrome.storage.local.get('ghcd_panelPos', (stored) => {
          panelEl.hidden = false;
          const btnRect = btn.getBoundingClientRect();
          const pos = stored.ghcd_panelPos || { x: btnRect.left - 300, y: btnRect.top - 340 };
          setPanelPosition(pos.x, pos.y, false);
        });
      } else {
        panelEl.hidden = true;
      }
    });
    document.body.appendChild(btn);
  }

  function init() {
    loadSettings(() => {
      scan();
      buildToggleButton();
      const observer = new MutationObserver(() => scan());
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('turbo:load', scan);
      document.addEventListener('pjax:end', scan);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
