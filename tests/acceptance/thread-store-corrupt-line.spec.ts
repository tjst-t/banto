/**
 * task-0236: 壊れた記録の行を捨てずに退避し、取次で人に届ける（inc-0075 続報）。
 *
 * 8/16 00:48、OOM 直後の読み戻しで `[banto] thread-61 の記録に読めない行があります` が
 * 1回出た。その行は `console.error` に出ただけで中身はどこにも残らず、直後の書き戻し
 * （全文置換）で永久に消えた。しかも画面には出ないので誰も気づかなかった。
 *
 * 読み飛ばす判断そのものは正しい（1行のために会話全部を失わない）。直すのは
 * 「捨てている」ことと「気づけない」ことの2つ。
 *
 * task-0161（原子的な書き込み）・task-0164（縮む書き戻しの拒否）は既に着地しており、
 * ここではその2つを壊さないことも前提にする（既存の thread-store-atomic-write.spec.ts /
 * thread-store-shrink-guard.spec.ts が引き続き通ること）。
 *
 * 実データ（/var/lib/banto）には触らない——必ず一時ディレクトリで測る。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { nodeAtomicWriteOps, type AtomicWriteOps } from "@banto/core";
import { ThreadStore, Inbox } from "@banto/host";
import type { TranscriptEntry } from "@banto/host";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-corrupt-line-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** その間に出た `console.error` を集める（既存の thread-store-shrink-guard.spec.ts と同じ流儀）。 */
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

/** 壊れた行の退避ファイル（`<threadId>.corrupt-<ISO8601>.jsonl`）。 */
function corruptQuarantineFiles(threadId: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${threadId}.corrupt-`))
    .sort();
}

function writeRawTranscript(threadId: string, lines: readonly string[]): void {
  fs.writeFileSync(path.join(dir, `${threadId}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
}

function po(text: string): TranscriptEntry {
  return { role: "po", text };
}
function banto(text: string): TranscriptEntry {
  return { role: "banto", text };
}

const THREAD = "thread-61";

describe("[task-0236] 壊れた記録の行を捨てずに退避し、取次で人に届ける", () => {
  it("[a1] 壊れた行は今まで通り飛ばして読み、生テキストをバイト単位で退避する", () => {
    const goodLines = [JSON.stringify(po("1本目")), JSON.stringify(banto("2本目"))];
    // OOM で書き込みが千切れた形（有効なUTF-8だがJSONとしては壊れている）
    const corruptLine = '{"role":"po","text":"途中で切れ';
    writeRawTranscript(THREAD, [...goodLines, corruptLine]);

    const store = new ThreadStore(dir);
    const { result: entries, logs } = capturingErrors(() => store.transcript(THREAD));

    assert.deepEqual(entries, [po("1本目"), banto("2本目")], "読める行は今まで通り全件返ること");
    assert.ok(
      logs.some((l) => l.includes(THREAD) && l.includes("読めない行")),
      "飛ばしたことを今まで通りログに出すこと"
    );

    const saved = corruptQuarantineFiles(THREAD);
    assert.equal(saved.length, 1, "壊れた行の退避ファイルが1つできること");
    const bytes = fs.readFileSync(path.join(dir, saved[0]!));
    assert.deepEqual(
      bytes,
      Buffer.from(`${corruptLine}\n`, "utf-8"),
      "壊れた行の生テキストがバイト単位一致で残ること"
    );
  });

  it("[a1] 1回の読みで複数行壊れていたら同じ退避ファイルへまとめる", () => {
    writeRawTranscript(THREAD, [JSON.stringify(po("1本目")), "{壊れ1", "{壊れ2"]);
    const store = new ThreadStore(dir);
    capturingErrors(() => store.transcript(THREAD));

    const saved = corruptQuarantineFiles(THREAD);
    assert.equal(saved.length, 1, "同じ読みで見つかった壊れは1ファイルにまとめること");
    const body = fs.readFileSync(path.join(dir, saved[0]!), "utf-8");
    assert.ok(body.includes("{壊れ1") && body.includes("{壊れ2"), "両方の壊れた行が残ること");
  });

  it("[a2] replace() で書き戻しても退避ファイルは消えず、壊れが見つかったスレッドは上書き前の元ファイル全体も退避される", () => {
    const goodLines = [JSON.stringify(po("1本目")), JSON.stringify(banto("2本目"))];
    const corruptLine = "{壊れた行";
    writeRawTranscript(THREAD, [...goodLines, corruptLine]);

    const store = new ThreadStore(dir);
    const entries = capturingErrors(() => store.transcript(THREAD)).result;
    const lineQuarantine = corruptQuarantineFiles(THREAD);
    assert.equal(lineQuarantine.length, 1, "読んだ時点で壊れた行の退避ができていること");

    // 縮まない書き戻し（task-0164 の検査は通る形）
    const grown = [...entries, po("3本目")];
    store.replace(THREAD, grown);

    const afterReplace = corruptQuarantineFiles(THREAD);
    assert.equal(
      afterReplace.length,
      2,
      "壊れた行の退避に加えて、上書き前の元ファイル全体の退避が増えること"
    );
    assert.ok(
      afterReplace.includes(lineQuarantine[0]!),
      "先にできた壊れた行の退避ファイルが消えないこと"
    );

    const fullBackupName = afterReplace.find((f) => f !== lineQuarantine[0])!;
    const fullBackup = fs.readFileSync(path.join(dir, fullBackupName), "utf-8");
    assert.equal(
      fullBackup,
      `${[...goodLines, corruptLine].join("\n")}\n`,
      "上書き前の元ファイルが（壊れた行も含めて）丸ごと残ること"
    );

    assert.deepEqual(new ThreadStore(dir).transcript(THREAD), grown, "書き戻した内容が反映されていること");
  });

  it("[a2] 元ファイルの全体退避は、壊れが見つかった上書きの分だけで、以後は増えない", () => {
    writeRawTranscript(THREAD, [JSON.stringify(po("1本目")), "{壊れ"]);
    const store = new ThreadStore(dir);
    const entries = capturingErrors(() => store.transcript(THREAD)).result;

    store.replace(THREAD, [...entries, po("2本目")]);
    const afterFirst = corruptQuarantineFiles(THREAD).length;
    assert.equal(afterFirst, 2, "壊れ行の退避1 + 上書き前の全体退避1");

    // 書き戻した内容自体は壊れていないので、以降の書き戻しで丸ごと退避を積み増さない
    store.replace(THREAD, [...entries, po("2本目"), banto("3本目")]);
    assert.equal(
      corruptQuarantineFiles(THREAD).length,
      afterFirst,
      "壊れが直った後の書き戻しでは退避を増やさないこと"
    );
  });

  it("[a3] 壊れが無いスレッドでは退避ファイルが作られない（毎回の丸ごとコピーはしない）", () => {
    const store = new ThreadStore(dir);
    store.replace(THREAD, [po("1本目")]);
    store.replace(THREAD, [po("1本目"), banto("2本目")]);
    store.transcript(THREAD);
    assert.equal(
      corruptQuarantineFiles(THREAD).length,
      0,
      "壊れていなければ退避ファイルを作らないこと"
    );
  });

  it("[a4] 退避が起きたことを取次へ1件だけ積み、スレッド・壊れた行数・退避先のパスを載せる", () => {
    const inbox = new Inbox();
    const store = new ThreadStore(dir, undefined, inbox);

    writeRawTranscript(THREAD, [JSON.stringify(po("1本目")), "{壊れ1", "{壊れ2"]);
    capturingErrors(() => store.transcript(THREAD));

    const items = inbox.list();
    assert.equal(items.length, 1, "取次に1件積まれること");
    const card = items[0]!;
    assert.ok(card.title.includes(THREAD), "どのスレッドかが載ること");
    assert.ok(card.title.includes("2行"), "壊れた行数が載ること");

    const saved = corruptQuarantineFiles(THREAD);
    assert.equal(saved.length, 1);
    assert.ok(
      card.what.includes(path.join(dir, saved[0]!)),
      "退避先のパスが載ること"
    );

    // 別のスレッドでも壊れが起きるが、起動あたり1件のまま積み増さない
    const THREAD2 = "thread-62";
    writeRawTranscript(THREAD2, [JSON.stringify(po("1本目")), "{また壊れ"]);
    capturingErrors(() => store.transcript(THREAD2));
    assert.equal(inbox.list().length, 1, "起動あたり1件だけであること");
  });

  it("[a4] inbox を渡さなければ何もしない（既存の呼び出し元は変えなくてよい）", () => {
    writeRawTranscript(THREAD, [JSON.stringify(po("1本目")), "{壊れ"]);
    const store = new ThreadStore(dir);
    assert.doesNotThrow(() => capturingErrors(() => store.transcript(THREAD)));
  });

  it("[a5] 退避の書き出しに失敗しても、記録の読み自体は続き、読める行は返る", () => {
    const goodLines = [JSON.stringify(po("1本目")), JSON.stringify(banto("2本目"))];
    writeRawTranscript(THREAD, [...goodLines, "{壊れた行"]);

    const failingWriteOps: AtomicWriteOps = {
      ...nodeAtomicWriteOps,
      openSync: () => {
        throw new Error("退避できない状況（試験用の注入）");
      },
    };
    const store = new ThreadStore(dir, failingWriteOps);
    const { result: entries, logs } = capturingErrors(() => store.transcript(THREAD));

    assert.deepEqual(
      entries,
      [po("1本目"), banto("2本目")],
      "退避が新しい落とし穴にならない——読める行は返ること"
    );
    assert.ok(
      logs.some((l) => l.includes("退避できませんでした")),
      "退避の失敗も黙らないこと"
    );
    assert.equal(
      corruptQuarantineFiles(THREAD).length,
      0,
      "書き出しに失敗した退避ファイルは残らないこと"
    );
  });
});
