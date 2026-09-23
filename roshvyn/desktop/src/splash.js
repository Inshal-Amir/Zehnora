'use strict';
const statusEl = document.getElementById('status');
window.splash.onStatus((text) => { statusEl.textContent = text; });
window.splash.onNeedKey((portalUrl) => {
  statusEl.textContent = 'An API key is needed to use the Roshvyn model.';
  document.getElementById('keyform').style.display = 'block';
  document.getElementById('portal').addEventListener('click', (e) => { e.preventDefault(); window.splash.openPortal(portalUrl); });
});
document.getElementById('keyform').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await window.splash.saveKey(document.getElementById('key').value);
    document.getElementById('keyform').style.display = 'none';
  } catch (err) {
    document.getElementById('err').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': /, '');
  }
});
