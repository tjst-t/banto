/**
 * credentials が実際にドライバへ届く（`spec-environment` §4・ADR-0010 決定32d）。
 *
 * **本物の sops で通す。** 偽の復号器では「鍵の受け渡し・環境変数への注入・平文を出さない」
 * のどれも見たことにならない——ここは秘密が漏れるかどうかの箇所なので、実物で確かめる。
 *
 * 見たいのは2つ：
 * (a) 復号した値が**ドライバの環境変数として**届くこと
 * (b) その値が**戻り値にもログにも出ない**こと（番頭の文脈に平文を出さない）
 *
 * sops / age が無い環境では飛ばす。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EnvironmentPool } from "@banto/environment-pool";

const SECRET = "とても秘密の値-9f3a2b";

let dir: string;
let repo: string;
let keyFile: string;
let available = false;

function has(binary: string): boolean {
  const result = childProcess.spawnSync("sh", ["-c", `command -v ${binary}`], { encoding: "utf8" });
  return result.status === 0;
}

before(() => {
  available = has("sops") && has("age-keygen");
  if (!available) return;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-cred-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "meta", "credentials"), { recursive: true });

  // 鍵を作る
  keyFile = path.join(dir, "age.key");
  const keygen = childProcess.spawnSync("age-keygen", ["-o", keyFile], { encoding: "utf8" });
  assert.equal(keygen.status, 0, `age-keygen が失敗: ${keygen.stderr}`);
  // age-keygen は "Public key: ..." を stderr へ、鍵ファイルには "# public key: ..." を書く
  const publicKey = /public key: (age1[a-z0-9]+)/i.exec(
    keygen.stderr + keygen.stdout + fs.readFileSync(keyFile, "utf-8")
  )?.[1];
  assert.ok(publicKey, "公開鍵を取り出せること");

  // 秘密を sops で暗号化して meta/credentials へ置く
  const plain = path.join(dir, "plain.yaml");
  fs.writeFileSync(plain, `MY_SECRET: ${SECRET}\n`);
  const encrypted = path.join(repo, "meta", "credentials", "staging.yaml");
  const enc = childProcess.spawnSync(
    "sops",
    ["--encrypt", "--age", publicKey, "--input-type", "yaml", "--output-type", "yaml", plain],
    { encoding: "utf8" }
  );
  assert.equal(enc.status, 0, `sops --encrypt が失敗: ${enc.stderr}`);
  fs.writeFileSync(encrypted, enc.stdout);
  // 暗号化されていること（平文がそのまま置かれていたら以降の検証に意味がない）
  assert.ok(!enc.stdout.includes(SECRET), "暗号化されていること");

  // 秘密を環境変数から拾ってファイルへ書くだけのプロファイル
  fs.writeFileSync(
    path.join(repo, "meta", "environments.yaml"),
    [
      "profiles:",
      "  staging:",
      "    driver: process",
      "    credentials: staging",
      "    config:",
      `      cmd: sh -c 'printf "%s" "$MY_SECRET" > ${path.join(dir, "leaked.txt")}; sleep 30'`,
      "    ttl: 10m",
      "",
    ].join("\n")
  );
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("[spec-environment §4] credentials がドライバへ届く", () => {
  it("復号した値がドライバの環境変数として届く", async (t) => {
    if (!available) {
      t.skip("sops / age が無い環境なので飛ばす");
      return;
    }
    const pool = new EnvironmentPool({
      dataDir: path.join(dir, "data"),
      sopsAgeKeyFile: keyFile,
      driverTimeoutMs: 20_000,
    });

    const created = await pool.provision({ repoPath: repo, profile: "staging", taskId: "cred" });
    // プロセスが起きて環境変数を書き出すまで待つ
    const written = path.join(dir, "leaked.txt");
    for (let i = 0; i < 40 && !fs.existsSync(written); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(fs.existsSync(written), "ドライバが起こしたコマンドが動いたこと");
    assert.equal(
      fs.readFileSync(written, "utf-8"),
      SECRET,
      "復号された値がそのまま環境変数として届いていること"
    );

    // (b) 平文が戻り値に出ていないこと（番頭の文脈に秘密を出さない）
    assert.ok(!JSON.stringify(created).includes(SECRET), "provision の返りに平文が出ないこと");
    const listed = pool.list();
    assert.ok(!JSON.stringify(listed).includes(SECRET), "一覧に平文が出ないこと");

    await pool.teardown(created.envId);
  });

  it("鍵が無ければ環境を立てない（原因の分からない失敗にしない）", async (t) => {
    if (!available) {
      t.skip("sops / age が無い環境なので飛ばす");
      return;
    }
    const pool = new EnvironmentPool({
      dataDir: path.join(dir, "data-nokey"),
      sopsAgeKeyFile: path.join(dir, "存在しない.key"),
      driverTimeoutMs: 20_000,
    });

    await assert.rejects(
      () => pool.provision({ repoPath: repo, profile: "staging", taskId: "cred-nokey" }),
      /sops|decrypt|復号/i
    );
    // I2: 復号できていないのに環境だけ立っている、が起きないこと
    assert.deepEqual(pool.list(), []);
  });

  it("credentials の参照名にパスを混ぜられない", async (t) => {
    if (!available) {
      t.skip("sops / age が無い環境なので飛ばす");
      return;
    }
    fs.writeFileSync(
      path.join(repo, "meta", "environments.yaml"),
      [
        "profiles:",
        "  evil:",
        "    driver: process",
        "    credentials: ../../../etc/passwd",
        "    config:",
        "      cmd: sleep 30",
        "    ttl: 10m",
        "",
      ].join("\n")
    );
    const pool = new EnvironmentPool({
      dataDir: path.join(dir, "data-evil"),
      sopsAgeKeyFile: keyFile,
      driverTimeoutMs: 20_000,
    });
    await assert.rejects(
      () => pool.provision({ repoPath: repo, profile: "evil", taskId: "evil" }),
      /invalid reference name/
    );
  });
});
