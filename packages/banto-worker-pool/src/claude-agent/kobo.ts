/**
 * Claude Code の職人が **工場（Kobo）** の口を叩くための経路（PO報告 2026-08-11）。
 *
 * ## なぜ要るか
 *
 * Kobo は職人に `report_phase` / `report_done`（実装役）と `audit_report`（監査役）を
 * 渡す前提で組んである。渡し方は `driverOptions.extensionPaths` ——**pi の言葉**で、
 * `pi -e <拡張>` に載る。`ClaudeAgentDriver` はそれを黙って無視していたので、
 * **Claude Code の職人には Kobo の口が1つも無かった**。
 *
 * 結果、実装を終えてコミットまでしていてもタスクは `implementing` のまま止まり、
 * 監査人は「`audit_report` ツールはこの環境に存在せず」と書き残して落ちた（実機の記録）。
 * Kobo から見ると**どのタスクも完走しない**。
 *
 * ## 何をするか
 *
 * pi 拡張（`banto-daemon/src/pi-extension/`）と**同じ HTTP 面**を叩くだけ。判断は無い
 * （D5）。`projectTag` / `taskId` は環境変数で固定する——職人に書かせると別のタスクの
 * 状態を動かせてしまう（決定35a と同じ理由）。
 *
 * D6: 依存は fetch のみ。Kobo のパッケージを読み込まない（職人の側に工場を持ち込まない）。
 * I2: 失敗は握りつぶさない。職人が「報告した」と誤解すると、報告そのものが消える。
 */

/** Kobo の口。無ければ（＝Kobo の職人ではないなら）作らない。 */
export interface KoboChannel {
  /** 工程が変わった（planning / implementing）。 */
  reportPhase(phase: "planning" | "implementing", note?: string): Promise<string>;
  /** 実装が終わった。**完了の宣言ではなく、監査へ回す合図**。 */
  reportDone(summary: string): Promise<string>;
  /** 監査の判定。**自由文ではなく pass / fail** で出す。 */
  auditReport(verdict: "pass" | "fail", findings: string[]): Promise<string>;
}

/**
 * 到達先と宛先が揃っていれば口を作る。無ければ `undefined`
 * ——**Kobo の職人でないものに Kobo の口を渡さない**（番頭が直に起こした職人には要らない）。
 *
 * `taskId` の役目の接尾辞（`task-0001:audit`）は落とす。Kobo の帳簿の鍵はタスクだけで、
 * 役目は工房側の都合（pi 拡張も同じことをしている）。
 */
export function createKoboChannel(env: NodeJS.ProcessEnv = process.env): KoboChannel | undefined {
  const baseUrl = env["BANTO_DAEMON_URL"];
  const projectTag = env["BANTO_PROJECT"];
  const taskId = env["BANTO_TASK_ID"]?.split(":")[0];
  if (!baseUrl || !projectTag || !taskId) return undefined;
  const root = baseUrl.replace(/\/$/u, "");

  const post = async (path: string, body: Record<string, unknown>): Promise<string> => {
    const url = `${root}/api/v1/projects/${encodeURIComponent(projectTag)}/tasks/${encodeURIComponent(taskId)}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // I2: **届かなかったことも成功に見せない。** 素の "fetch failed" では、職人にも
      //     読む人にも何が起きたか分からない——どこへ届かなかったのかを添える
      throw new Error(`[claude-agent] 工場への ${path} が届きません（${root}）: ${String(err)}`);
    }
    if (!res.ok) {
      // I2: 失敗を成功に見せない
      const text = await res.text().catch(() => "");
      throw new Error(`[claude-agent] 工場への ${path} が失敗しました (${res.status}): ${text}`);
    }
    return "ok";
  };

  return {
    async reportPhase(phase, note) {
      await post("/transition", { to: phase, ...(note ? { reason: note } : {}) });
      return `工程を ${phase} として工場に伝えました`;
    },
    async reportDone(summary) {
      // pi 側の `report_done` と同じ：実装の終わり＝監査へ回す
      await post("/transition", { to: "auditing", reason: summary });
      return "実装の完了を工場に伝えました（次は監査です。あなたが review-ready へ進めることはできません）";
    },
    async auditReport(verdict, findings) {
      await post("/audit-report", { verdict, findings });
      return `監査の判定（${verdict}）を工場に伝えました`;
    },
  };
}
