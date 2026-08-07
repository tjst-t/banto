/**
 * 独立サービスとして立っている Worker Pool / Environment Pool を、番頭ホストに載せる
 * （task-0066・ADR-0013 決定61）。
 *
 * **番頭ホストはもう工房も検証環境も自分の中に作らない。** 作っていた頃は
 *
 *   - Kobo が職人を起こすのに番頭の稼働が要り（決定27b が避けた依存の逆転）、
 *   - 番頭が立てた環境と Kobo が立てた環境で**台帳が2つに割れる**（inc-0027）
 *
 * の2つが起きていた。載せ方は Kobo と同じ形（`kobo-module.ts`）——契約は持ち主の
 * パッケージから取り、`execute` だけを HTTP 越しに差し替え、UI から見える口は
 * ホストが中継する。
 *
 * D5: ここに判断は無い。組み立てるだけ。
 */

import {
  WORKER_POOL_BASE_URL,
  createWorkerPoolModule,
  type WorkerPool,
} from "@banto/worker-pool";
import {
  ENVIRONMENT_POOL_BASE_URL,
  createEnvironmentPoolModule,
  type EnvironmentPool,
} from "@banto/environment-pool";
import type { BantoModule } from "./module.js";
import {
  contractOnly,
  createRemoteRelay,
  createRemoteSettings,
  createRemoteTools,
} from "./remote-module.js";

/** Worker Pool の既定の到達先（独立サービス。決定40：127.0.0.1 のみ）。 */
export function defaultWorkerPoolUrl(): string {
  return (
    process.env["BANTO_WORKER_POOL_URL"] ??
    `http://127.0.0.1:${process.env["BANTO_WORKER_POOL_PORT"] ?? "4300"}${WORKER_POOL_BASE_URL}`
  );
}

/** Environment Pool の既定の到達先（独立サービス。決定40a：127.0.0.1 のみ）。 */
export function defaultEnvironmentPoolUrl(): string {
  return (
    process.env["BANTO_ENV_POOL_URL"] ??
    `http://127.0.0.1:${process.env["BANTO_ENV_POOL_PORT"] ?? "4400"}${ENVIRONMENT_POOL_BASE_URL}`
  );
}

/**
 * 工房（Worker Pool）を到達先として載せる。
 *
 * `internalTools`（職人が叩く `worker.report` / `worker.ask`）は**持たない**——職人は
 * 工房の直の子なので、報告は工房の面へ返る（番頭ホストを経由させない・決定27）。
 * 職人の復帰（決定44）も工房が自分の起動時に済ませる。
 */
export function createRemoteWorkerPoolModule(
  remoteUrl: string = defaultWorkerPoolUrl(),
  fetchImpl: typeof fetch = fetch
): BantoModule {
  const contract = createWorkerPoolModule(contractOnly<WorkerPool>("Worker Pool"), WORKER_POOL_BASE_URL);
  return {
    name: contract.name,
    title: contract.title,
    description: contract.description,
    endpoint: { baseUrl: WORKER_POOL_BASE_URL },
    tools: createRemoteTools(contract.name, contract.tools, remoteUrl, fetchImpl),
    views: contract.views,
    skills: contract.skills,
    settings: createRemoteSettings(contract.settings, "worker", contract.name, remoteUrl, fetchImpl),
  } as BantoModule;
}

/**
 * 検証環境（Environment Pool）を到達先として載せる。
 *
 * **中継が要る**（決定39）。公開された環境の URL は `{baseUrl}/env/<envId>/` で、
 * ブラウザは別の機械で動くので 127.0.0.1 のサービスへは届かない。ホストが同じパスを
 * そのまま流す——中身は解釈しない（D5）。
 */
export function createRemoteEnvironmentPoolModule(
  remoteUrl: string = defaultEnvironmentPoolUrl(),
  fetchImpl: typeof fetch = fetch
): BantoModule {
  const contract = createEnvironmentPoolModule(
    contractOnly<EnvironmentPool>("Environment Pool"),
    ENVIRONMENT_POOL_BASE_URL
  );
  const relay = createRemoteRelay(remoteUrl);
  return {
    name: contract.name,
    title: contract.title,
    description: contract.description,
    endpoint: { baseUrl: ENVIRONMENT_POOL_BASE_URL },
    tools: createRemoteTools(contract.name, contract.tools, remoteUrl, fetchImpl),
    views: contract.views,
    skills: contract.skills,
    settings: createRemoteSettings(contract.settings, "env", contract.name, remoteUrl, fetchImpl),
    serve: (req, res) => relay.serve(req, res),
    handleUpgrade: (req, socket, head) => relay.handleUpgrade(req, socket, head),
  } as BantoModule;
}
