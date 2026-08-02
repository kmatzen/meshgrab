// Shared helpers for per-site enablement. Loaded by both the popup and the
// service worker.
//
// MeshGrab holds no host permissions at install. A site is enabled only when
// the user asks for it, which grants that one origin and registers the content
// scripts for it. Registration persists across restarts, which is what keeps
// document_start capture working on later loads.

/* exported originPatternFor, scriptIdsFor, registerForOrigin, unregisterForOrigin,
   isEnabled, isRegistered */

/** "https://example.com/path" -> "https://example.com/*" (null if not http/https) */
function originPatternFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return `${u.protocol}//${u.hostname}/*`;
}

/** Content-script ids are derived from the origin so they can be found again. */
function scriptIdsFor(pattern) {
  const slug = pattern.replace(/[^a-zA-Z0-9]/g, '-');
  return { hooks: `hooks-${slug}`, bridge: `bridge-${slug}` };
}

async function isEnabled(pattern) {
  if (!pattern) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}

/**
 * Permission and registration are independent pieces of state and they drift:
 * reloading an unpacked extension clears dynamic registrations while granted
 * optional permissions survive. Callers must check this separately rather than
 * treating a granted permission as proof the hooks will run.
 */
async function isRegistered(pattern) {
  if (!pattern) return false;
  const ids = Object.values(scriptIdsFor(pattern));
  const existing = await chrome.scripting.getRegisteredContentScripts();
  return ids.every((id) => existing.some((s) => s.id === id));
}

async function registerForOrigin(pattern) {
  const ids = scriptIdsFor(pattern);
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const have = new Set(existing.map((s) => s.id));

  const wanted = [
    {
      id: ids.hooks,
      matches: [pattern],
      js: ['hooks.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      persistAcrossSessions: true,
    },
    {
      id: ids.bridge,
      matches: [pattern],
      js: ['bridge.js'],
      runAt: 'document_start',
      world: 'ISOLATED',
      allFrames: true,
      persistAcrossSessions: true,
    },
  ].filter((s) => !have.has(s.id));

  if (wanted.length) await chrome.scripting.registerContentScripts(wanted);
}

async function unregisterForOrigin(pattern) {
  const ids = Object.values(scriptIdsFor(pattern));
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const drop = existing.filter((s) => ids.includes(s.id)).map((s) => s.id);
  if (drop.length) await chrome.scripting.unregisterContentScripts({ ids: drop });
}
