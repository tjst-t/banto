// **Project の実行場所を、その Project の記録で振り分ける**（決定・2026-10-08、`docs/specs/v4-security.md` §1「実行場所は
// core の中の差し替え口」）。Project の記録の `runtime` が `remote:<名前>` なら別のサーバ（`remote-ssh.ts`）、それ以外
// （既定・banto 全体用の箱）はこの host のコンテナ（`host-container.ts`）。
//
// 別のサーバで作らないもの（v4-security.md §1「最初は作らないもの」）：資源の上限と上限に当たった知らせ（向こうの持ち主の
// 責任）。

import type { RemoteSshRuntime } from "./remote-ssh.js";
import type { PlaceAddress, PreparedPlace, Runtime, RuntimePlace, ToolsInstallStatus } from "./runtime.js";

export class RuntimeRouter implements Runtime {
  readonly instancePlaceId: string;
  readonly toolsPlaceId: string;

  constructor(
    private readonly host: Runtime,
    private readonly remote: RemoteSshRuntime,
  ) {
    this.instancePlaceId = host.instancePlaceId;
    // 道具用の箱はいつもこの host（別のサーバの Project の Module も、逆向きのトンネル越しの中継で届く）
    this.toolsPlaceId = host.toolsPlaceId;
  }

  toolsInstallStatus(): ToolsInstallStatus {
    return this.host.toolsInstallStatus();
  }

  retryToolsInstall(): void {
    this.host.retryToolsInstall();
  }

  describePrerequisites(): string {
    return this.host.describePrerequisites();
  }

  prepare(place: RuntimePlace): Promise<PreparedPlace> {
    return this.remote.handles(place.id) ? this.remote.prepare(place) : this.host.prepare(place);
  }

  forget(placeId: string): void {
    if (this.remote.handles(placeId)) this.remote.forget(placeId);
    else this.host.forget(placeId);
  }

  release(placeId: string, opts: { stop: boolean }): Promise<void> {
    return this.remote.handles(placeId) ? this.remote.release(placeId) : this.host.release(placeId, opts);
  }

  async address(projectId: string): Promise<PlaceAddress> {
    return this.remote.handles(projectId) ? this.remote.address(projectId) : this.host.address(projectId);
  }

  /** 別のサーバからの要求は専用の待ち受け（`relay-listener.ts`）にしか来ない——core の口では「違う」 */
  async sourceMatches(projectId: string, remote: string): Promise<boolean> {
    return this.remote.handles(projectId) ? false : this.host.sourceMatches(projectId, remote);
  }

  async status(projectId: string): Promise<{ name: string; status: string } | undefined> {
    return this.remote.handles(projectId) ? undefined : this.host.status(projectId);
  }

  async applyLimits(placeId: string): Promise<void> {
    if (!this.remote.handles(placeId)) await this.host.applyLimits(placeId);
  }

  resourceTargets(): { containerName: string; projectId?: string }[] {
    return this.host.resourceTargets();
  }

  placeName(placeId: string): string {
    return this.host.placeName(placeId);
  }

  resourceScope(): Promise<string> {
    return this.host.resourceScope();
  }
}
