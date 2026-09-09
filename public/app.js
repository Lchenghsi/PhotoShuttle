'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = {
  mode: 'recent',
  days: 14,
  kind: 'all',
  items: [],
  byId: new Map(),
  selected: new Set(),
  activeDay: null,
  lastAnchor: null,
  mock: false,
  device: null,
  previewId: null,
  connected: false,
};

const thumbUrl = (id) => '/api/thumb?id=' + encodeURIComponent(id);
const fileInlineUrl = (id) => '/api/file?id=' + encodeURIComponent(id) + '&inline=1';

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ------------------------------------------------------------------ 工具 ---

function fmtSize(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayMeta(day) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (date.getTime() === today.getTime()) return { label: '今天', weekday: WEEKDAYS[date.getDay()] };
  const yesterday = new Date(today.getTime() - 86400_000);
  if (date.getTime() === yesterday.getTime()) return { label: '昨天', weekday: WEEKDAYS[date.getDay()] };
  return { label: `${m}月${d}日`, weekday: WEEKDAYS[date.getDay()] };
}

function kindLabel(it) {
  if (it.kind === 'video') return '视频';
  if (it.kind === 'raw') return 'RAW';
  if (it.kind === 'photo') return it.live ? 'Live Photo' : '照片';
  return it.ext;
}

/** Live Photo 选中静图时，把同名 MOV 动态部分一起带上。 */
function expandedSelection() {
  const out = new Set();
  for (const id of state.selected) {
    const it = state.byId.get(id);
    if (!it) continue;
    out.add(id);
    if (it.live) out.add(id.replace(/\.[^.]+$/, '.MOV'));
  }
  return out;
}

// ------------------------------------------------------------------ 启动 ---

boot();

async function boot() {
  bindEvents();
  applyTheme(localStorage.getItem('autopp-theme') === 'dark' ? 'dark' : 'light');
  window.addEventListener('resize', layoutSticky);
  openSse();
  try {
    const { data } = await api('/api/status');
    state.mock = !!data.mock;
    if (data.settings?.days) {
      state.days = data.settings.days;
      syncModeSeg();
    }
  } catch {
    /* 状态拿不到就继续尝试 index */
  }
  await loadIndex();
}

function bindEvents() {
  $('#modeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    state.days = Number(btn.dataset.days) || state.days;
    state.activeDay = null;
    syncModeSeg();
    loadIndex();
  });

  $('#kindSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-kind]');
    if (!btn) return;
    state.kind = btn.dataset.kind;
    syncKindSeg();
    render();
  });

  $('#btnTheme').addEventListener('click', () => {
    applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
  });

  $('#btnRetry').addEventListener('click', async () => {
    showLoading('正在重试连接…');
    await api('/api/connect', { method: 'POST' });
    await loadIndex();
  });

  $('#btnClear').addEventListener('click', () => {
    for (const id of state.selected) {
      const tile = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
      tile?.classList.remove('selected');
    }
    state.selected.clear();
    updateBottomBar();
    document.querySelectorAll('.day-head').forEach((h) => h.dataset.on !== '1' || syncDayHead(h));
  });

  $('#btnExport').addEventListener('click', () => exportSelection());

  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#btnShutdown')?.addEventListener('click', async () => {
    if (!confirm('确定退出简单传服务？\n（导出进行中时请勿退出）')) return;
    const btn = $('#btnShutdown');
    btn.disabled = true;
    const hint = $('#shutdownHint');
    try {
      await fetch('/api/shutdown', { method: 'POST' });
      if (hint) hint.textContent = '服务已退出，本窗口可关闭。再次启动请双击桌面「简单传」图标。';
    } catch {
      // 服务退出后连接断开属预期
      if (hint) hint.textContent = '服务已退出，本窗口可关闭。再次启动请双击桌面「简单传」图标。';
    }
  });

  $('#btnSettingsClose').addEventListener('click', () => $('#settingsDlg').close());
  $('#btnSettingsSave').addEventListener('click', saveSettings);

  $('#btnBrowse')?.addEventListener('click', async () => {
    const btn = $('#btnBrowse');
    const hint = $('#browseHint');
    btn.disabled = true;
    if (hint) hint.textContent = '正在打开选择窗口…';
    try {
      const { data } = await api('/api/pick-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initial: $('#inpExportDir').value }),
      });
      if (data?.ok && data.path) {
        $('#inpExportDir').value = data.path;
        if (hint) hint.textContent = '已选择：' + data.path;
      } else if (data?.ok) {
        if (hint) hint.textContent = '未选择目录';
      } else {
        if (hint) hint.textContent = data?.error?.message || '打开选择窗口失败';
      }
    } catch (err) {
      if (hint) hint.textContent = '打开选择窗口失败：' + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#btnPreviewClose').addEventListener('click', () => $('#previewDlg').close());
  $('#btnPreviewExport').addEventListener('click', () => {
    if (state.previewId) exportSelection([state.previewId]);
    $('#previewDlg').close();
  });
  $('#btnExportClose').addEventListener('click', () => $('#exportDlg').close());
}

function syncModeSeg() {
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    const match =
      b.dataset.mode === state.mode && (state.mode === 'all' || Number(b.dataset.days) === state.days);
    b.classList.toggle('active', match);
  });
}

function syncKindSeg() {
  document.querySelectorAll('#kindSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.kind === state.kind);
  });
}

function applyTheme(theme) {
  document.body.classList.toggle('dark', theme === 'dark');
  const btn = $('#btnTheme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  try {
    localStorage.setItem('autopp-theme', theme);
  } catch {
    /* 隐私模式等无法写入时忽略 */
  }
}

// ------------------------------------------------------------------ 状态 ---

const ERROR_HINTS = {
  'usbmux-down': {
    icon: '💻',
    title: '未检测到 Apple 移动设备服务',
    text: '请在微软商店安装 "Apple Devices" 应用（或 iTunes）并保持运行，然后用数据线连接 iPhone。',
  },
  'no-device': {
    icon: '📱',
    title: '未检测到 iPhone',
    text: '请用数据线连接 iPhone 并解锁；第一次连接需要在手机上点"信任此电脑"。',
  },
  'not-paired': {
    icon: '🔐',
    title: '手机还没有信任这台电脑',
    text: '解锁 iPhone → 在弹窗中点"信任" → 输入锁屏密码 → 回来点"重试"。',
  },
};

function showBanner(err) {
  const hint = ERROR_HINTS[err?.code] ?? {
    icon: '⚠️',
    title: '读取失败',
    text: err?.message || '未知错误',
  };
  const banner = $('#banner');
  banner.classList.toggle('warn', !ERROR_HINTS[err?.code]);
  $('#bannerIcon').textContent = hint.icon;
  $('#bannerTitle').textContent = hint.title;
  $('#bannerText').textContent = hint.text;
  banner.classList.remove('hidden');
  $('#grid').textContent = '';
  $('#dayStrip').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#bottomBar').classList.add('hidden');
  state.connected = false;
  updateDeviceChip();
}

function hideBanner() {
  $('#banner').classList.add('hidden');
  state.connected = true;
}

/** 多台 iPhone 在线时让用户选一台。 */
function showDevicePicker(devices) {
  const banner = $('#banner');
  banner.classList.remove('hidden');
  $('#bannerIcon').textContent = '📱';
  $('#bannerTitle').textContent = '检测到多台 iPhone，请选择一台';
  $('#bannerText').textContent = '';
  document.getElementById('deviceButtons')?.remove();
  const box = el('div');
  box.id = 'deviceButtons';
  box.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;';
  for (const d of devices) {
    const btn = el('button', 'btn', `${d.connectionType} · ${d.udid.slice(-4)}`);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      showLoading('正在连接设备…');
      try {
        await api('/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ udid: d.udid }),
        });
      } finally {
        hideLoading();
      }
      await loadIndex();
    });
    box.append(btn);
  }
  $('#btnRetry').after(box);
  $('#grid').textContent = '';
  state.connected = false;
  updateDeviceChip();
}

function showLoading(text) {
  $('#loadingText').textContent = text;
  $('#loading').classList.remove('hidden');
}

function hideLoading() {
  $('#loading').classList.add('hidden');
}

function updateDeviceChip() {
  const chip = $('#deviceChip');
  if (state.connected && state.device) {
    chip.textContent = (state.device.name || 'iPhone') + (state.mock ? ' · 模拟' : ' · 已连接');
    chip.classList.remove('hidden');
  } else {
    chip.classList.add('hidden');
  }
}

// ------------------------------------------------------------------ 索引 ---

async function loadIndex() {
  showLoading(
    state.mode === 'all'
      ? '正在读取完整相册（文件很多时需要十几秒）…'
      : '正在连接 iPhone 并读取近期照片…',
  );
  const { data } = await api(`/api/index?mode=${state.mode}&days=${state.days}`);
  hideLoading();

  if (!data?.ok) {
    if (data?.error?.code === 'choose-device') {
      showDevicePicker(data.devices || []);
      return;
    }
    showBanner(data?.error ?? { code: 'unknown', message: '服务无响应' });
    return;
  }
  hideBanner();
  state.device = data.device;
  state.mock = !!data.mock;
  updateDeviceChip();

  state.items = data.items;
  state.byId = new Map(state.items.map((i) => [i.id, i]));
  state.selected = new Set([...state.selected].filter((id) => state.byId.has(id)));
  render();
}

// ------------------------------------------------------------------ 渲染 ---

function kindMatch(it) {
  if (state.kind === 'photo') return it.kind === 'photo' || it.kind === 'raw' || it.kind === 'other';
  if (state.kind === 'video') return it.kind === 'video';
  return true;
}

function groupByDay(items) {
  const map = new Map();
  for (const it of items) {
    if (it.motionPart) continue; // Live Photo 的动态部分随静图一起导出，不单独显示
    if (!kindMatch(it)) continue;
    const key = it.day || '未知日期';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => ({ day, items: list }));
}

function render() {
  layoutSticky();
  renderDayStrip();
  renderGrid();
  updateBottomBar();
}

/** 顶栏在窄窗口会折行，置顶偏移按实际高度动态计算。 */
function layoutSticky() {
  const topbarH = document.getElementById('topbar').getBoundingClientRect().height;
  const strip = document.getElementById('dayStrip');
  const stripH = strip.classList.contains('hidden') ? 0 : strip.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--topbar-h', topbarH + 'px');
  document.documentElement.style.setProperty('--strip-h', stripH + 'px');
}

function renderDayStrip() {
  const strip = $('#dayStrip');
  strip.textContent = '';
  strip.classList.toggle('hidden', state.items.length === 0);
  for (const g of groupByDay(state.items)) {
    const meta = dayMeta(g.day);
    const chip = el('button', 'day-chip' + (g.day === state.activeDay ? ' active' : ''));
    chip.append(el('b', null, meta.label));
    chip.append(el('span', null, `${g.items.length} 项`));
    chip.addEventListener('click', () => {
      state.activeDay = state.activeDay === g.day ? null : g.day;
      render();
      document
        .querySelector(`.day-section[data-day="${CSS.escape(g.day)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    strip.append(chip);
  }
}

const CHUNK = 120;

function renderGrid() {
  const grid = $('#grid');
  grid.textContent = '';
  const groups = groupByDay(state.items);
  $('#empty').classList.toggle('hidden', groups.length > 0);

  for (const g of groups) {
    if (state.activeDay && g.day !== state.activeDay) continue;
    const meta = dayMeta(g.day);

    const section = el('div', 'day-section');
    section.dataset.day = g.day;

    const head = el('div', 'day-head');
    const title = el('span', null, meta.label);
    const sub = el('span', 'weekday', `${meta.weekday} · ${g.items.length} 项`);
    const actions = el('div', 'head-actions');
    const btnSel = el('button', 'mini-btn', '选当天');
    const btnExport = el('button', 'mini-btn primary', '导出该日');
    actions.append(btnSel, btnExport);
    head.append(title, sub, actions);

    head.dataset.on = g.items.every((it) => state.selected.has(it.id)) ? '1' : '0';
    btnSel.textContent = head.dataset.on === '1' ? '取消当天' : '选当天';
    btnSel.addEventListener('click', () => {
      const allOn = g.items.every((it) => state.selected.has(it.id));
      for (const it of g.items) {
        if (allOn) state.selected.delete(it.id);
        else state.selected.add(it.id);
        document
          .querySelector(`.tile[data-id="${CSS.escape(it.id)}"]`)
          ?.classList.toggle('selected', !allOn);
      }
      head.dataset.on = allOn ? '0' : '1';
      btnSel.textContent = allOn ? '选当天' : '取消当天';
      updateBottomBar();
    });
    btnExport.addEventListener('click', () => exportSelection(g.items.map((i) => i.id)));

    const tiles = el('div', 'tiles');
    const sentinel = el('div', 'tile-sentinel');
    sentinel.style.cssText = 'grid-column:1/-1;height:1px;';

    let rendered = 0;
    const renderMore = () => {
      const slice = g.items.slice(rendered, rendered + CHUNK);
      for (const it of slice) tiles.append(makeTile(it));
      rendered += slice.length;
      if (rendered >= g.items.length) {
        observer.disconnect();
        sentinel.remove();
      }
    };
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && renderMore(),
      { rootMargin: '800px' },
    );
    observer.observe(sentinel);

    section.append(head, tiles, sentinel);
    grid.append(section);
    renderMore();
  }
}

function makeTile(it) {
  const tile = el('div', 'tile' + (state.selected.has(it.id) ? ' selected' : ''));
  tile.dataset.id = it.id;

  const img = new Image();
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = it.name;
  img.src = thumbUrl(it.id);
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => {
    img.classList.add('broken');
    tile.classList.add('no-thumb');
  };
  tile.append(img);

  const badges = el('div', 'badges');
  if (it.favorite) badges.append(el('span', 'badge fav', '❤'));
  if (it.kind === 'video') badges.append(el('span', 'badge', it.durationSec ? '▶ ' + fmtDur(it.durationSec) : '▶ 视频'));
  if (it.live) badges.append(el('span', 'badge live', 'LIVE'));
  if (it.kind === 'raw') badges.append(el('span', 'badge', 'RAW'));
  tile.append(badges);
  tile.append(el('div', 'check'));

  // 单击切换选中；双击 / 长按打开预览。
  let pressTimer = null;
  let pressed = false;
  tile.addEventListener('pointerdown', () => {
    pressed = false;
    pressTimer = setTimeout(() => {
      pressed = true;
      openPreview(it.id);
    }, 450);
  });
  const cancelPress = () => clearTimeout(pressTimer);
  tile.addEventListener('pointerup', cancelPress);
  tile.addEventListener('pointerleave', cancelPress);
  tile.addEventListener('click', (e) => {
    if (pressed) return;
    if (e.shiftKey) {
      selectRange(it.id);
      return;
    }
    toggleSelect(it.id);
    state.lastAnchor = it.id;
  });
  tile.addEventListener('dblclick', () => openPreview(it.id));
  return tile;
}

function toggleSelect(id) {
  const on = !state.selected.has(id);
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  document
    .querySelector(`.tile[data-id="${CSS.escape(id)}"]`)
    ?.classList.toggle('selected', on);
  state.lastAnchor = id;
  updateBottomBar();
}

/** 当前筛选（类型 + 某天）下、按展示顺序排列的可见素材。 */
function visibleItems() {
  const flat = groupByDay(state.items).flatMap((g) => g.items);
  return state.activeDay ? flat.filter((i) => i.day === state.activeDay) : flat;
}

/** Shift+点击：从上次点击的项连选到当前项（跟随类型/日期筛选）。 */
function selectRange(endId) {
  const items = visibleItems();
  const a = items.findIndex((i) => i.id === state.lastAnchor);
  const b = items.findIndex((i) => i.id === endId);
  if (a === -1 || b === -1) {
    toggleSelect(endId);
    return;
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) {
    state.selected.add(items[i].id);
    document
      .querySelector(`.tile[data-id="${CSS.escape(items[i].id)}"]`)
      ?.classList.add('selected');
  }
  state.lastAnchor = endId;
  updateBottomBar();
}

function updateBottomBar() {
  const ids = expandedSelection();
  const bar = $('#bottomBar');
  bar.classList.toggle('hidden', ids.size === 0);
  if (ids.size === 0) return;
  let bytes = 0;
  for (const id of ids) bytes += state.byId.get(id)?.size ?? 0;
  $('#selInfo').textContent = `已选 ${ids.size} 项 · ${fmtSize(bytes)}`;
}

// ------------------------------------------------------------------ 预览 ---

let heicLibPromise = null;
function loadHeicLib() {
  heicLibPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/heic2any.min.js';
    s.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error('解码组件不可用')));
    s.onerror = () => reject(new Error('解码组件加载失败'));
    document.head.append(s);
  });
  return heicLibPromise;
}

async function decodeHeic(id, media) {
  try {
    const lib = await loadHeicLib();
    const res = await fetch(fileInlineUrl(id));
    if (!res.ok) throw new Error('原片读取失败');
    const blob = await res.blob();
    const out = await lib({ blob, toType: 'image/jpeg', quality: 0.92 });
    const url = URL.createObjectURL(Array.isArray(out) ? out[0] : out);
    if (!$('#previewDlg').open || state.previewId !== id) {
      URL.revokeObjectURL(url);
      return;
    }
    media.textContent = '';
    media.style.position = 'relative';
    const img = new Image();
    img.src = url;
    media.append(img);
  } catch (err) {
    if (!$('#previewDlg').open || state.previewId !== id) return;
    media.textContent = '';
    media.style.position = 'relative';
    const img = new Image();
    img.src = thumbUrl(id);
    media.append(img);
    const note = el('div', null, 'HEIC 解码失败，已显示设备缩略图');
    note.style.cssText = 'position:absolute;bottom:10px;color:#ffd;font-size:12px;';
    media.append(note);
  }
}

function openPreview(id) {
  const it = state.byId.get(id);
  if (!it) return;
  state.previewId = id;
  const media = $('#previewMedia');
  media.textContent = '';
  if (it.kind === 'video') {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.src = fileInlineUrl(id);
    media.append(video);
  } else if (/^(HEIC|HEIF)$/i.test(it.ext)) {
    const hint = el('div', null, 'HEIC 解码中…');
    hint.style.cssText = 'color:#ddd;font-size:14px;';
    media.append(hint);
    decodeHeic(id, media);
  } else {
    const img = new Image();
    // 浏览器原生支持的格式直接看原片，其余（RAW 等）用设备缩略图。
    img.src = /^(PNG|JPG|JPEG|GIF|WEBP|BMP)$/.test(it.ext) ? fileInlineUrl(id) : thumbUrl(id);
    media.append(img);
  }
  $('#previewTitle').textContent = it.name;
  $('#previewSub').textContent = `${it.day} · ${fmtSize(it.size)} · ${kindLabel(it)}` +
    (it.favorite ? ' · ❤ 收藏' : '') +
    (/^(HEIC|HEIF)$/i.test(it.ext) ? ' · 正在解码原片…' : /\.DNG$/i.test(it.ext) ? ' · 导出后可查看原片' : '');
  $('#previewDlg').showModal();
}

// ------------------------------------------------------------------ 设置 ---

async function openSettings() {
  const { data } = await api('/api/settings');
  $('#inpDays').value = data.settings?.days ?? 14;
  $('#inpExportDir').value = data.settings?.exportDir ?? '';
  $('#inpAutoExit').checked = data.settings?.autoExit !== false;
  $('#settingsDlg').showModal();
}

async function saveSettings() {
  const days = Number($('#inpDays').value) || 14;
  const exportDir = $('#inpExportDir').value.trim();
  await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days, exportDir, autoExit: $('#inpAutoExit').checked }),
  });
  $('#settingsDlg').close();
  if (state.mode === 'recent') {
    state.days = days;
    syncModeSeg();
    loadIndex();
  }
}

// ------------------------------------------------------------------ 导出 ---

function openExportDialog() {
  $('#exportTitle').textContent = '正在导出…';
  $('#exportBar').style.width = '0%';
  $('#exportLine').textContent = '';
  $('#exportLog').textContent = '';
  $('#btnExportClose').classList.add('hidden');
  $('#exportDlg').showModal();
}

function appendExportLine(text) {
  const log = $('#exportLog');
  const line = el('div', null, text);
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

function exportError(message) {
  $('#exportTitle').textContent = '导出失败';
  $('#exportLine').textContent = message;
  $('#btnExportClose').classList.remove('hidden');
}

async function exportSelection(ids) {
  const list = [...(ids ?? expandedSelection())];
  if (list.length === 0) return;
  openExportDialog();
  $('#exportLine').textContent = '首次导出：请在弹出的窗口中选择导出位置…';
  try {
    const { status, data } = await api('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: list }),
    });
    if (!data?.ok) {
      if (data?.cancelled) {
        $('#exportTitle').textContent = '已取消导出';
        $('#exportLine').textContent = '未选择导出位置。可在 ⚙️ 设置里指定导出目录后重试。';
        $('#btnExportClose').classList.remove('hidden');
        return;
      }
      exportError(data?.error?.message || 'HTTP ' + status);
      return;
    }
    $('#exportBar').style.width = '100%';
    $('#exportTitle').textContent = '导出完成';
    const failedNote = data.failed?.length ? `，${data.failed.length} 个失败` : '';
    $('#exportLine').textContent =
      `已导出 ${data.count} 个文件（${fmtSize(data.bytes)}）${failedNote}，资源管理器已打开：${data.target}`;
    $('#btnExportClose').classList.remove('hidden');
    state.selected.clear();
    document.querySelectorAll('.tile.selected').forEach((t) => t.classList.remove('selected'));
    updateBottomBar();
  } catch (err) {
    exportError(err.message);
  }
}

function openSse() {
  const es = new EventSource('/api/events');
  es.addEventListener('export-start', (e) => {
    const d = JSON.parse(e.data);
    $('#exportBar').style.width = '0%';
    $('#exportLine').textContent = `共 ${d.total} 项 → ${d.target}`;
  });
  es.addEventListener('export-progress', (e) => {
    const d = JSON.parse(e.data);
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    $('#exportBar').style.width = pct + '%';
    $('#exportLine').textContent = `${d.done}/${d.total}（${pct}%）`;
    appendExportLine(`✓ ${d.name}`);
  });
  es.addEventListener('export-done', (e) => {
    const d = JSON.parse(e.data);
    if (d.failed?.length) appendExportLine(`⚠ ${d.failed.length} 个文件失败`);
  });
  // 收藏等后台数据就绪：防抖后重拉索引，补上 ❤ 角标。
  es.addEventListener('index-updated', () => {
    clearTimeout(openSse.t);
    openSse.t = setTimeout(() => { loadIndex().catch(() => {}); }, 800);
  });
}
