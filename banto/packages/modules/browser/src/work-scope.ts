// **ブラウザを仕事の組に入れて起こす**（v4-modules.md §4.1「本体で決めたこと」、v4-security.md §1 の段2a）。
// ブラウザ（chromium-headless-shell とその子）は Shell のコマンド・サブエージェントと同じ「仕事」——メモリを食うのはこちらで、
// 尽きたら組の中だけで止まり、Module（この server.js）は巻き込まれない。止まったブラウザは次の道具の呼び出しで起こし直す。
//
// Playwright は起こす命令の前に何かを挟む口を持たないので、`executablePath` に小さな sh を渡し、その sh が
// `inWorkScope` の形（`systemd-run --user --scope … -- 本物のブラウザ "$@"`）に exec する。`--scope` はその場で exec する
// ので pid・パイプ（`--remote-debugging-pipe` の fd 3・4）・プロセスグループは変わらず、Playwright の止め方はそのまま効く。
//
// 組に入れられないとき（コンテナの外・バスが無い・入れ子のコンテナ）は今までどおり Playwright にそのまま起こさせる。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { inWorkScope } from "@banto/module-contract";
import { BROWSER_NAME } from "./install.js";

interface RegistryExecutable {
  executablePath(): string | undefined;
}

interface Registry {
  findExecutable(name: string): RegistryExecutable | undefined;
  validateHostRequirementsForExecutablesIfNeeded(executables: RegistryExecutable[], sdkLanguage: string): Promise<void>;
}

/**
 * Playwright が使うはずのブラウザの在りかと、頼るライブラリの確かめ。**公開の口に無いので playwright-core の中の registry を
 * 引く**（版は package.json で固定——上げたら壊れていないかを tools.integration.test が見る）。`PLAYWRIGHT_BROWSERS_PATH` を
 * 置いた後に呼ぶ
 */
function registry(): Registry {
  const require = createRequire(import.meta.url);
  // 中の口なので型は無い——ここで使う2つだけを上の Registry として受ける
  const bundle = require("playwright-core/lib/coreBundle") as { registry: { registry: Registry } };
  return bundle.registry.registry;
}

/** Playwright が起こすブラウザ（chromium-headless-shell）の在りか。入っているかは見ない */
export function browserExecutablePath(): string {
  const real = registry().findExecutable(BROWSER_NAME)?.executablePath();
  if (!real) throw new Error(`${BROWSER_NAME} はこの機械の種類では使えません`);
  return real;
}

/**
 * 仕事の組で起こすための `executablePath` と環境を用意する。組に入れられなければ undefined（Playwright にそのまま起こさせる）。
 * ブラウザが無い・ライブラリが足りないときは Playwright と同じ文言で投げる——`launchWithInstall` がそれを見て入れる
 */
export async function prepareScopedLaunch(wrapperPath: string): Promise<{ executablePath: string; env: Record<string, string> } | undefined> {
  const reg = registry();
  const executable = reg.findExecutable(BROWSER_NAME);
  if (!executable) throw new Error(`${BROWSER_NAME} はこの機械の種類では使えません`);
  const real = browserExecutablePath();
  const scoped = inWorkScope(real, [], { kind: "browser" });
  if (!scoped.scoped) return undefined;
  // 包む sh では Playwright の「入っていない」「ライブラリが足りない」の確かめが走らない——先に同じ確かめをする
  if (!existsSync(real)) throw new Error(`Executable doesn't exist at ${real}`);
  await reg.validateHostRequirementsForExecutablesIfNeeded([executable], "javascript");
  mkdirSync(dirname(wrapperPath), { recursive: true });
  writeFileSync(wrapperPath, `#!/bin/sh\nexec ${[scoped.command, ...scoped.args].map(shellQuote).join(" ")} "$@"\n`, { mode: 0o755 });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(scoped.env)) if (v !== undefined) env[k] = v;
  return { executablePath: wrapperPath, env };
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
