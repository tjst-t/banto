// 共通ヘルパー: ローカル試験サーバの起動/停止、CDP付きブラウザの起動/停止。
const { spawn } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright");

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, "server.js"), "0"], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    const onData = (d) => {
      out += d.toString();
      const m = out.match(/LISTENING (\d+)/);
      if (m && !settled) {
        settled = true;
        proc.stdout.off("data", onData);
        resolve({ proc, port: Number(m[1]) });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (d) => process.stderr.write(`[server-stderr] ${d}`));
    proc.on("exit", (code) => {
      if (!settled) reject(new Error(`server exited early code=${code} out=${out}`));
    });
    setTimeout(() => {
      if (!settled) reject(new Error(`server start timeout out=${out}`));
    }, 5000);
  });
}

function stopServer(handle) {
  if (handle && handle.proc && !handle.proc.killed) {
    handle.proc.kill("SIGTERM");
  }
}

async function launchBrowser() {
  const browser = await chromium.launch({ headless: true });
  return browser;
}

module.exports = { startServer, stopServer, launchBrowser };
