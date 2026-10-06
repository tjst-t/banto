// 試験用の偽の Infisical 接続（SDK の secrets()/folders() の写し）。**環境・フォルダ・再帰の有無を
// 本物と同じ向きで扱う**——「どこを読んだか」を間違えた実装が通らないように。
//
// 秘密の鍵は `"/g/sub\0KEY"`（既定の環境）か `"prod|/g/sub\0KEY"`（ほかの環境）。
import type { InfisicalConnection } from "../client.js";

export type Stored = { secretValue: string; secretComment?: string };

export function fakeConnection(opts: { environment?: string; environments?: string[] } = {}) {
  const def = opts.environment ?? "dev";
  const secrets = new Map<string, Stored>();
  const folders = new Set<string>(); // "/g" か "prod|/g"
  const listOptions: Array<Record<string, unknown>> = [];
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
    secrets: () => ({
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
  return { conn: conn as unknown as InfisicalConnection, secrets, folders, listOptions };
}
