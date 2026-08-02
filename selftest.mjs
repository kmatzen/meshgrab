// Self-test for the MeshGrab classifier. Runs hooks.js in a stubbed browser
// environment and feeds it buffers shaped like a real capture, including the
// helper-mesh noise that the byte-weighted vertex-count inference exists to
// survive. Run: node selftest.mjs
import { readFileSync } from 'node:fs';

// --- minimal browser stubs -------------------------------------------------
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.addEventListener = () => {};
const mkCtx = () => {
  function C() {}
  C.prototype.bufferData = function () {};
  C.prototype.texImage2D = function () {};
  C.prototype.texSubImage2D = function () {};
  return C;
};
globalThis.WebGLRenderingContext = mkCtx();
globalThis.WebGL2RenderingContext = mkCtx();

const src = readFileSync(new URL('./hooks.js', import.meta.url), 'utf8');
new Function(src)();
const MG = globalThis.__meshgrab;

// --- synthesise a capture matching the shapes we saw in the wild -----------
const V = 991375;
const T = 1928899;
const push = (target, arr) =>
  MG.bufs.push({ target, ctor: arr.constructor.name, byteLength: arr.byteLength, elems: arr.length, data: arr });

const pos = new Float32Array(V * 3);
const nor = new Int8Array(V * 4);
const uv = new Float32Array(V * 2);
const tan = new Float32Array(V * 4);
const dead = new Uint8Array(V);
const idx = new Uint32Array(T * 3);

for (let i = 0; i < V; i++) {
  pos[i * 3] = (i % 977) / 977 - 0.5;
  pos[i * 3 + 1] = (i % 613) / 613 - 0.5;
  pos[i * 3 + 2] = (i % 419) / 419 - 0.5;
  // unit normal along +Y, packed to bytes
  nor[i * 4] = 0; nor[i * 4 + 1] = 127; nor[i * 4 + 2] = 0; nor[i * 4 + 3] = 0;
  uv[i * 2] = (i % 101) / 101; uv[i * 2 + 1] = (i % 53) / 53;
  // unit tangent along +X, perpendicular to +Y normal, w = -1
  tan[i * 4] = 1; tan[i * 4 + 1] = 0; tan[i * 4 + 2] = 0; tan[i * 4 + 3] = -1;
}
for (let i = 0; i < idx.length; i++) idx[i] = i % V;

push(0x8892, pos);
push(0x8892, nor);
push(0x8892, uv);
push(0x8892, tan);
push(0x8892, dead);
push(0x8893, idx);

// helper meshes: several small 65x65 grids, as a real viewer ships
const GV = 4225;
for (let k = 0; k < 4; k++) {
  push(0x8892, new Float32Array(GV * 3));
  push(0x8892, new Float32Array(GV * 3));
  push(0x8892, new Float32Array(GV * 2));
  push(0x8893, new Uint16Array(24192));
}

// --- assertions ------------------------------------------------------------
const s = MG.summary();
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}${ok ? '' : `  (expected ${want})`}`);
};

check('vertexCount picks model, not helper grid', s.vertexCount, V);
check('triangleCount', s.triangleCount, T);
check('POSITION detected', s.slots.POSITION?.ctor, 'Float32Array');
check('POSITION components', s.slots.POSITION?.comps, 3);
check('NORMAL detected as packed', s.slots.NORMAL?.ctor, 'Int8Array');
check('NORMAL flagged packed', s.slots.NORMAL?.packed, true);
check('TANGENT detected', s.slots.TANGENT?.ctor, 'Float32Array');
check('TANGENT components', s.slots.TANGENT?.comps, 4);
check('TEXCOORD_0 detected', s.slots.TEXCOORD_0?.comps, 2);
check('dead attribute found', s.dead.length, 1);
check('dead attribute value', s.dead[0]?.constantValue, 0);
check('analysis ok', s.ok, true);

// --- GLB build (geometry only; texture path needs a real canvas) -----------
const built = await MG.buildGLB({ includeTextures: false, name: 'selftest' });
const d = built.bytes;
const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
const magic = dv.getUint32(0, true);
const ver = dv.getUint32(4, true);
const total = dv.getUint32(8, true);
const jlen = dv.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(d.subarray(20, 20 + jlen)));
const blen = dv.getUint32(20 + jlen, true);

console.log('');
check('GLB magic', magic, 0x46546c67);
check('GLB version', ver, 2);
check('GLB length == buffer length', total, d.byteLength);
check('BIN chunk ends at EOF', 20 + jlen + 8 + blen, d.byteLength);
check('JSON chunk 4-byte aligned', jlen % 4, 0);
const prim = json.meshes[0].primitives[0];
check('primitive has POSITION', typeof prim.attributes.POSITION, 'number');
check('primitive has NORMAL', typeof prim.attributes.NORMAL, 'number');
check('primitive has TANGENT', typeof prim.attributes.TANGENT, 'number');
check('primitive has TEXCOORD_0', typeof prim.attributes.TEXCOORD_0, 'number');
check('POSITION accessor has min/max', Array.isArray(json.accessors[prim.attributes.POSITION].min), true);
check('index accessor componentType is u32', json.accessors[prim.indices].componentType, 5125);
check('all accessor counts == V', new Set(
  ['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0'].map((k) => json.accessors[prim.attributes[k]].count)
).size, 1);
check('bufferViews within buffer', json.bufferViews.every(
  (b) => b.byteOffset + b.byteLength <= json.buffers[0].byteLength), true);
check('normals unpacked to float vec3', json.accessors[prim.attributes.NORMAL].componentType, 5126);

console.log(fail ? `\n${fail} FAILED` : '\nall checks passed');
process.exit(fail ? 1 : 0);
