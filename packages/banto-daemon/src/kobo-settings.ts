/**
 * 工場（Kobo）が設定画面に出す区画（決定41）。
 *
 * 決めるのは**役割ごとの職人の当て方**——実装・手直し・監査（レビュー）を、どの等級で、
 * あるいは**どのモデルで**やらせるか。
 *
 * ## 決定60a の改訂（PO裁定 2026-08-10）
 *
 * 決定60a は「Kobo はモデル名を知らず tier までしか渡さない」だった。PO が
 * 「実装やレビューをどのモデルの職人にやらせるか、等級ではなく名前で決めたい」と裁定した
 * ため、**名指しの口をここに開く**。裁定の中身と、それでも守っていることは:
 *
 *   - 名前の**解決**は Worker Pool のまま（`worker.models` が返す名前をそのまま渡すだけ）。
 *     Kobo は provider も鍵も知らないし、tier→モデルの表も持たない
 *   - ランタイム（pi / Claude Code）は**名前から決まる**ので、ここでは持たない
 *   - 名指しが無ければ従来どおり等級で回る（既定の振る舞いは変えない）
 *
 * D5: ここに判断は無い。設定を読み書きするだけで、どの役割に何を当てるかは PO が決める。
 * I2: 名前は保存する前に Worker Pool へ照合する——打ち間違いが「タスクを積んだ日の夜」に
 *     初めて出るのは遅すぎる。
 */

import type { ModuleSettingsSpec, SettingsSection } from "@banto/core";

/** 職人の役割（`WorkerRole` と同じ並び）。画面に出す順もこれ。 */
export const KOBO_ROLES = [
  {
    role: "executor" as const,
    label: "実装",
    hint: "タスクを実装する職人。ふだんはタスクの `model_tier` に従う",
  },
  {
    role: "rework" as const,
    label: "手直し",
    hint: "監査に落ちたものを直す職人。名指しが無ければ、落ちた回数だけ等級が上がる（昇格）",
  },
  {
    role: "audit" as const,
    label: "監査（レビュー）",
    hint: "実装を検める職人。名指しも等級の指定も無ければ reasoning",
  },
];

export type KoboRole = (typeof KOBO_ROLES)[number]["role"];

/** 役割ごとの当て方。両方とも省略できる（省略＝これまでどおり）。 */
export interface RoleAssignment {
  /** 等級。タスクの指定より優先する（監査のように指定を持たない役割にも効く）。 */
  tier?: "reasoning" | "standard" | "fast";
  /** モデルの名指し。**あれば等級より優先**し、昇格も効かない。 */
  model?: string;
}

export type RoleAssignments = Partial<Record<KoboRole, RoleAssignment>>;

/** 設定を持つ側（Daemon）に要る口。型で縛らないのは、契約だけの写しでも組み立てるため。 */
export interface RoleAssignmentStore {
  roleAssignments(): RoleAssignments;
  setRoleAssignments(next: RoleAssignments): void;
  /** 名指しの照合に使う、Worker Pool が返す名前。届かないときは空を返してよい。 */
  selectableModelNames(): Promise<string[]>;
  /**
   * 画面の選択肢に出す、モデルの名前と表示名（Worker Pool が数え上げたもの）。
   *
   * **打たせるのではなく選ばせる**（PO要望 2026-08-10）。届かないときは空——
   * そのときだけ自由入力に落ちる（工房が落ちていても設定画面は開けるように）。
   */
  selectableModels?(): Promise<Array<{ name: string; label: string }>>;
  /**
   * 監査の口（`audit_report`）の道具呼び出しを**させない**モデル名（ブラックリスト）。
   *
   * 能力は（provider の `/models` などからは）取れないので、**実際に判定の口を呼べない
   * ことが確かめられた**ものだけを列挙する（I1）。task-0246/0242 では
   * `huihui/deepseek-v4-flash-abliterated` を監査の役に当てた結果、監査人が
   * 判定の口（`audit_report`）を一度も呼べずに誤った failed が出た。
   *
   * **白リストではなくブラックリスト**（PO指示 2026-08-18）——載っていないモデル
   * （未実証でも）は監査の役に当てられる。弾くのはここに載った「実証済みの悪」だけ。
   *
   * 空・未定義＝確かめられない。そのときは**通す**（`selectableModelNames` と
   * 同じ方針——確かめられないことを「弾くべき」と混同しない）。
   */
  toolCallBlacklistedModels?(): Promise<string[]> | string[];
}

const TIER_OPTIONS = [
  { value: "", label: "指定なし（これまでどおり）" },
  { value: "reasoning", label: "reasoning（高精度）" },
  { value: "standard", label: "standard（通常）" },
  { value: "fast", label: "fast（高速）" },
];

const tierKey = (role: KoboRole): string => `${role}Tier`;
const modelKey = (role: KoboRole): string => `${role}Model`;

export function createKoboSettings(
  store: RoleAssignmentStore,
  section?: SettingsSection,
  options: { allowBlacklistedAuditModel?: boolean } = {}
): ModuleSettingsSpec {
  return {
    title: "工場（職人の当て方）",
    // 統合表「役割とモデル」に載せるための宣言（2026-08-19 提案 model-roles-module-offer）。
    // これらの役はタスクの等級（worker.<tier>）に従う（tierDependent）。
    modelRoles: KOBO_ROLES.map(({ role, label, hint }) => ({
      id: role,
      key: `${role}Model`,
      label,
      tierDependent: true,
    })),
    description:
      "実装・手直し・監査を、どの等級／どのモデルの職人にやらせるか。" +
      "**名指しがあれば等級より優先**され、監査に落ちたときの昇格も効かない" +
      "（名指しは「この役割はこのモデルで」と決め切る指定）。" +
      "名前は職人の一覧（`worker.models`）にあるもの——" +
      "Claude Code なら `opus` / `sonnet` / `haiku`、pi なら `provider/model`。",
    // **選択肢はそのつど数え上げる**（PO要望 2026-08-10）。「LLM・モデル」で職人に
    // 許したモデルと、使えるバックエンドのモデルが、そのまま並ぶ
    fields: async () => {
      const models = (await store.selectableModels?.()) ?? [];
      const modelOptions = [
        { value: "", label: "等級で決める（既定）" },
        ...models.map((m) => ({ value: m.name, label: m.label })),
      ];
      return KOBO_ROLES.flatMap((r) => [
      {
        key: tierKey(r.role),
        label: `${r.label}：等級`,
        type: "select" as const,
        options: TIER_OPTIONS,
        description: r.hint,
      },
      // 選べるものが数え上げられたなら**選ばせる**。届かなかったときだけ自由入力
      models.length > 0
        ? {
            key: modelKey(r.role),
            label: `${r.label}：モデルの名指し`,
            type: "select" as const,
            options: modelOptions,
            description:
              "**選ぶと、その役割の職人は必ずこのモデルで動く**（等級も昇格も効かない）。" +
              "並ぶのは「LLM・モデル」で職人に許したものと、使えるバックエンドのモデル",
          }
        : {
            key: modelKey(r.role),
            label: `${r.label}：モデルの名指し`,
            type: "text" as const,
            placeholder: "opus / opencode-go/deepseek-v4-flash",
            description:
              "空なら等級で決まる。**書くと、その役割の職人は必ずこのモデルで動く**" +
              "（工房へ届かないので選択肢を出せません。名前は保存時に確かめます）",
          },
      ]);
    },
    read: () => {
      const current = store.roleAssignments();
      return Object.fromEntries(
        KOBO_ROLES.flatMap((r) => [
          [tierKey(r.role), current[r.role]?.tier ?? ""],
          [modelKey(r.role), current[r.role]?.model ?? ""],
        ])
      );
    },
    write: async (values) => {
      const next: RoleAssignments = { ...store.roleAssignments() };
      const named: string[] = [];

      for (const r of KOBO_ROLES) {
        const assignment: RoleAssignment = { ...(next[r.role] ?? {}) };
        if (tierKey(r.role) in values) {
          const tier = String(values[tierKey(r.role)] ?? "").trim();
          if (tier.length === 0) delete assignment.tier;
          else if (tier === "reasoning" || tier === "standard" || tier === "fast") {
            assignment.tier = tier;
          } else {
            // I2: 知らない等級を黙って既定に落とさない
            throw new Error(`${r.label}の等級 "${tier}" は使えません（reasoning / standard / fast）`);
          }
        }
        if (modelKey(r.role) in values) {
          const model = String(values[modelKey(r.role)] ?? "").trim();
          if (model.length === 0) delete assignment.model;
          else {
            assignment.model = model;
            named.push(model);
          }
        }
        if (assignment.tier === undefined && assignment.model === undefined) delete next[r.role];
        else next[r.role] = assignment;
      }

      // 名指しは保存する前に照合する。打ち間違いが「実際に職人を起こす夜」に初めて
      // 出るのでは遅い——そのときタスクは failed になり、原因は職人の起動ログの奥にある
      if (named.length > 0) {
        const available = await store.selectableModelNames();
        if (available.length > 0) {
          const unknown = named.filter((m) => !available.includes(m));
          if (unknown.length > 0) {
            throw new Error(
              `知らないモデルです: ${unknown.join(", ")}\n選べるのは: ${available.join(", ")}`
            );
          }
        }
      }

      // 監査の役に、道具呼び出し（audit_report）を**確実に呼べない**モデルを当てるのは、
      // 「監査人が判定の口を一度も呼べずに誤った failed になる」（task-0246/0242）を
      // それと気づかずに許すことと同じ。**実際に職人を起こす前に弾く**。
      //
      // 白リストをやめた（PO指示 2026-08-18）ので、弾くのは**ブラックリストに載った
      // モデルだけ**——未実証を含むそれ以外は保存で拒否しない（PO が当てた割り当てを
      // Kobo が読み替えない）。ブラックリストが分かっているとき（一覧が届いている
      // とき）だけ厳しくし、確かめられないときは通す（selectableModelNames と同じ方針。
      // 工房が落ちているだけのときに設定を保存できなくなる方が困る）。それでも当て
      // たい場合は `allowBlacklistedAuditModel` で明示的に許可する（「当てるなら明示的
      // に許可する形」）。
      const auditModel = next.audit?.model;
      if (
        auditModel !== undefined &&
        !options?.allowBlacklistedAuditModel
      ) {
        const blacklisted = await store.toolCallBlacklistedModels?.();
        if (
          blacklisted !== undefined &&
          blacklisted.length > 0 &&
          blacklisted.includes(auditModel)
        ) {
          throw new Error(
            `監査の口（audit_report）の道具呼び出しができないモデルです: ${auditModel}\n` +
              `ブラックリスト: ${blacklisted.join(", ")}\n` +
              `（それでも当てたい場合は allowBlacklistedAuditModel で明示的に許可して）`
          );
        }
      }

      store.setRoleAssignments(next);
      section?.write({ ...(section.read() ?? {}), roleAssignments: next });
      return { applied: true, message: "変えました（次に起こす職人から効きます）。" };
    },
  };
}
