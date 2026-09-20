// **ログインの結果を、起動をまたいで持つ**（決定・2026-09-20、ユーザー指示）。
//
// Universal Auth の Client Secret には**使用回数の上限**を付けられる
// （Infisical の「Max Number of Uses」）。banto は起動のたびに1回ログインして
// いたので、**再起動のたびに残数が減り、いずれ切れる**——実際に切れた
// （`Access denied due to client secret usage limit reached`、2026-09-20）。
//
// ログインが返す access token には期限があり、**期限まで使い回せる**。
// 持っておけば、起動のたびの1回が要らなくなる。
//
// **期限は保存しない**（規則3——導出できない値を推測して持たない）。
// SDK の `login()` は `expiresIn` を返さない（`getAccessToken()` しか無い）ので、
// 期限を持とうとすると**当て推量を保存する**ことになる。代わりに
// **使ってみて駄目ならログインし直す**——期限切れは、そのとき分かればよい。
//
// **これは資格情報。** Client Secret と同じ扱いで、この Module のデータ置き場に
// 0600 で置く（`connection.json` の隣）。banto の記録にも画面にも出さない。

import { readFile, writeFile, mkdir, rename, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InfisicalConfig } from "./client.js";

interface CachedToken {
  /** **どの接続のトークンか**。接続先を変えたら使い回さない。秘密は入れない。 */
  key: string;
  accessToken: string;
}

/**
 * トークンが**どの接続のものか**を表す鍵。
 *
 * **Client Secret は入れない**——入れると、秘密を変えただけで（同じ identity
 * なのに）まだ生きているトークンを捨てることになる。逆に、接続先・identity・
 * Project・環境のどれかが変われば、そのトークンはもう別物。
 */
export function tokenKeyOf(config: InfisicalConfig): string {
  return [config.siteUrl, config.clientId, config.projectId, config.environment].join("|");
}

export class InfisicalTokenCache {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "access-token.json");
  }

  /** その接続のトークン。**別の接続のものなら無いものとして扱う**。 */
  async load(key: string): Promise<string | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<CachedToken>;
      if (!raw.accessToken || raw.key !== key) return undefined;
      return raw.accessToken;
    } catch {
      // **壊れた覚えを「たぶんこう」で読まない**（規則2）——無いものとして扱えば、
      // ログインし直すだけで回復する
      return undefined;
    }
  }

  async save(key: string, accessToken: string): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ key, accessToken } satisfies CachedToken), { mode: 0o600 });
    await rename(tmp, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  /** 使えなかったトークンを捨てる。**残しておくと、毎回ここで1往復無駄になる**。 */
  async forget(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
