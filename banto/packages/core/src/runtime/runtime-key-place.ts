// **実行場所の SSH 鍵が置き場（`RUNTIME_KEYS_GROUP`）の外にあるとき、受信箱に実行場所ごとに1枚出す**（決定・2026-10-17、
// Backlog #375。`docs/specs/v4-security.md` §1「向こうとの道」・`docs/specs/v4-frontend.md` の受信箱）。
//
// #361 で実行場所の鍵は Vault のグループ `banto-runtime` のものしか使わなくなった。前から登録してあった実行場所の鍵が
// 前のグループにあると繋がらず、その実行場所で動く Module が全部消えたのに、人に見えたのは host のログだけだった。
// 確かめるのは banto が起きたとき・登録が変わったとき・繋ごうとして「置き場に無い」で断ったとき・カードが開いている間の
// 1分ごと（人が Vault の管理画面で手で移した・登録を替えたら閉じる）。
//
// - 鍵が読める Vault のほかの置き場に1つだけある → 「移す」付きのカード（移す元を添える）
// - 複数ある・参照しか無い・どこにも無い（消えた・読めない Vault にある）→ 理由と入口だけのカード
// - 置き場にある → 閉じる
//
// 「繋がらないときのお知らせ」（`modules/remote-outage.ts`）とは重ねない——こちらが開いている実行場所は、あちらを出さない
// （呼び元が `blocks` を見る）

import { RUNTIME_KEYS_GROUP } from "@banto/module-contract";
import { RemoteRuntimeError } from "./remote-runtimes.js";

/** Vault にある ssh-identity の1行（人の管理面の一覧から。値は通らない） */
export interface VaultSshKey {
  implementation: string;
  name: string;
  group: string;
  /** 実行場所の鍵の置き場にあるか */
  runtime: boolean;
  /** 参照か（参照は実行場所の鍵の置き場へ移せない） */
  link: boolean;
}

export interface VaultSshKeyListing {
  keys: VaultSshKey[];
  /** 読めなかった Vault（`<実装>（<理由>）`） */
  failures: string[];
}

/** 受信箱のお知らせに載せる、どの実行場所のどの鍵の話か（`NoticeItem.runtimeKey`） */
export interface RuntimeKeyRef {
  runtime: string;
  alias: string;
  /** 「移す」で移す元。無ければ「移す」は出さない */
  from?: { implementation: string; group: string };
  /** 影響している Project（Vault の管理画面をその Project の画面で開く入口に使う） */
  projectIds: string[];
}

export interface RuntimeKeyCard extends RuntimeKeyRef {
  title: string;
  detail: string;
}

export interface RuntimeKeyPlaceDeps {
  /** 登録してある実行場所と、その鍵の alias */
  runtimes(): Array<{ name: string; identity: string }>;
  /** 読める Vault にある ssh-identity 全部（置き場を問わず）。Vault が1つも繋がらなければ投げる */
  listKeys(): Promise<VaultSshKeyListing>;
  /** その実行場所で動く Project（名前つき）と、繋がっていない Project ごとの Module の数 */
  affected(runtimeName: string): { projects: Array<{ id: string; name: string }>; modules: number };
  /** その実行場所の、いま開いているカード */
  openCard(runtimeName: string): RuntimeKeyCard | undefined;
  /** カードが開いている実行場所（登録を外した実行場所のカードを閉じるのに使う） */
  openCardRuntimes(): string[];
  raise(card: RuntimeKeyCard): Promise<void>;
  close(runtimeName: string): Promise<void>;
  /** 鍵が置き場に戻った実行場所へ、すぐ繋ぎ直す（試し直しの間を待たない） */
  reconnect(runtimeName: string): Promise<void>;
  log?: (line: string) => void;
}

export class RuntimeKeyPlaceWatch {
  /** 鍵が置き場に無いと分かっている実行場所（同期で引ける——Module ごとのお知らせを出す前に見る） */
  private readonly missing = new Set<string>();
  private running: Promise<void> | undefined;
  private again = false;

  constructor(private readonly deps: RuntimeKeyPlaceDeps) {}

  /** その実行場所は鍵が置き場の外にあるので繋がらない（Module ごと・繋がらないときのお知らせは出さない） */
  blocks(runtimeName: string): boolean {
    return this.missing.has(runtimeName);
  }

  /**
   * **確かめる**（全部の実行場所）。同時に頼まれたら1本にまとめ、走っている間に頼まれたらもう1回だけ走らせる。
   * Vault が読めないなら何も変えない（分からないのに出す・閉じるをしない）
   */
  check(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.runOnce();
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** 繋ごうとして「その鍵は置き場に無い」で断った——その鍵の実行場所に印を付け、確かめる */
  refused(alias: string): void {
    for (const r of this.deps.runtimes()) if (r.identity === alias) this.missing.add(r.name);
    void this.check().catch((err: unknown) => this.log(`[host] 実行場所の鍵の置き場を確かめられませんでした: ${errorText(err)}`));
  }

  /** 繋がった——鍵は置き場にある。開いていれば閉じる */
  connected(runtimeName: string): void {
    this.missing.delete(runtimeName);
    if (!this.deps.openCard(runtimeName)) return;
    void this.deps.close(runtimeName).catch((err: unknown) => this.log(`[host] お知らせを閉じられませんでした: ${errorText(err)}`));
  }

  /** 1分ごと：カードが開いている・置き場に無いと分かっている間だけ確かめ直す（人が手で直したら閉じる） */
  tick(): void {
    if (this.missing.size === 0 && this.deps.openCardRuntimes().length === 0) return;
    void this.check().catch((err: unknown) => this.log(`[host] 実行場所の鍵の置き場を確かめられませんでした: ${errorText(err)}`));
  }

  /**
   * **「移す」で移す元**。カードの記録を信じず、いまの Vault を読み直して決める（押すまでの間に人が手で動かしたかもしれない）。
   * 移せないなら理由つきで断る
   */
  async movePlan(runtimeName: string): Promise<{ alias: string; implementation: string; group: string }> {
    const r = this.deps.runtimes().find((x) => x.name === runtimeName);
    if (!r) throw new RemoteRuntimeError(404, `実行場所「${runtimeName}」はありません`);
    const card = cardFor(r, await this.deps.listKeys(), this.deps.affected(r.name));
    if (!card) throw new RemoteRuntimeError(409, `SSH 鍵「${r.identity}」はもう実行場所の鍵の置き場（グループ "${RUNTIME_KEYS_GROUP}"）にあります`);
    if (!card.from) throw new RemoteRuntimeError(409, card.detail);
    return { alias: r.identity, ...card.from };
  }

  /**
   * **移したあと**：確かめ直して（同じ鍵を使うほかの実行場所のカードも閉じる）、置き場に戻った実行場所へすぐ繋ぎ直す。
   * 頼まれた実行場所の繋ぎ直しの失敗は投げる（移したことは取り消さない——呼び元が人に出す）
   */
  async moved(runtimeName: string): Promise<void> {
    const before = new Set([...this.missing, runtimeName]);
    await this.check();
    const back = [...before].filter((n) => !this.missing.has(n) && this.deps.runtimes().some((r) => r.name === n));
    for (const n of back) {
      if (n === runtimeName) continue;
      void this.deps.reconnect(n).catch((err: unknown) => this.log(`[host] 別のサーバ「${n}」に繋ぎ直せませんでした: ${errorText(err)}`));
    }
    if (back.includes(runtimeName)) await this.deps.reconnect(runtimeName);
  }

  private async runOnce(): Promise<void> {
    const runtimes = this.deps.runtimes();
    const names = new Set(runtimes.map((r) => r.name));
    for (const n of [...this.missing]) if (!names.has(n)) this.missing.delete(n);
    // 外した実行場所のカードは閉じる
    for (const n of this.deps.openCardRuntimes()) if (!names.has(n)) await this.deps.close(n);
    if (runtimes.length === 0) return;
    let listing: VaultSshKeyListing;
    try {
      listing = await this.deps.listKeys();
    } catch (err) {
      this.log(`[host] 実行場所の鍵の置き場を確かめられませんでした（Vault を読めません）: ${errorText(err)}`);
      return;
    }
    for (const r of runtimes) {
      const card = cardFor(r, listing, this.deps.affected(r.name));
      const open = this.deps.openCard(r.name);
      if (!card) {
        this.missing.delete(r.name);
        if (open) await this.deps.close(r.name);
        continue;
      }
      this.missing.add(r.name);
      // 同じ話（題・鍵・移す元）なら出し直さない——止まっている Module の数が変わっただけで積まない
      if (open && sameCard(open, card)) continue;
      if (open) await this.deps.close(r.name);
      this.log(`[host] 別のサーバ「${r.name}」の SSH 鍵「${r.identity}」が実行場所の鍵の置き場にありません：${card.title}`);
      await this.deps.raise(card);
    }
  }

  private log(line: string): void {
    (this.deps.log ?? console.warn)(line);
  }
}

function sameCard(a: RuntimeKeyCard, b: RuntimeKeyCard): boolean {
  return (
    a.title === b.title &&
    a.alias === b.alias &&
    a.from?.implementation === b.from?.implementation &&
    a.from?.group === b.from?.group
  );
}

/** 置き場にあれば undefined。無ければ、人に出すカード */
export function cardFor(
  r: { name: string; identity: string },
  listing: VaultSshKeyListing,
  affected: { projects: Array<{ id: string; name: string }>; modules: number },
): RuntimeKeyCard | undefined {
  const same = listing.keys.filter((k) => k.name === r.identity);
  if (same.some((k) => k.runtime)) return undefined;
  const originals = same.filter((k) => !k.link);
  const links = same.filter((k) => k.link);
  const where = (k: VaultSshKey) => `${k.implementation} の「${k.group}」`;
  const place = `実行場所の SSH 鍵の置き場（グループ "${RUNTIME_KEYS_GROUP}"）`;
  const impact =
    affected.projects.length > 0
      ? `影響している Project：${affected.projects.map((p) => `「${p.name}」`).join("")}・止まっている Module ${affected.modules} 個。`
      : "この実行場所を使っている Project はまだありません。";
  const unread = listing.failures.length > 0 ? `読めなかった Vault があります：${listing.failures.join("、")}。` : "";
  const base = { runtime: r.name, alias: r.identity, projectIds: affected.projects.map((p) => p.id) };
  if (originals.length === 1) {
    const k = originals[0]!;
    return {
      ...base,
      from: { implementation: k.implementation, group: k.group },
      title: `別のサーバ ${r.name} に繋げません：SSH 鍵が置き場の外にあります`,
      detail:
        `SSH 鍵「${r.identity}」は Vault ${where(k)}にあり、${place}にありません。banto は実行場所にはこの置き場の鍵しか使いません。` +
        `「移す」で置き場へ移すと、すぐに繋ぎ直します。${impact}${unread}`,
    };
  }
  if (originals.length > 1 || links.length > 0) {
    return {
      ...base,
      title: `別のサーバ ${r.name} に繋げません：SSH 鍵が置き場の外にあります`,
      detail:
        (originals.length > 1
          ? `SSH 鍵「${r.identity}」は Vault の複数の置き場にあります（${originals.map(where).join("、")}）。どれを移すかは Vault の管理画面で選んでください。`
          : `SSH 鍵「${r.identity}」は参照（${links.map(where).join("、")}）しかありません。参照は移せないので、元の鍵を Vault の管理画面で${place}へ移してください。`) +
        `${impact}${unread}`,
    };
  }
  return {
    ...base,
    title: `別のサーバ ${r.name} に繋げません：SSH 鍵が見つかりません`,
    detail:
      (listing.failures.length > 0
        ? `SSH 鍵「${r.identity}」は読めた Vault のどこにもありません。${unread}その Vault にあるのかもしれません——読めるようにするか、`
        : `SSH 鍵「${r.identity}」はどの Vault にもありません（消えたのかもしれません）。`) +
      `Vault の管理画面で${place}に鍵を置くか、実行場所の設定で登録し直してください。${impact}`,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
