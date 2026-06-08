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

  // Request session from content script
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'REQUEST_SESSION' });
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
    max_days_on: 5
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
    max_days_on: parseInt(document.getElementById('const-max-days-on').value) || 5
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

  if (data.period) {
    await loadPairings(data.period);
  }
}

async function loadPairings(period) {
  try {
    const xml = await navblue.getPairings(period);
    rawPairings = navblue.parsePairings(xml);
    document.getElementById('pairings-count').textContent = rawPairings.length;
    renderPairings();
  } catch (e) {
    console.error('Pairings load failed:', e);
    document.getElementById('pairings-count').textContent = '—';
  }
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
  if (constants.prefer_weekends) {
    prefer_off.push('Weekends');
  }

  return {
    avoid_employees: constants.avoid_employees || [],
    avoid_pairings,
    prefer_off,
    line_conditions
  };
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
      apiKey
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

    bidModel = model;
    renderPairings(); // re-score with new model
    renderBidPreview(model);
    showStatus('chat-status', 'success', `Bid built — ${model.bid_groups?.length || 0} group(s)`);
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
  if (!session?.period) {
    showStatus('submit-status', 'error', 'No bid period detected — open PBS and navigate to your bid');
    return;
  }

  const token = document.getElementById('token-input').value.trim();
  if (!token) {
    showStatus('submit-status', 'error', 'Enter your submission token');
    return;
  }

  const { endpoint } = await chrome.storage.local.get('endpoint');
  if (!endpoint) {
    showStatus('submit-status', 'error', 'Validation endpoint not set — open Settings');
    return;
  }

  document.getElementById('btn-submit').disabled = true;
  showStatus('submit-status', 'loading', 'Validating token...');

  try {
    // Validate token
    const vRes = await fetch(`${endpoint}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });

    const vData = await vRes.json();
    if (!vRes.ok || !vData.valid) {
      throw new Error(vData.error || 'Invalid or already-used token');
    }

    showStatus('submit-status', 'loading', 'Submitting bid to NavBlue...');

    const xml = buildBidXml(bidModel);
    await navblue.submitBid(session.period, xml);

    document.getElementById('token-input').value = '';
    showStatus('submit-status', 'success', 'Bid submitted successfully!');
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
    document.getElementById('const-max-days-on').value = constants.max_days_on ?? 5;
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

  // Submit bid
  document.getElementById('btn-submit').addEventListener('click', submitBid);

  // Pairing search
  document.getElementById('pairing-search').addEventListener('input', renderPairings);

  // Collapsible sections
  const constHeader = document.querySelector('#section-constants .section-header[data-toggle]');
  const constBody = document.getElementById('constants-body');
  if (constHeader && constBody) bindToggle(constHeader, constBody);

  const pairingHeader = document.querySelector('#section-pairings .section-header[data-toggle]');
  const pairingBody = document.getElementById('pairings-body');
  if (pairingHeader && pairingBody) bindToggle(pairingHeader, pairingBody);

  // Messages from background (session data)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'NAVBLUE_DATA') {
      onSession(message.data);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(elementId, type, text) {
  const el = document.getElementById(elementId);
  el.textContent = text;
  el.className = `status-${type}`;
  el.classList.remove('hidden');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
