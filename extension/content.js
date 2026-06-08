// Runs inside the NavBlue PBS page
// Reads the JWT token and ALC code, sends to sidebar via background

const ALC_REGEX = /\/\/([^.]+)\.pbs\.vmc\.navblue\.cloud/;
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

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
  const text = document.body?.innerText || '';
  const isoMatch = text.match(/bid period[^\d]*(\d{4})-(\d{2})-\d{2}/i);
  if (isoMatch) {
    return `${MONTHS[parseInt(isoMatch[2], 10) - 1]}${isoMatch[1].slice(2)}`;
  }
  return null;
}

function sendSessionData() {
  const token = getToken();
  const alc = getAlc();
  if (!token || !alc) return;

  chrome.runtime.sendMessage({
    type: 'NAVBLUE_DATA',
    data: {
      token,
      alc,
      baseUrl: `https://${alc}.pbs.vmc.navblue.cloud`,
      period: extractPeriodFromDom()
    }
  });
}

sendSessionData();
window.addEventListener('hashchange', sendSessionData);
setTimeout(sendSessionData, 2000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REQUEST_SESSION') {
    sendSessionData();
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
