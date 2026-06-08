// Runs inside the NavBlue PBS page
// Reads the JWT token and ALC code, sends to sidebar via background

const ALC_REGEX = /\/\/([^.]+)\.pbs\.vmc\.navblue\.cloud/;
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Inject XHR/fetch interceptor into page main world ASAP
(function injectInterceptor() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('interceptor.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

// Listen for intercepted pairing data from the page
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data && e.data.type === '__PBS_DATA_CALL__') {
    console.log('[PBS intercept]', e.data.size + 'b', e.data.url.slice(-80), '|', e.data.preview?.slice(0,60));
  }
  if (e.data && e.data.type === '__PBS_PAIRINGS__') {
    console.log('[PBS intercept] PAIRINGS CAPTURED from', e.data.url, 'size:', e.data.data?.length);
    chrome.runtime.sendMessage({ type: 'NAVBLUE_PAIRINGS_CAPTURED', data: e.data.data, url: e.data.url });
  }
});

function getAlc() {
  const match = window.location.href.match(ALC_REGEX);
  return match ? match[1] : null;
}

function getToken() {
  const candidates = ['token', 'jwt', 'authToken', 'access_token'];
  for (const key of candidates) {
    const val = localStorage.getItem(key);
    if (val && val.startsWith('eyJ')) return val;
  }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const val = localStorage.getItem(key);
    if (val && val.startsWith('eyJ') && val.split('.').length === 3) return val;
  }
  return null;
}

function extractPeriodFromDom() {
  // 1. Check URL hash for period-like token (e.g. #/JUL26 or #/pairings/JUL26)
  const hashPeriod = window.location.hash.match(/\b([A-Z]{3}\d{2})\b/);
  if (hashPeriod) return hashPeriod[1];

  const text = document.body?.innerText || '';

  // 2. "JUL26" / "JUL2026" directly in page text
  const directMatch = text.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2}|\d{4})\b/);
  if (directMatch) {
    const mon = directMatch[1];
    const yr  = directMatch[2].length === 4 ? directMatch[2].slice(2) : directMatch[2];
    return `${mon}${yr}`;
  }

  // 3. ISO date near "period" label
  const isoMatch = text.match(/period[^\d]*(\d{4})-(\d{2})-\d{2}/i);
  if (isoMatch) {
    return `${MONTHS[parseInt(isoMatch[2], 10) - 1]}${isoMatch[1].slice(2)}`;
  }

  // 4. "July 2026" style
  const longMatch = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (longMatch) {
    const idx = ['january','february','march','april','may','june','july','august','september','october','november','december']
                  .indexOf(longMatch[1].toLowerCase());
    if (idx >= 0) return `${MONTHS[idx]}${longMatch[2].slice(2)}`;
  }

  return null;
}

function sendSessionData() {
  const token = getToken();
  const alc = getAlc();
  if (!token || !alc) return;

  const data = {
    token,
    alc,
    baseUrl: `https://${alc}.pbs.vmc.navblue.cloud`,
    period: extractPeriodFromDom()
  };

  // Write directly to storage — works even when background service worker is asleep
  chrome.storage.local.set({ navblueSession: data });

  // Also try message passing (best-effort; background may be sleeping)
  chrome.runtime.sendMessage({ type: 'NAVBLUE_DATA', data }).catch(() => {});
}

sendSessionData();
window.addEventListener('hashchange', sendSessionData);
setTimeout(sendSessionData, 2000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REQUEST_SESSION') {
    sendSessionData();
  }

  // Extract pairings from AngularJS app memory — no separate API call needed
  if (message.type === 'GET_PAIRINGS_FROM_ANGULAR') {
    try {
      const ng = window.angular;
      if (!ng) { sendResponse({ ok: false, error: 'AngularJS not found on page' }); return true; }

      // Walk all ng-controller elements looking for one that holds pairings
      const controllers = document.querySelectorAll('[ng-controller],[data-ng-controller]');
      let pairingData = null;

      for (const el of controllers) {
        try {
          const scope = ng.element(el).scope();
          if (!scope) continue;

          // NavBlue uses PairingData object (has .arrPairings) or direct arrays
          const PAIRING_KEYS = ['arrPairings', 'pairings', 'allPairings', 'pairingList', 'pairingData', 'bidPairings', 'filteredPairings', 'availablePairings'];
          for (const key of PAIRING_KEYS) {
            let candidate = scope[key];
            // PairingData wrapper object — unwrap .arrPairings
            if (candidate && !Array.isArray(candidate) && Array.isArray(candidate.arrPairings)) {
              candidate = candidate.arrPairings;
            }
            if (Array.isArray(candidate) && candidate.length > 0 && candidate[0].strPairingNumber) {
              pairingData = candidate;
              console.log('[PBS] Found pairings in scope.' + key, 'on', el.getAttribute('ng-controller') || el.getAttribute('data-ng-controller'), 'count:', pairingData.length);
              break;
            }
          }
          if (pairingData) break;

          // Also check one level deeper via $parent
          const parent = scope.$parent;
          if (parent) {
            for (const key of PAIRING_KEYS) {
              let candidate = parent[key];
              if (candidate && !Array.isArray(candidate) && Array.isArray(candidate.arrPairings)) {
                candidate = candidate.arrPairings;
              }
              if (Array.isArray(candidate) && candidate.length > 0 && candidate[0].strPairingNumber) {
                pairingData = candidate;
                console.log('[PBS] Found pairings in scope.$parent.' + key, 'count:', pairingData.length);
                break;
              }
            }
            if (pairingData) break;
          }
        } catch(e) {}
      }

      // Fallback: check ng-repeat elements that reference "pairing"
      if (!pairingData) {
        const repeaters = document.querySelectorAll('[ng-repeat],[data-ng-repeat]');
        for (const el of repeaters) {
          const expr = el.getAttribute('ng-repeat') || el.getAttribute('data-ng-repeat') || '';
          if (expr.toLowerCase().includes('pairing')) {
            try {
              const scope = ng.element(el).scope();
              // The repeated item itself may have pairing data
              if (scope && scope.pairing) {
                console.log('[PBS] Found ng-repeat pairing item, walking parent for array...');
                // Walk up to find the array
                let s = scope.$parent;
                while (s) {
                  for (const key of Object.keys(s)) {
                    if (Array.isArray(s[key]) && s[key].length > 0 && s[key][0] && (s[key][0].Number || s[key][0].number || s[key][0].PairingNumber)) {
                      pairingData = s[key];
                      console.log('[PBS] Found pairing array via ng-repeat parent, key:', key, 'count:', pairingData.length);
                      break;
                    }
                  }
                  if (pairingData) break;
                  s = s.$parent;
                }
              }
            } catch(e) {}
            if (pairingData) break;
          }
        }
      }

      if (pairingData) {
        sendResponse({ ok: true, pairings: JSON.stringify(pairingData.slice(0, 5)), count: pairingData.length, raw: pairingData });
      } else {
        // Dump scope keys from all controllers to help debug
        const scopeKeys = [];
        for (const el of controllers) {
          try {
            const scope = ng.element(el).scope();
            if (scope) {
              const keys = Object.keys(scope).filter(k => !k.startsWith('$') && !k.startsWith('$$'));
              scopeKeys.push({ ctrl: el.getAttribute('ng-controller'), keys: keys.slice(0, 20) });
            }
          } catch(e) {}
        }
        sendResponse({ ok: false, error: 'No pairings found in Angular scopes', scopeKeys });
      }
    } catch(e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }

  // Proxy NavBlue API calls from sidebar — runs same-origin so session cookies are included
  if (message.type === 'NAVBLUE_FETCH') {
    const { url, method, body, contentType } = message;
    const jwt = getToken();
    console.log('[PBS] NAVBLUE_FETCH jwt found:', !!jwt, 'url:', url.slice(0, 80));

    // Read XSRF token from cookies — AngularJS sends this on all non-GET requests
    const xsrfToken = document.cookie.split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('XSRF-TOKEN='))
      ?.split('=').slice(1).join('=');

    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
      ...(xsrfToken && method !== 'GET' ? { 'X-XSRF-TOKEN': xsrfToken } : {})
    };
    console.log('[PBS] XSRF token found:', !!xsrfToken, 'method:', method);
    if (contentType) headers['Content-Type'] = contentType;

    fetch(url, {
      method: method || 'GET',
      headers,
      credentials: 'include',
      ...(body ? { body } : {})
    })
    .then(async res => {
      const text = await res.text();
      sendResponse({ ok: res.ok, status: res.status, body: text });
    })
    .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
