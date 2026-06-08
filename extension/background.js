// Opens sidebar when extension icon is clicked on a NavBlue page
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Enable sidebar only on NavBlue PBS pages
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url) return;
  const isNavblue = tab.url.includes('pbs.vmc.navblue.cloud');
  chrome.action.setIcon({
    tabId,
    path: isNavblue
      ? { 16: 'icons/icon16.png', 48: 'icons/icon48.png' }
      : { 16: 'icons/icon16_grey.png', 48: 'icons/icon48_grey.png' }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Forward NavBlue session data from content script to sidebar
  if (message.type === 'NAVBLUE_DATA') {
    chrome.runtime.sendMessage({ type: 'NAVBLUE_DATA', data: message.data }).catch(() => {});
    return false;
  }

  // Forward intercepted pairings data from content script to sidebar
  if (message.type === 'NAVBLUE_PAIRINGS_CAPTURED') {
    chrome.runtime.sendMessage({ type: 'NAVBLUE_PAIRINGS_CAPTURED', data: message.data, url: message.url }).catch(() => {});
    return false;
  }

  // Relay Angular scope extraction request to NavBlue tab
  if (message.type === 'GET_PAIRINGS_FROM_ANGULAR') {
    chrome.tabs.query({ url: '*://*.pbs.vmc.navblue.cloud/*' }, (tabs) => {
      if (!tabs.length) { sendResponse({ ok: false, error: 'NavBlue tab not found' }); return; }
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        sendResponse(response || { ok: false, error: 'No response' });
      });
    });
    return true;
  }

  // Proxy NavBlue API calls through the NavBlue tab content script (same-origin)
  if (message.type === 'NAVBLUE_FETCH') {
    chrome.tabs.query({ url: '*://*.pbs.vmc.navblue.cloud/*' }, (tabs) => {
      if (!tabs.length) { sendResponse({ ok: false, error: 'NavBlue tab not found' }); return; }
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: 'Content script not ready — refresh the NavBlue tab' });
          return;
        }
        sendResponse(response || { ok: false, error: 'No response from content script' });
      });
    });
    return true;
  }

  // Claude API call — background worker stays awake, no CORS issue
  if (message.type === 'CLAUDE_REQUEST') {
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': message.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(message.payload)
    })
    .then(res => res.json().then(data => ({ res, data })))
    .then(({ res, data }) => {
      if (!res.ok) {
        sendResponse({ error: `Claude API error ${res.status}: ${data?.error?.message || JSON.stringify(data)}` });
      } else {
        sendResponse({ data });
      }
    })
    .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});
