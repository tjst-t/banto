/**
 * task-0161: 会話の記録と索引を原子的に書く（tmp + fsync + rename）。
 *
 * **なぜ。** ホストが OOM killer に殺される最中に全文置換（O_TRUNC）が走っていると、
 * 数MBの会話が空か半端な中身で残る。2026-08-16 00:48 に実際に起き、壊れた行は
 * 読み戻しで黙って捨てられ、直後の書き戻しで永久に消えた。
 *
 * ここで見るのは「落ちても元の記録が1バイトも変わらない」こと。
 * 実データ（/var/lib/banto）には触らない——必ず一時ディレクトリで測る。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomicSync, nodeAtomicWriteOps, type AtomicWriteOps } from "@banto/core";
import { ThreadStore } from "@banto/host";
import type { TranscriptEntry } from "@banto/host/protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
});

afterEach(() => {
  // 読めない権限のまま終わると後片付けが失敗する（読み取り専用にする試験がある）
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 既に消えている場合は何もしない
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 呼ばれた fs 操作を順に記録する。中身は本物に委ねる（`failAt` の手前まで）。 */
function recordingOps(
  calls: Array<{ op: string; arg: string | number }>,
  failAt?: { op: keyof AtomicWriteOps; error: Error }
): AtomicWriteOps {
  const wrap = <K extends keyof AtomicWriteOps>(op: K): AtomicWriteOps[K] =>
    ((...args: unknown[]) => {
      calls.push({ op, arg: args[0] as string | number });
      if (failAt && failAt.op === op) throw failAt.error;
      // I4: 記録するだけの薄い皮なので、引数の並びは本物へそのまま渡す
      return (nodeAtomicWriteOps[op] as (...a: unknown[]) => unknown)(...args);
    }) as AtomicWriteOps[K];
  return {
    mkdirSync: wrap("mkdirSync"),
    openSync: wrap("openSync"),
    writeSync: wrap("writeSync"),
    fsyncSync: wrap("fsyncSync"),
    closeSync: wrap("closeSync"),
    renameSync: wrap("renameSync"),
    rmSync: wrap("rmSync"),
  };
}

/** ディレクトリに残った一時ファイル。 */
function tmpLeftovers(target: string): string[] {
  return fs.readdirSync(target).filter((f) => f.includes(".tmp-"));
}

const ENTRIES: TranscriptEntry[] = [
  { role: "po", text: "こんにちは" },
  { role: "banto", text: "はい、番頭です" },
];

describe("[task-0161] 会話の記録と索引を原子的に書く", () => {
  it("[a4] fd の fsync と親ディレクトリの fsync の両方を経てから rename する", () => {
    const file = path.join(dir, "record.jsonl");
    const calls: Array<{ op: string; arg: string | number }> = [];

    writeFileAtomicSync(file, "本文\n", recordingOps(calls));

    const order = calls.map((c) => c.op);
    const renameAt = order.indexOf("renameSync");
    assert.ok(renameAt >= 0, "rename されていること");

    // rename より前に、書いた fd の fsync が済んでいる
    const fileFd = calls.find((c) => c.op === "openSync" && String(c.arg).includes(".tmp-"));
    assert.ok(fileFd, "同じディレクトリの tmp を開いていること");
    const fsyncBefore = calls.slice(0, renameAt).filter((c) => c.op === "fsyncSync");
    assert.equal(fsyncBefore.length, 1, "rename の前に fd を fsync していること");

    // rename のあとに、親ディレクトリの fsync が済んでいる
    const afterRename = calls.slice(renameAt + 1);
    const dirOpen = afterRename.find((c) => c.op === "openSync" && c.arg === dir);
    assert.ok(dirOpen, "親ディレクトリを開いていること");
    assert.equal(
      afterRename.filter((c) => c.op === "fsyncSync").length,
      1,
      "rename のあとに親ディレクトリを fsync していること"
    );

    assert.equal(fs.readFileSync(file, "utf-8"), "本文\n");
    assert.deepEqual(tmpLeftovers(dir), [], "tmp が残っていないこと");
  });

  it("[a1][a3] rename の直前で落ちても、元のファイルは1バイトも変わらず tmp も残らない", () => {
    const file = path.join(dir, "record.jsonl");
    fs.writeFileSync(file, "もとの中身\n", "utf-8");
    const before = fs.readFileSync(file);

    const calls: Array<{ op: string; arg: string | number }> = [];
    assert.throws(
      () =>
        writeFileAtomicSync(
          file,
          "あたらしい中身\n",
          recordingOps(calls, { op: "renameSync", error: new Error("落ちた") })
        ),
      /落ちた/,
      "I2: 書けなかったら握り潰さず投げること"
    );

    assert.deepEqual(fs.readFileSync(file), before, "元のファイルが変わっていないこと");
    assert.deepEqual(tmpLeftovers(dir), [], "失敗しても tmp を片付けること");
  });

  it("[a1] ThreadStore.replace() が途中で失敗しても、元の記録は1バイトも変わらない", () => {
    const store = new ThreadStore(dir);
    store.replace("thread-1", ENTRIES);
    const file = path.join(dir, "thread-1.jsonl");
    const before = fs.readFileSync(file);

    // 書けない状況を本物で作る。**古い実装（O_TRUNC の全文置換）はここを素通りして
    // 元ファイルを潰す**——書き込み権のあるディレクトリでは差が出ないので、
    // 新しいファイルを作れないディレクトリで測る
    assert.notEqual(process.getuid?.(), 0, "root だと権限による失敗を作れない");
    fs.chmodSync(dir, 0o500);
    try {
      assert.throws(() => store.replace("thread-1", [{ role: "po", text: "上書き" }]));
    } finally {
      fs.chmodSync(dir, 0o700);
    }

    assert.deepEqual(fs.readFileSync(file), before, "元の記録が変わっていないこと");
    assert.deepEqual(tmpLeftovers(dir), []);
  });

  it("[a2] ThreadStore.writeIndex() が途中で失敗しても、元の index.json は1バイトも変わらない", () => {
    const store = new ThreadStore(dir);
    store.upsert({
      id: "thread-1",
      title: "最初の相談",
      state: "open",
      createdAt: "2026-08-16T00:00:00.000Z",
    });
    const file = path.join(dir, "index.json");
    const before = fs.readFileSync(file);

    assert.notEqual(process.getuid?.(), 0, "root だと権限による失敗を作れない");
    fs.chmodSync(dir, 0o500);
    try {
      assert.throws(() =>
        store.upsert({
          id: "thread-2",
          title: "あとの相談",
          state: "open",
          createdAt: "2026-08-16T01:00:00.000Z",
        })
      );
    } finally {
      fs.chmodSync(dir, 0o700);
    }

    assert.deepEqual(fs.readFileSync(file), before, "元の索引が変わっていないこと");
    // 索引が壊れていない＝読み戻せる（壊れていると readIndex() が throw してホストが起動しない）
    assert.deepEqual(
      new ThreadStore(dir).threads().map((t) => t.id),
      ["thread-1"]
    );
    assert.deepEqual(tmpLeftovers(dir), []);
  });

  it("[a3] 正常に書けたあと、一時ファイルが1つも残らない", () => {
    const store = new ThreadStore(dir);
    store.upsert({
      id: "thread-1",
      title: "題",
      state: "open",
      createdAt: "2026-08-16T00:00:00.000Z",
    });
    store.replace("thread-1", ENTRIES);
    store.replace("thread-1", [...ENTRIES, { role: "po", text: "もう一度" }]);
    store.setCounter(7);

    assert.deepEqual(tmpLeftovers(dir), []);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["index.json", "thread-1.jsonl"]);
  });

  it("[a5] thread-store.ts に fs.writeFileSync の直接呼び出しが残っていない", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "packages", "banto-host", "src", "thread-store.ts"),
      "utf-8"
    );
    assert.ok(
      !/\bfs\.writeFileSync\s*\(/.test(source),
      "記録と索引の書き込みは原子的なヘルパを通すこと（tmp + fsync + rename）"
    );
  });

  it("[a6] 記録の中身・形式・読み戻しの結果はこれまでと変わらない", () => {
    const store = new ThreadStore(dir);
    store.replace("thread-1", ENTRIES);

    // 1行1発言の JSONL・末尾に改行、という形はそのまま
    const raw = fs.readFileSync(path.join(dir, "thread-1.jsonl"), "utf-8");
    assert.equal(raw, `${ENTRIES.map((e) => JSON.stringify(e)).join("\n")}\n`);
    assert.deepEqual(store.transcript("thread-1"), ENTRIES);

    // 空の記録は空のファイル（従来どおり）
    store.replace("thread-1", []);
    assert.equal(fs.readFileSync(path.join(dir, "thread-1.jsonl"), "utf-8"), "");
    assert.deepEqual(store.transcript("thread-1"), []);

    // 索引は2スペース字下げの JSON ＋ 末尾改行、読み戻しも同じ
    store.upsert({
      id: "thread-1",
      title: "題",
      state: "open",
      createdAt: "2026-08-16T00:00:00.000Z",
    });
    const index = fs.readFileSync(path.join(dir, "index.json"), "utf-8");
    assert.ok(index.endsWith("\n"));
    assert.deepEqual(JSON.parse(index), {
      version: 1,
      counter: 1,
      threads: [
        { id: "thread-1", title: "題", state: "open", createdAt: "2026-08-16T00:00:00.000Z" },
      ],
    });
    assert.deepEqual(new ThreadStore(dir).threads(), store.threads());
  });
});
