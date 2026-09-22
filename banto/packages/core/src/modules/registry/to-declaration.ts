// **`server.json` を banto の宣言にする**（追加・2026-09-21、ユーザー要望）。
//
// **宣言を組み立てるのは host**（`v4-security.md`「役割のなりすまし」）。画面が
// 送るのは**目録の中のどれか・付ける名前・人が入れた値**だけで、起動の指定も
// 役割も画面には作らせない——作らせると「役割を自由に入力できる欄」が生まれ、
// 第三者の Module が金庫の窓口を名乗れてしまう。
//
// **役割は名乗らせない。** registry から来たものは `satisfies: []` で入る
// ——`server.json` に banto の役割の語彙は無いし、有ったとしても
// **自己申告を信じない**（同上）。
//
// **閉じ込めは外せない**（`cli.ts`——外から繋いだコードは必ず閉じ込める）。

import { installNpmPackage, PackageInstallError } from "./install/npm.js";
import type { RegistryInput, RegistryServer } from "./server-json.js";
import { formatSupportOf, planFor } from "./support.js";

/** 人が入れた1件の答え。**値そのものか、Vault の名前か**。 */
export interface AnsweredInput {
  name: string;
  /** `vault` なら値は Vault から引く（宣言には名前だけ残る）。 */
  source: "vault" | "plain";
  value: string;
}

export interface BuildDeclarationRequest {
  server: RegistryServer;
  /** 付ける Module 名。 */
  name: string;
  answers: readonly AnsweredInput[];
  /** 取ってきたものの置き場（`${modulePackageDir}` が指す先）。 */
  packageDir: string;
  /** 試験が差し替える。 */
  installNpm?: typeof installNpmPackage;
}

export interface BuiltDeclaration {
  launch: unknown;
  meta: unknown;
  /** 何をしたかを人に言うための1行（受信箱・画面に出す）。 */
  summary: string;
}

export class RegistryInstallError extends Error {}

/** 差し込み語。**秘密は名前だけを宣言に残す**（値は起動の直前に Vault から引く）。 */
function valueOf(answer: AnsweredInput): string {
  return answer.source === "vault" ? `\${secret:${answer.value}}` : answer.value;
}

/** 人に聞くべきだったのに答えが無いもの。**黙って空で起動しない**（規則2）。 */
function assertRequiredAnswered(inputs: readonly RegistryInput[], answers: readonly AnsweredInput[]): void {
  const given = new Map(answers.map((a) => [a.name, a]));
  const missing = inputs
    .filter((i) => i.isRequired === true && typeof i.name === "string" && i.value === undefined)
    .filter((i) => {
      const a = given.get(i.name!);
      return !a || a.value.trim() === "";
    })
    .map((i) => i.name!);
  if (missing.length > 0) {
    throw new RegistryInstallError(`必須の項目が空です：${missing.join("・")}`);
  }
}

/**
 * 値が決まっている入力（`value` が書いてある）を、そのまま渡す組にする。
 * **人に聞かない**——registry が答えを持っているものを聞き返さない。
 */
function fixedEntries(inputs: readonly RegistryInput[]): Array<[string, string]> {
  return inputs
    .filter((i) => typeof i.name === "string" && typeof i.value === "string")
    .map((i) => [i.name!, i.value!] as [string, string]);
}

/**
 * **繋ぐ／取ってくる**を1本の筋でやる。
 *
 * - remote … プロセスは立てない。ヘッダに秘密を差す
 * - local（npm）… **ここで実際に取ってくる**。取れなければ宣言は作らない
 *   （入ってもいないものを一覧に並べない・規則13）
 */
export async function buildDeclarationFromRegistry(
  req: BuildDeclarationRequest,
): Promise<BuiltDeclaration> {
  const plan = planFor(req.server);

  if (plan.kind === "none") throw new RegistryInstallError(plan.reason);

  if (plan.kind === "remote") {
    const inputs = plan.remote.headers ?? [];
    assertRequiredAnswered(inputs, req.answers);
    const asked = new Map(inputs.map((i) => [i.name, i]));
    const headers: Record<string, string> = Object.fromEntries(fixedEntries(inputs));
    for (const a of req.answers) {
      // **聞かれていない欄を足させない**——画面から任意のヘッダを差す道を作らない
      if (!asked.has(a.name)) continue;
      if (a.value.trim() === "") continue;
      headers[a.name] = valueOf(a);
    }
    return {
      launch: { type: "http", url: plan.url, ...(Object.keys(headers).length ? { headers } : {}) },
      // **閉じ込めは書かない**——掛からないものを付けたふりをしない
      // （相手のサーバで動いているので Landlock は届かない）
      meta: { satisfies: [], dependsOn: [], isolation: "subprocess", scope: "instance" },
      summary: `${new URL(plan.url).host} に接続します`,
    };
  }

  const support = formatSupportOf(plan.pkg.registryType);
  if (!support.supported) {
    // **対応していないことを、理由ごと言う**（規則2）
    throw new RegistryInstallError(
      `${support.label} の配布物にはまだ対応していません：${support.reason ?? ""}`,
    );
  }

  const inputs = plan.pkg.environmentVariables ?? [];
  assertRequiredAnswered(inputs, req.answers);

  let installed;
  try {
    installed = await (req.installNpm ?? installNpmPackage)({
      identifier: plan.pkg.identifier,
      version: plan.pkg.version,
      dir: req.packageDir,
      registryBaseUrl: plan.pkg.registryBaseUrl,
    });
  } catch (err) {
    if (err instanceof PackageInstallError) throw new RegistryInstallError(err.message);
    throw err;
  }

  const asked = new Map(inputs.map((i) => [i.name, i]));
  const env: Record<string, string> = Object.fromEntries(fixedEntries(inputs));
  for (const a of req.answers) {
    if (!asked.has(a.name)) continue;
    if (a.value.trim() === "") continue;
    env[a.name] = valueOf(a);
  }

  // **引数は registry が書いたものだけ**（画面からは足せない）。
  // 人に聞く形の引数（`value` が無いもの）にはまだ対応しない——**黙って
  // 落とさず**、そういうものが在れば断る（規則2）
  const positional = plan.pkg.packageArguments ?? [];
  const unanswerable = positional.filter((a) => a.value === undefined && a.default === undefined);
  if (unanswerable.length > 0) {
    throw new RegistryInstallError(
      "この Module は起動時の引数を人に尋ねる形ですが、banto はまだその形に対応していません" +
        "（「カスタム」から手で書けば足せます）",
    );
  }
  const args = positional.map((a) => a.value ?? a.default!).filter((v) => v !== "");

  return {
    launch: {
      command: "${nodeExec}",
      args: [`\${modulePackageDir}/${installed.relativeScript}`, ...args],
      ...(Object.keys(env).length ? { env } : {}),
    },
    meta: {
      satisfies: [],
      dependsOn: [],
      isolation: "subprocess",
      scope: "instance",
      // **外から繋ぐコードは必ず閉じ込める**（`cli.ts` がこれを要求する）。
      // 根は持たない——Project のフォルダは渡さない
      confinement: { kind: "landlock", root: "none" },
    },
    summary: `${plan.pkg.identifier}@${installed.version} を取得しました`,
  };
}
