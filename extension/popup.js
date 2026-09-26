const $ = (id) => document.getElementById(id);
let tab;

function setStatus(msg) { $('status').textContent = msg; }

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const saved = await chrome.storage.local.get(['metaKey', 'json', 'max']);
  if (saved.metaKey) $('metaKey').value = saved.metaKey;
  if (saved.json !== undefined) $('json').checked = saved.json;
  if (saved.max !== undefined) $('max').value = saved.max;

  let url;
  try { url = new URL(tab.url); } catch { url = null; }
  const onSite = url && /(^|\.)dotandkey\.com$/.test(url.hostname);
  if (!onSite) {
    $('scrapeProduct').disabled = true;
    $('scrapeCollection').disabled = true;
    return;
  }
  const prod = url.pathname.match(/\/products\/([^/?#]+)/);
  const coll = url.pathname.match(/\/collections\/([^/?#]+)/);
  if (coll) $('collection').value = coll[1];
  $('scrapeProduct').disabled = !prod;
  $('pageInfo').textContent = prod
    ? `Product page: ${prod[1]}`
    : coll ? `Collection page: ${coll[1]}` : 'On dotandkey.com — enter a collection handle.';
}

async function run(mode) {
  const metaKey = $('metaKey').value.trim();
  if (!/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(metaKey)) {
    setStatus('Metafield must look like namespace.key');
    return;
  }
  const config = {
    mode,
    collection: $('collection').value.trim() || 'shop-all',
    max: Math.max(0, parseInt($('max').value, 10) || 0),
    json: $('json').checked,
    metaKey,
  };
  await chrome.storage.local.set({ metaKey, json: config.json, max: config.max });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { cmd: 'dk-scrape', config });
    setStatus('Started — watch the progress panel on the page. You can close this popup.');
  } catch (e) {
    setStatus('Error: ' + e.message);
  }
}

$('scrapeProduct').addEventListener('click', () => run('product'));
$('scrapeCollection').addEventListener('click', () => run('collection'));
init();
