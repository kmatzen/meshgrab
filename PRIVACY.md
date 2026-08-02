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

- `host_permissions: <all_urls>` — hooks must install at document start on
  whatever page you choose to debug, which cannot be known in advance. This
  grants the ability to run on any site; it is not used to send anything
  anywhere.
- `activeTab` — lets the popup identify and message the tab you have open.

## Verifying this

The claims above are checkable from the source, which is small and unminified:

```
grep -rE "fetch\(|XMLHttpRequest|WebSocket|importScripts|eval\(|new Function|https?://" *.js *.html
```

This returns nothing. There is no code path that moves data off your machine.
