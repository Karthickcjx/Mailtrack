// Phase 0 service worker skeleton. No permissions, no network, no OAuth yet.
chrome.runtime.onInstalled.addListener((details) => {
  console.info('[tracklet] installed:', details.reason, 'id:', chrome.runtime.id);
});
