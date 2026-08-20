/**
 * [task-0301] レビュー環境（`dev` プロファイル）は、web だけでなく**ブランチの
 * banto-host**も一緒に立て、web はそのホストだけを見る。
 *
 * **困っていたこと。** `docker/dev.yaml` の web サービスは
 * `BANTO_HOST_URL: http://host.docker.internal:4100` を持ち、`extra_hosts` の
 * host-gateway でホストの**本番**の banto（常駐サービス・:4100）へ抜けていた。
 * vite は `/ws` と `/api` を中継するだけなので、画面に映る中身は常に main のホストの
 * 応答——`packages/banto-host` を触るタスクは PO レビューで原理的に確認できず、
 * task-0279 で実害（PO が2回「直っていない」と差し戻し、職人が2回「直っている」と
 * 返す往復）が起きた。
 *
 * 直した形：`docker/dev.yaml` に**このワークツリーの banto-host**を立てる `host`
 * サービスを足し、web はそれだけを見る。ここは**構造の試験**（docker 不要・`npm test`
 * で回る）——compose と package.json を実際に読み、文字列比較ではなく構造として確かめる。
 * 「本当にブランチのホストが映っているか」を dev を実際に立てて確かめる生きた試験は
 * `env-docker-dev-branch-host.spec.ts`（`npm run test:docker`）。
 *
 * D6: 汎用の YAML パーサは足さない。`docker-driver.ts` の `resolveServiceName` と同じ
 * 判断（「compose ファイルの形は決まっているので正規表現で足りる」）を、ここでは
 * インデント構造を読む最小限のパーサとして踏襲する——文字列比較ではなく構造として
 * 読みたいのはブロックのネストであって、YAML 全仕様（アンカー・複数ドキュメント等）
 * ではないため。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..", "..");

type YamlValue = string | YamlValue[] | { [key: string]: YamlValue } | null;

/**
 * compose ファイルの形（ブロックスタイルのマップ・リストと、フロースタイルの
 * `["a", "b"]` 配列）だけを読める最小限のパーサ。全 YAML 仕様は要らない
 * （上のファイル冒頭の注記を見よ）。
 */
function parseBlockYaml(text: string): { [key: string]: YamlValue } {
  const lines: Array<{ indent: number; content: string }> = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, content: trimmed });
  }

  let pos = 0;

  function parseScalar(s: string): string {
    const v = s.trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  function parseValue(valueStr: string): YamlValue {
    const v = valueStr.trim();
    if (v.startsWith("[")) {
      // フロースタイルの配列（`command: ["node", ...]`）。この repo では二重引用符で
      // 統一されているので、そのまま JSON として読める
      return JSON.parse(v) as YamlValue[];
    }
    return parseScalar(v);
  }

  function parseList(indent: number): YamlValue[] {
    const arr: YamlValue[] = [];
    while (pos < lines.length && lines[pos]!.indent === indent && lines[pos]!.content.startsWith("- ")) {
      const rest = lines[pos]!.content.slice(2);
      pos++;
      arr.push(parseValue(rest));
    }
    return arr;
  }

  function parseMap(indent: number): { [key: string]: YamlValue } {
    const obj: { [key: string]: YamlValue } = {};
    while (pos < lines.length && lines[pos]!.indent === indent) {
      const line = lines[pos]!.content;
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (!m) {
        pos++;
        continue;
      }
      const key = m[1]!.trim();
      const valueStr = m[2]!;
      pos++;
      if (valueStr.trim() === "") {
        if (pos < lines.length && lines[pos]!.indent > indent) {
          const nestedIndent = lines[pos]!.indent;
          obj[key] = lines[pos]!.content.startsWith("- ") ? parseList(nestedIndent) : parseMap(nestedIndent);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseValue(valueStr);
      }
    }
    return obj;
  }

  return parseMap(0);
}

function asMap(v: YamlValue | undefined): { [key: string]: YamlValue } {
  assert.ok(v && typeof v === "object" && !Array.isArray(v), `マップであるはずの値がマップでない: ${JSON.stringify(v)}`);
  return v as { [key: string]: YamlValue };
}

function asArray(v: YamlValue | undefined): YamlValue[] {
  assert.ok(Array.isArray(v), `配列であるはずの値が配列でない: ${JSON.stringify(v)}`);
  return v as YamlValue[];
}

function asString(v: YamlValue | undefined): string {
  assert.equal(typeof v, "string", `文字列であるはずの値が文字列でない: ${JSON.stringify(v)}`);
  return v as string;
}

const devYamlPath = path.join(repoRoot, "docker", "dev.yaml");
const devYamlDoc = parseBlockYaml(fs.readFileSync(devYamlPath, "utf-8"));
const services = asMap(devYamlDoc["services"]);

describe("[task-0301/a1] dev の web は本番ホストへ抜けない", () => {
  const web = asMap(services["web"]);
  const webEnv = asMap(web["environment"]);

  it("BANTO_HOST_URL は compose 内のホストサービスを指す（host.docker.internal ではない）", () => {
    const url = asString(webEnv["BANTO_HOST_URL"]);
    assert.doesNotMatch(url, /host\.docker\.internal/, `本番ホストへ抜ける綴りが残っている: ${url}`);
    const m = /^http:\/\/([a-zA-Z0-9_-]+):(\d+)$/.exec(url);
    assert.ok(m, `BANTO_HOST_URL の形が想定と違う: ${url}`);
    const [, hostname] = m!;
    assert.ok(
      Object.prototype.hasOwnProperty.call(services, hostname!),
      `BANTO_HOST_URL (${url}) が指す先 "${hostname}" は、この compose に定義されたサービスではない`
    );
  });

  it("extra_hosts（host-gateway）が web の定義から消えている", () => {
    assert.equal(web["extra_hosts"], undefined, "web に extra_hosts が残っている");
  });
});

describe("[task-0301/a2] dev はこのワークツリーの banto-host を起こす", () => {
  function isHostServiceCommand(command: YamlValue | undefined): boolean {
    if (!Array.isArray(command)) return false;
    const joined = command.map((c) => String(c)).join(" ");
    return joined.includes("packages/banto-host/src/bin.ts") && joined.includes("serve");
  }

  const hostServiceNames = Object.keys(services).filter((name) =>
    isHostServiceCommand(asMap(services[name])["command"])
  );

  it("banto-host の serve を起こすサービスが、ちょうど1つ在る", () => {
    assert.equal(
      hostServiceNames.length,
      1,
      `packages/banto-host/src/bin.ts の serve を指す command を持つサービスが ` +
        `${hostServiceNames.length} 個（1個であるはず）: ${hostServiceNames.join(", ")}`
    );
  });

  const hostService = asMap(services[hostServiceNames[0]!]);
  const hostEnv = asMap(hostService["environment"]);

  it("マウントされたワークツリー（/app）を土台にしている", () => {
    const volumes = asArray(hostService["volumes"]).map((v) => asString(v));
    assert.ok(
      volumes.some((v) => v === "..:/app"),
      `ワークツリーを /app にマウントしていない: ${JSON.stringify(volumes)}`
    );
  });

  it("(i) BANTO_DATA_DIR は使い捨てパスで、本番のデータ置き場に触れない", () => {
    const dataDir = asString(hostEnv["BANTO_DATA_DIR"]);
    assert.ok(dataDir.length > 0, "BANTO_DATA_DIR が設定されていない");
    assert.doesNotMatch(dataDir, /\/var\/lib\/banto/, `本番のデータ置き場を指している: ${dataDir}`);
    const volumes = asArray(hostService["volumes"]).map((v) => asString(v));
    assert.ok(
      volumes.every((v) => !v.includes("/var/lib/banto")),
      `volumes が本番のデータ置き場に触れている: ${JSON.stringify(volumes)}`
    );
  });

  it("(ii) ホスト側のポートを1つも publish しない", () => {
    assert.equal(hostService["ports"], undefined, `ports が定義されている: ${JSON.stringify(hostService["ports"])}`);
  });

  it("(iii) 実在の worker-pool / environment-pool へは届かない URL を与えられている", () => {
    const workerPoolUrl = asString(hostEnv["BANTO_WORKER_POOL_URL"]);
    const envPoolUrl = asString(hostEnv["BANTO_ENV_POOL_URL"]);
    // 実在のプールへは絶対に繋がらない書き方（既存の docker 試験・package.json の
    // test スクリプトと同じ形）であることだけを確かめる。実際に到達しないかどうかは
    // ネットワークの話であってこの構造試験の役目ではない
    for (const [label, url] of [
      ["BANTO_WORKER_POOL_URL", workerPoolUrl],
      ["BANTO_ENV_POOL_URL", envPoolUrl],
    ] as const) {
      assert.match(
        url,
        /^http:\/\/127\.0\.0\.1:1\//,
        `${label} が実在のプールへ届きうる形をしている: ${url}`
      );
    }
  });
});

describe("[task-0301/a3] 生きた検証の試験が package.json に登録されている", () => {
  const liveSpecRel = "tests/acceptance/env-docker-dev-branch-host.spec.ts";

  it(`${liveSpecRel} が在る`, () => {
    assert.ok(fs.existsSync(path.join(repoRoot, liveSpecRel)), `${liveSpecRel} が見つからない`);
  });

  it("package.json の test:docker 一覧に登録されている", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    const testDocker = pkg.scripts["test:docker"] ?? "";
    const tokens = testDocker.split(/\s+/);
    assert.ok(
      tokens.includes(liveSpecRel),
      `test:docker に ${liveSpecRel} が無い: ${testDocker}`
    );
  });
});
