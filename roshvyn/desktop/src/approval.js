'use strict';
const q = new URLSearchParams(location.search);
const id = q.get('id');
for (const k of ['command', 'cwd', 'workspace', 'shell', 'reason']) document.getElementById(k).textContent = q.get(k) || '—';
document.getElementById('deny').addEventListener('click', () => window.approval.decide(id, false));
document.getElementById('approve').addEventListener('click', () => window.approval.decide(id, true));
let left = 120;
setInterval(() => { left -= 1; document.getElementById('left').textContent = String(Math.max(left, 0)); }, 1000);
