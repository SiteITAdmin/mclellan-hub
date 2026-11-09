'use strict';
(() => {
  const status = document.getElementById('notification-status');
  const button = document.getElementById('enable-notifications');
  if (!button) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { status.textContent = 'Push is unavailable here. On iPhone, add the Hub to your Home Screen and open it there.'; button.disabled = true; return; }
  const send = async (path, body) => { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Unable to save notifications'); return data; };
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not allowed. You can change this in browser settings.');
      const registration = await navigator.serviceWorker.register('/crm-worker.js'); await navigator.serviceWorker.ready;
      const key = document.getElementById('notification-key').value.replace(/-/g,'+').replace(/_/g,'/');
      const bytes = Uint8Array.from(atob(key + '='.repeat((4-key.length%4)%4)), c => c.charCodeAt(0));
      const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      const spaces = Array.from(document.querySelectorAll('input[name="spaces"]:checked')).map(x => x.value);
      await send('/crm/notifications/subscribe', { subscription: subscription.toJSON(), spaces });
      status.textContent = 'Notifications enabled for this device.';
    } catch (e) { status.textContent = e.message; }
    finally { button.disabled = false; }
  });
  document.getElementById('disable-notifications').addEventListener('click', async () => {
    try { const registration = await navigator.serviceWorker.getRegistration('/crm-worker.js'); const sub = await registration?.pushManager.getSubscription(); if(sub){await send('/crm/notifications/unsubscribe',{endpoint:sub.endpoint});await sub.unsubscribe();}status.textContent='Notifications disabled on this device.'; }
    catch(e){status.textContent=e.message;}
  });
})();
