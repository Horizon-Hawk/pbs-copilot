// On install/reload, re-inject content script into any already-open NavBlue tabs
// Without this, reloading the extension leaves existing tabs with no content script
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: '*://*.pbs.vmc.navblue.cloud/*' }, (tabs) => {
    for (const tab of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      }).catch(() => {});
    }
  });
});

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
    // Persist so sidebar can read it on open even if the broadcast was missed
    chrome.storage.local.set({ navblueSession: message.data });
    chrome.runtime.sendMessage({ type: 'NAVBLUE_DATA', data: message.data }).catch(() => {});
    return false;
  }

  // Forward intercepted pairings data from content script to sidebar
  if (message.type === 'NAVBLUE_PAIRINGS_CAPTURED') {
    // Persist so sidebar can read it on open even if the broadcast was missed
    chrome.storage.local.set({ cachedPairingsXml: message.data, cachedPairingsUrl: message.url });
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

  // Claude API call — proxied through Vercel backend (API key stays server-side)
  if (message.type === 'CLAUDE_REQUEST') {
    chrome.storage.local.get('licenseKey', async ({ licenseKey }) => {
      try {
        const res = await fetch('https://pbs-copilot-backend.vercel.app/api/claude', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ license_key: licenseKey || '', ...message.payload })
        });
        const data = await res.json();
        if (!res.ok) {
          sendResponse({ error: data.error || `Server error ${res.status}` });
        } else {
          sendResponse({ data });
        }
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  return false;
});
