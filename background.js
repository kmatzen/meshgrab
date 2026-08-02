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

// Reconcile registrations against granted permissions, in both directions.
//
// Removing stale registrations is the obvious half. The other half matters more
// in practice: reloading or updating the extension drops dynamic registrations
// while granted optional permissions survive, leaving sites the user enabled
// with no hooks. Without restoring them the popup reports the site as enabled
// and nothing ever captures, and reloading the page cannot fix it.
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

    const granted = await chrome.permissions.getAll();
    for (const pattern of granted.origins || []) {
      try {
        await registerForOrigin(pattern);
      } catch (e) {
        console.warn('MeshGrab: could not restore registration for', pattern, e);
      }
    }
  } catch (e) {
    console.warn('MeshGrab: reconcile failed', e);
  }
};

chrome.runtime.onInstalled.addListener(reconcile);
chrome.runtime.onStartup.addListener(reconcile);
