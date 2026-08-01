/**
 * 設定の置き場（task-0047・prototype の設定面）。
 *
 * **番頭が書き換えられない場所に置く**（決定38b）。ホストのデータ置き場は `file.write` の
 * 砦が守っており、番頭はどの設定でも書けない——設定を書き換えられると、場所の許可も
 * 上限も自分で広げられてしまう（自己昇格）。
 *
 * **環境変数より設定が強い、ではない。** 起動時の環境変数・CLI引数は「その起動の指定」で、
 * ここは「保存された指定」。**保存された方を優先する**——画面で変えたのに次の起動で
 * 元に戻る、が一番分かりにくい。環境変数は保存が無いときの既定として効く。
 *
 * D3: 保存するのは**明示的に設定されたものだけ**。既定値は書かない——書くと、既定を
 *     変えたときに古い値が固定されたまま残る。
 * I2: 壊れた設定で黙って既定に落ちない。気づかないまま別の設定で動くのが一番困る。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 場所ひとつぶんの設定（`BANTO_PLACES` の1項目に相当）。 */
export interface PlaceSetting {
  id: string;
  path: string;
  /** 書き込みを許す範囲（glob）。空・未設定なら読み取り専用（決定38a）。 */
  writable?: string[];
}

export interface BantoSettings {
  llm?: {
    provider?: string;
    model?: string;
  };
  /** 番頭が作業できる場所。設定するとここが真実になり、`BANTO_PLACES` は使われない。 */
  places?: PlaceSetting[];
  environment?: {
    defaultTtlMs?: number;
    maxTtlMs?: number;
    maxInstancesPerProfile?: number;
    maxInstancesTotal?: number;
    adhocDrivers?: "builtin" | "all" | "none";
    defaultRunTimeoutMs?: number;
    collectedRetentionMs?: number;
  };
  /**
   * モジュールが宣言した設定の値（決定41）。区画名で分ける。
   *
   * 中身の形は**モジュールが決める**——ここは保存先を貸しているだけで、解釈しない。
   */
  modules?: Record<string, Record<string, unknown>>;
  network?: {
    /** 待ち受けるアドレス（決定40）。既定は localhost のみ。 */
    bind?: string;
    /** 外から見えるときの banto 自身の URL（検証環境のリンクに使う）。 */
    publicUrl?: string;
    /** Caddy の admin API（決定39c）。`envDomain` と対で設定する。 */
    caddyAdmin?: string;
    envDomain?: string;
  };
}

interface SettingsFile extends BantoSettings {
  version: 1;
}

export class SettingsStore {
  private readonly filePath: string;
  private settings: BantoSettings;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.settings = this.read();
  }

  /** 保存されている設定。 */
  all(): BantoSettings {
    return structuredClone(this.settings);
  }

  /** どこに保存しているか。画面に出す（番頭が触れない場所であることを示すため）。 */
  location(): string {
    return this.filePath;
  }

  /**
   * 区画ごとに差し替える。
   *
   * 区画まるごとの置き換えにしてあるのが要点——項目ごとの浅いマージだと、
   * 「場所を1つ消す」が表現できない（消したい項目を送る手段が無い）。
   */
  update<K extends keyof BantoSettings>(section: K, value: BantoSettings[K]): void {
    if (value === undefined) delete this.settings[section];
    else this.settings[section] = value;
    this.write();
  }

  private read(): BantoSettings {
    if (!fs.existsSync(this.filePath)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch (err) {
      // I2: 黙って既定に落ちない。設定したつもりの値と違う値で動くのが一番困る
      throw new Error(`${this.filePath} を読めません（設定が壊れています）: ${String(err)}`);
    }
    const { version: _version, ...rest } = parsed as SettingsFile;
    return rest;
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const body: SettingsFile = { version: 1, ...this.settings };
    fs.writeFileSync(this.filePath, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  }
}
