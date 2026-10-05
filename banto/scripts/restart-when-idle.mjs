#!/usr/bin/env node
// **banto を、途中で切れるものが無くなるのを待ってから再起動する**（決定・2026-09-28、ユーザー。待つものを
// 2026-10-05 に変えた——アーキ仕様 §2.5「画面から banto を更新する」の待つ段）。
//
// host で人が打つ（コンテナの中の AI からは host の systemd に届かない）。稼働中の host の
// `GET /api/admin/activity` を数秒おきに見て、**待つもの**（`blocking`：実行中の Module の呼び出しと、「続けられる」と
// 名乗らない Module の返事待ちの仕事——切れると結果が分からなくなるもの）が無くなったら `systemctl restart` する。
// 走っている AI のターン・続けられる Module の仕事（サブエージェントなど）・人の返事待ちは、起き直したあと続くので
// 待たない（`--all` で、今までどおり全部が空くまで待つ）。まず sudo 無しで打ち（画面からの更新を整えた host では
// polkit の規則で許されている——手順書 D）、断られたら（Interactive authentication required・Access denied）
// `sudo systemctl restart` で打ち直す。待っている間は、何が残っているかを変わったときだけ表示する。
//
//   node scripts/restart-when-idle.mjs                 # 途中で切れるものが無くなるまで待って再起動
//   node scripts/restart-when-idle.mjs --all           # 全部（走っているターン・返事待ちの仕事・人の返事待ちも）空くまで待つ
//   node scripts/restart-when-idle.mjs --status        # いま動いているものを出して終わる（再起動してよければ終了コード 0、待つものがあれば 1）
//
// そのほか：--interval <秒>（既定 5）・--timeout <分>（既定 無し）・--dry-run（再起動せずに終わる）・
// --units "<unit> <unit>"（既定 "banto-host.service banto-frontend.service"）。
// 合言葉と口は banto の設定（BANTO_CONFIG_PATH か ~/.config/banto/config.json）から読む。
// `restartable` を返さない古い host には、`--all` と同じに全部が空くまで待つ。
//
// **待つものが無いと見てから再起動するまでの間に、新しい呼び出しが始まることはありうる**（受け付けを止める仕組みは
// まだ作っていない）。その呼び出しは切れて、続きの AI に「結果は分かりません」と伝わる。

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

// 2026-10-05 に無くした——人の返事待ちは既定で待たなくなった。黙って受けると、--all と一緒に打ったときに意味が割れる
if (flag("--ignore-waiting-on-human")) {
  console.error(
    "--ignore-waiting-on-human は無くなりました。人の返事待ちは既定で待ちません（起き直したら続きの AI がもう一度聞きます）。" +
      "全部が空くまで待つなら --all を使ってください",
  );
  process.exit(2);
}

const configPath =
  process.env.BANTO_CONFIG_PATH ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "banto", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const url = `http://127.0.0.1:${config.port ?? 4737}/api/admin/activity`;
const intervalMs = Number(option("--interval", "5")) * 1000;
const timeoutMin = option("--timeout", undefined);
const deadline = timeoutMin ? Date.now() + Number(timeoutMin) * 60_000 : undefined;
const units = option("--units", "banto-host.service banto-frontend.service").split(/\s+/).filter(Boolean);
const all = flag("--all");
const restartCommand = `systemctl restart ${units.join(" ")}（polkit の規則が無い host では sudo を付けて）`;

/** polkit に断られた（規則が無い）ときの systemctl の言葉。これのときだけ sudo で打ち直す——ほかの失敗は打ち直さない */
const DENIED = /Interactive authentication required|Access denied/i;

function restart() {
  console.log(`systemctl restart ${units.join(" ")}`);
  // --no-ask-password：断られたら、パスワードを聞かずにすぐ失敗する（端末だと polkit の問い合わせで止まる）
  const r = spawnSync("systemctl", ["--no-ask-password", "restart", ...units], { stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status === 0) return;
  if (!DENIED.test(r.stderr ?? "")) {
    process.stderr.write(r.stderr ?? "");
    console.error(`systemctl restart が失敗しました（終了コード ${r.status}）`);
    process.exit(1);
  }
  console.log(`polkit に断られたので sudo で打ち直します：sudo systemctl restart ${units.join(" ")}`);
  execFileSync("sudo", ["systemctl", "restart", ...units], { stdio: "inherit" });
}

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

/** 1件の行（待つもの・続くもの） */
function line(i) {
  if (i.kind === "turn") {
    const state = i.waitingOnHuman ? "人の返事待ちで止まっている" : "走っている";
    const queued = i.queued > 0 ? `・人の発言が${i.queued}件順番待ち` : "";
    return `ターン：${where(i)}（${state}・${since(i.startedAt)}${queued}）`;
  }
  if (i.kind === "reply") return `返事待ちの仕事：${where(i)}（${i.module}・${since(i.since)}）`;
  if (i.kind === "moduleReply")
    return `Module が頼んだ仕事：${i.projectName ?? i.projectId ?? "banto 全体"}（${i.caller} が ${i.module} に・${since(i.since)}）`;
  const origin = i.origin === "canvas" ? "人が画面で押したもの" : i.origin === "turn" ? "AI のターンから" : i.origin;
  return `Module の呼び出し：${i.connName}（${origin}${i.threadId ? `・${where(i)}` : ""}${i.waitingOnHuman ? "・人の返事待ち" : ""}）`;
}

/** 古い host（`restartable` を返さない）の答えを、全部待つものとして並べる */
function legacyItems(a) {
  return [
    ...a.turns.map((t) => ({ kind: "turn", ...t })),
    ...a.awaitingReplies.map((r) => ({ kind: "reply", ...r })),
    ...a.moduleCalls.map((c) => ({ kind: "call", ...c })),
  ];
}

const modern = (a) => typeof a.restartable === "boolean";
/** 再起動してよいか。既定は `restartable`（待つものが無い）、--all か古い host は `idle`（全部空） */
const ready = (a) => (all || !modern(a) ? a.idle : a.restartable);

function describe(a) {
  if (a.idle) return ["動いているものはありません"];
  if (!modern(a)) return ["（この host は待つものを分けて返さない古い版です。全部が空くまで待ちます）", ...legacyItems(a).map(line)];
  if (all) {
    // --all：全部待つ。続くものも待っているので、まとめて並べる
    return [...a.blocking, ...a.continuesAfterRestart].map(line);
  }
  const lines = [];
  if (a.blocking.length > 0) {
    lines.push("待つもの（切れると結果が分からなくなる）：");
    for (const i of a.blocking) lines.push(`  ${line(i)}`);
  } else lines.push("待つものはありません");
  if (a.continuesAfterRestart.length > 0) {
    lines.push("起き直したあと続くもの（待たない）：");
    for (const i of a.continuesAfterRestart) lines.push(`  ${line(i)}`);
  }
  return lines;
}

let activity;
try {
  activity = await fetchActivity();
} catch (err) {
  console.error(`banto の host に聞けませんでした：${err instanceof Error ? err.message : err}`);
  console.error(
    err instanceof NoEndpointError
      ? "動いている host は、この口を持っていない古い版です。今回だけは画面で動いているものが無いかを確かめてから、" +
          `${restartCommand} してください`
      : `host が止まっているなら、待つものはありません。そのまま ${restartCommand} してください`,
  );
  process.exit(2);
}

if (flag("--status")) {
  for (const text of describe(activity)) console.log(text);
  process.exit(ready(activity) ? 0 : 1);
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
    : `\n途中で切れるものはありません。起き直したあと続くもの ${activity.continuesAfterRestart.length} 件`,
);
if (flag("--dry-run")) {
  console.log(`--dry-run なので再起動しません（するなら：${restartCommand}）`);
  process.exit(0);
}
restart();
console.log("再起動しました");
