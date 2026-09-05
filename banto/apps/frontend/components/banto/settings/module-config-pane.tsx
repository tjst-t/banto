// Module 自身が `ui://<id>/config` で持ち込む設定面（§6.2）。banto は値を
// 持たない——中身は Module 自身の tool を呼んで読み書きする。実際の二重iframe
// ハンドシェイクは実装していない（本実装の仕事）が、「これは banto 自身の
// UIではなく、他人のコードが描いている」ことが一目で分かる見た目にする——
// 設定面は常に sandboxed（in-page を許さない、§6.2）という決定を、モックでも
// 崩さずに示す。
//
// `projectId` は §6.2「設定面への Project の文脈」（決定・2026-09-02）の
// モック実装——Module プロセスは Project に紐づかないので、banto がこの面を
// 埋め込むときに「今どの Project のために描いているか」を渡す。対応するかは
// Module 次第（このモックでは Vault 系の実装だけが Project 単位の alias
// 一覧を出す形で「対応している」例を示す）。渡さなければ instance 全体の
// 既定を描くだけの Module と同じに見える——それが「対応しない Module」の姿
import { Folders, ShieldCheck } from "lucide-react";
import { getImplementation, getVaultAliasesForProject, mockModuleConfigFields } from "@/lib/mock/settings";
import { getProject } from "@/lib/mock/projects";

export function ModuleConfigPane({
  implementationId,
  projectId,
}: {
  implementationId: string;
  projectId?: string;
}) {
  const impl = getImplementation(implementationId);
  const fields = mockModuleConfigFields[implementationId] ?? [];
  const aliases = projectId ? getVaultAliasesForProject(projectId) : [];
  const showProjectAliases = impl?.roleId === "vault" && projectId !== undefined;
  if (!impl) return null;

  return (
    <div>
      <p className="mb-3 text-xs text-ink-3">
        <code className="rounded bg-surface-2 px-1 py-0.5">
          ui://{implementationId}/config
        </code>{" "}
        ——banto の Configuration ではなく、{impl.name} 自身が持つ設定
        {projectId ? (
          <>
            {" "}
            ·{" "}
            <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-ink-2">
              <Folders className="size-3" />
              対象 Project：{getProject(projectId).name}
            </span>
          </>
        ) : null}
      </p>
      <div className="rounded-lg border border-dashed border-border bg-surface-2/60 p-4">
        <div className="mb-3 flex items-center gap-1.5 text-xs text-ink-3">
          <ShieldCheck className="size-3.5" />
          sandboxed iframe
        </div>
        {/* この枠の中だけ、banto 自身の UI と質感を変える——背景・角丸・枠線を
            banto のカードとずらし、「ここから先は他人のコードの領域」を示す */}
        <div className="rounded-md border border-border bg-card p-3">
          {fields.length === 0 ? (
            <p className="text-sm text-ink-3">この Module はまだ設定項目を公開していない</p>
          ) : (
            <dl className="flex flex-col gap-2">
              {fields.map((f, i) => (
                <div
                  key={f.label}
                  id={`anchor-module-config-${implementationId}-${i}`}
                  className="flex items-center justify-between gap-3 rounded-md text-sm"
                >
                  <dt className="text-ink-3">{f.label}</dt>
                  <dd className="font-mono text-xs text-foreground">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {showProjectAliases ? (
          <div className="mt-3 rounded-md border border-border bg-card p-3">
            <p className="mb-2 text-xs text-ink-3">この Project の alias（値は出さない）</p>
            {aliases.length === 0 ? (
              <p className="text-sm text-ink-3">この Project の alias はまだ無い</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-ink-3">
                    <th className="py-1 font-medium">名前</th>
                    <th className="py-1 font-medium">パス</th>
                    <th className="py-1 font-medium">使いみち</th>
                  </tr>
                </thead>
                <tbody>
                  {aliases.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-b-0">
                      <td className="py-1.5 pr-2 font-mono text-ink-2">${a.name}</td>
                      <td className="py-1.5 pr-2 text-ink-3">{a.path}</td>
                      <td className="py-1.5 text-ink-3">{a.usedBy.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
