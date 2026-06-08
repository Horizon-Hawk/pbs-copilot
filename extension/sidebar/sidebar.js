import { NavblueClient } from './navblue.js';
import { buildBidXml } from './bid_builder.js';
import { buildBidFromPreferences, scorePairings } from './claude_client.js';

// ── State ─────────────────────────────────────────────────────────────────────
let session = null;      // { token, alc, baseUrl, period }
let navblue = null;
let rawPairings = [];
let bidModel = null;
let groups = [];         // persisted bid groups
let constants = {};      // persisted constants
let editingGroupIndex = null;

// ── Startup ───────────────────────────────────────────────────────────────────
async function init() {
  await loadStorage();
  renderGroupsList();
  renderConstantsSummary();
  bindEvents();

  // Try storage first (content script writes here directly, works even when background is asleep)
  const { navblueSession } = await chrome.storage.local.get('navblueSession');
  if (navblueSession?.token) {
    onSession(navblueSession);
    return;
  }

  // Fallback: ask the NavBlue tab to re-send session data
  chrome.tabs.query({ url: '*://*.pbs.vmc.navblue.cloud/*' }, tabs => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'REQUEST_SESSION' }).catch(() => {});
    }
  });
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function loadStorage() {
  const data = await chrome.storage.local.get(['constants', 'groups', 'apiKey', 'endpoint']);
  constants = data.constants || {
    avoid_employees: [],
    checkin_before: '06:00',
    min_between: 48,
    avoid_stations: [],
    prefer_weekends: true,
    max_days_on: 6,
    min_credit: 75,
    max_credit: 90,
    pre_award_credit: 0
  };
  groups = data.groups || [];

  if (data.apiKey) document.getElementById('setting-api-key').value = data.apiKey;
  if (data.endpoint) document.getElementById('setting-endpoint').value = data.endpoint;
}

async function saveSettings() {
  const apiKey = document.getElementById('setting-api-key').value.trim();
  const endpoint = document.getElementById('setting-endpoint').value.trim();
  await chrome.storage.local.set({ apiKey, endpoint });
}

async function saveConstants() {
  constants = {
    avoid_employees: document.getElementById('const-employees').value
      .split(',').map(s => s.trim()).filter(Boolean),
    checkin_before: document.getElementById('const-checkin-before').value,
    min_between: parseInt(document.getElementById('const-min-between').value) || 48,
    avoid_stations: document.getElementById('const-avoid-stations').value
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    prefer_weekends: document.getElementById('const-prefer-weekends').checked,
    max_days_on: parseInt(document.getElementById('const-max-days-on').value) || 6,
    min_credit: parseInt(document.getElementById('const-min-credit').value) || 75,
    max_credit: parseInt(document.getElementById('const-max-credit').value) || 90,
    pre_award_credit: parseFloat(document.getElementById('const-pre-award-credit').value) || 0
  };
  await chrome.storage.local.set({ constants });
  renderConstantsSummary();
}

async function saveGroups() {
  await chrome.storage.local.set({ groups });
}

// ── Session ───────────────────────────────────────────────────────────────────
async function onSession(data) {
  session = data;
  navblue = new NavblueClient(data);

  document.getElementById('header-meta').textContent =
    `${data.alc.toUpperCase()}${data.period ? ' · ' + data.period : ''}`;

  document.getElementById('state-disconnected').classList.add('hidden');
  document.getElementById('state-connected').classList.remove('hidden');

  // Hide token input when no validation endpoint is configured
  chrome.storage.local.get('endpoint').then(({ endpoint }) => {
    document.getElementById('token-input').style.display = endpoint ? '' : 'none';
  });

  if (data.period) {
    loadPairings(data.period);    // non-blocking — display only
    loadPersonData(data.period);  // non-blocking — absences for bid building
  }
}

async function loadPersonData(period) {
  try {
    const xml = await navblue.getPersonData(period);
    const parsed = navblue.parsePersonData(xml);
    session.absences = (parsed.absences || []).filter(a => !a.historical);
    session.personXml = xml;
    console.log('[PBS] Loaded', session.absences.length, 'active absences');
  } catch (e) {
    console.warn('[PBS] Person data load failed:', e.message);
    session.absences = [];
  }
}

async function loadPairings(period) {
  const countEl = document.getElementById('pairings-count');
  const listEl  = document.getElementById('pairings-list');
  countEl.textContent = '…';

  // First try: interceptor cache (populated when user navigates to pairings in NavBlue)
  try {
    const cached = await chrome.storage.local.get(['cachedPairingsXml', 'cachedPairingsFormat']);
    if (cached.cachedPairingsXml) {
      const parsed = cached.cachedPairingsFormat === 'json'
        ? parsePairingsJson(cached.cachedPairingsXml)
        : parsePairingsXml(cached.cachedPairingsXml);
      if (parsed.length) {
        rawPairings = parsed;
        countEl.textContent = rawPairings.length;
        renderPairings();
        console.log('[PBS] Loaded', rawPairings.length, 'pairings from storage cache');
        return;
      }
    }
  } catch (e) {
    console.warn('[PBS] Cache read failed:', e.message);
  }

  // Second try: NavBlue API
  try {
    const xml = await navblue.getPairings(period);
    rawPairings = navblue.parsePairings(xml);
    if (rawPairings.length) {
      countEl.textContent = rawPairings.length;
      renderPairings();
      return;
    }
  } catch (e) {
    console.warn('[PBS] API pairings failed, trying Angular extraction:', e.message);
  }

  // Second try: extract from AngularJS app memory
  countEl.textContent = '…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PAIRINGS_FROM_ANGULAR' });
    if (res?.ok && res.raw?.length) {
      // Normalize NavBlue str-prefixed Angular objects
      rawPairings = res.raw.map(p => ({
        number:   p.strPairingNumber || '',
        length:   p.strLength || p.strLengthValue || '',
        checkin:  p.strCheckinTime || '',
        checkout: p.strCheckoutTime || '',
        credit:   p.strCredit || '',
        tafb:     p.strTafb || '',
        layovers: Array.isArray(p.arrLayoverNames)
          ? p.arrLayoverNames
          : (p.strLayoverNames || '').split(',').filter(Boolean),
        dates:    p.strPairingDates || '',
        detail:   p.strPairingReport || ''
      })).filter(p => p.number);
      countEl.textContent = rawPairings.length;
      if (rawPairings.length) { renderPairings(); return; }
    }
    console.warn('[PBS] No pairings cached yet — showing reload prompt');
    showPairingsPrompt(listEl, countEl, period);
  } catch (e) {
    console.warn('[PBS] loadPairings catch:', e.message);
    showPairingsPrompt(listEl, countEl, period);
  }
}

function showPairingsPrompt(listEl, countEl, period) {
  countEl.textContent = '!';
  listEl.innerHTML = `
    <button id="btn-nav-pairings" class="btn-primary" style="width:100%;margin-bottom:6px;">▶ Load Pairings from NavBlue</button>
    <div style="display:flex;gap:6px;margin-bottom:8px;">
      <button id="btn-reload-navblue" class="btn-secondary" style="font-size:11px;flex:1;">↻ Reload NavBlue tab</button>
      <button id="btn-retry-pairings" class="btn-secondary" style="font-size:11px;flex:1;">🔄 Check again</button>
    </div>
    <details>
      <summary style="font-size:11px;color:#94a3b8;cursor:pointer;">Paste response manually (fallback)</summary>
      <textarea id="pairings-paste" placeholder="Paste NavBlue pairings XML or JSON here…"
        style="width:100%;height:80px;margin-top:4px;font-size:10px;background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:4px;padding:4px;box-sizing:border-box;resize:vertical;"></textarea>
      <button id="btn-parse-paste" class="btn-secondary" style="font-size:11px;margin-top:4px;width:100%;">Load from paste</button>
    </details>`;

  document.getElementById('btn-nav-pairings')?.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.pbs.vmc.navblue.cloud/*' });
    if (!tabs.length) {
      listEl.innerHTML = '<div class="status-error" style="font-size:12px;">NavBlue tab not found — open NavBlue first.</div>';
      return;
    }
    const tabId = tabs[0].id;
    listEl.innerHTML = '<div class="status-loading" style="font-size:12px;">Loading pairings from NavBlue…</div>';
    countEl.textContent = '…';
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const ng = window.angular;

          function extractAndPost() {
            if (!ng) return false;
            try {
              const allEls = document.querySelectorAll('[ng-controller],[data-ng-controller]');
              for (const el of allEls) {
                try {
                  let scope = ng.element(el).scope();
                  const checked = new Set();
                  while (scope && !checked.has(scope.$id)) {
                    checked.add(scope.$id);
                    for (const key of Object.keys(scope)) {
                      if (key.startsWith('$')) continue;
                      const v = scope[key];
                      const arr = (v && !Array.isArray(v) && Array.isArray(v.arrPairings)) ? v.arrPairings
                                : (Array.isArray(v) ? v : null);
                      if (arr && arr.length > 0 && arr[0] && arr[0].strPairingNumber) {
                        window.postMessage({ type: '__PBS_PAIRINGS__', url: 'angular-scope:' + key, data: JSON.stringify(arr), format: 'json' }, '*');
                        return true;
                      }
                    }
                    scope = scope.$parent;
                  }
                } catch(e) {}
              }
            } catch(e) {}
            return false;
          }

          // Try extracting immediately (already on pairings page)
          if (extractAndPost()) return { method: 'scope-immediate' };

          // Navigate to pairings, then extract after Angular loads the data
          let navigated = false;
          try {
            const inj = ng?.element(document.body)?.injector?.();
            if (inj) {
              const $loc = inj.get('$location');
              const $rs  = inj.get('$rootScope');
              const cur  = $loc.path() || '';
              if (!cur.toLowerCase().includes('pairing')) {
                for (const p of ['/pairings', '/bid/pairings', '/bidding/pairings', '/schedule/pairings']) {
                  try { $loc.path(p); $rs.$apply(); navigated = true; break; } catch(e) {}
                }
              }
            }
          } catch(e) {}

          // Click-based fallback if Angular route failed
          if (!navigated) {
            const els = [
              ...document.querySelectorAll('[ui-sref*="pairing"],[href*="pairing"],[ng-click*="pairing"]'),
              ...[...document.querySelectorAll('a,li,button,.nav-item,[role="menuitem"]')]
                .filter(el => /\bpairings?\b/i.test(el.textContent.trim()))
            ];
            if (els.length) { els[0].click(); navigated = true; }
          }

          if (!navigated) {
            window.postMessage({ type: '__PBS_NAV_FAILED__' }, '*');
            return { method: 'none' };
          }

          // Poll for pairings in Angular scope after navigation (up to 8 seconds)
          let attempts = 0;
          const poll = setInterval(() => {
            attempts++;
            if (extractAndPost() || attempts >= 16) clearInterval(poll);
          }, 500);

          return { method: 'navigated' };
        }
      });
    } catch(e) {
      listEl.innerHTML = `<div class="status-error" style="font-size:12px;">Script injection failed: ${escHtml(e.message)}</div>`;
    }
  });

  document.getElementById('btn-reload-navblue')?.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.pbs.vmc.navblue.cloud/*' });
    if (!tabs.length) { listEl.innerHTML = '<div class="status-error" style="font-size:12px;">NavBlue tab not found.</div>'; return; }
    chrome.tabs.reload(tabs[0].id);
    countEl.textContent = '…';
    listEl.innerHTML = '<div class="status-loading" style="font-size:12px;">Reloading NavBlue… then click ▶ Load Pairings.</div>';
  });

  document.getElementById('btn-retry-pairings')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-retry-pairings');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    await loadPairings(period);
  });

  document.getElementById('btn-parse-paste')?.addEventListener('click', () => {
    const text = document.getElementById('pairings-paste')?.value?.trim();
    if (!text) return;
    try {
      const isJson = text.startsWith('[') || text.startsWith('{');
      const parsed = isJson ? parsePairingsJson(text) : parsePairingsXml(text);
      console.log('[PBS] Paste parsed', parsed.length, 'pairings (format:', isJson ? 'json' : 'xml', ')');
      if (parsed.length && parsed.some(p => p.number)) {
        rawPairings = parsed;
        countEl.textContent = rawPairings.length;
        renderPairings();
        chrome.storage.local.set({ cachedPairingsXml: text, cachedPairingsFormat: isJson ? 'json' : 'xml' });
      } else {
        let sample;
        if (isJson) {
          try { const d = JSON.parse(text); const arr = Array.isArray(d) ? d : (d.arrPairings || d.pairings || d.data || []); sample = JSON.stringify(Object.keys(arr[0] || {})); } catch(e) { sample = e.message; }
        } else {
          sample = window.__pbsLastPairingAttrs ? JSON.stringify(Object.keys(window.__pbsLastPairingAttrs)) : 'no <Pairing> elements found';
        }
        alert(`Parsed 0 usable pairings — number attribute not found.\n\nActual keys in data:\n${sample}\n\nShare this with the developer to fix the field mapping.`);
      }
    } catch (e) {
      alert('Parse error: ' + e.message);
    }
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Pairings ──────────────────────────────────────────────────────────────────
function renderPairings() {
  const filter = (document.getElementById('pairing-search').value || '').toLowerCase();
  const list = document.getElementById('pairings-list');

  let pairings = rawPairings;
  if (filter) {
    pairings = pairings.filter(p =>
      p.number?.toLowerCase().includes(filter) ||
      p.layovers?.some(l => l.toLowerCase().includes(filter)) ||
      p.length?.toString().includes(filter)
    );
  }

  const scored = bidModel ? scorePairings(pairings, bidModel) : pairings;

  list.innerHTML = scored.map(p => {
    const cls = p.score ? `pairing-row pairing-${p.score}` : 'pairing-row';
    const layovers = (p.layovers || []).join('/') || '—';
    return `<div class="${cls}" title="${p.reason || ''}">
      <span class="pairing-num">${p.number}</span>
      <span class="pairing-meta">${p.length}d · ${layovers} · CI ${p.checkin || '—'}</span>
    </div>`;
  }).join('');
}

// ── Constants summary ─────────────────────────────────────────────────────────
function renderConstantsSummary() {
  const list = document.getElementById('constants-list');
  const items = [];
  if (constants.avoid_employees?.length)
    items.push(`Avoid: ${constants.avoid_employees.join(', ')}`);
  if (constants.checkin_before)
    items.push(`No CI before ${constants.checkin_before}`);
  if (constants.min_between)
    items.push(`≥${constants.min_between}h between trips`);
  if (constants.avoid_stations?.length)
    items.push(`No ${constants.avoid_stations.join('/')}`);
  if (constants.prefer_weekends)
    items.push('Prefer weekends off');
  if (constants.max_days_on)
    items.push(`Max ${constants.max_days_on} days on`);
  if (constants.pre_award_credit)
    items.push(`Pre-award ${constants.pre_award_credit}h → need ${Math.max(0, (constants.min_credit || 75) - constants.pre_award_credit)}h more`);
  if (constants.min_credit)
    items.push(`Min credit ${constants.min_credit}h`);
  if (constants.max_credit)
    items.push(`Max credit ${constants.max_credit}h`);

  list.innerHTML = items.length
    ? items.map(i => `<div class="summary-item">${i}</div>`).join('')
    : '<div class="muted">No constants set</div>';
}

// ── Bid groups ────────────────────────────────────────────────────────────────
function renderGroupsList() {
  const list = document.getElementById('groups-list');
  if (!groups.length) {
    list.innerHTML = '<div class="muted">No bid groups yet</div>';
    return;
  }
  list.innerHTML = groups.map((g, i) => `
    <div class="group-row">
      <span class="group-name">${g.name || `Group ${i + 1}`}</span>
      <div class="group-actions">
        <button class="btn-icon" data-edit="${i}" title="Edit">✏</button>
        <button class="btn-icon btn-danger" data-delete="${i}" title="Delete">✕</button>
      </div>
    </div>
    ${i < groups.length - 1 ? '<div class="group-arrow">↓ else</div>' : ''}
  `).join('');

  list.querySelectorAll('[data-edit]').forEach(btn =>
    btn.addEventListener('click', () => openGroupEditor(parseInt(btn.dataset.edit))));
  list.querySelectorAll('[data-delete]').forEach(btn =>
    btn.addEventListener('click', () => deleteGroup(parseInt(btn.dataset.delete))));
}

function openGroupEditor(index) {
  editingGroupIndex = index;
  const g = index === null ? {} : groups[index];
  const title = index === null ? 'New Bid Group' : `Edit Group ${index + 1}`;

  document.getElementById('group-editor-title').textContent = title;
  document.getElementById('group-name').value = g.name || '';
  document.getElementById('group-avoids').value = g.avoids_text || '';
  document.getElementById('group-awards').value = g.awards_text || '';
  document.getElementById('group-specific').value = (g.specific_pairings || []).join(', ');
  document.getElementById('group-else-next').checked = g.else_start_next !== false;

  document.getElementById('panel-group-editor').classList.remove('hidden');
}

async function saveGroup() {
  const name = document.getElementById('group-name').value.trim() || `Group ${(editingGroupIndex ?? groups.length) + 1}`;
  const avoids_text = document.getElementById('group-avoids').value.trim();
  const awards_text = document.getElementById('group-awards').value.trim();
  const specific_pairings = document.getElementById('group-specific').value
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const else_start_next = document.getElementById('group-else-next').checked;

  const group = { name, avoids_text, awards_text, specific_pairings, else_start_next };

  if (editingGroupIndex === null) {
    groups.push(group);
  } else {
    groups[editingGroupIndex] = group;
  }

  await saveGroups();
  renderGroupsList();
  document.getElementById('panel-group-editor').classList.add('hidden');
}

async function deleteGroup(index) {
  groups.splice(index, 1);
  await saveGroups();
  renderGroupsList();
}

// ── Build bid ─────────────────────────────────────────────────────────────────
function buildModelFromConstants() {
  const avoid_pairings = [];
  const line_conditions = [];
  const prefer_off = [];

  if (constants.checkin_before) {
    avoid_pairings.push({ type: 'PairingCheckin', operator: 'LT', time: constants.checkin_before });
  }
  if (constants.avoid_stations?.length) {
    avoid_pairings.push({ type: 'LayoverStations', stations: constants.avoid_stations, match: 'Any' });
  }
  if (constants.min_between) {
    line_conditions.push({ type: 'TimeBetweenPairings', hours: constants.min_between });
  }
  if (constants.max_days_on) {
    line_conditions.push({ type: 'MaximumDaysOn', days: constants.max_days_on });
  }
  if (constants.min_credit) {
    line_conditions.push({ type: 'MinimumCreditWindow', hours: constants.min_credit });
  }
  if (constants.max_credit) {
    line_conditions.push({ type: 'MaximumCreditWindow', hours: constants.max_credit });
  }
  if (constants.prefer_weekends) {
    prefer_off.push('Weekends');
  }

  // Auto-add pre-awarded absence date ranges as prefer_off
  for (const absence of (session?.absences || [])) {
    const dates = expandDateRange(absence.start, absence.end);
    if (dates.length) prefer_off.push({ dates });
  }

  return {
    avoid_employees: constants.avoid_employees || [],
    avoid_pairings,
    prefer_off,
    line_conditions
  };
}

function getPeriodDays(period) {
  if (!period) return null;
  const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const m = period.match(/^([A-Z]{3})(\d{2})$/);
  if (!m || MONTHS[m[1]] === undefined) return null;
  return new Date(2000 + parseInt(m[2]), MONTHS[m[1]] + 1, 0).getDate();
}

function expandDateRange(start, end) {
  const norm = d => {
    if (!d) return null;
    return d.includes('-') ? d : `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  };
  const s = norm(start), e = norm(end);
  if (!s || !e) return [];
  const dates = [];
  const cur = new Date(s + 'T00:00:00Z');
  const endDate = new Date(e + 'T00:00:00Z');
  while (cur <= endDate) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function buildBid() {
  const preferences = document.getElementById('chat-input').value.trim();
  if (!preferences) return;

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    showStatus('chat-status', 'error', 'API key not set — open Settings first');
    return;
  }

  showStatus('chat-status', 'loading', 'Building your bid with AI...');
  document.getElementById('btn-build').disabled = true;

  try {
    const model = await buildBidFromPreferences({
      preferences,
      pairings: rawPairings,
      absences: session?.absences || [],
      period: session?.period,
      apiKey,
      preAwardCredit: constants.pre_award_credit || 0,
      minCredit: constants.min_credit || 75
    });

    // Merge user's saved constants into the generated model
    model.constants = buildModelFromConstants();

    // Merge saved groups' specific pairings / text if no groups returned
    if (!model.bid_groups?.length && groups.length) {
      model.bid_groups = groups.map((g, i, arr) => ({
        name: g.name,
        avoid_pairings: g.avoid_pairings || [],
        award_pairings: g.award_pairings || [],
        specific_pairings: g.specific_pairings || [],
        else_start_next: i < arr.length - 1
      }));
    }

    const meta = model._meta;
    delete model._meta;

    bidModel = model;
    renderPairings();
    renderBidPreview(model);

    let statusMsg = `Bid built — ${model.bid_groups?.length || 0} group(s)`;
    if (meta?.creditContext) {
      const { total_credit, trip_count, days_worked } = meta.creditContext;
      const periodDays = getPeriodDays(session?.period);
      const daysOff = (periodDays && days_worked) ? periodDays - days_worked : null;
      statusMsg = `${trip_count} trip${trip_count !== 1 ? 's' : ''} · ${total_credit}h credit`;
      if (daysOff !== null) statusMsg += ` · ${daysOff} days off`;
    }
    showStatus('chat-status', 'success', statusMsg);
  } catch (e) {
    showStatus('chat-status', 'error', e.message);
  } finally {
    document.getElementById('btn-build').disabled = false;
  }
}

function renderBidPreview(model) {
  const preview = document.getElementById('bid-preview');
  if (!model?.bid_groups?.length) {
    preview.innerHTML = '';
    return;
  }
  preview.innerHTML = model.bid_groups.map((g, i) => `
    <div class="preview-group">
      <strong>${g.name || `Group ${i + 1}`}</strong>
      ${g.specific_pairings?.length ? `<div class="preview-line">Cherry-picked: ${g.specific_pairings.join(', ')}</div>` : ''}
      ${g.avoid_pairings?.length ? `<div class="preview-line avoid">Avoid: ${g.avoid_pairings.map(r => ruleLabel(r)).join(', ')}</div>` : ''}
      ${g.award_pairings?.length ? `<div class="preview-line award">Prefer: ${g.award_pairings.map(r => ruleLabel(r)).join(', ')}</div>` : ''}
    </div>
    ${g.else_start_next ? '<div class="preview-arrow">↓ else</div>' : ''}
  `).join('');
}

function ruleLabel(rule) {
  switch (rule.type) {
    case 'PairingCheckin': return `CI ${rule.operator === 'LT' ? 'before' : 'after'} ${rule.time}`;
    case 'LayoverStations': return `${rule.stations?.join('/')} layover`;
    case 'PairingLength': return `${rule.days}-day trip`;
    case 'TimeAwayFromBase': return `TAFB ${rule.operator === 'GT' ? '>' : '<'} ${rule.time}`;
    case 'DutyIsRedeye': return 'redeye';
    default: return rule.type;
  }
}

// ── Submit ─────────────────────────────────────────────────────────────────────
async function submitBid() {
  if (!bidModel) {
    showStatus('submit-status', 'error', 'Build a bid first');
    return;
  }
  const period = (session?.period || document.getElementById('period-input').value.trim()).toUpperCase();
  if (!period) {
    showStatus('submit-status', 'error', 'Enter the bid period (e.g. JUL26)');
    return;
  }

  const { endpoint } = await chrome.storage.local.get('endpoint');
  const token = document.getElementById('token-input').value.trim();

  // Token gate is optional — if no endpoint is configured, submit directly
  const useTokenGate = !!endpoint;

  if (useTokenGate && !token) {
    showStatus('submit-status', 'error', 'Enter your submission token');
    return;
  }

  document.getElementById('btn-submit').disabled = true;

  try {
    if (useTokenGate) {
      showStatus('submit-status', 'loading', 'Validating token...');
      const vRes = await fetch(`${endpoint}/api/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const vData = await vRes.json();
      if (!vRes.ok || !vData.valid) {
        throw new Error(vData.error || 'Invalid or already-used token');
      }
    }

    const targetEl = document.querySelector('input[name="bid-target"]:checked');
    const target = targetEl?.value || 'current';
    showStatus('submit-status', 'loading', `Submitting ${target} bid to NavBlue...`);

    const xml = buildBidXml(bidModel);
    console.log('[PBS] Submitting BidLines XML (target:', target, '):', xml);
    await navblue.submitBid(period, xml, target);

    if (useTokenGate) {
      await fetch(`${endpoint}/api/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      document.getElementById('token-input').value = '';
    }

    showStatus('submit-status', 'success', `${target === 'default' ? 'Default' : 'Current'} bid submitted!`);
  } catch (e) {
    showStatus('submit-status', 'error', e.message);
  } finally {
    document.getElementById('btn-submit').disabled = false;
  }
}

// ── Collapsible sections ──────────────────────────────────────────────────────
function bindToggle(headerEl, bodyEl) {
  headerEl.addEventListener('click', () => {
    bodyEl.classList.toggle('collapsed');
    const toggle = headerEl.querySelector('.section-toggle');
    if (toggle) toggle.textContent = bodyEl.classList.contains('collapsed') ? '▸' : '▾';
  });
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  // Settings panel
  document.getElementById('btn-settings').addEventListener('click', () =>
    document.getElementById('panel-settings').classList.remove('hidden'));
  document.getElementById('btn-close-settings').addEventListener('click', () =>
    document.getElementById('panel-settings').classList.add('hidden'));
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    await saveSettings();
    document.getElementById('panel-settings').classList.add('hidden');
  });

  // Constants panel
  document.getElementById('btn-edit-constants').addEventListener('click', () => {
    // Populate form from current constants
    document.getElementById('const-employees').value = (constants.avoid_employees || []).join(', ');
    document.getElementById('const-checkin-before').value = constants.checkin_before || '06:00';
    document.getElementById('const-min-between').value = constants.min_between ?? 48;
    document.getElementById('const-avoid-stations').value = (constants.avoid_stations || []).join(', ');
    document.getElementById('const-prefer-weekends').checked = constants.prefer_weekends !== false;
    document.getElementById('const-max-days-on').value = constants.max_days_on ?? 6;
    document.getElementById('const-pre-award-credit').value = constants.pre_award_credit ?? 0;
    document.getElementById('const-min-credit').value = constants.min_credit ?? 75;
    document.getElementById('const-max-credit').value = constants.max_credit ?? 90;
    document.getElementById('panel-constants').classList.remove('hidden');
  });
  document.getElementById('btn-close-constants').addEventListener('click', () =>
    document.getElementById('panel-constants').classList.add('hidden'));
  document.getElementById('btn-save-constants').addEventListener('click', async () => {
    await saveConstants();
    document.getElementById('panel-constants').classList.add('hidden');
  });

  // Bid groups
  document.getElementById('btn-add-group').addEventListener('click', () => openGroupEditor(null));
  document.getElementById('btn-close-group-editor').addEventListener('click', () =>
    document.getElementById('panel-group-editor').classList.add('hidden'));
  document.getElementById('btn-save-group').addEventListener('click', saveGroup);

  // Build bid
  document.getElementById('btn-build').addEventListener('click', buildBid);
  document.getElementById('btn-clear-bid').addEventListener('click', () => {
    bidModel = null;
    document.getElementById('chat-input').value = '';
    document.getElementById('bid-preview').innerHTML = '';
    document.getElementById('chat-status').className = 'muted hidden';
    document.getElementById('chat-status').textContent = '';
    renderPairings(); // re-render without scoring
  });

  // Submit bid
  document.getElementById('btn-submit').addEventListener('click', submitBid);

  document.getElementById('btn-copy-data').addEventListener('click', () => {
    const data = JSON.stringify({
      period: session?.period,
      pairings: rawPairings,
      absences: session?.absences || [],
      personXmlSnippet: session?.personXml?.slice(0, 2000) || null
    });
    navigator.clipboard.writeText(data).then(() => {
      document.getElementById('btn-copy-data').textContent = '✓ Copied!';
      setTimeout(() => document.getElementById('btn-copy-data').textContent = '📋 Copy pairing data', 2000);
    });
  });

  // Round-trip debug
  document.getElementById('btn-roundtrip').addEventListener('click', async () => {
    const period = (session?.period || document.getElementById('period-input').value.trim()).toUpperCase();
    if (!period || !navblue) { showStatus('submit-status', 'error', 'Not connected'); return; }
    showStatus('submit-status', 'loading', 'Round-trip test — posting existing bid back unchanged...');
    try {
      await navblue.roundTripTest(period);
      showStatus('submit-status', 'success', 'Round-trip OK — BidSets structure is accepted');
    } catch (e) {
      showStatus('submit-status', 'error', `Round-trip failed: ${e.message}`);
    }
  });

  // Manual period load
  document.getElementById('btn-load-period').addEventListener('click', () => {
    const period = document.getElementById('period-pairings').value.trim().toUpperCase();
    if (!period) return;
    if (session) session.period = period;
    document.getElementById('header-meta').textContent =
      session ? `${session.alc?.toUpperCase() || ''} · ${period}` : period;
    loadPairings(period);
    loadPersonData(period);
  });

  // Pairings paste fallback
  document.getElementById('btn-load-pasted').addEventListener('click', () => {
    const xml = document.getElementById('pairings-paste').value.trim();
    if (!xml) return;
    try {
      const parsed = navblue ? navblue.parsePairings(xml) : parsePairingsXml(xml);
      if (!parsed.length) {
        document.getElementById('pairings-list').innerHTML =
          '<div class="status-error">Parsed 0 pairings — check the XML format</div>';
        return;
      }
      rawPairings = parsed;
      document.getElementById('pairings-count').textContent = rawPairings.length;
      document.getElementById('pairings-paste').value = '';
      renderPairings();
    } catch (e) {
      document.getElementById('pairings-list').innerHTML =
        `<div class="status-error">Parse error: ${escHtml(e.message)}</div>`;
    }
  });

  // Pairing search
  document.getElementById('pairing-search').addEventListener('input', renderPairings);

  // Collapsible sections
  const constHeader = document.querySelector('#section-constants .section-header[data-toggle]');
  const constBody = document.getElementById('constants-body');
  if (constHeader && constBody) bindToggle(constHeader, constBody);

  const pairingHeader = document.querySelector('#section-pairings .section-header[data-toggle]');
  const pairingBody = document.getElementById('pairings-body');
  if (pairingHeader && pairingBody) bindToggle(pairingHeader, pairingBody);

  // Messages from background (session data) — only re-init if token changed
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'NAVBLUE_PAIRINGS_CAPTURED') {
      console.log('[PBS] Pairings captured from', message.url, 'format:', message.format, 'size:', message.data?.length);
      try {
        const parsed = message.format === 'json'
          ? parsePairingsJson(message.data)
          : parsePairingsXml(message.data);
        if (parsed.length) {
          rawPairings = parsed;
          document.getElementById('pairings-count').textContent = rawPairings.length;
          document.getElementById('pairings-list').innerHTML = ''; // clear prompt
          renderPairings();
          chrome.storage.local.set({ cachedPairingsXml: message.data, cachedPairingsFormat: message.format, cachedPairingsUrl: message.url });
          console.log('[PBS] Loaded', rawPairings.length, 'pairings');
        } else {
          console.warn('[PBS] parsePairings returned 0 items — format:', message.format, 'preview:', message.data?.slice(0,200));
        }
      } catch (e) {
        console.warn('[PBS] Failed to parse pairings:', e.message, 'preview:', message.data?.slice(0,200));
      }
    }

    if (message.type === 'NAVBLUE_NAV_FAILED') {
      const listEl = document.getElementById('pairings-list');
      if (listEl) listEl.innerHTML = '<div class="status-info" style="font-size:12px;">Auto-navigate failed — switch to NavBlue and click Pairings manually.</div>';
    }

    if (message.type === 'NAVBLUE_DATA') {
      const incoming = message.data;
      chrome.storage.local.set({ navblueSession: incoming });
      if (!session || incoming.token !== session.token) {
        onSession(incoming);
      } else if (incoming.period && !session.period) {
        session.period = incoming.period;
        document.getElementById('header-meta').textContent =
          `${incoming.alc.toUpperCase()} · ${incoming.period}`;
        loadPairings(incoming.period);
        loadPersonData(incoming.period);
      }
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parsePairingsXml(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const nodes = [...doc.querySelectorAll('Pairing')];
  if (nodes.length > 0) {
    const attrs = {};
    for (const a of nodes[0].attributes) attrs[a.name] = a.value;
    console.log('[PBS] parsePairingsXml first <Pairing> attributes:', JSON.stringify(attrs));
    window.__pbsLastPairingAttrs = attrs; // expose for paste-box diagnostics
  }
  return nodes.map(p => {
    // Try both known attribute name variants
    const num = p.getAttribute('Number') || p.getAttribute('PairingNumber') ||
                p.getAttribute('OriginalNumber') || p.getAttribute('strPairingNumber') || null;
    return {
      number:   num,
      length:   p.getAttribute('Length') || p.getAttribute('Days') || null,
      checkin:  p.getAttribute('CheckIn') || p.getAttribute('CheckinTime') || p.getAttribute('CheckInTime') || null,
      checkout: p.getAttribute('CheckOut') || p.getAttribute('CheckoutTime') || p.getAttribute('CheckOutTime') || null,
      credit:   p.getAttribute('Credit') || null,
      tafb:     p.getAttribute('Tafb') || p.getAttribute('TAFB') || p.getAttribute('TimeAwayFromBase') || null,
      layovers: (p.getAttribute('LayoverLocationNames') || p.getAttribute('Layovers') || '').split(',').filter(Boolean),
      dates:    p.getAttribute('Dates') || p.getAttribute('PairingDates') || null,
      detail:   p.getAttribute('DetailReport') || ''
    };
  }).filter(p => p.number); // drop items where no number attribute matched
}

function parsePairingsJson(jsonText) {
  let data = JSON.parse(jsonText);
  // Unwrap envelope: PairingData object has arrPairings, or direct array
  if (!Array.isArray(data)) {
    data = data.arrPairings || data.pairings || data.data || [];
  }
  return data.filter(p => p.strPairingNumber).map(p => ({
    number:   p.strPairingNumber,
    length:   p.strLength || p.strLengthValue || '',
    checkin:  p.strCheckinTime || '',
    checkout: p.strCheckoutTime || '',
    credit:   p.strCredit || '',
    tafb:     p.strTafb || '',
    layovers: Array.isArray(p.arrLayoverNames)
      ? p.arrLayoverNames
      : (p.strLayoverNames || '').split(',').filter(Boolean),
    dates:    p.strPairingDates || '',
    detail:   p.strPairingReport || ''
  }));
}

function showStatus(elementId, type, text) {
  const el = document.getElementById(elementId);
  el.textContent = text;
  el.className = `status-${type}`;
  el.classList.remove('hidden');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
