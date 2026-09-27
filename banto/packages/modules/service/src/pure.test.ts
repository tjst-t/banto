import { test } from "node:test";
import assert from "node:assert/strict";
import { assertName, normalizeDefinition, sameDefinition, ServiceError } from "./spec.js";
import { envLine, renderUnit } from "./unit.js";
import { decideState } from "./state.js";
import { parseListening } from "./systemd.js";
import { stamp } from "./log-wrapper.js";

test("名前：unit 名にそのまま使える文字だけ通す", () => {
  assert.equal(assertName("web"), "web");
  assert.equal(assertName("api-dev2"), "api-dev2");
  for (const bad of ["", "Web", "-web", "a b", "a.b", "a/b", "x".repeat(64), 3, undefined]) {
    assert.throws(() => assertName(bad), ServiceError, String(bad));
  }
});

test("定義の正規化：根の外の cwd・BANTO_*・範囲外のポートは断る。ポートは並べて重複を落とす", () => {
  const root = "/p/root";
  const d = normalizeDefinition({ command: "  npm run dev ", cwd: "app/../web", ports: [4000, 3000, 3000], envSecrets: { B: "b", A: "a" } }, root);
  assert.deepEqual(d, { command: "npm run dev", cwd: "web", ports: [3000, 4000], envSecrets: { A: "a", B: "b" } });
  assert.equal(normalizeDefinition({ command: "x", cwd: "." }, root).cwd, "");
  assert.throws(() => normalizeDefinition({ command: "x", cwd: "../other" }, root), /根の外/);
  assert.throws(() => normalizeDefinition({ command: "x", cwd: "/etc" }, root), /根の外/);
  assert.throws(() => normalizeDefinition({ command: "x", envSecrets: { BANTO_HOST_MCP_TOKEN: "t" } }, root), /BANTO_/);
  assert.throws(() => normalizeDefinition({ command: "x", envSecrets: { "A-B": "t" } }, root), /環境変数名/);
  assert.throws(() => normalizeDefinition({ command: "x", ports: [0] }, root), /1〜65535/);
  assert.throws(() => normalizeDefinition({ command: "x", ports: "3000" }, root), /数字の配列/);
  assert.throws(() => normalizeDefinition({ command: " " }, root), /command/);
});

test("同じ中身の比較は、並び順の違いを同じとみなす", () => {
  const root = "/p";
  const a = normalizeDefinition({ command: "x", ports: [2, 1], envSecrets: { B: "b", A: "a" } }, root);
  const b = normalizeDefinition({ command: "x", ports: [1, 2], envSecrets: { A: "a", B: "b" } }, root);
  assert.ok(sameDefinition(a, b));
  assert.ok(!sameDefinition(a, { ...b, command: "y" }));
  assert.ok(!sameDefinition(a, { ...b, envSecrets: { A: "a", B: "other" } }));
});

test("unit：% はエスケープし、ExecStart の各語は引用符で包む。鍵の値は unit に入らない", () => {
  const u = renderUnit({ name: "web", workingDirectory: "/p/100%", nodePath: "/usr/local/bin/node", wrapperPath: "/c d/w.js", dir: "/s/web" });
  assert.match(u, /WorkingDirectory=\/p\/100%%/);
  assert.match(u, /ExecStart="\/usr\/local\/bin\/node" "\/c d\/w\.js" "\/s\/web"/);
  assert.match(u, /EnvironmentFile=-\/s\/web\/env/);
  assert.match(u, /Restart=on-failure/);
  assert.match(u, /WantedBy=default\.target/);
});

test("鍵のファイルの1行：引用符・バックスラッシュ・$ をエスケープする", () => {
  assert.equal(envLine("A", 'x"y\\z$HOME'), 'A="x\\"y\\\\z\\$HOME"');
  // 改行は生のまま（systemd は引用符の中の生の改行を読み、\\n は2文字として読む——実測）
  assert.equal(envLine("A", "l1\nl2\r"), 'A="l1\nl2\r"');
});

test("状態：systemd が忘れた終わり方を、起動役の記録で見分ける", () => {
  const inactive = { ActiveState: "inactive", SubState: "dead" };
  const t0 = "2026-09-27T00:00:00.000Z";
  const t1 = "2026-09-27T00:00:05.000Z";
  assert.equal(decideState({ show: { ActiveState: "active" }, desired: "running" }), "running");
  assert.equal(decideState({ show: { ActiveState: "activating", SubState: "auto-restart" }, desired: "running" }), "restarting");
  assert.equal(decideState({ show: { ActiveState: "failed" }, desired: "running" }), "crashed");
  assert.equal(decideState({ show: inactive, desired: "stopped" }), "stopped");
  assert.equal(decideState({ show: inactive, desired: "running" }), "not-started");
  const exit = (o: object) => ({ at: t1, code: 0, signal: null, stopRequested: false, ...o });
  assert.equal(decideState({ show: inactive, desired: "running", lastExit: exit({ stopRequested: true }), startedAt: t0 }), "stopped-externally");
  assert.equal(decideState({ show: inactive, desired: "running", lastExit: exit({}), startedAt: t0 }), "exited");
  assert.equal(decideState({ show: inactive, desired: "running", lastExit: exit({ code: 3 }), startedAt: t0 }), "crashed");
  // 今回の起動より古い記録は使わない
  assert.equal(decideState({ show: inactive, desired: "running", lastExit: exit({ at: t0 }), startedAt: t1 }), "not-started");
});

test("ss の出力から待ち受けのポートを拾う（IPv4・IPv6）", () => {
  const text = "LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\nLISTEN 0 4096 [::]:8080 [::]:*\nLISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*\n";
  assert.deepEqual([...parseListening(text)].sort((a, b) => a - b), [53, 3000, 8080]);
});

test("ログの行に時刻を付け、標準エラーには印を付ける", () => {
  const now = new Date("2026-09-27T01:02:03.000Z");
  assert.equal(stamp("hello", "out", now), "2026-09-27T01:02:03.000Z hello\n");
  assert.equal(stamp("oops", "err", now), "2026-09-27T01:02:03.000Z [stderr] oops\n");
});
