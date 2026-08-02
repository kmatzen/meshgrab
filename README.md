# MeshGrab

A Chrome extension that captures WebGL vertex buffers and textures at upload
time, classifies the vertex attributes, and exports a glTF 2.0 binary you can
open in any glTF-capable tool.

It answers one question: **what did the renderer actually put on the GPU?** That
is often not what the source asset says it should have, and the gap between the
two is where rendering bugs live.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this directory
4. **Reload any tab you want to capture.** Hooks install at `document_start`; a
   tab that was already open when you installed has none.

## Use

Load a page that renders a model, then open the popup from the toolbar. There is
no on-page UI — nothing about the page changes.

The popup shows the inferred vertex and triangle counts, every detected
attribute with its real GPU format, and any textures captured. **Export GLB**
writes the file.

If it reports that no uploads were seen, the geometry reached the GPU before the
hooks ran, or has not uploaded yet. Trigger a fresh upload — reload, or switch
models if the page has a picker — and check again. Geometry frequently uploads
lazily, well after the model first appears on screen.

## What it captures

| | |
|---|---|
| `POSITION` | float vec3 |
| `NORMAL` | float vec3, or byte/short packed vec4 — unpacked and renormalised on export |
| `TANGENT` | float vec4, verified against the normal |
| `TEXCOORD_0` | float vec2 |
| indices | u16 or u32 |
| textures | original encoded bytes, retained from the source `Blob` — not a canvas re-encode |

Textures are triaged into `baseColor` / `metallicRoughness` / `normal` by pixel
statistics and wired into a `pbrMetallicRoughness` material on export.

## How it decides what things are

Attributes are identified by **content**, not by assuming a layout:

- Tangents must be unit length, have `w = ±1`, and be perpendicular to the
  normal. A float `VEC4` that fails those tests is not treated as a tangent.
- Normals are separated from positions by unit-length testing, since both are
  commonly float vec3.
- Vertex count is inferred by **byte-weighted agreement** across buffers.
  Counting how many buffers agree instead would pick decoration: a scene with
  several small helper meshes (ground grids, gizmos) has more buffers agreeing
  on the helper's vertex count than on the model's.
- A per-vertex buffer holding one distinct value across the whole mesh is
  reported as a **dead attribute** — bandwidth being paid for and not used.

## Limits — read before trusting an export

**Not captured at all:**

- **Interleaved vertex buffers.** Engines that pack position, normal and UV into
  a single buffer are not handled; the classifier assumes one attribute per
  buffer and rejects anything over 4 components per vertex. This is the most
  likely reason a given site yields nothing.
- **Quantized attributes.** Positions stored as normalised integers rather than
  floats are not detected.
- **Compressed textures.** Anything uploaded via `compressedTexImage2D` is
  skipped.
- **Textures loaded as `<img>` elements** rather than from a `Blob`. Geometry
  exports correctly; textures come out empty.
- **WebGPU.** No coverage.
- **Rendering inside a worker** with a transferred `OffscreenCanvas`. Content
  scripts do not run in workers, so no hooks reach it.

**Captured but incomplete:**

- **Node and world transforms are lost.** GPU buffers are in local space; the
  engine applies the world matrix in the shader. If a page applies a root
  rotation — a Z-up→Y-up correction, say — the export will not have it and the
  model may import rotated. This is not recoverable from buffer capture.
- **Packed normals were already lossy before capture.** Unpacking 8-bit normals
  returns roughly 0.5° of angular error. If you are chasing a shading artefact,
  compare against the source asset, not against this export.
- **Material scalar factors are invisible.** `metallicFactor`, `roughnessFactor`,
  `baseColorFactor` and friends live in the material definition, not in the
  buffers. Export assumes 1.0. If your import does not match the page, check
  these first.
- **Single primitive only.** A scene split across many meshes exports whichever
  primitive dominates the byte count — the largest object, not the scene.
- **The texture pool accumulates across model switches.** Use **Reset** when
  changing models, or the previous model's maps may be wired into the material.
- **Memory.** Captured buffers are copied, so peak usage is roughly 2× the
  geometry, capped at 640 MB per tab. The popup reports when the cap is hit.

## Permissions

- `host_permissions: <all_urls>` — the hooks must install at `document_start` on
  whatever page you are debugging, which is not known in advance.
- `activeTab` — lets the popup identify and message the tab you are looking at.

No network access, no remote code, no analytics. See `PRIVACY.md`.

## Development

```
node selftest.mjs
```

Runs `hooks.js` against synthesised buffers shaped like a real capture —
including helper-mesh noise — and asserts both the attribute classification and
the structure of the emitted GLB. No browser required.

## Files

| | |
|---|---|
| `hooks.js` | MAIN world, `document_start`. Capture, classification, GLB build |
| `bridge.js` | ISOLATED world. Relays between page and popup |
| `popup.js` / `popup.html` | UI |
| `selftest.mjs` | Node harness for the classifier and GLB writer |

## License

MIT — see `LICENSE`.
