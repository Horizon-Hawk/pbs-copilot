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

// Route messages between content script and sidebar
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NAVBLUE_DATA') {
    // Forward NavBlue session data from content script to sidebar
    chrome.runtime.sendMessage({ type: 'NAVBLUE_DATA', data: message.data });
  }
  return true;
});
