// MeshGrab — ISOLATED-world relay. The MAIN-world hooks can touch the page's
// WebGL objects but have no chrome.* access; the popup has chrome.* but cannot
// see page globals. This sits between them.

(() => {
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__meshgrab !== 'res') return;
    const entry = pending.get(d.id);
    if (!entry) return;
    pending.delete(d.id);
    clearTimeout(entry.timer);
    entry.resolve(d.error ? { error: d.error } : { payload: d.payload });
  });

  const ask = (cmd, opts, timeoutMs = 120000) =>
    new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      window.postMessage({ __meshgrab: 'req', id, cmd, opts }, '*');
    });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'meshgrab') return;
    ask(msg.cmd, msg.opts, msg.cmd === 'download' ? 300000 : 30000).then(sendResponse);
    return true; // async
  });
})();
