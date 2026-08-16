/**
 * **立てた compose プロジェクトを控えて、どこで落ちても畳む**（inc-0083・task-0214）。
 *
 * ## なぜ要るか（2026-08-16 の実測）
 *
 * docker のアドレスプールが枯渇し、**工場の着地が全部止まった**。
 * `banto-env-*` のネットワークが 27本・コンテナが 31件（全部 `Up`）残っていたのに、
 * 台帳が知っていたのは 4件だけ。残りの大半は**受け入れ試験の取り残し**だった
 * ——20件が `tests/fixtures/docker` 由来、3件が `/tmp/banto-rebuild-*` 由来。
 *
 * 取り残しの形はどれも同じで、**後片付けをテストの最後の行に書いていた**。
 * アサーションが落ちた瞬間にそこへ到達しなくなるので、落ちたぶんだけ残る。
 * しかも `npm test` は `env-docker-` を除外しているので、**漏れても誰も気づかない**。
 *
 * ## ここで守ること
 *
 *   1. **立てたら即座に控える**（`track` / `trackEnv`）。控えるのは名前だけなので、
 *      立てる前でも控えられる——`provision` が途中でこけて実体だけ残る形も拾える
 *   2. **畳むのは後片付けの場所から**（`after` / `afterEach` / `finally`）。
 *      本文の最後の行に置かない
 *   3. **1件目の teardown が投げても、残りを畳む**。失敗は捨てずに集めて、
 *      最後にまとめて投げる（I2: 握り潰さない・畳み損ねを黙って通さない）
 *
 * この決まりを守れているかは `tests/acceptance/env-tests-teardown-their-compose.spec.ts`
 * が spec の中身を読んで見張る（docker を使わないので `npm test` に含まれる）。
 */

import * as childProcess from "node:child_process";

/** docker ドライバの compose プロジェクト名の接頭辞（`docker-driver.ts` の `projectName`）。 */
export const ENV_PROJECT_PREFIX = "banto-env-";

/** envId から compose プロジェクト名を作る。 */
export function projectNameOf(envId: string): string {
  return `${ENV_PROJECT_PREFIX}${envId}`;
}

/** `docker compose -p <project> down` の結果。**投げない**（呼び手が集めて裁く）。 */
export interface ComposeDownResult {
  ok: boolean;
  detail?: string;
}

/**
 * compose プロジェクトを名前だけで畳む。
 *
 * `-f` を渡さないのは、**compose ファイルが既に消えていても畳めるようにする**ため
 * （tmp に書いた検体を先に消してしまった場合でも、ラベルで引ける）。
 * 存在しないプロジェクトを畳んでも 0 で返る＝**冪等**。
 */
export function composeDown(project: string, timeoutMs = 120_000): ComposeDownResult {
  const r = childProcess.spawnSync(
    "docker",
    ["compose", "-p", project, "down", "-v", "--remove-orphans"],
    { encoding: "utf8", timeout: timeoutMs }
  );
  if (r.error) return { ok: false, detail: `${project}: ${r.error.message}` };
  if (r.status !== 0) {
    return { ok: false, detail: `${project}: exit=${r.status ?? "null"} ${(r.stderr ?? "").trim()}` };
  }
  return { ok: true };
}

/** 控えるときの但し書き。 */
export interface TrackOptions {
  /**
   * `docker compose down` まで掛けるか（既定 true）。
   * process ドライバの環境のように compose を持たないものは false にする
   * ——docker が無くても回るテストを、後片付けのせいで docker 必須にしないため。
   */
  composeDown?: boolean;
}

interface TrackedEntry {
  project: string;
  composeDown: boolean;
  before?: () => unknown | Promise<unknown>;
}

export interface ComposeCleanup {
  /**
   * compose プロジェクトを控える。`before` は畳む前に一度だけ走らせる後始末
   * （機構の口＝`pool.teardown` やドライバの `teardown` を通したいとき）。
   * 同じ名前を2度控えても1つとして扱う。
   */
  track(project: string, before?: () => unknown | Promise<unknown>, opts?: TrackOptions): string;
  /** envId で控える（プロジェクト名は `banto-env-<envId>`）。戻り値はプロジェクト名。 */
  trackEnv(envId: string, before?: () => unknown | Promise<unknown>, opts?: TrackOptions): string;
  /** いま控えているプロジェクト名（控えた順）。 */
  tracked(): string[];
  /**
   * 控えたものを**全部**畳む。控えた順の逆から畳み、
   * **1件が投げても残りを続ける**。控えは畳んだ時点で空にする（二度畳まない）。
   *
   * 畳み損ねがあれば、全部処理し終えてから**まとめて投げる**
   * （I2: 残骸を黙って見逃さない）。`before` の失敗は機構の口が効かなかっただけなので
   * 投げる材料にはせず、最後の `compose down` が通っていれば良しとする。
   */
  teardownAll(): Promise<void>;
}

export function createComposeCleanup(): ComposeCleanup {
  const entries: TrackedEntry[] = [];

  const track = (
    project: string,
    before?: () => unknown | Promise<unknown>,
    opts?: TrackOptions
  ): string => {
    const found = entries.find((e) => e.project === project);
    if (found) {
      // 後から来た後始末のほうが新しい（handle が差し替わった等）ので上書きする
      if (before) found.before = before;
      return project;
    }
    entries.push({
      project,
      composeDown: opts?.composeDown !== false,
      ...(before ? { before } : {}),
    });
    return project;
  };

  return {
    track,
    trackEnv: (envId, before, opts) => track(projectNameOf(envId), before, opts),
    tracked: () => entries.map((e) => e.project),
    teardownAll: async (): Promise<void> => {
      const pending = entries.splice(0).reverse();
      const failures: string[] = [];
      for (const entry of pending) {
        try {
          if (entry.before) await entry.before();
        } catch {
          // 機構の口が効かなかっただけ。実体は次の `compose down` で畳む
        }
        if (!entry.composeDown) continue;
        try {
          const r = composeDown(entry.project);
          if (!r.ok) failures.push(r.detail ?? entry.project);
        } catch (err) {
          failures.push(`${entry.project}: ${(err as Error).message}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `compose を畳めなかったものが ${failures.length} 件ある（残骸になる）:\n` +
            failures.map((f) => `  - ${f}`).join("\n")
        );
      }
    },
  };
}
