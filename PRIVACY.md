# Privacy

MeshGrab does not collect, transmit, or store any user data.

## What it does

The extension installs hooks on the WebGL APIs of pages you visit and retains
vertex buffers and texture bytes **in the memory of the tab being inspected**.
That data is used to build a glTF file when you click Export, which is saved
through Chrome's normal download flow to your own machine.

## What it does not do

- **No network requests.** The extension makes no outbound connections of any
  kind. There is no server, no telemetry, no analytics, no error reporting.
- **No remote code.** All code ships in the package. Nothing is fetched or
  evaluated at runtime.
- **No persistence.** Captured data lives only in the inspected tab's memory and
  is discarded when the tab is closed, navigated, or Reset. Nothing is written
  to extension storage, cookies, or `localStorage`.
- **No page content is read** beyond the WebGL buffers and texture blobs the
  page uploads to the GPU. Form fields, cookies, credentials, and page text are
  never accessed.

## Permissions and why

MeshGrab requests **no host access at install time**. It cannot read or run on
any site until you explicitly enable that site.

- `optional_host_permissions: *://*/*` — declares the set of sites you may
  later choose from. Nothing is granted by declaring it. Clicking **Enable on
  this site** requests access to that one origin, and Chrome shows you the
  prompt.
- `scripting` — registers the capture hooks for an origin you have enabled, so
  they install at document start on subsequent loads.
- `activeTab` — lets the popup read the current tab's URL, so it can show you
  which site you are about to enable.

Access is per-origin and reversible. **Disable on this site** revokes the
permission and unregisters the hooks; revoking from `chrome://extensions` has
the same effect, and the extension reconciles its registrations to match.

## Verifying this

The claims above are checkable from the source, which is small and unminified.

No network or dynamic-evaluation APIs are used anywhere:

```
grep -rE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|eval\(|new Function" *.js *.html
```

This returns nothing.

Two matches do exist for a broader search, and neither moves data anywhere:

- `background.js` calls `importScripts('sites.js')` — the service worker loading
  a file from inside this extension. It takes no URL and cannot fetch remotely.
- `sites.js` contains `https://example.com` in a comment illustrating how a URL
  is converted to an origin pattern.

There is no code path that moves data off your machine.
