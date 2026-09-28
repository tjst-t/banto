#!/usr/bin/env node
// **banto の中で動いているものが無くなるまで待ってから、再起動する**（決定・2026-09-28、ユーザー）。
//
// host で人が打つ（コンテナの中の AI からは host の systemd に届かない）。稼働中の host の
// `GET /api/admin/activity` を数秒おきに見て、走っているターン・返事待ちの仕事（待たない形で頼んだ
// サブエージェントなど）・Module の呼び出しが無くなったら `sudo systemctl restart` する。
// 待っている間は、何が残っているかを変わったときだけ表示する。
//
//   node scripts/restart-when-idle.mjs                 # 空くまで待って再起動
//   node scripts/restart-when-idle.mjs --status        # いま動いているものを出して終わる（空なら終了コード 0、動いていれば 1）
//   node scripts/restart-when-idle.mjs --ignore-waiting-on-human
//                                                      # 承認・質問の返事待ちで止まっているターンだけなら、待たずに再起動する
//
// そのほか：--interval <秒>（既定 5）・--timeout <分>（既定 無し）・--dry-run（再起動せずに終わる）・
// --units "<unit> <unit>"（既定 "banto-host.service banto-frontend.service"）。
// 合言葉と口は banto の設定（BANTO_CONFIG_PATH か ~/.config/banto/config.json）から読む。
//
// **空いたと見てから再起動するまでの間に新しいターンが始まることはありうる**（受け付けを止める仕組みは
// まだ作っていない）。その場合、そのターンは再起動後に「途中で終わった」扱いになる。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const configPath =
  process.env.BANTO_CONFIG_PATH ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "banto", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const url = `http://127.0.0.1:${config.port ?? 4737}/api/admin/activity`;
const intervalMs = Number(option("--interval", "5")) * 1000;
const timeoutMin = option("--timeout", undefined);
const deadline = timeoutMin ? Date.now() + Number(timeoutMin) * 60_000 : undefined;
const units = option("--units", "banto-host.service banto-frontend.service").split(/\s+/).filter(Boolean);
const ignoreHuman = flag("--ignore-waiting-on-human");

class NoEndpointError extends Error {}

async function fetchActivity() {
  const res = await fetch(url, { headers: { authorization: `Bearer ${config.authToken}` } });
  if (res.status === 404) throw new NoEndpointError(`${url} が 404 を返しました`);
  if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`);
  return res.json();
}

const where = (r) => `${r.projectName ?? r.projectId ?? "?"} / ${r.threadTitle ?? r.threadId ?? "（会話なし）"}`;
const since = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 120 ? `${s}秒前から` : `${Math.round(s / 60)}分前から`;
};

function describe(a) {
  if (a.idle) return ["動いているものはありません"];
  const lines = [];
  for (const t of a.turns) {
    const state = t.waitingOnHuman ? "人の返事待ちで止まっている" : "走っている";
    const queued = t.queued > 0 ? `・人の発言が${t.queued}件順番待ち` : "";
    lines.push(`ターン：${where(t)}（${state}・${since(t.startedAt)}${queued}）`);
  }
  for (const r of a.awaitingReplies) lines.push(`返事待ちの仕事：${where(r)}（${r.module}・${since(r.since)}）`);
  const inTurns = new Set(a.turns.map((t) => t.threadId));
  for (const c of a.moduleCalls) {
    // ターンの中の呼び出しは、上のターンの行で分かる——人が画面で押したもの等だけ出す
    if (c.threadId && inTurns.has(c.threadId)) continue;
    lines.push(`Module の呼び出し：${c.connName}（${c.origin === "canvas" ? "人が画面で押したもの" : c.origin}${c.threadId ? `・${where(c)}` : ""}）`);
  }
  return lines;
}

const ready = (a) => a.idle || (ignoreHuman && a.onlyWaitingOnHuman);

let activity;
try {
  activity = await fetchActivity();
} catch (err) {
  console.error(`banto の host に聞けませんでした：${err instanceof Error ? err.message : err}`);
  console.error(
    err instanceof NoEndpointError
      ? "動いている host は、この口を持っていない古い版です。今回だけは画面で動いているものが無いかを確かめてから、" +
          `sudo systemctl restart ${units.join(" ")} してください`
      : `host が止まっているなら、待つものはありません。そのまま sudo systemctl restart ${units.join(" ")} してください`,
  );
  process.exit(2);
}

if (flag("--status")) {
  for (const line of describe(activity)) console.log(line);
  process.exit(activity.idle ? 0 : 1);
}

let last = "";
while (!ready(activity)) {
  const text = describe(activity).join("\n");
  if (text !== last) {
    console.log(`\n[${new Date().toLocaleTimeString()}] 待っています：`);
    console.log(text);
    last = text;
  }
  if (deadline && Date.now() > deadline) {
    console.error(`\n${timeoutMin}分待っても空きませんでした。再起動せずに終わります`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, intervalMs));
  activity = await fetchActivity();
}

console.log(
  activity.idle
    ? "\n動いているものがなくなりました"
    : "\n残っているのは人の返事待ちで止まっているターンだけです（--ignore-waiting-on-human）",
);
if (flag("--dry-run")) {
  console.log(`--dry-run なので再起動しません（するなら：sudo systemctl restart ${units.join(" ")}）`);
  process.exit(0);
}
console.log(`sudo systemctl restart ${units.join(" ")}`);
execFileSync("sudo", ["systemctl", "restart", ...units], { stdio: "inherit" });
console.log("再起動しました");
