// 命令行入口。
// 浏览器模式：npm start / npm run mock（或直接运行 简单传.exe）
// CLI 导出：  简单传.exe export --today [--dest DIR] [--json]（详见 README）
import { start } from './server.js';

const argv = process.argv.slice(2);

// 注意：不要用顶层 await —— SEA 打包要求 CJS bundle，不支持 TLA。
async function main() {
  // 子命令：export —— 给 agent / 脚本用的无界面导出。
  if (argv[0] === 'export') {
    const { runExportCli } = await import('./cli-export.js');
    process.exit(await runExportCli(argv.slice(1)));
  }

  const mock = argv.includes('--mock');
  const openBrowser = !argv.includes('--no-open');

  const result = await start({ mock, openBrowser }).catch((err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(err.message);
    } else {
      console.error('启动失败: ' + (err?.message || err));
    }
    process.exit(1);
  });
  // 端口被另一个简单传占用时，start 已经唤起了它的窗口，这里直接退出。
  if (result?.alreadyRunning) process.exit(0);
}

main();
