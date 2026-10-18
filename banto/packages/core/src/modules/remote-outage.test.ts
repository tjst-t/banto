import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { InboxStore } from "../inbox/store.js";
import { RemoteRuntimeError, RemoteUnreachableError, isRemoteUnreachable } from "../runtime/remote-runtimes.js";
import { SshConnectionClosedError, isSshUnreachable } from "../runtime/ssh.js";
import { ConnectBackoff } from "./connect-backoff.js";
import { REMOTE_OUTAGE_NOTICE_AFTER_MS, RemoteOutageWatch, type RemoteOutageNotice } from "./remote-outage.js";

/** 手で進める時計と予約（`setTimeout` の替わり） */
function clock() {
  let t = 1_000_000;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => t,
    schedule: (fn: () => void, ms: number) => {
      const timer = { at: t + ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    advance(ms: number) {
      t += ms;
      for (const timer of [...timers]) {
        if (timer.at <= t) {
          timers.delete(timer);
          timer.fn();
        }
      }
    },
  };
}

function watch() {
  const c = clock();
  const raised: RemoteOutageNotice[] = [];
  const closed: string[] = [];
  const w = new RemoteOutageWatch({
    raise: (n) => raised.push(n),
    close: (name) => closed.push(name),
    schedule: c.schedule,
    now: c.now,
  });
  return { c, w, raised, closed };
}

const TIMEOUT = "ubuntu@10.10.254.38 に繋げませんでした（ssh の終了コード 255）：ssh: connect to host 10.10.254.38 port 22: Connection timed out";

test("(1) 3 分未満で繋がれば、お知らせは出ない", () => {
  const { c, w, raised, closed } = watch();
  w.recordUnreachable("vm", "browser-p1", "p1", TIMEOUT);
  c.advance(60_000);
  w.recordUnreachable("vm", "terminal-p1", "p1", TIMEOUT);
  c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS - 60_001);
  assert.equal(w.recordConnected("vm", "p1"), REMOTE_OUTAGE_NOTICE_AFTER_MS - 1, "途切れていた長さを返す");
  c.advance(10 * 60_000);
  assert.deepEqual(raised, [], "繋がったあとに時間が来ても出さない");
  assert.deepEqual(closed, [], "出していないものは閉じない");
});

test("(2) 3 分を超えたら実行場所ごとに1枚だけ——影響している Project と Module の数を添える", () => {
  const { c, w, raised } = watch();
  w.recordUnreachable("vm", "browser-p1", "p1", "前の理由");
  w.recordUnreachable("vm", "terminal-p1", "p1", "前の理由");
  w.recordUnreachable("vm", "shell-p2", "p2", TIMEOUT);
  w.recordUnreachable("other", "shell-p3", "p3", TIMEOUT);
  c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS - 1);
  assert.equal(raised.length, 0, "3 分になるまでは出さない");
  c.advance(1);
  // 試し直しで失敗が続いても、もう1枚は出さない
  w.recordUnreachable("vm", "browser-p1", "p1", TIMEOUT);
  c.advance(10 * 60_000);
  assert.deepEqual(
    raised.sort((a, b) => a.runtimeName.localeCompare(b.runtimeName)),
    [
      { runtimeName: "other", reason: TIMEOUT, projectIds: ["p3"], modules: 1 },
      { runtimeName: "vm", reason: TIMEOUT, projectIds: ["p1", "p2"], modules: 3 },
    ],
  );
});

test("(3) 繋がったら、出していたお知らせを閉じる。また途切れたら、そこから 3 分数え直す", () => {
  const { c, w, raised, closed } = watch();
  w.recordUnreachable("vm", "browser-p1", "p1", TIMEOUT);
  c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS);
  assert.equal(raised.length, 1);
  w.recordConnected("vm", "p1");
  assert.deepEqual(closed, ["vm"]);
  assert.equal(w.recordConnected("vm", "p1"), undefined, "2 度目の繋がったは何もしない");
  assert.deepEqual(closed, ["vm"]);
  w.recordUnreachable("vm", "browser-p1", "p1", TIMEOUT);
  c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS - 1);
  assert.equal(raised.length, 1);
  c.advance(1);
  assert.equal(raised.length, 2);
});

test("実行場所を外したら、待っていた分は出さず、出していたものは閉じる", () => {
  const { c, w, raised, closed } = watch();
  w.recordUnreachable("a", "m-p1", "p1", TIMEOUT);
  w.recordUnreachable("b", "m-p2", "p2", TIMEOUT);
  c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS);
  w.forget("a");
  w.recordUnreachable("c", "m-p3", "p3", TIMEOUT);
  w.forget("c");
  c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS);
  assert.deepEqual(raised.map((n) => n.runtimeName).sort(), ["a", "b"]);
  assert.deepEqual(closed, ["a"]);
});

test("(2)(3) 受信箱と繋ぐ：1枚だけ開き、繋がったら閉じる（書き込み中に閉じても残らない）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-remote-outage-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const c = clock();
    const pending: Promise<unknown>[] = [];
    const w = new RemoteOutageWatch({
      raise: (n) => void pending.push(inbox.raiseNotice({ dedupeKey: `remote-unreachable:${n.runtimeName}`, title: `${n.runtimeName} に繋げません`, detail: n.reason })),
      close: (name) => void pending.push(inbox.acknowledgeNoticesByKey(`remote-unreachable:${name}`)),
      schedule: c.schedule,
      now: c.now,
    });
    // ほかの Project のお知らせ・同じ鍵の Project のお知らせは閉じない
    await inbox.raiseNotice({ projectId: "p1", dedupeKey: "remote-unreachable:vm", title: "別", detail: "x" });
    w.recordUnreachable("vm", "browser-p1", "p1", TIMEOUT);
    w.recordUnreachable("vm", "terminal-p1", "p1", TIMEOUT);
    c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS);
    // 書き終わる前に繋がった
    w.recordConnected("vm", "p1");
    await Promise.all(pending);
    const open = inbox.listOpen().filter((i) => i.kind === "notice");
    assert.deepEqual(open.map((i) => i.kind === "notice" && i.title), ["別"]);

    pending.length = 0;
    w.recordUnreachable("vm", "browser-p1", "p1", TIMEOUT);
    c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS);
    await Promise.all(pending);
    const titles = inbox.listOpen().flatMap((i) => (i.kind === "notice" ? [i.title] : [])).sort();
    assert.deepEqual(titles, ["vm に繋げません", "別"], "また途切れたら新しく1枚出る");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(2)(4) 見分け：SSH が繋がらない失敗だけを実行場所の側に回す", () => {
  assert.equal(isSshUnreachable({ code: 255, stdout: "", stderr: "ssh: connect to host 10.10.254.38 port 22: Connection timed out" }), true);
  assert.equal(isSshUnreachable({ code: 255, stdout: "", stderr: "Host key verification failed." }), false, "鍵の違いは待っても直らない");
  assert.equal(isSshUnreachable({ code: 1, stdout: "", stderr: "向こうのコマンドが失敗" }), false, "繋がっていて向こうで落ちた");
  assert.equal(isRemoteUnreachable(new RemoteUnreachableError(502, TIMEOUT)), true);
  assert.equal(isRemoteUnreachable(new SshConnectionClosedError("SSH の接続が途中で閉じました")), true);
  // 繋がっていて Module だけ起きない・この機械のコンテナ——今どおり Module ごと
  assert.equal(isRemoteUnreachable(new RemoteRuntimeError(400, "前提が足りません")), false);
  assert.equal(isRemoteUnreachable(new Error("Error: Shutting down")), false);
  assert.ok(new RemoteUnreachableError(502, TIMEOUT) instanceof RemoteRuntimeError, "画面の口は今どおり 502 で返す");
});

test("(2)(4) 試し直しの間：実行場所の側に回した失敗は知らせたことにしない。理由が変われば Module ごとに知らせる", () => {
  const b = new ConnectBackoff({ baseMs: 5_000, maxMs: 60_000, stableMs: 600_000 });
  assert.equal(b.recordFailure("browser-p1", "v1", TIMEOUT, { quiet: true }), false);
  assert.equal(b.recordFailure("browser-p1", "v1", TIMEOUT, { quiet: true }), false);
  assert.equal(b.streak("browser-p1"), 2, "間は今どおり伸びる");
  assert.equal(b.recordFailure("browser-p1", "v1", "前提が足りません"), true, "繋がって Module だけ起きない——今どおり1回知らせる");
  assert.equal(b.recordFailure("browser-p1", "v1", "前提が足りません"), false);
});

test("(Backlog #383) 出している実行場所の一覧——画面の「!」と同じ判定。理由が変われば知らせ、繋がれば外れる", () => {
  const c = clock();
  const changed: string[] = [];
  const w = new RemoteOutageWatch({ raise: () => undefined, close: () => undefined, changed: (n) => changed.push(n), schedule: c.schedule, now: c.now });
  const since = c.now();
  w.recordUnreachable("vm", "browser-p1", "p1", "前の理由");
  w.recordUnreachable("vm", "browser-p1", "p1", TIMEOUT);
  assert.deepEqual(w.raised(), [], "3 分になるまでは載らない");
  assert.deepEqual(changed, [], "出す前に理由が変わっても知らせない");
  c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS);
  assert.deepEqual(w.raised(), [{ runtimeName: "vm", reason: TIMEOUT, since, projectIds: ["p1"] }]);
  w.recordUnreachable("vm", "terminal-p1", "p1", TIMEOUT);
  assert.deepEqual(changed, [], "同じ理由なら知らせない");
  w.recordUnreachable("vm", "terminal-p1", "p1", "SSH の接続が途中で閉じました");
  assert.deepEqual(changed, ["vm"]);
  assert.equal(w.raised()[0]?.reason, "SSH の接続が途中で閉じました");
  w.recordConnected("vm", "p1");
  assert.deepEqual(w.raised(), []);
});

test("繋がったかは Project ごとの接続で見る：同じ実行場所のほかの Project が繋がらないままなら閉じない（v4-security.md §1）", () => {
  const { c, w, raised, closed } = watch();
  const changed: string[] = [];
  const w2 = new RemoteOutageWatch({ raise: (n) => raised.push(n), close: (n) => closed.push(n), changed: (n) => changed.push(n), schedule: c.schedule, now: c.now });
  for (const x of [w, w2]) {
    x.recordUnreachable("vm", "shell-p1", "p1", TIMEOUT);
    x.recordUnreachable("vm", "shell-p2", "p2", TIMEOUT);
  }
  c.advance(REMOTE_OUTAGE_NOTICE_AFTER_MS);
  assert.equal(raised.length, 2);
  assert.equal(w2.unreachableReason("vm", "p1"), TIMEOUT);
  assert.equal(w2.unreachableReason("vm", "p3"), undefined, "繋がらない Module の無い Project には理由を言わない");
  // 先に送るためだけの接続は、Project の Module が繋がったことにならない
  assert.equal(w2.recordConnected("vm", undefined), undefined);
  assert.equal(w2.raised().length, 1);
  // p1 が繋がった：p2 が残っているので閉じない。印からは p1 が外れる
  assert.equal(w2.recordConnected("vm", "p1"), undefined);
  assert.deepEqual(closed, []);
  assert.deepEqual(changed, ["vm"]);
  assert.deepEqual(w2.raised().map((o) => o.projectIds), [["p2"]]);
  assert.equal(w2.unreachableReason("vm", "p1"), undefined);
  assert.equal(w2.unreachableReason("vm", "p2"), TIMEOUT);
  // p2 も繋がった：閉じる
  assert.equal(w2.recordConnected("vm", "p2"), REMOTE_OUTAGE_NOTICE_AFTER_MS);
  assert.deepEqual(closed, ["vm"]);
  assert.deepEqual(w2.raised(), []);
});
