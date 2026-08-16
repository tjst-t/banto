/**
 * task-0160: 起票（バックログ）の土台（prop-0003 段取り1）。
 *
 * ここで見たいのは4つ——**書いたら残る／重複しない／どこへ行ったか辿れる／機械が読める**。
 * いまの `work/inbox/**` は読むコードがゼロなので、10種に割れた status も id 衝突3組も
 * 誰にも気づかれなかった。土台の試験が確かめるのは「気づける形になったか」である。
 *
 * **md は必ず tmpdir へ書く**（`work/backlog/*.md` は実行時に書かれるもので成果物ではない）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BACKLOG_STATUSES,
  type BacklogEntry,
  type BacklogFileInput,
  type BacklogPatch,
  type BacklogStatus,
} from "../../packages/banto-host/src/backlog.js";
import { FileBacklogStore } from "../../packages/banto-host/src/backlog-store-file.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let dir: string;
let logFile: string;
let mdDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-backlog-"));
  logFile = path.join(dir, "data", "backlog.jsonl");
  mdDir = path.join(dir, "repo", "work", "backlog");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(): FileBacklogStore {
  return new FileBacklogStore({ logFile, markdownDir: mdDir });
}

/** jsonl に載っている **1件ごとの姿**を、別プロセスで読み直して返す。 */
function readInFreshProcess(): BacklogEntry[] {
  const script = path.join(dir, "read-back.mts");
  const storePath = path.join(REPO_ROOT, "packages", "banto-host", "src", "backlog-store-file.ts");
  fs.writeFileSync(
    script,
    [
      `import { FileBacklogStore } from ${JSON.stringify(storePath)};`,
      `const store = new FileBacklogStore({ logFile: process.argv[2]! });`,
      `process.stdout.write(JSON.stringify(await store.list()));`,
    ].join("\n"),
    "utf8"
  );
  const out = execFileSync(process.execPath, ["--import", "tsx", script, logFile], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return JSON.parse(out) as BacklogEntry[];
}

function mdFiles(): string[] {
  if (!fs.existsSync(mdDir)) return [];
  return fs.readdirSync(mdDir).filter((n) => n.endsWith(".md")).sort();
}

describe("起票の置き場（ファイル実装）", () => {
  it("a1: file → list → update → list が jsonl を経て往復し、別プロセスで読み直しても同じ", async () => {
    const store = open();
    const filed = await store.file({
      kind: "improvement",
      title: "起票に機構を持たせる",
      body: "いまはメモでしかない",
      origin: "po（枝104の結論）",
      clientKey: "k-1",
    });
    assert.equal(filed.status, "open");
    assert.equal(filed.title, "起票に機構を持たせる");

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, filed.id);

    const updated = await store.update(filed.id, {
      status: "tasked",
      tasks: [{ projectTag: "banto", taskId: "task-0160" }],
    });
    assert.equal(updated.status, "tasked");
    assert.deepEqual(updated.tasks, [{ projectTag: "banto", taskId: "task-0160" }]);
    // 書き換えても本文は消えない（触れなかった欄はそのまま）
    assert.equal(updated.body, "いまはメモでしかない");
    assert.equal(updated.origin, "po（枝104の結論）");
    // 書き換えの事実が updatedAt に出る（createdAt は動かない）
    assert.equal(updated.createdAt, filed.createdAt);
    assert.ok(updated.updatedAt >= filed.updatedAt);

    const after = await store.list();
    assert.equal(after.length, 1, "書き換えで件数が増えてはいけない");
    assert.equal(after[0]?.status, "tasked");

    // **プロセスを作り直して読み直しても同じ**——真実は jsonl であって、走っている process の記憶ではない
    const fresh = readInFreshProcess();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]?.id, filed.id);
    assert.equal(fresh[0]?.status, "tasked");
    assert.equal(fresh[0]?.body, "いまはメモでしかない");
    assert.deepEqual(fresh[0]?.tasks, [{ projectTag: "banto", taskId: "task-0160" }]);
  });

  it("a2: id は bl-NNNN の連番で、Store を開き直しても番号が衝突しない", async () => {
    const store = open();
    const first = await store.file({ kind: "incident", title: "一件目" });
    const second = await store.file({ kind: "incident", title: "二件目" });
    assert.equal(first.id, "bl-0001");
    assert.equal(second.id, "bl-0002");

    // 同じ jsonl を開き直す＝既存の最大値を見て採番する
    const reopened = open();
    const third = await reopened.file({ kind: "proposal", title: "三件目" });
    assert.equal(third.id, "bl-0003");

    const ids = (await reopened.list()).map((e) => e.id);
    assert.deepEqual(ids, ["bl-0001", "bl-0002", "bl-0003"]);
    assert.equal(new Set(ids).size, ids.length, "id が衝突している");

    // 番号は外から入らない（ローカル主権）——external を持たせても id は banto が振る
    const external = await reopened.file({
      kind: "improvement",
      title: "外で立った件",
      external: { provider: "github", id: "42", url: "https://example.invalid/42" },
    });
    assert.equal(external.id, "bl-0004");
    assert.equal(external.external?.id, "42");
  });

  it("a3: 同じ clientKey で二度 file しても1件のまま・返る id も同じ", async () => {
    const store = open();
    const once = await store.file({ kind: "improvement", title: "同じ用件", clientKey: "same" });
    const twice = await store.file({ kind: "improvement", title: "同じ用件", clientKey: "same" });
    assert.equal(twice.id, once.id);
    assert.equal((await store.list()).length, 1);

    // 開き直しても冪等（合印の索引は jsonl から復元される）
    const reopened = open();
    const thrice = await reopened.file({ kind: "improvement", title: "同じ用件", clientKey: "same" });
    assert.equal(thrice.id, once.id);
    assert.equal((await reopened.list()).length, 1);

    // 別の合印なら別の起票として立ち、番号は次へ進む
    const other = await reopened.file({ kind: "improvement", title: "別の用件", clientKey: "other" });
    assert.notEqual(other.id, once.id);
    assert.equal((await reopened.list()).length, 2);
  });

  it("a4: 状態は4値だけ。それ以外は黙って通らず例外になる", async () => {
    const store = open();
    assert.deepEqual([...BACKLOG_STATUSES], ["open", "tasked", "dropped", "done"]);

    // 4値は通る
    const entry = await store.file({ kind: "improvement", title: "状態を変える" });
    for (const status of BACKLOG_STATUSES) {
      const updated = await store.update(entry.id, { status });
      assert.equal(updated.status, status);
    }

    // 既存 md に居た10種のうち、4値でないものは全部はねる
    // I4: 型で通らない値を実行時に渡すための cast（外から来る値を模す）
    const rejected = ["resolved", "inbox", "backlog", "fixed", "landed", "closed", "in-progress", "accepted", ""];
    for (const bad of rejected) {
      await assert.rejects(
        () => store.update(entry.id, { status: bad as BacklogStatus }),
        (err: unknown) => {
          assert.ok(err instanceof Error, `"${bad}" で Error が投げられていない`);
          assert.match(err.message, /起票の状態/);
          return true;
        },
        `"${bad}" が状態として通ってしまった`
      );
      await assert.rejects(
        () => store.file({ kind: "improvement", title: "だめな状態", status: bad as BacklogStatus }),
        /起票の状態/,
        `file で "${bad}" が通ってしまった`
      );
    }
    // はねた分が起票として残っていないこと
    assert.equal((await store.list()).length, 1);
    // 最後に通した4値目のまま（例外で壊れていない）
    assert.equal((await store.get(entry.id))?.status, "done");

    // 知らない種別も同じ扱い
    // I4: 同上
    await assert.rejects(
      () => store.file({ kind: "bug" as "improvement", title: "知らない種別" }),
      /起票の種別/
    );
  });

  it("a5: md 書き出しが働き、件数が jsonl と一致する。md を消しても jsonl から戻せる", async () => {
    const store = open();
    await store.file({ kind: "improvement", title: "一件目", body: "本文", clientKey: "a" });
    await store.file({ kind: "incident", title: "二件目", clientKey: "b" });
    const third = await store.file({ kind: "proposal", title: "三件目", clientKey: "c" });
    await store.update(third.id, { status: "tasked", tasks: [{ projectTag: "banto", taskId: "task-0160" }] });

    const entries = await store.list();
    assert.ok(entries.length > 0, "0件同士の一致では何も確かめていない");
    assert.equal(entries.length, 3);
    assert.equal(mdFiles().length, entries.length);
    assert.deepEqual(mdFiles(), ["bl-0001.md", "bl-0002.md", "bl-0003.md"]);

    // md の中身は front matter ＋ 本文。書き換えた状態と tasks が載っている
    const thirdMd = fs.readFileSync(path.join(mdDir, "bl-0003.md"), "utf8");
    assert.match(thirdMd, /^---\n/);
    assert.match(thirdMd, /\nid: bl-0003\n/);
    assert.match(thirdMd, /\nkind: proposal\n/);
    assert.match(thirdMd, /\nstatus: tasked\n/);
    assert.match(thirdMd, /\ntasks: \["banto\/task-0160"\]\n/);
    assert.match(thirdMd, /\ncreatedAt: \d{4}-\d{2}-\d{2}T/);
    assert.match(thirdMd, /\nupdatedAt: \d{4}-\d{2}-\d{2}T/);
    assert.match(fs.readFileSync(path.join(mdDir, "bl-0001.md"), "utf8"), /\n本文\n/);

    // md は保険であって正ではない——消しても jsonl から全件戻る
    fs.rmSync(mdDir, { recursive: true, force: true });
    assert.equal(mdFiles().length, 0);
    const regenerated = open().regenerateMarkdown();
    assert.equal(regenerated, 3);
    assert.equal(mdFiles().length, entries.length);
    assert.equal(fs.readFileSync(path.join(mdDir, "bl-0003.md"), "utf8"), thirdMd);

    // 書き出し先を渡さなければ md は書かない（既定を決め打ちしない）
    const noMd = new FileBacklogStore({ logFile: path.join(dir, "data2", "backlog.jsonl") });
    await noMd.file({ kind: "improvement", title: "md 無し" });
    assert.equal((await noMd.list()).length, 1);
    assert.equal(fs.existsSync(path.join(dir, "data2", "backlog.jsonl")), true);
  });

  it("a6: capabilities() が pull/push の可否を返し、ファイル実装は pull を断る", async () => {
    const store = open();
    assert.deepEqual(store.capabilities(), { pull: false, push: false });

    // 呼べてしまったときに黙って落ちず、「持たない」と分かる言葉で断る
    await assert.rejects(
      () => store.pull(),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Error が投げられていない");
        assert.match(err.message, /pull を持ちません/);
        assert.match(err.message, /capabilities\(\)\.pull/);
        return true;
      }
    );
  });

  it("a9: 採番は呼ぶ側が決められない。名指しできるのは取り込み経路だけで、そこも衝突すれば例外", async () => {
    const store = open();

    // 型に口が無い（`BacklogFileInput` に id が無いこと自体が保証）。
    // ここで確かめるのは、型を迂回して実行時に紛れ込ませても採番を奪えないこと
    // I4: 型で通らない値を渡すための cast（道具の JSON 入力・移行スクリプトを模す）
    const sneaky = { kind: "improvement", title: "番号を名乗る", id: "bl-9999" } as BacklogFileInput;
    await assert.rejects(
      () => store.file(sneaky),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Error が投げられていない");
        assert.match(err.message, /id は呼ぶ側では決められません/);
        return true;
      },
      "file が id の指定を受け入れてしまった"
    );
    // はねた分は起票として残っていない＝番号も進んでいない
    assert.equal((await store.list()).length, 0);
    assert.equal((await store.file({ kind: "improvement", title: "普通に立てる" })).id, "bl-0001");

    // 書き換えの側も裏口にしない
    // I4: 同上
    await assert.rejects(
      () => store.update("bl-0001", { id: "bl-9999" } as BacklogPatch),
      /id は書き換えられません/,
      "update から id を動かせてしまった"
    );
    assert.equal((await store.get("bl-0001"))?.id, "bl-0001");
    assert.equal(await store.get("bl-9999"), undefined);

    // 名指しできるのは取り込み経路（adopt）だけ
    const adopted = await store.adopt({ id: "bl-0042", kind: "incident", title: "外から来た件" });
    assert.equal(adopted.id, "bl-0042");
    assert.equal((await store.get("bl-0042"))?.title, "外から来た件");

    // そこでも既存 id と衝突すれば例外（黙って上書きも、黙って採番し直しもしない）
    await assert.rejects(
      () => store.adopt({ id: "bl-0042", kind: "incident", title: "同じ番号を名乗る" }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Error が投げられていない");
        assert.match(err.message, /既にあります/);
        return true;
      },
      "adopt が既存 id を上書きしてしまった"
    );
    assert.equal((await store.get("bl-0042"))?.title, "外から来た件", "上書きされている");
    assert.equal((await store.list()).length, 2);

    // 綴りが違うものも通さない
    for (const bad of ["imp-0070", "42", "bl-42", ""]) {
      await assert.rejects(
        () => store.adopt({ id: bad, kind: "incident", title: "変な id" }),
        /起票の id ではありません/,
        `"${bad}" が id として通ってしまった`
      );
    }

    // 取り込んだ番号より後は、その先から続く（取り込みが採番を巻き戻さない）
    assert.equal((await store.file({ kind: "improvement", title: "その次" })).id, "bl-0043");
  });

  it("a10: 並行して30件 file しても番号が衝突せず、jsonl に30件全部が残る", async () => {
    const store = open();
    const N = 30;

    const filed = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.file({ kind: "improvement", title: `並行 ${i}`, clientKey: `p-${i}` })
      )
    );

    const ids = filed.map((e) => e.id);
    assert.equal(ids.length, N);
    assert.equal(new Set(ids).size, N, `発番が重複している: ${ids.join(",")}`);

    // 索引の上でも30件（同じ id を上書きし合っていない）
    assert.equal((await store.list()).length, N);

    // jsonl を読み直しても30件全部が残っている＝行の混ざりも欠落も無い
    const reopened = await open().list();
    assert.equal(reopened.length, N);
    assert.deepEqual(
      reopened.map((e) => e.id).sort(),
      [...ids].sort(),
      "読み直したら id の顔ぶれが変わっている"
    );
    assert.deepEqual(
      reopened.map((e) => e.title).sort(),
      filed.map((e) => e.title).sort()
    );

    // 生の jsonl も1行1件で壊れていないこと（壊れた行を replay が黙って捨てていないか）
    const rawLines = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    assert.equal(rawLines.length, N, "jsonl の行数が起票の件数と合わない");
    for (const raw of rawLines) JSON.parse(raw);

    // md も30枚
    assert.equal(mdFiles().length, N);
  });

  it("a11: 採番は git も md も見ない。md 置き場を空にしても番号は戻らず続く", async () => {
    const store = open();
    for (const i of [1, 2, 3]) await store.file({ kind: "improvement", title: `${i}件目` });
    assert.equal(mdFiles().length, 3);

    // 記録の md を丸ごと消す（別ワークツリーから見た・未追跡で見えない・掃除された、を模す）
    fs.rmSync(mdDir, { recursive: true, force: true });
    assert.equal(mdFiles().length, 0);

    // 真実は jsonl だけなので、次は bl-0004。**戻らない**
    const afterWipe = await open().file({ kind: "improvement", title: "md を消したあと" });
    assert.equal(afterWipe.id, "bl-0004", "md の有無で採番が変わっている");

    // md 置き場を渡さない Store から見ても同じ答え（見る場所で答えが変わらない）
    const noMdView = new FileBacklogStore({ logFile });
    assert.equal((await noMdView.file({ kind: "improvement", title: "md を見ない" })).id, "bl-0005");

    // md 置き場に嘘の番号が置かれていても、採番はそれを見ない
    fs.mkdirSync(mdDir, { recursive: true });
    fs.writeFileSync(path.join(mdDir, "bl-9999.md"), "---\nid: bl-9999\n---\n嘘の番号\n", "utf8");
    assert.equal((await open().file({ kind: "improvement", title: "嘘の隣" })).id, "bl-0006");

    // 別のディレクトリに md を書き出しても採番は jsonl のまま（ワークツリー非依存）
    const otherMdDir = path.join(dir, "another-worktree", "work", "backlog");
    const otherView = new FileBacklogStore({ logFile, markdownDir: otherMdDir });
    assert.equal((await otherView.file({ kind: "improvement", title: "別の作業ツリー" })).id, "bl-0007");

    // 台帳は1本なので、どの見え方から書いても全部残っている
    assert.equal((await open().list()).length, 7);
  });
});
