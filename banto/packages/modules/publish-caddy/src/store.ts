// この Module の置き場（host が渡す `BANTO_MODULE_DATA_DIR`）に持つもの：
//
// - `settings.json`——人が設定画面で決める、この Caddy の繋ぎ方（admin の場所・基のドメイン・届く範囲）
// - `routes.json`——公開の**マスター**。Caddy のルートはここから作り直せる写し（Service の systemd の定義と同じ関係）。
//   Basic 認証は bcrypt のハッシュだけを持つので 0600 で書く

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PublishError, type Reach, type RouteRecord } from "./route.js";

export interface CaddySettings {
  /** Caddy の admin API。`http://127.0.0.1:2019`（Caddy の既定）か `unix:/path/to/admin.sock` */
  adminUrl: string;
  /** 公開の URL の基（例 `banto.tjstkm.net` → `web-1a2b3c4d.banto.tjstkm.net`）。**決めていなければ公開しない** */
  baseDomain?: string;
  /** ルートを足す Caddy の server の名前。空なら 443 で待ち受けている1つを探す */
  serverName?: string;
  /** その URL がどこまで届くか。**分からなければ一番広い「インターネット」を見せる**（狭く見せるほうが危ない） */
  reach: Reach;
}

export const DEFAULT_SETTINGS: CaddySettings = { adminUrl: "http://127.0.0.1:2019", reach: "internet" };

const REACHES: readonly Reach[] = ["machine", "lan", "internet"];

export function parseSettings(raw: unknown): CaddySettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  const adminUrl = typeof s.adminUrl === "string" && s.adminUrl.trim() !== "" ? s.adminUrl.trim() : DEFAULT_SETTINGS.adminUrl;
  if (!/^(http:\/\/|unix:\/)/.test(adminUrl)) throw new PublishError("admin の場所は http://… か unix:/… です");
  const baseDomain = typeof s.baseDomain === "string" ? s.baseDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "") : "";
  if (baseDomain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(baseDomain)) {
    throw new PublishError(`基のドメインが不正です：${baseDomain}`);
  }
  const serverName = typeof s.serverName === "string" ? s.serverName.trim() : "";
  const reach = s.reach === undefined ? DEFAULT_SETTINGS.reach : s.reach;
  if (!REACHES.includes(reach as Reach)) throw new PublishError(`届く範囲が不正です：${JSON.stringify(s.reach)}`);
  return {
    adminUrl,
    ...(baseDomain ? { baseDomain } : {}),
    ...(serverName ? { serverName } : {}),
    reach: reach as Reach,
  };
}

async function writeJson(path: string, value: unknown, mode: number): Promise<void> {
  // 別名に書いて置き換える——途中で落ちても半端なファイルを残さない
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode });
  await rename(tmp, path);
}

async function readJson(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  // 壊れていたら止まる（黙って空にすると、公開の記録を失ったまま Caddy のルートを片付けてしまう）
  try {
    return JSON.parse(text);
  } catch {
    throw new PublishError(`${path} が壊れています（JSON として読めません）`);
  }
}

export class PublishStore {
  constructor(private readonly dir: string) {}

  async settings(): Promise<CaddySettings> {
    return parseSettings(await readJson(join(this.dir, "settings.json")));
  }

  async setSettings(raw: unknown): Promise<CaddySettings> {
    const s = parseSettings(raw);
    await mkdir(this.dir, { recursive: true });
    await writeJson(join(this.dir, "settings.json"), s, 0o600);
    return s;
  }

  async routes(): Promise<RouteRecord[]> {
    const raw = await readJson(join(this.dir, "routes.json"));
    return raw === undefined ? [] : ((raw as { routes: RouteRecord[] }).routes ?? []);
  }

  async setRoutes(routes: RouteRecord[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJson(join(this.dir, "routes.json"), { routes }, 0o600);
  }
}
