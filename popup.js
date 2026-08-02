const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString();
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

let tabId = null;

const send = async (cmd, opts) => {
  if (tabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    $('host').textContent = tab?.url ? new URL(tab.url).hostname : '—';
  }
  try {
    const res = await chrome.tabs.sendMessage(tabId, { target: 'meshgrab', cmd, opts });
    return res || { error: 'no response from page' };
  } catch (e) {
    return { error: 'content script not present — reload the tab after installing' };
  }
};

const row = (k, v, cls) =>
  `<div class="row"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`;

const renderCapture = (s) => {
  if (!s) return;
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
          const desc = `${a.ctor.replace('Array', '')}×${a.comps}${a.packed ? ' packed' : ''} · ${mb(a.bytes)}`;
          return row(k, desc);
        })
        .join('') +
      (s.dead?.length
        ? s.dead
            .map((d) =>
              row(
                'dead attribute',
                `<span class="tag warn">${mb(d.bytes)} constant ${d.constantValue}</span>`
              )
            )
            .join('')
        : '')
    : '<span class="empty">none detected</span>';

  const notes = [...(s.notes || [])];
  if (s.hint) notes.unshift(s.hint);
  if (notes.length) {
    $('attrs').innerHTML += `<div class="note">${notes.join('<br>')}</div>`;
  }
  $('export').disabled = !s.ok;
};

const renderTextures = (list) => {
  if (!list?.length) {
    $('texs').innerHTML = '<span class="empty">none captured</span>';
    return;
  }
  $('texs').innerHTML = list
    .map((t) =>
      t.error
        ? row('error', `<span class="tag bad">${t.error}</span>`)
        : row(t.role, `${t.w}×${t.h} · ${mb(t.size)}`)
    )
    .join('');
};

const refresh = async () => {
  $('status').textContent = 'reading page…';
  const r = await send('summary');
  if (r.error) {
    $('status').textContent = r.error;
    $('capture').innerHTML = `<span class="tag bad">${r.error}</span>`;
    return;
  }
  renderCapture(r.payload);
  $('status').textContent = '';
  const t = await send('textures');
  if (!t.error) renderTextures(t.payload);
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

refresh();
