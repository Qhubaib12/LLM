const STORAGE_PREFIX = 'pes:v1:';
const SETTINGS_KEY = 'pes:settings';
const els = {
  pageUrl: document.getElementById('pageUrl'), savedCount: document.getElementById('savedCount'), savedState: document.getElementById('savedState'),
  saveBtn: document.getElementById('saveBtn'), restoreBtn: document.getElementById('restoreBtn'), deleteBtn: document.getElementById('deleteBtn'),
  disableToggle: document.getElementById('disableToggle'), exportBtn: document.getElementById('exportBtn'), importFile: document.getElementById('importFile'), status: document.getElementById('status')
};
let activeTab;

const storageKey = (url) => STORAGE_PREFIX + url;
const setStatus = (text, kind = '') => { els.status.textContent = text; els.status.className = `status ${kind}`; };
const canUse = (url) => url && /^(https?|file):/i.test(url);
const localGet = (keys) => chrome.storage.local.get(keys);
const localSet = (obj) => chrome.storage.local.set(obj);
const localRemove = (keys) => chrome.storage.local.remove(keys);

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function sendToTab(type, payload = {}) {
  try { return await chrome.tabs.sendMessage(activeTab.id, { type, ...payload }); }
  catch (error) { throw new Error('This page cannot be edited by extensions. Try an http(s) page and refresh it.'); }
}
async function getSettings() {
  const data = await localGet(SETTINGS_KEY);
  return data[SETTINGS_KEY] || { disabledUrls: {} };
}
async function saveSettings(settings) { await localSet({ [SETTINGS_KEY]: settings }); }
async function notify(message) { try { await chrome.runtime.sendMessage({ type: 'PES_NOTIFY', message }); } catch (_) {} }

async function refreshUi() {
  activeTab = await getActiveTab();
  els.pageUrl.textContent = activeTab?.url || 'No active tab';
  const usable = canUse(activeTab?.url);
  for (const b of [els.saveBtn, els.restoreBtn, els.deleteBtn, els.disableToggle]) b.disabled = !usable;
  if (!usable) setStatus('Chrome internal pages and the Web Store are not accessible.', 'err');
  const all = await localGet(null);
  const key = storageKey(activeTab?.url || '');
  const has = Boolean(all[key]);
  els.savedCount.textContent = Object.keys(all).filter((k) => k.startsWith(STORAGE_PREFIX)).length;
  els.savedState.textContent = has ? 'Saved' : 'Not saved';
  els.savedState.style.background = has ? '#dcfce7' : '#f1f5f9';
  els.savedState.style.color = has ? '#166534' : '#475569';
  const settings = await getSettings();
  els.disableToggle.checked = Boolean(settings.disabledUrls?.[activeTab?.url]);
}

els.saveBtn.addEventListener('click', async () => {
  try {
    setStatus('Detecting DOM changes…');
    const response = await sendToTab('PES_CAPTURE');
    if (!response?.ok) throw new Error(response?.error || 'Capture failed.');
    await localSet({ [storageKey(activeTab.url)]: response.snapshot });
    setStatus(`Saved ${response.snapshot.operations.length} changes for this URL.`, 'ok');
    await notify('Saved current page changes.');
    await refreshUi();
  } catch (error) { setStatus(error.message, 'err'); }
});
els.restoreBtn.addEventListener('click', async () => {
  try {
    const data = await localGet(storageKey(activeTab.url));
    const snapshot = data[storageKey(activeTab.url)];
    if (!snapshot) throw new Error('No saved version for this URL.');
    const response = await sendToTab('PES_RESTORE', { snapshot, force: true });
    if (!response?.ok) throw new Error(response?.error || 'Restore failed.');
    setStatus(`Restored ${response.applied} changes.`, 'ok');
    await notify('Restored saved version.');
  } catch (error) { setStatus(error.message, 'err'); }
});
els.deleteBtn.addEventListener('click', async () => {
  try { await localRemove(storageKey(activeTab.url)); setStatus('Deleted saved version for this URL.', 'ok'); await refreshUi(); }
  catch (error) { setStatus(error.message, 'err'); }
});
els.disableToggle.addEventListener('change', async () => {
  const settings = await getSettings();
  settings.disabledUrls ||= {};
  if (els.disableToggle.checked) settings.disabledUrls[activeTab.url] = true; else delete settings.disabledUrls[activeTab.url];
  await saveSettings(settings);
  setStatus(els.disableToggle.checked ? 'Automatic restoration disabled for this URL.' : 'Automatic restoration enabled for this URL.', 'ok');
});
els.exportBtn.addEventListener('click', async () => {
  const all = await localGet(null);
  const payload = { app: 'Page Edit Saver', version: 1, exportedAt: new Date().toISOString(), data: all };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'page-edit-saver-export.json'; a.click(); URL.revokeObjectURL(url);
  setStatus('Exported saved modifications.', 'ok');
});
els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files[0]; if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const allowed = Object.fromEntries(Object.entries(data).filter(([k]) => k.startsWith(STORAGE_PREFIX) || k === SETTINGS_KEY));
    await localSet(allowed); setStatus(`Imported ${Object.keys(allowed).length} records.`, 'ok'); await refreshUi();
  } catch (error) { setStatus(`Import failed: ${error.message}`, 'err'); }
  finally { els.importFile.value = ''; }
});
refreshUi().catch((e) => setStatus(e.message, 'err'));
