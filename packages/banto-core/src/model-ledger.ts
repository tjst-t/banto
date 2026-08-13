/**
 * **役の台帳**（ADR-0021 決定101）。誰が何を使うかは、この1つの表だけが持つ。
 *
 * ## なぜ pi の台帳から出すのか（決定99）
 *
 * `llm-registry.json`（`LlmCatalog`）は **pi バックエンドの台帳**である——プロバイダの登録・
 * 鍵・`models.json` の取り込み・文脈長の手入力は、どれも pi 固有の関心事。そこに役の決定を
 * 同居させていたので、**Claude Code のモデルに採用の旗を立てる先が無かった**（症状1）。
 *
 * 供給（誰が何を出せるか）はバックエンドの持ち物、役の決定（誰が何を使うか）は核の持ち物。
 *
 * ## 範囲（決定99a）
 *
 * ここが持つのは **`steward` と `worker.<tier>`** まで。Kobo の `executor` / `rework` /
 * `audit` は**移さない**——「既定は核が持ち、**呼び出し側のモジュールが上書きできる**」が
 * 一般則で、Kobo は上書きする側。寄せると Kobo が Banto へ依存する（決定27 の依存逆転）。
 *
 * ## 版印（決定101a）
 *
 * **番頭ホストと工房は別サービスで、再起動が独立している。** しかも工房は更新時刻で
 * 走行中に読み直す。版印が無いと、古い版のコードが新しい形のファイルを読み、
 * **黙って別のモデルで走る**（候補の先頭へ、あるいは起動時の写しへ落ちる。どちらも
 * 例外にならない）。**読めない版なら止まる**（I2）。
 *
 * D3: 提示（選べるモデルの一覧）はここに持たない。供給元に聞いて導出する。
 * D6: node:fs / node:path のみ。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelConstraints, ModelTier } from "./llm-registry.js";

/**
 * 台帳の版。**形を変えたら上げる。** 上げ忘れると、古い読み手が新しい形を黙って読む。
 */
export const MODEL_LEDGER_SCHEMA_VERSION = 1;

/** 核が持つ役（決定99a）。呼び出し側のモジュールの役はここに入らない。 */
export const LEDGER_ROLES = [
  "steward",
  "worker.reasoning",
  "worker.standard",
  "worker.fast",
] as const;
export type LedgerRole = (typeof LEDGER_ROLES)[number];

export function isLedgerRole(value: string): value is LedgerRole {
  return (LEDGER_ROLES as readonly string[]).includes(value);
}

/** 職人の等級から役名へ。 */
export function ledgerWorkerRole(tier: ModelTier): LedgerRole {
  return `worker.${tier}` as LedgerRole;
}

/**
 * モデルの座標。**3成分**（決定98c・103）——同じ `opus` が pi 経由でも Agent SDK 経由でも
 * 指せるので、`backend` が無いと一意に解決できない。
 */
export interface LedgerModelRef {
  backend: string;
  provider: string;
  model: string;
}

/** 同じモデルを指しているか。 */
export function sameRef(a: LedgerModelRef, b: LedgerModelRef): boolean {
  return a.backend === b.backend && a.provider === b.provider && a.model === b.model;
}

/** 表示・比較に使う1行の形。**保存はしない**（3成分が正）。 */
export function refKey(ref: LedgerModelRef): string {
  return `${ref.backend}/${ref.provider}/${ref.model}`;
}

/**
 * 役ごとの束縛。
 *
 * **`only` は任意**（決定101e）。未指定＝母集団ぜんぶが候補——「台帳に採用する」と
 * 「役に許す」を必ず2回踏ませないため。「この役には使わせたくない」が出たときだけ書く。
 */
export interface RoleBinding {
  /** 既定の1つ。 */
  default?: LedgerModelRef;
  /** この役に許すものを絞る。**未指定＝母集団ぜんぶ**。 */
  only?: LedgerModelRef[];
  /** この役の条件（`local` のみ等）。**制約は決して緩めない**（決定101b）。 */
  constraints?: ModelConstraints;
}

export interface ModelLedgerData {
  schemaVersion: number;
  /**
   * **母集団**（決定101e）。この店で使う気があるモデル。役ごとに採り直さない。
   *
   * 空＝まだ採用していない。**「採用していないものは使えない」**（PO裁定 2026-08-04）は
   * そのまま効く。
   */
  adopted: LedgerModelRef[];
  roles: Partial<Record<LedgerRole, RoleBinding>>;
  /**
   * 等級の指定が無いときの既定（決定99a：既定は核）。
   * **バックエンドの入切（`defaultBackend`）は供給の話なので工房に残る。**
   */
  defaultTier?: ModelTier;
}

const EMPTY: ModelLedgerData = {
  schemaVersion: MODEL_LEDGER_SCHEMA_VERSION,
  adopted: [],
  roles: {},
};

export interface ModelLedgerOptions {
  path: string;
  /**
   * **読むだけ**（決定101d）。工房はこちらで開く——同じファイルを2つのプロセスが
   * 全文上書きすると、片方の書き込みが黙って消える。
   */
  readOnly?: boolean;
}

/**
 * 役の台帳。
 *
 * **読み直す**：番頭ホストが書き、工房が読む（`LlmCatalog` と同じ形）。抱え込むと
 * 「画面で選んだのに職人が変わらない、再起動するまで」という分かりにくい壊れ方になる。
 */
export class ModelLedger {
  private readonly filePath: string;
  private readonly readOnly: boolean;

  constructor(options: ModelLedgerOptions) {
    this.filePath = options.path;
    this.readOnly = options.readOnly === true;
  }

  get path(): string {
    return this.filePath;
  }

  /** 読むだけで開かれているか（移行は書き手だけが走らせる）。 */
  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** 台帳のファイルが在るか。**無い＝まだ移行していない**（呼び出し側は従来の経路へ落ちる）。 */
  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * **毎回ディスクから読む。**
   *
   * `LlmCatalog` は更新時刻で読み直すが、**同じミリ秒に2回書くと取りこぼす**
   * ——試験で実際に踏んだ。この台帳は数KBしか無く、取りこぼしの代償は
   * 「黙って別のモデルで走る」（決定101a がまさに避けたいこと）なので、
   * 微々たる読み込みより正しさを採る。
   */
  private load(): ModelLedgerData {
    if (!fs.existsSync(this.filePath)) {
      return { ...EMPTY, adopted: [], roles: {} };
    }
    let parsed: Partial<ModelLedgerData>;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<ModelLedgerData>;
    } catch (err) {
      // I2: 壊れた台帳で黙って空から始めない——役の割り当てを失ったことに気づけない
      throw new Error(`${this.filePath} を読めません（壊れた JSON）: ${String(err)}`);
    }
    const version = parsed.schemaVersion;
    /**
     * **読めない版なら止まる**（決定101a）。
     *
     * 番頭ホストと工房は別サービスで再起動が独立するので、片方だけ新しい版という状態が
     * 必ず生まれる。ここで止めないと、古い読み手が新しい形を黙って読み、**別のモデルで走る**。
     */
    if (version !== MODEL_LEDGER_SCHEMA_VERSION) {
      throw new Error(
        `${this.filePath} の版が合いません（台帳 ${String(version)} / このプロセス ` +
          `${MODEL_LEDGER_SCHEMA_VERSION}）。番頭ホストと工房を同じ版へ入れ直してください` +
          "——版が違うまま進むと、黙って別のモデルで走ります。"
      );
    }
    return {
      schemaVersion: MODEL_LEDGER_SCHEMA_VERSION,
      adopted: Array.isArray(parsed.adopted) ? parsed.adopted : [],
      roles: parsed.roles ?? {},
      ...(parsed.defaultTier ? { defaultTier: parsed.defaultTier } : {}),
    };
  }

  private save(data: ModelLedgerData): void {
    // I2: 読むだけの口から書かれたら止める（黙って捨てると、直したつもりで直っていない）
    if (this.readOnly) {
      throw new Error(`${this.filePath} は読み取り専用で開かれています（決定101d）`);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }

  /** 台帳の中身（写し）。 */
  all(): ModelLedgerData {
    const d = this.load();
    return {
      schemaVersion: d.schemaVersion,
      adopted: d.adopted.map((r) => ({ ...r })),
      roles: Object.fromEntries(
        Object.entries(d.roles).map(([k, v]) => [k, { ...v }])
      ) as Partial<Record<LedgerRole, RoleBinding>>,
      ...(d.defaultTier ? { defaultTier: d.defaultTier } : {}),
    };
  }

  roles(): Partial<Record<LedgerRole, RoleBinding>> {
    return this.all().roles;
  }

  role(role: LedgerRole): RoleBinding | undefined {
    const found = this.load().roles[role];
    return found ? { ...found } : undefined;
  }

  /**
   * **部分更新**（決定101c）。
   *
   * 役の欄を丸ごと置き換える書き方をやめる——`backend` が落ちた事故（症状4）は
   * `backend` 固有の話ではなく、**全置換**が原因だった。同じ形で `only` も
   * `constraints` も落ちる。**役へ書く経路はすべてここを通す。**
   */
  updateRole(role: LedgerRole, patch: Partial<RoleBinding>): void {
    const d = this.load();
    const current = d.roles[role] ?? {};
    const next: RoleBinding = { ...current };
    if ("default" in patch) {
      if (patch.default) next.default = { ...patch.default };
      else delete next.default;
    }
    if ("only" in patch) {
      if (patch.only) next.only = patch.only.map((r) => ({ ...r }));
      else delete next.only;
    }
    if ("constraints" in patch) {
      if (patch.constraints) next.constraints = { ...patch.constraints };
      else delete next.constraints;
    }
    d.roles[role] = next;
    this.save(d);
  }

  /** 役の割り当てを外す。 */
  clearRole(role: LedgerRole): void {
    const d = this.load();
    if (!d.roles[role]) return;
    delete d.roles[role];
    this.save(d);
  }

  // ── 母集団（決定101e） ──────────────────────────────────────────────────

  adopted(): LedgerModelRef[] {
    return this.all().adopted;
  }

  isAdopted(ref: LedgerModelRef): boolean {
    return this.load().adopted.some((r) => sameRef(r, ref));
  }

  /** 母集団へ足す（冪等）。 */
  adopt(ref: LedgerModelRef): void {
    const d = this.load();
    if (d.adopted.some((r) => sameRef(r, ref))) return;
    d.adopted.push({ ...ref });
    this.save(d);
  }

  /** 母集団から外す（冪等）。**役に割り当てられているものは外せない**（解決先を失う）。 */
  unadopt(ref: LedgerModelRef): void {
    const d = this.load();
    const bound = Object.entries(d.roles).find(
      ([, binding]) => binding?.default && sameRef(binding.default, ref)
    );
    if (bound) {
      throw new Error(
        `${refKey(ref)} は「${bound[0]}」に割り当てられています。` +
          "先に別のモデルを割り当ててください。"
      );
    }
    const before = d.adopted.length;
    d.adopted = d.adopted.filter((r) => !sameRef(r, ref));
    if (d.adopted.length !== before) this.save(d);
  }

  /** 等級の指定が無いときの既定（決定99a）。 */
  defaultTier(): ModelTier | undefined {
    return this.load().defaultTier;
  }

  setDefaultTier(tier: ModelTier | undefined): void {
    const d = this.load();
    if (tier) d.defaultTier = tier;
    else delete d.defaultTier;
    this.save(d);
  }

  /**
   * まだ台帳が無いときに一度だけ作る（移行）。**既に在れば何もしない**——
   * 移行を毎回の起動で走らせると、人が消した割り当てが復活する（`migrateOnce` で踏んだ罠）。
   *
   * @returns 作ったかどうか
   */
  initialize(seed: Omit<ModelLedgerData, "schemaVersion">): boolean {
    if (this.exists()) return false;
    this.save({ schemaVersion: MODEL_LEDGER_SCHEMA_VERSION, ...seed });
    return true;
  }
}
