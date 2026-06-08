// Runs inside the NavBlue PBS page
// Reads the JWT token and ALC code, sends to sidebar via background

const ALC_REGEX = /\/\/([^.]+)\.pbs\.vmc\.navblue\.cloud/;

function getAlc() {
  const match = window.location.href.match(ALC_REGEX);
  return match ? match[1] : null;
}

function getToken() {
  // NavBlue stores the JWT in localStorage under various possible keys
  const candidates = ['token', 'jwt', 'authToken', 'access_token'];
  for (const key of candidates) {
    const val = localStorage.getItem(key);
    if (val && val.startsWith('eyJ')) return val;
  }
  // Fallback: scan all localStorage keys for a JWT-shaped value
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const val = localStorage.getItem(key);
    if (val && val.startsWith('eyJ') && val.split('.').length === 3) return val;
  }
  return null;
}

function extractPeriodFromUrl() {
  const hash = window.location.hash;
  const params = new URLSearchParams(hash.replace(/^#\/?[^?]*\??/, ''));
  return params.get('period') || null;
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
      period: extractPeriodFromUrl()
    }
  });
}

// Send on load and re-send if page navigates (SPA hash changes)
sendSessionData();
window.addEventListener('hashchange', sendSessionData);

// Also expose an API for the sidebar to request fresh data
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'REQUEST_SESSION') {
    sendSessionData();
  }
});
