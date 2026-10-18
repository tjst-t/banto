// 試験用の偽の Infisical 接続（SDK の secrets()/folders() の写し）。**環境・フォルダ・再帰の有無を
// 本物と同じ向きで扱う**——「どこを読んだか」を間違えた実装が通らないように。
//
// 秘密の鍵は `"/g/sub\0KEY"`（既定の環境）か `"prod|/g/sub\0KEY"`（ほかの環境）。
import { retryOnRateLimit, type InfisicalConnection } from "../client.js";

export type Stored = { secretValue: string; secretComment?: string };

/**
 * **回数制限**（2026-10-18、Backlog #389）。窓の中で `calls` 回を超えた secrets() の呼び出しは、本物の SDK と同じ
 * 文言の 429 で断る（"Please try again in 13 seconds"）。**待つ（`sleep`）と窓が新しくなる**——`persistent` なら
 * 新しくならない（ずっと断られ続ける）。待ち方は本物と同じ `retryOnRateLimit` を通す（実際には待たない）
 */
export type FakeRateLimit = { calls: number; persistent?: boolean };

export function fakeConnection(
  opts: { environment?: string; environments?: string[]; rateLimit?: FakeRateLimit } = {},
) {
  const def = opts.environment ?? "dev";
  const sleeps: number[] = [];
  let callsInWindow = 0;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    if (!opts.rateLimit?.persistent) callsInWindow = 0;
  };
  const limited = <T extends object>(api: T): T => {
    const limit = opts.rateLimit;
    if (!limit) return api;
    const counted = new Proxy(api, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (++callsInWindow > limit.calls) {
            throw new Error(
              "[URL=/api/v3/secrets/raw] [Method=get] [StatusCode=429] Rate limit exceeded. Please try again in 13 seconds",
            );
          }
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    });
    return retryOnRateLimit(counted, { sleep });
  };
  const secrets = new Map<string, Stored>();
  const folders = new Set<string>(); // "/g" か "prod|/g"
  const listOptions: Array<Record<string, unknown>> = [];
  /** 一括更新（`PATCH /api/v4/secrets/batch`）に来た引数。`failBatch` を立てると断る（1件ずつに落ちるかを見る） */
  const batchCalls: Array<Record<string, unknown>> = [];
  /** 1件ずつの注記・値の書き込み（`updateSecret`）に来た引数 */
  const updateCalls: Array<Record<string, unknown>> = [];
  const control = { failBatch: false };
  const envKey = (env: string, path: string) => (env === def ? path : `${env}|${path}`);
  const at = (env: string, path: string, key: string) => `${envKey(env, path)}\0${key}`;
  const parse = (k: string) => {
    const [where, secretKey] = k.split("\0") as [string, string];
    const bar = where.indexOf("|");
    return bar === -1
      ? { env: def, secretPath: where, secretKey }
      : { env: where.slice(0, bar), secretPath: where.slice(bar + 1), secretKey };
  };
  const conn = {
    scope: { projectId: "p1", environment: def },
    scopeFor: (env?: string) => ({ projectId: "p1", environment: env ?? def }),
    listEnvironments: async () => opts.environments ?? [def],
    folders: () => ({
      async create(o: { environment: string; name: string; path: string }) {
        const full = o.path === "/" ? `/${o.name}` : `${o.path}/${o.name}`;
        if (o.path !== "/" && !folders.has(envKey(o.environment, o.path))) {
          throw new Error(`parent folder ${o.path} not found`);
        }
        if (folders.has(envKey(o.environment, full))) throw new Error("Folder already exists");
        folders.add(envKey(o.environment, full));
      },
      async listFolders(o: { environment: string }) {
        return [...folders]
          .map((f) => (f.includes("|") ? { env: f.split("|")[0], path: f.split("|")[1]! } : { env: def, path: f }))
          .filter((f) => f.env === o.environment && f.path.split("/").length === 2)
          .map((f) => ({ name: f.path.slice(1) }));
      },
    }),
    // **v4 の一括更新**（本物は SDK の外で直に呼ぶ口、2026-10-18）。`mode` は既定の `failOnNotFound`——1つでも無ければ
    // 何も書かずに呼び出しごと断る。**値は受けない**（渡されたら試験が気づくように断る）
    batch: () => limited({
      async updateSecrets(o: {
        projectId: string;
        environment: string;
        secretPath: string;
        secrets: Array<{ secretKey: string; secretComment: string; secretValue?: unknown }>;
      }) {
        batchCalls.push(o as unknown as Record<string, unknown>);
        if (control.failBatch) throw new Error("[URL=/api/v4/secrets/batch] [Method=patch] [StatusCode=500] Something went wrong");
        if (o.secrets.some((x) => "secretValue" in x)) throw new Error("一括更新に値が渡された");
        const keys = o.secrets.map((x) => at(o.environment, o.secretPath, x.secretKey));
        if (keys.some((k) => !secrets.has(k))) {
          throw new Error("[URL=/api/v4/secrets/batch] [Method=patch] [StatusCode=404] Secret not found");
        }
        o.secrets.forEach((x, i) => {
          secrets.set(keys[i]!, { ...secrets.get(keys[i]!)!, secretComment: x.secretComment });
        });
      },
    }),
    secrets: () => limited({
      async listSecrets(o: { environment: string; secretPath: string; recursive?: boolean; viewSecretValue?: boolean }) {
        listOptions.push(o as unknown as Record<string, unknown>);
        const base = o.secretPath.replace(/\/+$/, "") || "/";
        const under = (p: string) =>
          o.recursive ? base === "/" || p === base || p.startsWith(`${base}/`) : p === base;
        const hits = [...secrets.entries()]
          .map(([k, v]) => ({ ...parse(k), v }))
          .filter((x) => x.env === o.environment && under(x.secretPath));
        return {
          secrets: hits.map((x) => ({
            secretPath: x.secretPath,
            secretKey: x.secretKey,
            secretComment: x.v.secretComment ?? "",
            secretValue: o.viewSecretValue === false ? "<hidden-by-infisical>" : x.v.secretValue,
            secretValueHidden: o.viewSecretValue === false,
          })),
        };
      },
      async getSecret(o: { environment: string; secretName: string; secretPath: string }) {
        const got = secrets.get(at(o.environment, o.secretPath, o.secretName));
        if (!got) throw new Error("not found");
        return { secretValue: got.secretValue };
      },
      async createSecret(key: string, o: { environment: string; secretPath: string; secretValue: string; secretComment?: string }) {
        // **フォルダが無ければ書けない**（本物と同じ。フォルダを作らずに書く実装を見逃さない）
        if (o.secretPath !== "/" && !folders.has(envKey(o.environment, o.secretPath))) {
          throw new Error(`folder ${o.secretPath} not found`);
        }
        if (secrets.has(at(o.environment, o.secretPath, key))) throw new Error("Secret already exist");
        secrets.set(at(o.environment, o.secretPath, key), { secretValue: o.secretValue, secretComment: o.secretComment });
      },
      async updateSecret(key: string, o: { environment: string; secretPath: string; secretValue?: string; secretComment?: string }) {
        updateCalls.push({ key, ...o });
        const cur = secrets.get(at(o.environment, o.secretPath, key));
        if (!cur) throw new Error("not found");
        secrets.set(at(o.environment, o.secretPath, key), {
          secretValue: o.secretValue ?? cur.secretValue,
          secretComment: o.secretComment ?? cur.secretComment,
        });
      },
      async deleteSecret(key: string, o: { environment: string; secretPath: string }) {
        if (!secrets.delete(at(o.environment, o.secretPath, key))) throw new Error("not found");
      },
    }),
  };
  return { conn: conn as unknown as InfisicalConnection, secrets, folders, listOptions, sleeps, batchCalls, updateCalls, control,
    /** 回数制限の窓を新しくする（試験の準備で使った回数を数えないように） */
    resetRateWindow: () => {
      callsInWindow = 0;
    },
  };
}
