'use strict';
const dot = document.getElementById('dot');
const label = document.getElementById('label');
async function refresh() {
  const s = await window.zehnora.status();
  const ok = s.librechat && s.modelApi === 'online';
  dot.style.background = ok ? '#2ed3c3' : '#f0697a';
  label.textContent = `Workspace: ${s.workspace ?? 'not selected'} · Model API: ${s.modelApi}`;
  document.body.title = `Model API ${s.apiBase} · approval window ${s.approvalBridge ? 'ready' : 'not listening'}`;
}
document.getElementById('folder').addEventListener('click', async () => { await window.zehnora.chooseWorkspace(); refresh(); });
document.getElementById('account').addEventListener('click', () => window.zehnora.openPortal());
refresh();
setInterval(refresh, 15000);
