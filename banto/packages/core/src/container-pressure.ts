// **コンテナが資源の上限に当たったら、受信箱で知らせる**（決定・2026-10-05、ユーザー要望。`docs/specs/v4-security.md` §1）。
//
// 上限（メモリ・プロセス数）に当たると、カーネルがプロセスを止めたり fork を断ったりする。中で動いていた試験や
// ビルドは「理由の分からない形で落ちる」だけで、人も AI も上限のせいだと気づけない（規則2——黙らない）。
//
// 用意できたコンテナを1分ごとに見て、前に見たときより数えが増えていれば、その Project のお知らせを1件出す
// （同じものが開いている間は増やさない——受信箱の dedupeKey）。最初に見た値は基準にするだけで知らせない
// （banto を起こし直すたびに昔の分を言い直さない）。コンテナを起こし直すと数えは 0 に戻るので、前より小さければ
// その値を新しく増えた分として扱う
export interface PressureCounts {
  oomKills: number;
  pidsMax: number;
}

export interface PressureNotice {
  projectId?: string;
  dedupeKey: string;
  title: string;
  detail: string;
}

export class ContainerPressureWatch {
  private readonly last = new Map<string, PressureCounts>();

  constructor(
    private readonly opts: {
      read(containerName: string): Promise<PressureCounts | undefined>;
      notify(n: PressureNotice): Promise<unknown>;
      /** その Project の今の上限（人に見せる1行。例「メモリ 11 GiB・CPU 3 コア分・プロセス 8192」） */
      describeLimits(projectId: string): string;
    },
  ) {}

  /** 1回見る。`targets` は今用意できているコンテナ（Project の id → コンテナの名前、banto 全体用は projectId 無し） */
  async tick(targets: readonly { containerName: string; projectId?: string }[]): Promise<void> {
    for (const t of targets) {
      let now: PressureCounts | undefined;
      try {
        now = await this.opts.read(t.containerName);
      } catch {
        now = undefined;
      }
      if (!now) continue;
      const before = this.last.get(t.containerName);
      this.last.set(t.containerName, now);
      if (!before) continue;
      const grew = (cur: number, prev: number) => (cur >= prev ? cur - prev : cur);
      const oom = grew(now.oomKills, before.oomKills);
      const pids = grew(now.pidsMax, before.pidsMax);
      const where = t.projectId ? "この Project のコンテナ" : "banto 全体用のコンテナ";
      const limits = t.projectId ? `いまの上限：${this.opts.describeLimits(t.projectId)}。` : "";
      const fix = t.projectId
        ? "上げるなら banto 全体の設定「コンテナ」で、この機械に残す分を減らすか、Project の設定「コンテナ」の値を見直してください。"
        : "";
      if (oom > 0) {
        await this.opts.notify({
          ...(t.projectId ? { projectId: t.projectId } : {}),
          dedupeKey: `container-oom:${t.containerName}`,
          title: "メモリの上限に当たり、プロセスが止められました",
          detail: `${where}（${t.containerName}）で、メモリの上限に当たったため ${oom} 個のプロセスがカーネルに止められました。直前に落ちた試験やビルドは、これが原因かもしれません。${limits}${fix}`,
        });
      }
      if (pids > 0) {
        await this.opts.notify({
          ...(t.projectId ? { projectId: t.projectId } : {}),
          dedupeKey: `container-pids:${t.containerName}`,
          title: "プロセス数の上限に当たりました",
          detail: `${where}（${t.containerName}）で、プロセス数の上限に当たり、新しいプロセスを起こせなかったことが ${pids} 回ありました。直前に落ちた処理は、これが原因かもしれません。${limits}${fix}`,
        });
      }
    }
  }

  /** 消したコンテナの基準を忘れる（作り直したときに前の値と比べない） */
  forget(containerName: string): void {
    this.last.delete(containerName);
  }
}
