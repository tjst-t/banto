// §9-2: Xvfb :99 を上げ DISPLAY=:99 で headful chromium を起動できるか。
const { chromium } = require("playwright");
const { execSync } = require("node:child_process");

(async () => {
  const execPath = chromium.executablePath();
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: false });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const version = browser.version();

  let psAll = "";
  let mainRssMb = "不明";
  try {
    psAll = execSync(`ps -eo pid,ppid,rss,cmd | grep -F 'ms-playwright' | grep -v grep`).toString();
    const mainLine = psAll.split("\n").find((l) => l.trim() && !l.includes("--type="));
    if (mainLine) mainRssMb = (Number(mainLine.trim().split(/\s+/)[2]) / 1024).toFixed(1);
  } catch (e) {
    psAll = `ps失敗: ${e.message}`;
  }
  const totalRssMb = (
    psAll.split("\n").filter((l) => l.trim() && !l.startsWith("ps失敗")).reduce((s, l) => s + Number(l.trim().split(/\s+/)[2] || 0), 0) / 1024
  ).toFixed(1);

  console.log(JSON.stringify({
    display: process.env.DISPLAY,
    execPath, version, elapsedSec: elapsed,
    mainProcessRssMb: mainRssMb,
    allChromiumProcessesRssMbTotal: totalRssMb,
  }, null, 2));
  console.log("--- main process line ---");
  console.log(psAll.split("\n").find((l) => l.trim() && !l.includes("--type=")));

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});
