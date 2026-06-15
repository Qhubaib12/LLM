const STORAGE_PREFIX = 'pes:v1:';
const SETTINGS_KEY = 'pes:settings';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(SETTINGS_KEY, (data) => {
    if (!data[SETTINGS_KEY]) chrome.storage.local.set({ [SETTINGS_KEY]: { disabledUrls: {} } });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'PES_NOTIFY') {
        await chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.svg',
          title: 'Page Edit Saver',
          message: String(message.message || 'Done')
        });
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'PES_COUNT') {
        const all = await chrome.storage.local.get(null);
        sendResponse({ ok: true, count: Object.keys(all).filter((k) => k.startsWith(STORAGE_PREFIX)).length });
        return;
      }
      sendResponse({ ok: false, error: 'Unknown background message.' });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true;
});
