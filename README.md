<div align="center">

# 简单传

**用一根数据线，在浏览器里秒看 iPhone 近两周的照片和视频，按日期一键导出到电脑。**

Windows 本地运行 · 照片不经过任何云端 · 免安装 Node

<img src="docs/screenshot.png" alt="简单传界面截图" width="860">

[![平台](https://img.shields.io/badge/平台-Windows%2010%20%2F%2011-0078d4)](#-下载使用免装-node)
[![运行时](https://img.shields.io/badge/运行时-零%20npm%20依赖-3fb950)](#-源码运行与打包)
[![分发](https://img.shields.io/badge/分发-单文件%20exe-8957e5)](../../releases)
[![许可证](https://img.shields.io/badge/许可证-MIT-c9d1d9)](LICENSE)

</div>

---

## 这是什么

iPhone 连上 Windows 后，自带「照片」应用要把整张 HEIC 原片下载下来再解码，几千张照片的库要等很久；资源管理器的 MTP 视图同样慢。

**简单传**绕开了这两条慢路径：它直接读取 iOS 系统为每张照片生成的**设备级缩略图**（约 360×480 的现成 JPEG），配合「默认只显示近两周」的小窗口策略，万级相册也能**秒开**；看中了哪天的照片，**按日期一键导出**到资源管理器。

| | 简单传 | Windows 照片应用 | 资源管理器(MTP) |
| --- | --- | --- | --- |
| 近期照片浏览速度 | **秒开**（读设备自带缩略图） | 慢（逐张下载 HEIC 解码） | 慢 |
| 按日期批量导出 | **一键**（自动建日期文件夹） | 手动逐张 | 手动逐张 |
| 需要登录/账号 | 否 | 偏好 iCloud 体验 | 否 |
| 安装 | 双击 exe 即用 | 系统自带 | 系统自带 |

## ✨ 功能特性

- **近两周秒开** —— 默认只显示近两周（可切 30 天/全部），索引按"从新到旧"扫描、扫够即停，1.5 万项相册的全流程实测 **0.2~0.3 秒**
- **真·缩略图** —— 直接读 iOS 自带的缩略图库（`/PhotoData/Thumbnails/V2/`），不解码 HEIC、不下载原片，滚动无压力；内存 LRU + 磁盘双层缓存，第二次看更快
- **按日期一键操作** —— 每个日期分组有「选当天」「导出该日」；日期条快速跳转/聚焦某一天
- **一键导出到资源管理器** —— 自动按日期建子文件夹、重名自动改名、把文件时间写成**拍摄时间**（资源管理器里排序直接是对的）；完成后自动打开资源管理器定位
- **Live Photo 完整带走** —— 选中静图自动附上同名 .MOV 动态部分
- **多选** —— 单击切换、**Shift+点击** 连选一段、**Ctrl+点击** 单个切换
- **类型筛选 + 深色模式** —— 全部/仅图片/仅视频一键切换；深浅色主题随心换
- **视频时长角标** —— 解析 MOV/MP4 的 moov 原子取时长（两次小读，不下原片），网格直接显示 `▶ 0:05`
- **iCloud 占位提示** —— 导出时逐文件校验字节，实际远小于设备标称（疑似 iCloud 未下载原图）会单独标注
- **多设备选择** —— 同时插多台 iPhone 时弹横幅选一台，记住选择
- **日志与自动退出** —— 运行日志落在 `~/.jiandanchuan/logs/`；关闭应用窗口后 90 秒自动退出服务（可在设置关闭）
- **视频支持** —— 设备关键帧做封面，浏览器里直接播放
- **免装 Node** —— Release 提供单文件 exe，双击即用

## 📥 下载使用（免装 Node）

1. 到 [**Releases**](../../releases) 下载 `简单传-win64.zip`，解压后双击 **简单传.exe**——会自动弹出一个**独立应用窗口**（无地址栏无标签页，带独立任务栏图标），并自动在桌面创建「简单传」快捷方式（服务在一个最小化的控制台窗口里运行），以后从桌面图标启动即可
2. 准备工作（一次性）：
   - 在微软商店安装 [**Apple Devices**](https://apps.microsoft.com/detail/9np83lwlpz9k) 应用（或 iTunes），保持后台运行
   - 数据线连接 iPhone，解锁手机，弹窗点「**信任此电脑**」并输入锁屏密码
3. 点「导出到资源管理器」开始导出；**第一次导出**会弹出文件夹选择窗口让你指定保存位置，之后自动记住

> 首次运行 SmartScreen 会提示"未知发布者"，点「更多信息 → 仍要运行」即可（未做付费代码签名）。
>
> **退出程序**：应用窗口里打开 ⚙️ 设置 → 点「退出服务」即可结束后台进程（直接关闭窗口的话，服务会在 90 秒后自动退出，也可在设置里关闭这个行为）。
>
> 可选进阶：用浏览器打开 `http://127.0.0.1:5178` 时，地址栏右侧会出现「安装」图标——安装后简单传会以 PWA 形式出现在开始菜单里。

## 🤖 CLI 自动化接口（给 agent / 脚本）

```bash
简单传.exe export --today                    # 导出今天拍的照片+视频
简单传.exe export --date 2026-09-01          # 指定日期
简单传.exe export --days 3 --kind video      # 最近三天仅视频
简单传.exe export --today --dest D:\备份     # 指定导出目录
简单传.exe export --today --json             # JSON 输出（便于程序解析）
```

- 不启动界面、不占固定端口，可与正在运行的窗口实例并存
- 退出码：0 成功（含 0 个可导出项），1 有失败
- `--json` 返回 `{ok, count, bytes, target, failed[], suspicious[]}`

## 🚀 它是怎么工作的

```
浏览器 H5 界面（无框架、无构建）
   │  fetch / SSE
本地服务（127.0.0.1:5178，纯 Node 实现，零 npm 依赖）
   │  纯 JS 实现 Apple 协议栈
usbmuxd (127.0.0.1:27015，Apple 移动设备服务)
   └─ lockdown (设备 62078, TLS) ── StartService ── AFC 连接池 ×16
        ├── /DCIM/…                                   原片（仅导出/预览时读取）
        ├── /PhotoData/Thumbnails/V2/DCIM/…/5005.JPG  照片缩略图（设备现成）
        └── /PhotoData/Thumbnails/VideoKeyFrames/…    视频关键帧
```

三个关键设计：

1. **缩略图永远不解码** —— iOS 自己就存好了缩略图，网格渲染只是一次小文件读取，实测量级约 **1000 张/秒**（USB 3）
2. **近期优先的扫描** —— DCIM 按路径"从新到旧"补元数据（约 5000 项/秒），近两周模式扫够就提前收工
3. **AFC 连接池** —— AFC 每连接同时只允许一个请求，16 条连接的并发池是全部速度的来源；缩略图/元数据/导出各自限流互不抢占

## ❓ 常见问题

<details>
<summary><b>提示"未检测到 Apple 移动设备服务"</b></summary>

安装 Microsoft Store 的 [Apple Devices](https://apps.microsoft.com/detail/9np83lwlpz9k) 或 iTunes，并保持其后台运行。
</details>

<details>
<summary><b>提示"未检测到 iPhone"</b></summary>

检查数据线（劣质线只能充电不能传数据），解锁手机；第一次连接需在手机上点「信任此电脑」。
</details>

<details>
<summary><b>HEIC 照片在预览里显示不出来</b></summary>

正常现象——浏览器不认识 HEIC。预览里显示的是设备缩略图，**导出的永远是完整原片**。
</details>

<details>
<summary><b>导出在 iPhone 上编辑过的视频时失败</b></summary>

在 iPhone 上刚编辑过（裁剪、加滤镜等）的视频，iOS 仍在后台渲染成片；渲染未完成时文件尚未就绪，简单传导出该文件可能失败。请先在手机相册里确认这段视频能正常播放编辑后的效果（说明渲染已完成），再回来重新导出即可。
</details>

<details>
<summary><b>SmartScreen / 杀毒软件提示</b></summary>

程序未做付费代码签名（免费分发的独立工具普遍如此），点「仍要运行」；不放心可只在内网/本地环境使用——程序不会访问任何外部服务器。
</details>

## 🔒 隐私

- 全部功能**本地完成**：手机 → 本电脑，没有任何中转服务器
- 设置与缩略图缓存保存在 `C:\Users\<你>\.jiandanchuan\`，可随时整体删除
- 不收集任何数据，无遥测、无上报

## 🛠 源码运行与打包

```bash
# 源码运行（需 Node ≥18，零 npm 依赖，无需 install）
npm start          # 自动打开 http://127.0.0.1:5178
npm run mock       # 无 iPhone 时的模拟数据演示

# 打包单文件 exe（免装 Node 的发行版）
npm run build:exe  # → dist/简单传.exe + release/简单传-win64.zip
```

打包说明：构建机会经 npm 拉取 esbuild/postject（仅构建期）；产物用 Node SEA 注入生成单文件 exe，页面资源全部内嵌。

## 📁 项目结构

```
server/
  device/    plist(二进制+XML)、usbmux、lockdown、afc、session(连接池)
  library/   scanner(DCIM 扫描/近期过滤)、thumbs(缩略图三层缓存)
  library.js 真实设备门面   mock.js 模拟设备   exporter.js 导出器
  index.js   HTTP 服务与 REST/SSE 接口（含原生文件夹选择桥）
public/      纯 H5 前端（无框架、无构建）
scripts/     gen-icons/gen-ico（自绘图标）、build-sea.mjs 单文件 exe 打包
docs/        界面截图与开发日志（docs/开发日志.md）
```

## 🙏 致谢

- [AlexBeesley/ios_transfer](https://github.com/AlexBeesley/ios_transfer)（MIT）—— "直接读 iOS 自带 V2 缩略图库"的关键思路与协议实现细节参考
- [artificiadrian/dcimport](https://github.com/artificiadrian/dcimport)（MIT）—— AFC 增量导入与日期过滤思路
- [thomas694/iPhoneMediaTransfer](https://github.com/thomas694/iPhoneMediaTransfer)（GPLv3）—— Photos.sqlite 元数据思路
- [libimobiledevice](https://libimobiledevice.org) 社区多年积累的协议文档

## 📄 License

[MIT](LICENSE)
