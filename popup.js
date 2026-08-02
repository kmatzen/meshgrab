const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString();
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
const show = (id, on) => $(id).classList.toggle('hidden', !on);

let tab = null;
let pattern = null;

const send = async (cmd, opts) => {
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { target: 'meshgrab', cmd, opts });
    return res || { error: 'no response' };
  } catch {
    // No receiver: the content script is not in this page yet.
    return { error: 'no-content-script' };
  }
};

const row = (k, v, cls) =>
  `<div class="row"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`;

const renderCapture = (s) => {
  const badge = s.ok
    ? '<span class="tag ok">mesh found</span>'
    : `<span class="tag bad">${s.reason || 'no mesh'}</span>`;
  $('capture').innerHTML =
    row('status', badge) +
    row('vertices', fmt(s.vertexCount)) +
    row('triangles', fmt(s.triangleCount)) +
    row('buffers', fmt(s.bufferCount)) +
    row('captured', s.capturedMB + ' MB') +
    (s.capturing ? '' : row('capture', '<span class="tag warn">paused</span>'));

  const order = ['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'COLOR_0'];
  const found = order.filter((k) => s.slots?.[k]);
  $('attrs').innerHTML = found.length
    ? found
        .map((k) => {
          const a = s.slots[k];
          return row(k, `${a.ctor.replace('Array', '')}×${a.comps}${a.packed ? ' packed' : ''} · ${mb(a.bytes)}`);
        })
        .join('') +
      (s.dead || [])
        .map((d) => row('dead attribute', `<span class="tag warn">${mb(d.bytes)} constant ${d.constantValue}</span>`))
        .join('')
    : '<span class="empty">none detected</span>';

  const notes = [...(s.notes || [])];
  if (s.hint) notes.unshift(s.hint);
  if (notes.length) $('attrs').innerHTML += `<div class="note">${notes.join('<br>')}</div>`;

  $('export').disabled = !s.ok;
};

const renderTextures = (list) => {
  $('texs').innerHTML = list?.length
    ? list
        .map((t) =>
          t.error
            ? row('error', `<span class="tag bad">${t.error}</span>`)
            : row(t.role, `${t.w}×${t.h} · ${mb(t.size)}`)
        )
        .join('')
    : '<span class="empty">none captured</span>';
};

// ---------------------------------------------------------------- view state

const showGate = () => { show('gate', true); show('needsReload', false); show('main', false); };
const showReload = () => { show('gate', false); show('needsReload', true); show('main', false); };
const showMain = () => { show('gate', false); show('needsReload', false); show('main', true); };

const refresh = async () => {
  const enabled = await isEnabled(pattern);
  if (!enabled) return showGate();

  const r = await send('summary');
  if (r.error === 'no-content-script') return showReload();
  if (r.error) {
    showMain();
    $('capture').innerHTML = `<span class="tag bad">${r.error}</span>`;
    return;
  }

  showMain();
  renderCapture(r.payload);
  $('status').textContent = '';
  const t = await send('textures');
  if (!t.error) renderTextures(t.payload);
};

// ------------------------------------------------------------------ handlers

$('enable').onclick = async () => {
  $('enable').disabled = true;
  $('status').textContent = 'requesting access…';
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (e) {
    $('status').textContent = 'request failed: ' + e;
  }
  if (!granted) {
    $('enable').disabled = false;
    $('status').textContent = 'access declined — nothing changed';
    return;
  }
  try {
    await registerForOrigin(pattern);
  } catch (e) {
    $('status').textContent = 'registration failed: ' + e;
    $('enable').disabled = false;
    return;
  }
  chrome.tabs.reload(tab.id);
  window.close();
};

$('reload').onclick = () => {
  chrome.tabs.reload(tab.id);
  window.close();
};

$('disable').onclick = async () => {
  $('status').textContent = 'removing access…';
  try {
    await unregisterForOrigin(pattern);
    await chrome.permissions.remove({ origins: [pattern] });
  } catch (e) {
    $('status').textContent = 'failed: ' + e;
    return;
  }
  await refresh();
  $('status').textContent = 'access removed for this site';
};

$('refresh').onclick = refresh;

$('reset').onclick = async () => {
  await send('reset');
  $('status').textContent = 'buffers cleared — reload the page to re-capture';
  refresh();
};

$('export').onclick = async () => {
  $('export').disabled = true;
  $('status').textContent = 'building GLB… (large meshes take a few seconds)';
  const r = await send('download');
  if (r.error) {
    $('status').textContent = 'export failed: ' + r.error;
  } else {
    const p = r.payload;
    $('status').textContent = `${p.filename} — ${mb(p.total)}, ${fmt(p.vertexCount)}v / ${fmt(p.triangleCount)}t`;
  }
  $('export').disabled = false;
};

// ---------------------------------------------------------------------- init

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pattern = originPatternFor(tab?.url || '');

  if (!pattern) {
    $('host').textContent = '—';
    $('status').textContent = 'MeshGrab only works on http and https pages.';
    return;
  }

  const host = new URL(tab.url).hostname;
  $('host').textContent = host;
  $('gate-host').textContent = host;
  await refresh();
})();
