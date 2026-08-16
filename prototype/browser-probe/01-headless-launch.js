// §9-1: playwright chromium を headless で起動できるか。バージョン・実行ファイルパス・
// 起動秒数・常駐RSS(MB)を測る。
const { chromium } = require("playwright");
const { execSync } = require("node:child_process");

function rssMbOfPid(pid) {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return (Number(out) / 1024).toFixed(1);
  } catch (e) {
    return `ps失敗: ${e.message}`;
  }
}

(async () => {
  const execPath = chromium.executablePath();
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: true });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  const version = browser.version();

  // browser.process() がこの playwright バージョンでは undefined を返すため、
  // ms-playwright 配下の実行ファイルで ps から該当プロセス群を拾う。
  // 実測: headless:true では chromium.executablePath()(chrome-linux64/chrome)ではなく
  // 別バイナリ chromium_headless_shell-*/chrome-headless-shell が実際に使われていた。
  let psAll = "";
  let mainRssMb = "不明";
  try {
    psAll = execSync(`ps -eo pid,ppid,rss,cmd | grep -F 'ms-playwright' | grep -v grep`).toString();
    const mainLine = psAll.split("\n").find((l) => l.trim() && !l.includes("--type="));
    if (mainLine) {
      const rssKb = Number(mainLine.trim().split(/\s+/)[2]);
      mainRssMb = (rssKb / 1024).toFixed(1);
    }
  } catch (e) {
    psAll = `ps失敗: ${e.message}`;
  }
  const totalRssMb = (
    psAll
      .split("\n")
      .filter((l) => l.trim())
      .reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[2] || 0), 0) / 1024
  ).toFixed(1);

  console.log(JSON.stringify({
    execPath,
    version,
    elapsedSec: elapsed,
    mainProcessRssMb: mainRssMb,
    allChromiumProcessesRssMbTotal: totalRssMb,
  }, null, 2));
  console.log("--- ps (pid ppid rss cmd) ---");
  console.log(psAll);

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});
