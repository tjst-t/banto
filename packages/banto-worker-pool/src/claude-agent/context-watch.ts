/**
 * 職人の文脈が伸びたことを知らせる係（PO 裁定 2026-08-20・可視化のみ）。
 *
 * `host.ts` から分けてあるのは、あちらが `main()` を即実行する入口で試験から
 * import できないため——判定そのものは純粋なので、ここだけ直に確かめられるようにする。
 */

/** 職人の文脈長を知らせる既定の刻み（トークン）。理由は `ContextWatch`。 */
export const DEFAULT_CONTEXT_WARN_TOKENS = 200_000;

/**
 * **伸び続ける職人に気づけるようにする**（PO 裁定 2026-08-20・可視化のみ）。
 *
 * 費用の実測（34時間）で、職人側の cache read は $80。中央値は 31ターン・8万トークンで
 * 健全だが、**裾に集中している**——最長の1本（task-0287）だけで 302ターン・40万トークン・
 * cache read $13.9。文脈は毎ターン丸ごと読み直されるので、費用は長さに比例して増える。
 *
 * **打ち切りはしない。** 途中で切られた仕事はやり直しになり、かえって高く付きうる——
 * そこは本物のトレードオフなので、まず「どのタスクが伸びるのか」を数えられるようにする
 * （P6「根拠は計測」）。上限を入れるかどうかは、この数字が貯まってから決める。
 *
 * 刻みごとに1回だけ出す。毎ターン出すと journal が埋まって、かえって気づけない。
 */
export class ContextWatch {
  private turns = 0;
  private notified = 0;
  private readonly step: number;
  private readonly write: (text: string) => void;

  /**
   * `env` と `write` は差し替えられる——**既定は本番の口**（`process.env`／標準エラー）。
   * 試験がグローバルを書き換えずに済むだけで、呼び出し側は今までどおり `new ContextWatch(名前)`。
   */
  constructor(
    private readonly label: string,
    options: { env?: NodeJS.ProcessEnv; write?: (text: string) => void } = {}
  ) {
    const env = options.env ?? process.env;
    this.write = options.write ?? ((text) => void process.stderr.write(text));
    const raw = env["BANTO_WORKER_CONTEXT_WARN_TOKENS"];
    const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number.parseInt(raw, 10);
    // I2: 読めない値は黙って既定に落とさず知らせる
    if (raw !== undefined && raw.trim() !== "" && (!Number.isFinite(parsed) || parsed <= 0)) {
      this.write(
        `[claude-agent] BANTO_WORKER_CONTEXT_WARN_TOKENS は正の整数です（${raw}）。既定を使います\n`
      );
    }
    this.step = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WARN_TOKENS;
  }

  /** SDK の assistant メッセージ1件分を数える。`usage` が無ければ数だけ進める。 */
  observe(usage: unknown): void {
    this.turns += 1;
    const u = usage as Record<string, number | undefined> | undefined;
    if (!u) return;
    const tokens =
      (u["input_tokens"] ?? 0) +
      (u["cache_creation_input_tokens"] ?? 0) +
      (u["cache_read_input_tokens"] ?? 0);
    if (tokens <= 0) return;
    const reached = Math.floor(tokens / this.step);
    if (reached <= this.notified) return;
    this.notified = reached;
    this.write(
      `[claude-agent] ${this.label}: 文脈が ${tokens.toLocaleString("en-US")} トークンに達しました` +
        `（${this.turns} ターン目・知らせる刻み ${this.step.toLocaleString("en-US")}）。` +
        `文脈は毎ターン読み直されるので、ここから先は1ターンあたりの費用が増え続けます\n`
    );
  }
}

