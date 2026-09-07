// Module 宣言の**重ね方**（決定・2026-09-07、ユーザー指摘が起点）。
//
// **既定を写さない。変えたところだけを持つ。**
//
// 以前は Project ごとに宣言の一覧を**丸ごと写して**いた。すると既定を改良しても
// 写しを持つ Project には届かず、「そこだけ動かない」が起きる——実際に起きた
// （2026-09-07：Module の設定の置き場を既定に足したのに、写しを持つ Project では
// 保存できなかった）。**写しはいつか食い違う**（規則3）。
//
// **やり方は VS Code に倣う**（規則12——名前のある問題は既知の答えで通り過ぎる）：
//
// - 既定はプログラムが持ち、設定ファイルには**変えた項目だけ**が入る
// - 「プリミティブと配列は**置換**、オブジェクトは**マージ**」
//   （https://code.visualstudio.com/docs/configure/settings）
//
// banto での対応：
//
// | 項目 | 規則 |
// |---|---|
// | `launch.command`（文字列） | 置換 |
// | `launch.args`（配列） | 置換 |
// | `launch.env`（オブジェクト） | **キー単位でマージ** |
// | `meta`（オブジェクト） | **キー単位でマージ** |
// | 既定に無い name | まるごと新しい Module として足す |
// | `enabled: false` | その Module を**外す**（VS Code に無い、banto が足す） |

import type { ModuleDeclaration } from "./declaration.js";

/**
 * Project が持つ**差分**。既定と同じ項目は書かない。
 * `enabled: false` は「既定にあるが、この Project では外す」。
 */
export interface ModuleOverlay {
  name: string;
  launch?: Partial<ModuleDeclaration["launch"]>;
  meta?: unknown;
  /** false なら既定の Module を外す（省略＝外さない）。 */
  enabled?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** オブジェクトはキー単位でマージ、それ以外は置換（VS Code と同じ規則）。 */
function mergeValue(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isPlainObject(base) && isPlainObject(over)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(over)) merged[key] = mergeValue(base[key], value);
    return merged;
  }
  return over;
}

/**
 * 既定に差分を重ねて、実際に使う宣言を作る。
 * **合成はここ1箇所**——結果をどこにも保存しない（規則3）。
 */
export function applyModuleOverlay(
  defaults: readonly ModuleDeclaration[],
  overlays: readonly ModuleOverlay[] | undefined,
): ModuleDeclaration[] {
  if (!overlays || overlays.length === 0) return [...defaults];

  const byName = new Map(overlays.map((o) => [o.name, o]));
  const result: ModuleDeclaration[] = [];

  for (const base of defaults) {
    const over = byName.get(base.name);
    byName.delete(base.name);
    if (over?.enabled === false) continue; // この Project では外す
    if (!over) {
      result.push(base);
      continue;
    }
    result.push({
      name: base.name,
      launch: {
        command: over.launch?.command ?? base.launch.command,
        args: over.launch?.args ?? base.launch.args,
        env: mergeValue(base.launch.env, over.launch?.env) as ModuleDeclaration["launch"]["env"],
      },
      meta: mergeValue(base.meta, over.meta),
    });
  }

  // 既定に無い Module は、そのまま足す（外す指定だけのものは足さない）
  for (const over of byName.values()) {
    if (over.enabled === false) continue;
    if (!over.launch?.command || !over.launch.args) continue;
    result.push({
      name: over.name,
      launch: { command: over.launch.command, args: over.launch.args, env: over.launch.env },
      meta: over.meta,
    });
  }
  return result;
}

/** 深く同じ値か（差分を取るときに「変わっていない」を判定する）。 */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** オブジェクトのうち、既定と違うキーだけを残す。 */
function objectDiff(base: unknown, next: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(next)) return sameValue(base, next) ? undefined : (next as undefined);
  const baseObj = isPlainObject(base) ? base : {};
  const diff: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (isPlainObject(value) && isPlainObject(baseObj[key])) {
      const nested = objectDiff(baseObj[key], value);
      if (nested && Object.keys(nested).length > 0) diff[key] = nested;
      continue;
    }
    if (!sameValue(baseObj[key], value)) diff[key] = value;
  }
  return Object.keys(diff).length > 0 ? diff : undefined;
}

/**
 * **丸ごとの写しを、差分に圧縮する**（移行と、書き戻しの両方で使う）。
 *
 * いま Config に入っているのは丸ごとの写しなので、読んだ時点でこれを通す。
 * **冪等**——差分をもう一度圧縮しても同じものが出る。
 *
 * 注記：「意図して既定と同じ値に固定していた」場合と区別がつかなくなる。
 * いまその用途は無い（差分は自動の書き戻しでしか作られていない）ので、
 * 記録した上でこの形にする（決定・2026-09-07）。
 */
export function diffFromDefaults(
  defaults: readonly ModuleDeclaration[],
  whole: readonly ModuleDeclaration[],
): ModuleOverlay[] {
  const defaultsByName = new Map(defaults.map((d) => [d.name, d]));
  const overlays: ModuleOverlay[] = [];

  for (const d of whole) {
    const base = defaultsByName.get(d.name);
    defaultsByName.delete(d.name);
    if (!base) {
      // 既定に無い Module は、そのまま差分として持つ
      overlays.push({ name: d.name, launch: d.launch, meta: d.meta });
      continue;
    }
    const launch: Partial<ModuleDeclaration["launch"]> = {};
    if (base.launch.command !== d.launch.command) launch.command = d.launch.command;
    if (!sameValue(base.launch.args, d.launch.args)) launch.args = d.launch.args;
    const envDiff = objectDiff(base.launch.env, d.launch.env);
    if (envDiff) launch.env = envDiff as ModuleDeclaration["launch"]["env"];
    const metaDiff = objectDiff(base.meta, d.meta);

    if (Object.keys(launch).length === 0 && !metaDiff) continue; // 既定のまま
    overlays.push({
      name: d.name,
      ...(Object.keys(launch).length > 0 ? { launch } : {}),
      ...(metaDiff ? { meta: metaDiff } : {}),
    });
  }

  // **既定にあって写しに無いものは「外した」**——黙って戻さない（規則2）
  for (const name of defaultsByName.keys()) {
    overlays.push({ name, enabled: false });
  }
  return overlays;
}
