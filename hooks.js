// MeshGrab — MAIN-world hooks. Installed at document_start, before any page
// script runs, so the first geometry upload of the session is captured. This is
// the whole reason the extension exists: doing it by hand from the console means
// the model is already on the GPU and you have to force a re-upload to see it.

(() => {
  if (window.__meshgrab) return;

  const ARRAY_BUFFER = 0x8892;
  const ELEMENT_ARRAY_BUFFER = 0x8893;
  const MIN_BUFFER_BYTES = 4096;
  const MAX_CAPTURE_BYTES = 640 * 1024 * 1024; // refuse to OOM the tab

  const MG = (window.__meshgrab = {
    version: '1.0.0',
    capturing: true,
    bufs: [],
    texBlobs: [],
    texBitmaps: [],
    bytes: 0,
    calls: 0,
    notes: [],
  });

  const note = (m) => {
    if (MG.notes.length < 40) MG.notes.push(m);
  };

  // ---------------------------------------------------------------- buffers

  const room = (n) => MG.bytes + n <= MAX_CAPTURE_BYTES;

  for (const Ctx of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    const orig = Ctx.prototype.bufferData;
    if (!orig || orig.__meshgrab) continue;
    const patched = function (target, data /* , usage, ... */) {
      try {
        MG.calls++; // every invocation, even ones we filter out — see MG.calls === 0 below
        if (
          MG.capturing &&
          data &&
          typeof data === 'object' &&
          typeof data.byteLength === 'number' &&
          data.byteLength >= MIN_BUFFER_BYTES &&
          (target === ARRAY_BUFFER || target === ELEMENT_ARRAY_BUFFER)
        ) {
          if (!room(data.byteLength)) {
            if (!MG.__capped) {
              MG.__capped = true;
              note(`capture cap of ${(MAX_CAPTURE_BYTES / 1048576) | 0} MB reached — later uploads dropped`);
            }
          } else {
            // Copy: engines routinely reuse scratch arrays between uploads, so
            // holding the original reference can hand you mutated garbage later.
            const view = ArrayBuffer.isView(data) ? data.slice() : new Uint8Array(data).slice();
            MG.bufs.push({
              target,
              ctor: view.constructor.name,
              byteLength: view.byteLength,
              elems: view.length,
              data: view,
            });
            MG.bytes += view.byteLength;
          }
        }
      } catch (e) {
        note('bufferData hook: ' + e);
      }
      return orig.apply(this, arguments);
    };
    patched.__meshgrab = true;
    Ctx.prototype.bufferData = patched;
  }

  // --------------------------------------------------------------- textures

  // Most engines hand the GPU an ImageBitmap/HTMLImageElement decoded from a
  // Blob. Retaining the Blob keeps the *original encoded bytes*, which is what
  // you want — re-encoding a canvas readback would change them.
  const origCreateURL = URL.createObjectURL;
  if (origCreateURL && !origCreateURL.__meshgrab) {
    const patched = function (obj) {
      const url = origCreateURL.call(this, obj);
      try {
        if (MG.capturing && obj instanceof Blob && /^image\//.test(obj.type || '')) {
          MG.texBlobs.push({ blob: obj, size: obj.size, type: obj.type, via: 'objectURL' });
        }
      } catch {}
      return url;
    };
    patched.__meshgrab = true;
    URL.createObjectURL = patched;
  }

  const origCIB = self.createImageBitmap;
  if (origCIB && !origCIB.__meshgrab) {
    const patched = function (src) {
      try {
        if (MG.capturing && src instanceof Blob && /^image\//.test(src.type || '')) {
          MG.texBlobs.push({ blob: src, size: src.size, type: src.type, via: 'bitmap' });
        }
      } catch {}
      return origCIB.apply(this, arguments);
    };
    patched.__meshgrab = true;
    self.createImageBitmap = patched;
  }

  // Fallback for engines that upload from a canvas or a bitmap they built
  // themselves, where no image Blob ever existed.
  for (const Ctx of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    for (const fn of ['texImage2D', 'texSubImage2D']) {
      const orig = Ctx.prototype[fn];
      if (!orig || orig.__meshgrab) continue;
      const patched = function () {
        try {
          const src = arguments[arguments.length - 1];
          if (
            MG.capturing &&
            src &&
            typeof src === 'object' &&
            !ArrayBuffer.isView(src) &&
            (src.width | 0) >= 64 &&
            (src.height | 0) >= 64
          ) {
            MG.texBitmaps.push({ src, w: src.width, h: src.height, kind: src.constructor?.name });
          }
        } catch {}
        return orig.apply(this, arguments);
      };
      patched.__meshgrab = true;
      Ctx.prototype[fn] = patched;
    }
  }

  // --------------------------------------------------------------- analysis

  const dedupeTextures = () => {
    const seen = new Set();
    const out = [];
    for (const t of MG.texBlobs) {
      const k = t.size + ':' + t.type;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  };

  const stats = (arr, comps, stride) => {
    let unit = 0, wPm1 = 0, n = 0;
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    const count = arr.length / comps;
    const step = Math.max(1, Math.floor(count / 2000)) * (stride || 1);
    for (let i = 0; i < count; i += step) {
      const x = arr[i * comps], y = arr[i * comps + 1], z = arr[i * comps + 2];
      const len = Math.hypot(x, y, z);
      if (Math.abs(len - 1) < 0.02) unit++;
      if (comps === 4 && Math.abs(Math.abs(arr[i * comps + 3]) - 1) < 0.001) wPm1++;
      if (x < mn[0]) mn[0] = x; if (y < mn[1]) mn[1] = y; if (z < mn[2]) mn[2] = z;
      if (x > mx[0]) mx[0] = x; if (y > mx[1]) mx[1] = y; if (z > mx[2]) mx[2] = z;
      n++;
    }
    return { unitFrac: unit / n, wPm1Frac: wPm1 / n, min: mn, max: mx, sampled: n };
  };

  // Pick the vertex count that the most *bytes* agree on. Counting buffers
  // instead loses to decoration: a viewer with several small helper meshes
  // (ground grids, gizmos) has more buffers agreeing on the helper's vertex
  // count than on the model's, and you export the grid instead of the asset.
  const inferVertexCount = (arrays) => {
    const cands = new Set();
    for (const b of arrays) {
      for (const comps of [1, 2, 3, 4]) {
        if (b.elems % comps) continue;
        const v = b.elems / comps;
        if (v >= 16) cands.add(v);
      }
    }
    let best = 0, bestBytes = -1;
    for (const v of cands) {
      let bytes = 0, count = 0;
      for (const b of arrays) {
        if (b.elems % v) continue;
        if (b.elems / v > 4) continue; // >4 components per vertex is not an attribute
        bytes += b.byteLength;
        count++;
      }
      if (count < 2) continue; // need positions plus at least one companion
      if (bytes > bestBytes || (bytes === bestBytes && v > best)) { bestBytes = bytes; best = v; }
    }
    return best;
  };

  MG.analyze = () => {
    const arrays = MG.bufs.filter((b) => b.target === ARRAY_BUFFER);
    const indices = MG.bufs
      .filter((b) => b.target === ELEMENT_ARRAY_BUFFER)
      .sort((a, b) => b.byteLength - a.byteLength);

    if (!arrays.length) return { ok: false, reason: 'no ARRAY_BUFFER uploads captured' };

    const V = inferVertexCount(arrays);
    if (!V) return { ok: false, reason: 'could not infer a vertex count' };

    const candidates = arrays.filter((b) => b.elems % V === 0 && b.elems / V <= 4);
    const slots = { POSITION: null, NORMAL: null, TANGENT: null, TEXCOORD_0: null, COLOR_0: null };
    const dead = [];
    const unclaimed = [];

    for (const b of candidates) {
      const comps = b.elems / V;
      const float = b.ctor === 'Float32Array';
      const s = comps >= 3 ? stats(b.data, comps) : null;
      const info = { ...b, comps, stat: s };

      if (comps === 1) {
        let allSame = true;
        const first = b.data[0];
        for (let i = 0; i < b.elems; i += Math.max(1, (b.elems / 500) | 0)) {
          if (b.data[i] !== first) { allSame = false; break; }
        }
        (allSame ? dead : unclaimed).push({ ...info, constantValue: allSame ? first : undefined });
        continue;
      }
      if (comps === 2 && float) { slots.TEXCOORD_0 ||= info; continue; }
      if (comps === 4 && float && s.unitFrac > 0.9 && s.wPm1Frac > 0.9) { slots.TANGENT ||= info; continue; }
      if (comps === 4 && !float) { slots.NORMAL ||= { ...info, packed: true }; continue; }
      if (comps === 3 && float) {
        if (s.unitFrac > 0.9) slots.NORMAL ||= info;
        else slots.POSITION ||= info;
        continue;
      }
      if (comps === 4 && float) { slots.COLOR_0 ||= info; continue; }
      unclaimed.push(info);
    }

    // A packed-normal buffer can outrank a float one; if POSITION never got
    // filled but a spare float vec3 exists, take it.
    if (!slots.POSITION) {
      const spare = candidates.find((b) => b.ctor === 'Float32Array' && b.elems / V === 3 && b !== slots.NORMAL);
      if (spare) slots.POSITION = { ...spare, comps: 3, stat: stats(spare.data, 3) };
    }

    return {
      ok: !!slots.POSITION,
      reason: slots.POSITION ? null : 'no POSITION-like buffer found',
      vertexCount: V,
      indexCount: indices[0]?.elems || 0,
      triangleCount: indices[0] ? indices[0].elems / 3 : 0,
      slots,
      indices: indices[0] || null,
      dead,
      unclaimed,
      textures: dedupeTextures().map((t) => ({ size: t.size, type: t.type })),
      capturedBytes: MG.bytes,
      notes: MG.notes,
    };
  };

  // Summary safe to structured-clone across the bridge (no typed arrays).
  MG.summary = () => {
    const a = MG.analyze();
    const slim = (s) => (s ? { ctor: s.ctor, comps: s.comps, bytes: s.byteLength, packed: !!s.packed } : null);
    return {
      ok: a.ok,
      reason: a.reason,
      version: MG.version,
      capturing: MG.capturing,
      vertexCount: a.vertexCount || 0,
      triangleCount: a.triangleCount || 0,
      capturedMB: +(MG.bytes / 1048576).toFixed(2),
      bufferCount: MG.bufs.length,
      calls: MG.calls,
      // Distinguishes "hooks never saw an upload" (missed the load — trigger
      // one) from "saw uploads but rejected them" (a filter/heuristic bug).
      hint:
        MG.bufs.length === 0
          ? MG.calls === 0
            ? 'no bufferData calls seen — the upload happened before injection, or off the main thread. Trigger a fresh upload: switch models, or reload with the popup closed.'
            : `saw ${MG.calls} bufferData calls but captured none — all were below the size floor or an unexpected target`
          : null,
      slots: a.slots
        ? Object.fromEntries(Object.entries(a.slots).map(([k, v]) => [k, slim(v)]))
        : {},
      dead: (a.dead || []).map((d) => ({ bytes: d.byteLength, ctor: d.ctor, constantValue: d.constantValue })),
      textures: a.textures || [],
      notes: MG.notes,
    };
  };

  // ---------------------------------------------------------- texture triage

  const classifyTexture = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const N = 96;
    const c = new OffscreenCanvas(N, N);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, N, N);
    const p = ctx.getImageData(0, 0, N, N).data;
    const dim = { w: bmp.width, h: bmp.height };
    bmp.close();

    let n = 0, blueDom = 0;
    const sum = [0, 0, 0], sq = [0, 0, 0];
    for (let i = 0; i < p.length; i += 4) {
      const c3 = [p[i], p[i + 1], p[i + 2]];
      for (let k = 0; k < 3; k++) { sum[k] += c3[k]; sq[k] += c3[k] * c3[k]; }
      if (c3[2] > 200 && Math.abs(c3[0] - 128) < 60 && Math.abs(c3[1] - 128) < 60) blueDom++;
      n++;
    }
    const mean = sum.map((s) => s / n);
    const sd = sq.map((s, k) => Math.sqrt(Math.max(0, s / n - mean[k] * mean[k])));

    let role = 'baseColor';
    if (blueDom / n > 0.6) role = 'normal';
    else if (sd[0] < 6 && mean[2] < 64) role = 'metallicRoughness';

    return { ...dim, role, mean: mean.map((v) => +v.toFixed(1)), sd: sd.map((v) => +v.toFixed(2)) };
  };

  MG.inspectTextures = async () => {
    const out = [];
    for (const t of dedupeTextures()) {
      try {
        out.push({ size: t.size, type: t.type, ...(await classifyTexture(t.blob)) });
      } catch (e) {
        out.push({ size: t.size, type: t.type, error: String(e).slice(0, 120) });
      }
    }
    return out;
  };

  // -------------------------------------------------------------- GLB export

  MG.buildGLB = async (opts = {}) => {
    const a = MG.analyze();
    if (!a.ok) throw new Error(a.reason || 'analysis failed');

    const V = a.vertexCount;
    const pos = a.slots.POSITION.data;

    // exact min/max — required by the glTF spec for POSITION
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V; i++)
      for (let c = 0; c < 3; c++) {
        const v = pos[i * 3 + c];
        if (v < mn[c]) mn[c] = v;
        if (v > mx[c]) mx[c] = v;
      }

    // Unpack byte-quantised normals to float vec3. Lossy in the sense that the
    // 8-bit quantisation already happened upstream — this does not restore it.
    let nor = null;
    const ns = a.slots.NORMAL;
    if (ns) {
      if (ns.packed || ns.comps === 4) {
        const scale = ns.ctor === 'Int8Array' ? 127 : ns.ctor === 'Int16Array' ? 32767 : 1;
        nor = new Float32Array(V * 3);
        for (let i = 0; i < V; i++) {
          let x = ns.data[i * ns.comps] / scale;
          let y = ns.data[i * ns.comps + 1] / scale;
          let z = ns.data[i * ns.comps + 2] / scale;
          const l = Math.hypot(x, y, z) || 1;
          nor[i * 3] = x / l; nor[i * 3 + 1] = y / l; nor[i * 3 + 2] = z / l;
        }
      } else {
        nor = ns.data;
      }
    }

    const uv = a.slots.TEXCOORD_0?.data || null;
    const tan = a.slots.TANGENT?.data || null;
    const idx = a.indices?.data || null;

    const texs = opts.includeTextures === false ? [] : await MG.inspectTextures();
    const blobs = dedupeTextures();

    // One texture per material slot. The capture pool accumulates across model
    // switches, so embedding every blob bloats the file with maps nothing
    // references — reset between models if you switched.
    const chosen = new Map();
    for (let i = 0; i < blobs.length; i++) {
      if (texs[i]?.error) continue;
      const role = texs[i]?.role || 'baseColor';
      if (chosen.has(role)) continue;
      chosen.set(role, { blob: blobs[i].blob, mime: blobs[i].type });
    }
    const imgBytes = [];
    const roles = [];
    for (const [role, v] of chosen) {
      imgBytes.push(new Uint8Array(await v.blob.arrayBuffer()));
      roles.push({ role, mime: v.mime });
    }
    MG.lastExportSkippedTextures = blobs.length - chosen.size;

    const parts = [];
    const add = (arr) => (arr ? (parts.push(arr), parts.length - 1) : -1);
    const iIdx = add(idx);
    const iPos = add(pos);
    const iNor = add(nor);
    const iUv = add(uv);
    const iTan = add(tan);
    const imgStart = parts.length;
    imgBytes.forEach((b) => parts.push(b));

    const offs = [];
    let o = 0;
    for (const p of parts) { offs.push(o); o += p.byteLength; o = (o + 3) & ~3; }
    const bin = new Uint8Array(o);
    parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer, p.byteOffset ?? 0, p.byteLength), offs[i]));

    const bufferViews = parts.map((p, i) => {
      const v = { buffer: 0, byteOffset: offs[i], byteLength: p.byteLength };
      if (i === iIdx) v.target = ELEMENT_ARRAY_BUFFER;
      else if (i < imgStart) v.target = ARRAY_BUFFER;
      return v;
    });

    const accessors = [];
    const attributes = {};
    const acc = (bv, componentType, count, type, extra) =>
      (accessors.push({ bufferView: bv, componentType, count, type, ...extra }), accessors.length - 1);

    let indicesAccessor;
    if (iIdx >= 0) {
      const ct = idx.constructor.name === 'Uint16Array' ? 5123 : 5125;
      indicesAccessor = acc(iIdx, ct, idx.length, 'SCALAR');
    }
    attributes.POSITION = acc(iPos, 5126, V, 'VEC3', { min: mn, max: mx });
    if (iNor >= 0) attributes.NORMAL = acc(iNor, 5126, V, 'VEC3');
    if (iUv >= 0) attributes.TEXCOORD_0 = acc(iUv, 5126, V, 'VEC2');
    if (iTan >= 0) attributes.TANGENT = acc(iTan, 5126, V, 'VEC4');

    const images = [];
    const textures = [];
    const byRole = {};
    roles.forEach((r, i) => {
      images.push({ bufferView: imgStart + i, mimeType: r.mime || 'image/jpeg' });
      textures.push({ source: images.length - 1, sampler: 0 });
      if (byRole[r.role] === undefined) byRole[r.role] = textures.length - 1;
    });

    const material = { name: 'meshgrab_pbr', doubleSided: true, pbrMetallicRoughness: {} };
    if (byRole.baseColor !== undefined) material.pbrMetallicRoughness.baseColorTexture = { index: byRole.baseColor };
    if (byRole.metallicRoughness !== undefined) {
      material.pbrMetallicRoughness.metallicRoughnessTexture = { index: byRole.metallicRoughness };
      material.pbrMetallicRoughness.metallicFactor = 1;
      material.pbrMetallicRoughness.roughnessFactor = 1;
    }
    if (byRole.normal !== undefined) material.normalTexture = { index: byRole.normal };

    const primitive = { attributes, mode: 4 };
    if (indicesAccessor !== undefined) primitive.indices = indicesAccessor;
    if (textures.length) primitive.material = 0;

    const json = {
      asset: { version: '2.0', generator: `MeshGrab ${MG.version} (WebGL buffer capture)` },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: opts.name || 'meshgrab_capture' }],
      meshes: [{ primitives: [primitive] }],
      accessors,
      bufferViews,
      buffers: [{ byteLength: o }],
    };
    if (textures.length) {
      json.materials = [material];
      json.textures = textures;
      json.images = images;
      json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    }

    let js = JSON.stringify(json);
    while (js.length % 4) js += ' ';
    const jsb = new TextEncoder().encode(js);
    const total = 12 + 8 + jsb.length + 8 + bin.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsb.length, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsb, 20);
    const bo = 20 + jsb.length;
    dv.setUint32(bo, bin.length, true);
    dv.setUint32(bo + 4, 0x004e4942, true);
    out.set(bin, bo + 8);

    return { bytes: out, total, vertexCount: V, triangleCount: a.triangleCount, textures: texs };
  };

  MG.download = async (opts = {}) => {
    const built = await MG.buildGLB(opts);
    const name = (opts.filename || `meshgrab-${location.hostname}-${built.vertexCount}v`) + '.glb';
    const url = URL.createObjectURL(new Blob([built.bytes], { type: 'model/gltf-binary' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 120000);
    return { filename: name, total: built.total, vertexCount: built.vertexCount, triangleCount: built.triangleCount };
  };

  MG.reset = () => {
    MG.bufs.length = 0;
    MG.texBlobs.length = 0;
    MG.texBitmaps.length = 0;
    MG.bytes = 0;
    MG.calls = 0;
    MG.notes.length = 0;
    MG.__capped = false;
  };

  // ----------------------------------------------------------- bridge intake

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__meshgrab !== 'req') return;
    const reply = (payload, error) =>
      window.postMessage({ __meshgrab: 'res', id: d.id, payload, error: error ? String(error) : null }, '*');
    try {
      if (d.cmd === 'summary') reply(MG.summary());
      else if (d.cmd === 'textures') reply(await MG.inspectTextures());
      else if (d.cmd === 'download') reply(await MG.download(d.opts || {}));
      else if (d.cmd === 'reset') { MG.reset(); reply({ reset: true }); }
      else if (d.cmd === 'pause') { MG.capturing = !MG.capturing; reply({ capturing: MG.capturing }); }
      else reply(null, 'unknown command: ' + d.cmd);
    } catch (e) {
      reply(null, e);
    }
  });
})();
