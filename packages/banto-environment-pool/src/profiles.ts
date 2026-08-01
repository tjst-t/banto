/**
 * プロファイルの在り処は呼び出し側が渡す（ADR-0010 決定34c・task-0034）。
 *
 * `repoPath` を受け取り `<repoPath>/meta/environments.yaml` を**都度読む**（D3：ファイルは
 * 意図。キャッシュしない）。
 *
 * **Environment Pool は独自のプロジェクト登録簿を持たない。** Kobo は自分の
 * `ProjectRegistry` から、番頭は自分が知っている作業場所から `repoPath` を渡す。
 * 持たせると Kobo の登録簿と二重管理になり、食い違ったときにどちらが正か決められない。
 *
 * D6: node:fs / node:path のみ（パーサは banto-core にある既存のもの）。
 * I2: 無い・壊れている・上限超過は、それぞれ別の理由として返す。黙って既定に落とさない。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseEnvProfiles, type EnvProfile } from "@banto/core";
import { checkProfileLimits, type EnvLimits } from "./limits.js";

/** `meta/environments.yaml` の在り処。 */
export function environmentsFilePath(repoPath: string): string {
  return path.join(repoPath, "meta", "environments.yaml");
}

export type ProfileLookup =
  | { ok: true; profile: EnvProfile }
  | { ok: false; reason: string };

/**
 * リポジトリからプロファイルを1つ引く。
 *
 * 上限（決定34f）の検査もここで通す——プロファイルを使う経路が複数あっても、
 * 検査を通らずに使われる道ができないようにするため。
 */
export function loadProfile(repoPath: string, name: string, limits: EnvLimits): ProfileLookup {
  const file = environmentsFilePath(repoPath);
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `${file} がありません（このリポジトリには検証環境の定義がない）` };
  }

  const parsed = parseEnvProfiles(fs.readFileSync(file, "utf-8"));
  const profile = parsed.valid.find((p) => p.name === name);
  if (!profile) {
    // I2: 定義が壊れていて弾かれた場合と、そもそも書かれていない場合を区別して返す
    const failure = parsed.failures.find((f) => f.name === name);
    if (failure) return { ok: false, reason: `profile "${name}" は不正です: ${failure.reason}` };
    const known = parsed.valid.map((p) => p.name).join(", ");
    return { ok: false, reason: `profile "${name}" は ${file} にありません。定義済み: ${known || "(なし)"}` };
  }

  const within = checkProfileLimits(profile, limits);
  if (!within.ok) return { ok: false, reason: within.reason };
  return { ok: true, profile };
}

/** そのリポジトリで使えるプロファイル名（上限を超えるものは理由つきで分けて返す）。 */
export function listProfiles(
  repoPath: string,
  limits: EnvLimits
): { usable: EnvProfile[]; rejected: Array<{ name: string; reason: string }> } {
  const file = environmentsFilePath(repoPath);
  if (!fs.existsSync(file)) return { usable: [], rejected: [] };

  const parsed = parseEnvProfiles(fs.readFileSync(file, "utf-8"));
  const usable: EnvProfile[] = [];
  const rejected = [...parsed.failures];
  for (const profile of parsed.valid) {
    const within = checkProfileLimits(profile, limits);
    if (within.ok) usable.push(profile);
    else rejected.push({ name: profile.name, reason: within.reason });
  }
  return { usable, rejected };
}
