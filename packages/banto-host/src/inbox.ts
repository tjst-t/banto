/**
 * 取次 — 番頭に用があるものを、出所を問わず受ける（spec-design §0④・spec-ui §3）。
 *
 * **これは Banto 側の汎用の受け口で、Kobo 固有ではない。** Kobo のアテンションキューとは
 * 別物で、どの店（モジュール）も・番頭自身も・職人も・検証環境も・外の道具も、同じ口へ
 * 「POに用がある」を積める。プロトタイプの「セッション開始リクエスト」を一本化したもの
 * （PO裁定 2026-08-05 ④「一本化しよう。分ける理由がない」）。
 *
 * 一通は spec-ui §3 の三部構成を必須とする——**画面を遡らず、その札だけで判断できること**。
 *   経緯（起点となったPOの指示）／起きたこと（その後の経過）／求める判断（問いと選択肢）
 *
 * D3: 状態の真実はここが一箇所で持ち、UI は配られた状態を描くだけ。
 *     滞留時間・件数は `createdAt` から導出できるので**持たない**。
 * D5: 判断は無い。並び順（滞留 × 止めている後続）だけがここの仕事で、
 *     何を積むか・何と答えるかは積む側とPOが決める。
 * I2: 知らない id への回答は黙って捨てず例外にする。
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** 一通の出所。**誰が言っているか**を、読む前に出すために要る。 */
export interface InboxSource {
  /** 機械の名前（`banto` / `worker` / `kobo` / `env` / `github` など）。絞り込みの単位。 */
  id: string;
  /** 画面に出す名前（「職人 w-28」「Kobo（開発）」など）。 */
  label: string;
}

/**
 * 押されたときにホストが実行する処理（決定73）。
 *
 * **これが無いと、POが押しても何も起きない。** 以前は取次が「答えを記録して番頭に伝える」
 * だけで、実際に効かせるのは番頭の次のターン任せだった——書き込み許可のように
 * **番頭には実行できない**（機構で分けてある。決定38c）ものは、そこで止まる。
 *
 * 呼ぶ先は普通 `internalTools`（番頭に渡さない口。決定29e）。番頭が自分で押せない
 * ことは変わらない——押すのは PO で、ホストが代わりに呼ぶ。
 *
 * D5: ここに判断は無い。積む側が「押されたら何を呼ぶか」を書き、ホストは呼ぶだけ。
 */
export interface InboxEffect {
  /** どのモジュールの口か。中核の Tool なら `core`。 */
  module: string;
  /** 呼ぶ Tool の論理名。 */
  tool: string;
  args?: Record<string, unknown>;
}

/** POに何を求めているか。選択肢は「その場で押せる答え」。 */
export interface InboxAction {
  id: string;
  label: string;
  /**
   * 見た目の強さ。`call` が朱の塗り（推し）、`plain` が既定、`quiet` が控えめ。
   * **意味づけは積む側が持つ**——画面はこれを描くだけ。
   */
  tone?: "call" | "plain" | "quiet";
  /** 押されたときにホストが実行する処理（決定73）。無ければ記録と知らせだけ。 */
  effect?: InboxEffect;
}

/** 押したときに開く先。会話と面を**同時に**開くのが取次の要点。 */
export interface InboxOpens {
  /** 既にある会話へ移る。無ければ何も起きない（新しく作らない）。 */
  threadId?: string;
  /** キャンバスに開く面。 */
  canvas?: { kind: string; params?: Record<string, unknown>; title?: string };
  /**
   * 設定の区画へ移る（決定75）。
   *
   * キャンバスのタブではなく**会話に被さる面**なので、開くのは画面側の役目
   * ——ホストはどこへ行きたいかだけを載せる。「その場で押せる答え」では足りず、
   * 細かく決めたいときの逃げ道（書き込み許可なら範囲の編集）がここ。
   */
  settings?: { section?: string };
}

export interface InboxItem {
  id: string;
  /**
   * 同じ用件を二度積まないための合印（決定73）。
   *
   * 積む側が「これは同じ頼みだ」と言える場合にだけ付ける（書き込み許可なら要求の id）。
   * **未解決の同じ合印があれば積み増さない**——番頭が同じことを頼み直しても、
   * POの前に同じ札が2枚並ばない。答えの出たものは合印が同じでも新しく積める
   * （一度断った件を頼み直すのは、別の用件だから）。
   */
  key?: string;
  source: InboxSource;
  /** 種別の表示名（「後戻りできない」「番頭では決められない」など）。 */
  kind: string;
  /** よりどころの規則（D1 / D9 / P3 など）。あれば札の隅に小さく出る。 */
  rule?: string;
  title: string;
  /** 三部構成。経緯は起点が無い（システム起点の）ものだけ省ける。 */
  why?: string;
  what: string;
  ask: string;
  actions: InboxAction[];
  opens?: InboxOpens;
  /** この判断が止めている後続の数。並び順の第二の軸。 */
  blocking?: number;
  createdAt: string;
  /** 答えたら埋まる。埋まった一通は数に入らず、下の段へ落ちる。 */
  resolvedAt?: string;
  /** 押された選択肢の id。 */
  resolution?: string;
}

/**
 * 画面へ配る形。導出できる値は載せない（D3）。
 *
 * **選択肢に付いた `effect` は落とす**（決定73）。押されたときに何を呼ぶかを画面へ配ると、
 * 画面から任意の口を呼べることになり、承認を番頭から機構で分けた意味が無くなる
 * ——画面は「押された」を投げ返すだけで、呼ぶのはホスト（I1：ずるを不可能にする）。
 */
export type InboxItemView = Omit<InboxItem, "actions"> & {
  actions: Array<Omit<InboxAction, "effect">>;
};

/** 一通から `effect` を落とす。配るときは必ずここを通す。 */
function toView(item: InboxItem): InboxItemView {
  return {
    ...item,
    actions: item.actions.map(({ effect: _effect, ...action }) => action),
  };
}

interface LogLine {
  v: 1;
  at: string;
  post?: InboxItem;
  resolve?: { id: string; action: string; at: string };
}

export interface PostInput {
  /** 同じ用件を二度積まないための合印。未解決の同じ合印があれば積み増さない。 */
  key?: string;
  source: InboxSource;
  kind: string;
  rule?: string;
  title: string;
  why?: string;
  what: string;
  ask: string;
  actions: InboxAction[];
  opens?: InboxOpens;
  blocking?: number;
}

/**
 * 取次の帳簿。
 *
 * 記録は**追記だけのイベントログ**（積んだ／答えた）。起動時に読み直して今の姿を作る
 * ——導出できる状態をファイルに持たないため（D3）。
 */
export class Inbox {
  private readonly items = new Map<string, InboxItem>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly logFile?: string) {
    if (logFile) this.replay();
  }

  /** 変化を購読する。サーバはこれで WS へ配り直す。 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 一通を積む。積んだ本人には id を返す（後で自分で畳めるように）。
   *
   * `key` が付いていて、**未解決の同じ合印**が既にあるなら、それをそのまま返す
   * ——同じ頼みで札を積み増さない（`PlaceGrantStore.request` と同じ考え方）。
   */
  post(input: PostInput): InboxItem {
    if (input.key !== undefined) {
      const existing = [...this.items.values()].find(
        (i) => i.key === input.key && !i.resolvedAt
      );
      if (existing) return existing;
    }
    const item: InboxItem = {
      id: `in-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.items.set(item.id, item);
    this.append({ v: 1, at: item.createdAt, post: item });
    this.emit();
    return item;
  }

  /**
   * 答える。**答えは消さずに残す**——「何を選んだか」は後から辿れる必要がある
   * （やり直したくなったときの出発点になる）。
   */
  resolve(id: string, action: string): InboxItem {
    const item = this.items.get(id);
    // I2: 知らない id を黙って捨てない。押した側は押せたつもりでいる
    if (!item) throw new Error(`取次に "${id}" という一通はありません。`);
    if (item.resolvedAt) throw new Error(`"${item.title}" は既に答えが出ています（${item.resolution}）。`);
    const known = item.actions.some((a) => a.id === action);
    if (!known) {
      throw new Error(
        `"${action}" は "${item.title}" の選択肢にありません（${item.actions.map((a) => a.id).join(" / ")}）。`
      );
    }
    const at = new Date().toISOString();
    const next: InboxItem = { ...item, resolvedAt: at, resolution: action };
    this.items.set(id, next);
    this.append({ v: 1, at, resolve: { id, action, at } });
    this.emit();
    return next;
  }

  get(id: string): InboxItem | undefined {
    return this.items.get(id);
  }

  /**
   * いま積まれているもの。**並び順は滞留 × 止めている後続**（spec-ui §1）。
   * 答えの出たものは後ろにまとめる。
   */
  list(): InboxItemView[] {
    const weight = (i: InboxItem): number => {
      const ageMin = (Date.now() - Date.parse(i.createdAt)) / 60000;
      return ageMin * (1 + (i.blocking ?? 0));
    };
    return [...this.items.values()]
      .sort((a, b) => {
        if (!a.resolvedAt !== !b.resolvedAt) return a.resolvedAt ? 1 : -1;
        if (a.resolvedAt && b.resolvedAt) return b.resolvedAt.localeCompare(a.resolvedAt);
        return weight(b) - weight(a);
      })
      .map(toView);
  }

  /** まだ答えの出ていない数。上段の札に出る唯一の数字。 */
  pendingCount(): number {
    return [...this.items.values()].filter((i) => !i.resolvedAt).length;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private append(line: LogLine): void {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify(line) + "\n", "utf8");
    } catch (err) {
      // I2: 残せなかったことを黙らない。ただし取次そのものは動かし続ける
      //     （記録できないより、POに届かないほうが困る）
      console.error(`[inbox] 記録を書けません: ${String(err)}`);
    }
  }

  private replay(): void {
    if (!this.logFile || !fs.existsSync(this.logFile)) return;
    let lineNo = 0;
    for (const raw of fs.readFileSync(this.logFile, "utf8").split("\n")) {
      lineNo += 1;
      if (raw.trim().length === 0) continue;
      try {
        const line = JSON.parse(raw) as LogLine;
        if (line.post) this.items.set(line.post.id, line.post);
        if (line.resolve) {
          const item = this.items.get(line.resolve.id);
          if (item) {
            this.items.set(item.id, { ...item, resolvedAt: line.resolve.at, resolution: line.resolve.action });
          }
        }
      } catch (err) {
        // I2: 壊れた1行で全部を捨てない。ただし黙らない
        console.error(`[inbox] ${this.logFile}:${lineNo} を読めません: ${String(err)}`);
      }
    }
  }
}
