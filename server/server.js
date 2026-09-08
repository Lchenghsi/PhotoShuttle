import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { RealLibrary } from './library.js';
import { MockLibrary } from './mock.js';
import { Exporter } from './exporter.js';
import { listDevices } from './device/usbmux.js';

// SEA 单文件环境里 import.meta.url 的垫片是 undefined，取目录走安全回退。
let __dirname = process.cwd();
try {
  __dirname = path.dirname(fileURLToPath(import.meta.url));
} catch {
  /* SEA 模式：静态资源走内嵌，__dirname 仅作回退 */
}
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const FILE_MIME = {
  HEIC: 'image/heic',
  HEIF: 'image/heif',
  JPG: 'image/jpeg',
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  GIF: 'image/gif',
  MOV: 'video/quicktime',
  MP4: 'video/mp4',
  M4V: 'video/mp4',
  DNG: 'image/x-adobe-dng',
};

const DEFAULT_SETTINGS = {
  days: 14,
  exportDir: path.join(os.homedir(), 'Pictures', 'iPhone照片导出'),
  exportDirChosen: false,
  autoExit: true,      // SEA exe 模式：应用窗口关闭后自动退出服务
  deviceUdid: '',      // 多设备时记住用户选择
};

function loadSettings(dataDir) {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ------------------------------------------------- 原生文件夹选择对话框 ---

let activePicker = null; // 当前打开的选择窗口进程（可能被用户遗忘在后台）

/**
 * 弹出 Windows 原生的文件夹选择窗口（FolderBrowserDialog）。
 * 返回所选路径；用户取消或出错返回 null。用 PowerShell 调 WinForms，零外部依赖。
 *
 * 关键点：先 Show 一个 1×1、全透明、置顶的宿主窗口再 ShowDialog，
 * 否则对话框会出现在当前前台窗口（浏览器）的后面，看起来像按钮没反应。
 */
function pickFolderDialog(initialPath) {
  return new Promise((resolve) => {
    // 上一次的对话框还开着（被遗忘在后台）时，先关掉它，避免新请求被卡。
    if (activePicker && !activePicker.killed) {
      try { activePicker.kill(); } catch { /* 已退出 */ }
    }
    const initial =
      typeof initialPath === 'string' && initialPath.trim() && fs.existsSync(initialPath.trim())
        ? initialPath.trim().replace(/'/g, "''")
        : '';
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "Add-Type -AssemblyName System.Drawing | Out-Null",
      '$form = New-Object System.Windows.Forms.Form',
      "$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$form.StartPosition = 'Manual'",
      '$form.Location = New-Object System.Drawing.Point([int](($screen.Width - 200) / 2), [int](($screen.Height - 200) / 2))',
      '$form.Size = New-Object System.Drawing.Size(1, 1)',
      '$form.Opacity = 0',
      '$form.ShowInTaskbar = $false',
      '$form.TopMost = $true',
      '$form.Show()',
      '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dlg.Description = '选择 简单传 照片导出位置'",
      '$dlg.ShowNewFolderButton = $true',
      initial ? `$dlg.SelectedPath = '${initial}'` : '',
      '$r = $dlg.ShowDialog($form)',
      // 管道输出会退回 GBK 代码页，中文路径直接输出会乱码；转成 UTF-8 Base64 就与代码页无关。
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('PICKED::' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dlg.SelectedPath))) } else { Write-Output 'PICKED::' }",
      '$form.Close()',
      '$form.Dispose()',
    ].filter(Boolean).join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-NoLogo', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    activePicker = child;
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
    }, 10 * 60 * 1000);
    const finish = (val) => {
      if (done) return;
      done = true;
      activePicker = null;
      clearTimeout(timer);
      resolve(val);
    };
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const m = out.match(/PICKED::(.*)/);
      const raw = m ? m[1].trim() : '';
      finish(raw ? Buffer.from(raw, 'base64').toString('utf8') : null);
    });
  });
}

// ------------------------------------------------------------------ SSE ---

const sseClients = new Set();
const broadcast = (event, data) => {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
};

// --------------------------------------------------------------- 小工具 ---

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, file) {
  const stream = fs.createReadStream(file);
  stream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    stream.pipe(res);
  });
  stream.on('error', () => {
    res.writeHead(404);
    res.end('not found');
  });
}

/** SEA 单文件模式下，静态资源来自内嵌数据（二进制为 base64）而不是磁盘。 */
function serveEmbedded(res, entry) {
  res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' });
  res.end(entry.b64 ? Buffer.from(entry.b64, 'base64') : entry.data);
}

async function ensureAssetIndex() {
  if (library.ensureIndex) {
    await library.ensureConnected();
    await library.ensureIndex();
  }
}

// ---------------------------------------------------------------- 路由 ---

let library;
let exporter;
let settings;

async function handleApi(req, res, url) {
  const { pathname } = url;
  const q = url.searchParams;

  if (pathname === '/api/status' && req.method === 'GET') {
    let devices = [];
    if (!settings.mock) {
      try { devices = await listDevices(); } catch { devices = []; }
    } else if (library.status.device) {
      devices = [library.status.device];
    }
    return sendJson(res, 200, {
      ok: true,
      app: 'jiandanchuan',
      mock: !!settings.mock,
      dataDir: settings.dataDir,
      devices,
      settings: { days: settings.days, exportDir: settings.exportDir, exportDirChosen: settings.exportDirChosen, autoExit: settings.autoExit },
      ...library.status,
    });
  }

  if (pathname === '/api/devices' && req.method === 'GET') {
    if (settings.mock) return sendJson(res, 200, { ok: true, devices: [] });
    try {
      return sendJson(res, 200, { ok: true, devices: await listDevices() });
    } catch (err) {
      return sendJson(res, 200, { ok: true, devices: [], error: err.message });
    }
  }

  if (pathname === '/api/connect' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await library.ensureConnected(body?.udid || settings.deviceUdid || undefined);
      if (body?.udid) {
        settings.deviceUdid = String(body.udid);
        saveSettings();
      }
    } catch {
      /* 错误已经体现在 status 里 */
    }
    return sendJson(res, 200, { ok: library.status.state === 'connected', ...library.status });
  }

  if (pathname === '/api/index' && req.method === 'GET') {
    const mode = q.get('mode') === 'all' ? 'all' : 'recent';
    const days = Math.min(3650, Math.max(1, Number(q.get('days')) || settings.days));
    // 多台设备在线且用户还没选过：让前端出选择横幅，而不是默默挑一台。
    if (library.status.state !== 'connected' && !settings.deviceUdid && !settings.mock) {
      let devices = [];
      try { devices = await listDevices(); } catch { devices = []; }
      if (devices.length > 1) {
        return sendJson(res, 200, {
          ok: false,
          error: { code: 'choose-device', message: '检测到多台设备，请选择一台' },
          devices,
        });
      }
    }
    try {
      const result = await library.getIndex({ mode, days });
      return sendJson(res, 200, { ok: true, mode, days, ...result });
    } catch (err) {
      return sendJson(res, 200, {
        ok: false,
        error: { code: err.code || 'index-failed', message: err.message },
      });
    }
  }

  if (pathname === '/api/thumb' && req.method === 'GET') {
    const id = q.get('id');
    if (!id) return sendJson(res, 400, { ok: false, error: { message: '缺少 id' } });
    try {
      const thumb = await library.thumb(id);
      if (!thumb) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('no thumbnail');
      }
      res.writeHead(200, {
        'Content-Type': thumb.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return res.end(thumb.data);
    } catch (err) {
      return sendJson(res, 503, { ok: false, error: { message: err.message } });
    }
  }

  if (pathname === '/api/file' && req.method === 'GET') {
    const id = q.get('id');
    const inline = q.get('inline') === '1';
    if (!id) return sendJson(res, 400, { ok: false, error: { message: '缺少 id' } });
    try {
      await ensureAssetIndex();
      const asset = library.getAsset(id);
      const ext = (asset?.ext || id.split('.').pop() || '').toUpperCase();
      const name = asset?.name || id.split('/').pop();
      res.writeHead(200, {
        'Content-Type': FILE_MIME[ext] ?? 'application/octet-stream',
        'Content-Length': asset?.size || undefined,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
      });
      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });
      await library.streamFile(id, async (chunk) => {
        if (aborted || res.destroyed) throw new Error('客户端已取消');
        if (!res.write(chunk)) await once(res, 'drain');
      });
      return res.end();
    } catch (err) {
      if (!res.headersSent) {
        return sendJson(res, 503, { ok: false, error: { message: err.message } });
      }
      return res.end();
    }
  }

  if (pathname === '/api/export' && req.method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
    if (ids.length === 0) {
      return sendJson(res, 400, { ok: false, error: { message: '没有选择任何项目' } });
    }
    // 第一次导出：先弹原生对话框选导出位置，之后记住不再询问。
    if (!settings.exportDirChosen) {
      const picked = await pickFolderDialog(settings.exportDir);
      if (!picked) {
        return sendJson(res, 200, { ok: false, cancelled: true });
      }
      settings.exportDir = picked;
      settings.exportDirChosen = true;
      saveSettings();
    }
    try {
      const result = await exporter.exportItems(ids, settings.exportDir);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      const code = err.code === 'busy' ? 409 : 500;
      return sendJson(res, code, { ok: false, error: { message: err.message } });
    }
  }

  if (pathname === '/api/pick-folder' && req.method === 'POST') {
    const body = await readBody(req);
    const picked = await pickFolderDialog(body?.initial ?? settings.exportDir);
    return sendJson(res, 200, { ok: true, path: picked });
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      settings: {
        days: settings.days,
        exportDir: settings.exportDir,
        exportDirChosen: settings.exportDirChosen,
        autoExit: settings.autoExit,
        deviceUdid: settings.deviceUdid,
      },
      dataDir: settings.dataDir,
    });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    if (body && typeof body === 'object') {
      if (Number.isFinite(body.days)) {
        settings.days = Math.min(3650, Math.max(1, Math.round(body.days)));
      }
      if (typeof body.exportDir === 'string' && body.exportDir.trim()) {
        settings.exportDir = body.exportDir.trim();
        settings.exportDirChosen = true;
      }
      if (typeof body.autoExit === 'boolean') {
        settings.autoExit = body.autoExit;
        if (settings.autoExit) armIdleExit(); else disarmIdleExit();
      }
      saveSettings();
    }
    return sendJson(res, 200, { ok: true, settings: { ...settings } });
  }

  if (pathname === '/api/shutdown' && req.method === 'POST') {
    // 页面设置里的「退出服务」按钮：响应后自行退出进程。
    sendJson(res, 200, { ok: true, bye: true });
    setTimeout(() => process.exit(0), 300);
    return;
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    disarmIdleExit(); // 应用窗口还开着，不自动退出
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
      if (sseClients.size === 0) armIdleExit(); // 所有窗口都关了 → 90s 后退出（导出中会顺延）
    });
    return;
  }

  return sendJson(res, 404, { ok: false, error: { message: '未知接口 ' + req.method + ' ' + pathname } });
}

function saveSettings() {
  fs.writeFileSync(
    path.join(settings.dataDir, 'settings.json'),
    JSON.stringify({
      days: settings.days,
      exportDir: settings.exportDir,
      exportDirChosen: settings.exportDirChosen,
      autoExit: settings.autoExit,
      deviceUdid: settings.deviceUdid,
    }, null, 2),
    'utf8',
  );
}

// ---------------------------------------------- 日志落盘 + 关窗自动退出 ---

let armIdleExit = () => {};
let disarmIdleExit = () => {};

function setupLogging(dataDir) {
  try {
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `app-${new Date().toISOString().slice(0, 10)}.log`);
    let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    let stream = fs.createWriteStream(file, { flags: 'a' });
    const orig = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    const fmt = (args) => args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a)))
      .join(' ');
    const tee = (level, origFn) => (...args) => {
      origFn(...args);
      try {
        if (size > 5 * 1024 * 1024) {
          stream.end();
          fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
          size = 0;
          stream = fs.createWriteStream(file, { flags: 'a' });
        }
        const line = `[${new Date().toISOString()}] [${level}] ` + fmt(args);
        stream.write(line + '\n');
        size += line.length + 1;
      } catch { /* 日志失败不影响功能 */ }
    };
    console.log = tee('info', orig.log);
    console.warn = tee('warn', orig.warn);
    console.error = tee('error', orig.error);
    process.on('uncaughtException', (err) => orig.error('[uncaught] ' + (err.stack || err.message)));
    process.on('unhandledRejection', (err) => orig.error('[unhandledRejection] ' + (err?.stack || err?.message || String(err))));
  } catch { /* 日志不可用则忽略 */ }
}

// ------------------------------------------------- 独立应用窗口与快捷方式 ---

/** 探测某端口上跑的是不是另一个简单传实例。 */
async function probeOurs(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1200) });
    const j = await res.json();
    return j?.app === 'jiandanchuan';
  } catch {
    return false;
  }
}

function findChromiumBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/** 用 Edge/Chrome 的 --app 模式打开独立应用窗口（无地址栏）；都没有则退回默认浏览器。 */
function openAppWindow(url) {
  const browser = findChromiumBrowser();
  if (browser) {
    spawn(browser, ['--app=' + url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}

/** 首次运行：把 exe 安装到 %LOCALAPPDATA%\简单传\，创建桌面快捷方式（仅 SEA 发行版）。
 *  注意：刻意不用 VBS 做隐藏窗口启动器——「VBS + 隐藏窗口拉起 exe」会被
 *  Windows Defender 启发式报毒（Trojan:VBS/Obfuse.A!MTB），所以快捷方式
 *  直接指向 exe（控制台最小化运行）。 */
function ensureLauncher() {
  if (process.platform !== 'win32' || !globalThis.EMBEDDED_PUBLIC) return;
  try {
    // 安装到稳定位置：之后即使删除/移动项目目录，桌面图标也照常可用。
    const installDir = path.join(process.env.LOCALAPPDATA || settings.dataDir, '简单传');
    const installedExe = path.join(installDir, '简单传.exe');
    fs.mkdirSync(installDir, { recursive: true });
    if (path.resolve(process.execPath) !== path.resolve(installedExe)) {
      fs.copyFileSync(process.execPath, installedExe);
    }

    // 清理旧方案遗留的 vbs 启动器（会触发 Defender 报毒）。
    for (const legacy of [
      path.join(installDir, '启动简单传.vbs'),
      path.join(settings.dataDir, '启动简单传.vbs'),
    ]) {
      try { fs.rmSync(legacy, { force: true }); } catch { /* 忽略 */ }
    }

    const flag = path.join(installDir, '.launcher-created');
    if (fs.existsSync(flag)) return;
    const ps1 = path.join(installDir, 'create-shortcut.ps1');
    const esc = (s) => s.replace(/'/g, "''");
    const content = [
      "\ufeff$ws = New-Object -ComObject WScript.Shell",
      "$desktop = [Environment]::GetFolderPath('Desktop')",
      "$lnk = $ws.CreateShortcut((Join-Path $desktop '简单传.lnk'))",
      "$lnk.TargetPath = '" + esc(installedExe) + "'",
      '$lnk.WindowStyle = 7', // 最小化：控制台缩进任务栏，不弹黑窗
      "$lnk.WorkingDirectory = '" + esc(installDir) + "'",
      "$lnk.IconLocation = '" + esc(installedExe) + ",0'",
      '$lnk.Save()',
    ].join('\r\n');
    fs.writeFileSync(ps1, content, 'utf8');
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, stdio: 'ignore' })
      .on('close', () => { try { fs.writeFileSync(flag, '1'); fs.rmSync(ps1, { force: true }); } catch { /* 忽略 */ } })
      .on('error', () => {});
  } catch { /* 安装/快捷方式创建失败不影响主功能 */ }
}

/**
 * 启动本地服务。
 * @param {object} [options]
 * @param {number} [options.port]      监听端口，默认 5178（可用环境变量 AUTO_PP_PORT 覆盖）
 * @param {string} [options.dataDir]   数据/缓存目录，默认 ~/.jiandanchuan
 * @param {boolean} [options.mock]     模拟设备模式
 * @param {boolean} [options.openBrowser] 启动后自动打开系统浏览器
 * @returns {Promise<{server: http.Server, port: number, exporter: Exporter, settings: object}>}
 */
export async function start(options = {}) {
  let port = Number(options.port || process.env.AUTO_PP_PORT || 5178);
  let dataDir = options.dataDir || process.env.AUTO_PP_DATA || path.join(os.homedir(), '.jiandanchuan');
  if (!options.dataDir && !process.env.AUTO_PP_DATA && !fs.existsSync(dataDir)) {
    // 数据目录更名（.auto-pp → .jiandanchuan）时做一次性迁移，保留设置与缩略图缓存。
    const legacy = path.join(os.homedir(), '.auto-pp');
    if (fs.existsSync(legacy)) {
      try {
        fs.renameSync(legacy, dataDir);
        console.log('已迁移旧数据目录: ' + legacy + ' → ' + dataDir);
      } catch {
        dataDir = legacy; // 旧目录被占用等情况，继续沿用
      }
    }
  }
  fs.mkdirSync(dataDir, { recursive: true });

  settings = loadSettings(dataDir);
  settings.dataDir = dataDir;
  settings.mock = !!options.mock;

  // 清理上次会话可能遗留、被遗忘在后台的"浏览文件夹"窗口。
  if (process.platform === 'win32' && !settings.mock) {
    spawn('taskkill', ['/F', '/FI', 'WINDOWTITLE eq 浏览文件夹', '/IM', 'powershell.exe'], {
      windowsHide: true,
    }).on('error', () => undefined);
  }

  library = options.mock ? new MockLibrary() : new RealLibrary(dataDir);
  exporter = new Exporter(library);
  exporter.on('start', (d) => {
    console.log(`导出开始：${d.total} 项 → ${d.target}`);
    broadcast('export-start', d);
  });
  exporter.on('progress', (d) => broadcast('export-progress', d));
  exporter.on('done', (d) => {
    console.log(
      `导出完成：${d.count} 个文件（${(d.bytes / 1048576).toFixed(1)} MB）→ ${d.target}` +
        (d.failed?.length ? `，失败 ${d.failed.length} 个` : '') +
        (d.suspicious?.length ? `，疑似 iCloud 未下载 ${d.suspicious.length} 个` : ''),
    );
    broadcast('export-done', d);
  });

  setupLogging(dataDir);

  // 关窗自动退出（仅 SEA exe）：应用窗口的 SSE 断开且 90 秒无重连 → 退出（导出中顺延）。
  armIdleExit = () => {
    if (!globalThis.EMBEDDED_PUBLIC || settings.autoExit === false) return;
    clearTimeout(armIdleExit.t);
    armIdleExit.t = setTimeout(() => {
      if (exporter.running) {
        armIdleExit();
        return;
      }
      console.log('应用窗口已关闭且无活动，自动退出服务');
      process.exit(0);
    }, 90_000);
  };
  disarmIdleExit = () => clearTimeout(armIdleExit.t);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url);
      }
      if (req.method !== 'GET') {
        res.writeHead(405);
        return res.end();
      }
      // SEA 单文件模式：资源已内嵌（sea-entry.js 在启动早期注入 globalThis.EMBEDDED_PUBLIC）。
      const EMBEDDED = globalThis.EMBEDDED_PUBLIC;
      if (EMBEDDED) {
        const key = url.pathname === '/' || url.pathname === '/index.html' ? '/index.html' : url.pathname;
        const entry = EMBEDDED[key];
        if (entry) return serveEmbedded(res, entry);
        res.writeHead(404);
        return res.end('not found');
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      const candidate = path.normalize(path.join(PUBLIC_DIR, url.pathname));
      if (candidate.startsWith(PUBLIC_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return serveStatic(res, candidate);
      }
      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      console.error('request failed:', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { message: err.message } });
    }
  });

  // 绑定端口：被占时先探测是不是另一个简单传（是 → 唤起它的窗口），否则顺延端口。
  let bound = 0;
  let lastBindErr = null;
  for (let attempt = 0; attempt <= 10; attempt++) {
    const tryPort = port + attempt;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(tryPort, '127.0.0.1', resolve);
      });
      bound = tryPort;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (await probeOurs(tryPort)) {
        if (options.openBrowser) openAppWindow(`http://127.0.0.1:${tryPort}`);
        console.log(`简单传已在运行（端口 ${tryPort}），已唤起它的窗口`);
        return { alreadyRunning: true, port: tryPort };
      }
      console.log(`端口 ${tryPort} 被其他程序占用，尝试 ${tryPort + 1}`);
      lastBindErr = err;
    }
  }
  if (!bound) throw lastBindErr ?? new Error('无法绑定监听端口');
  port = bound;
  server.removeAllListeners('error');
  server.on('error', (err) => console.error('server error:', err.message));

  const url = `http://127.0.0.1:${port}`;
  console.log('');
  console.log(settings.mock ? '  简单传（模拟模式，无真实设备）' : '  简单传 —— iPhone 照片速览与导出');
  console.log(`  已启动: ${url}`);
  console.log(`  缓存目录: ${dataDir}`);
  console.log(`  导出目录: ${settings.exportDir}`);
  console.log('  按 Ctrl+C 退出');
  console.log('');

  if (options.openBrowser && process.platform === 'win32') {
    // 用 Edge/Chrome 的 --app 模式打开独立应用窗口（无地址栏、有独立任务栏图标）。
    openAppWindow(url);
  }
  ensureLauncher();
  armIdleExit();

  return { server, port, exporter, settings, library };
}
