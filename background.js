// Keeps registered content scripts in sync with granted host permissions.
//
// Without this, revoking a site's access from chrome://extensions would leave a
// stale registration behind: Chrome would refuse to inject it, and the popup
// would report the site as enabled while nothing was actually capturing.

importScripts('sites.js');

// Drop registrations for origins the user has revoked.
chrome.permissions.onRemoved.addListener(async (perms) => {
  for (const pattern of perms.origins || []) {
    try {
      await unregisterForOrigin(pattern);
    } catch (e) {
      console.warn('MeshGrab: failed to unregister', pattern, e);
    }
  }
});

// Reconcile on install and on browser start: any registration whose origin is
// no longer granted is removed. Covers permissions revoked while the worker was
// not running.
const reconcile = async () => {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const stale = [];
    for (const s of scripts) {
      const pattern = s.matches?.[0];
      if (!pattern) continue;
      if (!(await chrome.permissions.contains({ origins: [pattern] }))) stale.push(s.id);
    }
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  } catch (e) {
    console.warn('MeshGrab: reconcile failed', e);
  }
};

chrome.runtime.onInstalled.addListener(reconcile);
chrome.runtime.onStartup.addListener(reconcile);
