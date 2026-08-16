/**
 * fix task-0162: 追記ログの読みで壊れた行・千切れた最終行を黙って飛ばさない。
 *
 * ホスト（banto.service）は OOM killer に繰り返し殺されており、**書き込みの途中で
 * 死ぬと turns.jsonl の最終行が千切れる**。これまでの `readAll()` は JSON パースの
 * 失敗を `catch {}` で握り潰していたため、台帳が壊れたことに誰も気づけなかった（I2 違反）。
 *
 * ここでは
 *   - 壊れた行があっても、その前後の読める行は全件返ること
 *   - 何行目が読めなかったかが警告に出ること（無言で飛ばさない）
 *   - 末尾に改行が無い＝千切れた最終行を、そうと分かる形で警告に出すこと
 *   - 正常な台帳の読みはこれまでと1文字も変わらないこと
 * を確かめる。台帳は一時ディレクトリへ向ける（`/var/lib/banto` の実データには触らない）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TurnLog, type TurnLogEntry } from "../../packages/banto-host/src/turn-log.js";

let dir: string;
let file: string;
let log: TurnLog;
/** その試験の間に console.error へ出た行。 */
let warnings: string[];
let realError: typeof console.error;

/** 1行分の台帳エントリを組む（時刻だけずらす）。 */
function entry(threadId: string, source = "worker"): TurnLogEntry {
  return {
    at: new Date(0).toISOString(),
    threadId,
    source,
    durationMs: 1,
    ok: true,
  };
}

/** 台帳ファイルを生の文字列から作る（千切れた行を再現するので JSON では書けない）。 */
function write(raw: string): void {
  fs.writeFileSync(file, raw, "utf-8");
}

function line(e: TurnLogEntry): string {
  return JSON.stringify(e);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-turn-ledger-broken-"));
  file = path.join(dir, "turns.jsonl");
  log = new TurnLog(file);
  warnings = [];
  realError = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
});

afterEach(() => {
  console.error = realError;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("[task-0162] ターン台帳の壊れた行", () => {
  it("[a1] 壊れた行の前後の読める行は全件返る", () => {
    write(
      [line(entry("t-1")), "{ここで死んだ", line(entry("t-2")), line(entry("t-3")), ""].join("\n")
    );

    const entries = log.readAll();

    assert.deepEqual(
      entries.map((e) => e.threadId),
      ["t-1", "t-2", "t-3"]
    );
  });

  it("[a2] 読めなかった行は警告に出て、何行目かが分かる", () => {
    write([line(entry("t-1")), "{ここで死んだ", line(entry("t-2")), ""].join("\n"));

    const { problems } = log.read();

    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.line, 2);
    assert.equal(problems[0]!.kind, "unparsable");
    // 無言で飛ばさない：console.error に、何行目かを添えて出る
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^\[banto\] /);
    assert.match(warnings[0]!, /2行目/);
  });

  it("[a2] 壊れた行が大量にあっても警告は上限で打ち切られ、残りは件数で分かる", () => {
    write(Array.from({ length: 25 }, (_, i) => `{壊れた行 ${i}`).join("\n") + "\n");

    const { entries, problems } = log.read();

    assert.equal(entries.length, 0);
    assert.equal(problems.length, 25);
    // 10行までは個別に、残り15行は件数だけ（console を埋めない）
    assert.equal(warnings.length, 11);
    assert.match(warnings[10]!, /他に 15 行/);
  });

  it("[a3] 末尾に改行が無い＝千切れた最終行を検出し、その旨が警告に出る", () => {
    // OOM killer で書き込みの途中に死んだ形：最後の行が改行の手前で切れている
    const cut = line(entry("t-3")).slice(0, 20);
    write([line(entry("t-1")), line(entry("t-2")), cut].join("\n"));

    const { entries, problems } = log.read();

    // 千切れ行を除いた残りは正常に返る
    assert.deepEqual(
      entries.map((e) => e.threadId),
      ["t-1", "t-2"]
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.line, 3);
    assert.equal(problems[0]!.kind, "truncated");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /3行目/);
    assert.match(warnings[0]!, /千切れた最終行/);
  });

  it("[a3] 最終行が読めても改行が無ければ警告は出る（行そのものは失わない）", () => {
    // 改行の1バイトだけ落ちた形。中身は揃っているので捨てない
    write([line(entry("t-1")), line(entry("t-2"))].join("\n"));

    const { entries, problems } = log.read();

    assert.deepEqual(
      entries.map((e) => e.threadId),
      ["t-1", "t-2"]
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.line, 2);
    assert.equal(problems[0]!.kind, "no-trailing-newline");
    assert.match(warnings[0]!, /2行目/);
  });

  it("[a4] 正常な台帳は今までどおり読め、警告は1行も出ない", () => {
    const rows = [entry("t-1", "po"), entry("t-2"), entry("t-3", "kobo")];
    write(rows.map(line).join("\n") + "\n");

    const { entries, problems } = log.read();

    assert.deepEqual(entries, rows);
    assert.deepEqual(problems, []);
    assert.deepEqual(warnings, []);
    // readAll() の戻りもこれまでと変わらない
    assert.deepEqual(log.readAll(), rows);
  });

  it("[a4] 台帳が無いときは空で返り、警告も出ない", () => {
    assert.deepEqual(log.readAll(), []);
    assert.deepEqual(warnings, []);
  });

  it("[a4] 空行が混じっていても、これまでどおり黙って読み飛ばす", () => {
    write(["", line(entry("t-1")), "", line(entry("t-2")), ""].join("\n"));

    const { entries, problems } = log.read();

    assert.deepEqual(
      entries.map((e) => e.threadId),
      ["t-1", "t-2"]
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(warnings, []);
  });

  it("[a1] 追記できることは壊れた行があっても変わらない", () => {
    write([line(entry("t-1")), "{ここで死んだ", ""].join("\n"));

    log.append(entry("t-2"));

    const { entries, problems } = log.read();
    assert.deepEqual(
      entries.map((e) => e.threadId),
      ["t-1", "t-2"]
    );
    assert.equal(problems.length, 1);
  });
});
