// docs/specs/v4-architecture.md §2.5「host は権限を確認する」（初回のみ承認・以降は
// 同じ Project 内で自動許可）と「host は Event Store に記録するが、メタデータだけ」
// の実装。**許可も監査も Event Store が唯一の真実**（規則3）——プロセスメモリに
// 持つと host を再起動するたびに人が承認し直すことになり、監査
// （docs/specs/v4-frontend.md §6.0）の前提も失われる。

import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import { relayFold, grantKey, type RelayReadModel } from "./grants-fold.js";

/** 中継1件の宛名。**値は含めない**——記録に残るのはここまで（§2.5）。 */
export interface RelayCallDescriptor {
  /** Project ごとの Module のときだけ付く。instance に1本の Module は undefined。 */
  projectId?: string;
  /** 呼び出し元（宣言の名前。プロセスの識別子ではない）。 */
  callerModule: string;
  targetModule: string;
  kind: "tool" | "resource" | "prompt";
  name: string;
}

export interface RelayCallOutcome {
  allowed: boolean;
  /** 許可・拒否の理由（「宣言された依存に含まれない」「承認済み」等）。 */
  reason?: string;
  /** 実際に中継した結果。拒否されたときは付かない。 */
  ok?: boolean;
}

export class RelayGrantStore {
  private readonly projection: SnapshotProjection<RelayReadModel>;

  constructor(dataDir: string, private readonly log: EventLog) {
    this.projection = new SnapshotProjection(dataDir, "relay", log, relayFold);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }
  async save(): Promise<void> {
    await this.projection.save();
  }

  isGranted(call: RelayCallDescriptor): boolean {
    return this.projection.current.grants.has(grantKey(call));
  }

  /** 人が許可した。**この Project の、この組み合わせ**にだけ効く（§2.5）。 */
  async grant(call: RelayCallDescriptor): Promise<void> {
    const event = await this.log.append("relay.grant_created", call);
    this.projection.applyOne(event);
  }

  /**
   * 中継を1件記録する。**成否も含めて残す**——拒否された呼び出し・失敗した
   * 呼び出しこそが監査で見たいもの（規則2——黙って消えない）。
   * 読み取り用の投影は持たない（画面がまだ無い）。ログが記録そのもの。
   */
  async recordCall(call: RelayCallDescriptor, outcome: RelayCallOutcome): Promise<void> {
    await this.log.append("relay.call_recorded", { ...call, ...outcome });
  }
}
