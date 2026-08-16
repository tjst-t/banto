/**
 * inc-0075 / task-0164: **縮む書き戻しを拒む番人**。
 *
 * 2026-08-16、幹の記録から8/14 15:22〜8/16 00:48 の約33時間ぶんが消えた。
 * `ThreadStore.replace()` が無条件の全文上書きで、**メモリが真実・ファイルはその写し**
 * だったため、古いメモリで書き戻すたびにファイル側の新しい記録が消えた。
 *
 * 原因（なぜ書き戻しが止まったか）は未確定だが、**原因が何であれ**「縮む書き戻し」と
 * 「前方一致しない書き戻し」を拒めば、被害は33時間ではなく0で止まっていた。
 * ここで固定するのはその安全弁である。
 *
 * I2: 拒んだことを黙らせない——退避ファイルとログの両方を確かめる。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ThreadStore } from "@banto/host";
import type { TranscriptEntry } from "@banto/host";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-shrink-guard-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** その間に出た `console.error` を集める（拒否を黙らせていないことの確認に使う）。 */
function capturingErrors<T>(run: () => T): { result: T; logs: string[] } {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: run(), logs };
  } finally {
    console.error = original;
  }
}

/** 退避された書き戻し（`<threadId>.jsonl.rejected-<ISO8601>`）。 */
function rejectedFiles(threadId: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${threadId}.jsonl.rejected-`))
    .sort();
}

function po(text: string): TranscriptEntry {
  return { role: "po", text };
}
function banto(text: string): TranscriptEntry {
  return { role: "banto", text };
}

const THREAD = "thread-61";

describe("[task-0164 a1/a3] 縮む書き戻しを拒む", () => {
  it("件数が減る書き戻しを拒み、ディスクの記録を守る", () => {
    const store = new ThreadStore(dir);
    const full = [po("1本目"), banto("2本目"), po("3本目"), banto("4本目")];
    store.replace(THREAD, full);

    // 古いメモリを持ったまま書き戻しに来た（事故そのものの形）
    const { logs } = capturingErrors(() => store.replace(THREAD, [po("1本目")]));

    assert.deepEqual(
      new ThreadStore(dir).transcript(THREAD),
      full,
      "ディスクの記録は1行も減っていないこと"
    );

    const saved = rejectedFiles(THREAD);
    assert.equal(saved.length, 1, "拒んだ内容を別名で退避していること");
    const quarantined = fs
      .readFileSync(path.join(dir, saved[0]!), "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as TranscriptEntry);
    assert.deepEqual(quarantined, [po("1本目")], "退避されるのは拒んだ書き戻しの中身");

    const rejection = logs.find((l) => l.includes("拒みました"));
    assert.ok(rejection, `拒否をログに出すこと（出たログ: ${JSON.stringify(logs)}）`);
    assert.match(rejection, /\[banto\]/u, "journal で追えるよう [banto] を付けること");
    assert.match(rejection, /4 本の記録が 1 本に縮もうとしました/u, "何本が何本になろうとしたか");
  });

  it("空の書き戻しも拒む（全部消える形がいちばん困る）", () => {
    const store = new ThreadStore(dir);
    store.replace(THREAD, [po("残るべき")]);
    capturingErrors(() => store.replace(THREAD, []));
    assert.deepEqual(new ThreadStore(dir).transcript(THREAD), [po("残るべき")]);
    assert.equal(rejectedFiles(THREAD).length, 1);
  });

  it("正常な書き戻し（件数が同じ・増える）は今までどおり通る", () => {
    const store = new ThreadStore(dir);
    store.replace(THREAD, [po("あ")]);
    // 発話は1文字ずつ来て末尾へ継ぎ足される＝件数は同じ
    store.replace(THREAD, [po("あい")]);
    store.replace(THREAD, [po("あい"), banto("はい")]);
    assert.deepEqual(new ThreadStore(dir).transcript(THREAD), [po("あい"), banto("はい")]);
    assert.equal(rejectedFiles(THREAD).length, 0, "正常な書き戻しで退避を作らないこと");
  });

  it("拒否の基準はメモリに載せた件数（壊れた行を飛ばして読んでも誤検知しない）", () => {
    // 実ファイルは4行だが、1行壊れているので読めるのは3件（`transcript()` は飛ばす）
    const lines = [
      JSON.stringify(po("1本目")),
      JSON.stringify(banto("2本目")),
      JSON.stringify(po("3本目")),
      "{壊れた行",
    ];
    fs.writeFileSync(path.join(dir, `${THREAD}.jsonl`), `${lines.join("\n")}\n`, "utf-8");

    const store = new ThreadStore(dir);
    const loaded = capturingErrors(() => store.transcript(THREAD)).result;
    assert.equal(loaded.length, 3, "壊れた行は飛ばして読むこと（既存の挙動）");

    // 読んだ3件をそのまま書き戻す。実ファイルの行数（4）を基準にすると誤って拒む
    const { logs } = capturingErrors(() => store.replace(THREAD, loaded));
    assert.equal(rejectedFiles(THREAD).length, 0, `誤検知しないこと（ログ: ${JSON.stringify(logs)}）`);
    assert.deepEqual(new ThreadStore(dir).transcript(THREAD), loaded);
  });
});

describe("[task-0164 a5] 前方一致でない書き戻しを拒む", () => {
  it("件数が同じでも、既にある行と食い違えば拒む", () => {
    const store = new ThreadStore(dir);
    const full = [po("1本目"), banto("2本目"), po("3本目")];
    store.replace(THREAD, full);

    // 件数は同じだが中身が別物（別の会話のメモリで上書きしに来た形）
    const { logs } = capturingErrors(() =>
      store.replace(THREAD, [po("1本目"), po("別物"), po("3本目")])
    );

    assert.deepEqual(new ThreadStore(dir).transcript(THREAD), full, "ディスクは守られること");
    assert.equal(rejectedFiles(THREAD).length, 1, "退避すること");
    const rejection = logs.find((l) => l.includes("拒みました"));
    assert.ok(rejection);
    assert.match(rejection, /\[banto\]/u);
    assert.match(rejection, /前方一致になっていません/u);
  });

  it("件数が多くても、前のほうが食い違えば拒む", () => {
    const store = new ThreadStore(dir);
    store.replace(THREAD, [po("1本目"), banto("2本目")]);
    capturingErrors(() =>
      store.replace(THREAD, [banto("すり替え"), po("2本目"), po("3本目"), po("4本目")])
    );
    assert.deepEqual(new ThreadStore(dir).transcript(THREAD), [po("1本目"), banto("2本目")]);
    assert.equal(rejectedFiles(THREAD).length, 1);
  });

  it("**事故そのものの形**: ディスクが先に育っていたら、古いメモリの書き戻しを拒む", () => {
    // 8/14 15:22 に起動したプロセス。ここまでを読み込んだ
    const stale = new ThreadStore(dir);
    const early = [po("8/14 の発言"), banto("8/14 の返事")];
    stale.replace(THREAD, early);

    // その後、記録は33時間ぶん育った（ここでは別インスタンスが書いた形で作る）
    const grown = [...early, po("8/15 の発言"), banto("8/15 の返事"), po("8/16 の発言")];
    new ThreadStore(dir).replace(THREAD, grown);

    // 古いメモリのまま書き戻しに来る。**ここで止まらなければ33時間が消える**
    const { logs } = capturingErrors(() => stale.replace(THREAD, early));

    assert.deepEqual(new ThreadStore(dir).transcript(THREAD), grown, "育ったぶんが消えないこと");
    assert.equal(rejectedFiles(THREAD).length, 1);
    assert.ok(logs.some((l) => l.includes("[banto]") && l.includes("拒みました")));
  });
});

describe("[task-0164] 起動時の書き換えはガードに当たらない", () => {
  it("settleInterrupted 相当（件数を変えず走っている道具を確定させる）は通る", () => {
    const store = new ThreadStore(dir);
    const before: TranscriptEntry[] = [
      po("やって"),
      { role: "tool", name: "system.restart", state: "running" },
      banto("はい"),
    ];
    store.replace(THREAD, before);

    const restored = new ThreadStore(dir);
    const loaded = restored.transcript(THREAD);
    // threads.ts の settleInterrupted と同じ形（map で置き換え＝件数も役も変わらない）
    const settled = loaded.map((e) =>
      e.role === "tool" && e.state === "running"
        ? ({ ...e, state: "ok", output: "再起動しました。" } as TranscriptEntry)
        : e
    );
    const { logs } = capturingErrors(() => restored.replace(THREAD, settled));

    assert.equal(rejectedFiles(THREAD).length, 0, `拒まないこと（ログ: ${JSON.stringify(logs)}）`);
    const onDisk = new ThreadStore(dir).transcript(THREAD);
    assert.equal(onDisk.length, 3);
    assert.equal(onDisk[1]!.role === "tool" ? onDisk[1]!.state : undefined, "ok");
  });

  it("repairTrunkCards 相当（末尾に札を足す）は通る", () => {
    const store = new ThreadStore(dir);
    store.replace(THREAD, [po("やって")]);
    const restored = new ThreadStore(dir);
    const loaded = restored.transcript(THREAD);
    const repaired: TranscriptEntry[] = [...loaded, { role: "branch", branchId: "thread-62" }];
    capturingErrors(() => restored.replace(THREAD, repaired));
    assert.equal(rejectedFiles(THREAD).length, 0);
    assert.equal(new ThreadStore(dir).transcript(THREAD).length, 2);
  });
});
