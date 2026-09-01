// Module 自身が `ui://<id>/config` で持ち込む設定面（§6.2）。banto は値を
// 持たない——中身は Module 自身の tool を呼んで読み書きする。実際の二重iframe
// ハンドシェイクは実装していない（本実装の仕事）が、「これは banto 自身の
// UIではなく、他人のコードが描いている」ことが一目で分かる見た目にする——
// 設定面は常に sandboxed（in-page を許さない、§6.2）という決定を、モックでも
// 崩さずに示す。
import { ShieldCheck } from "lucide-react";
import { getImplementation, mockModuleConfigFields } from "@/lib/mock/settings";

export function ModuleConfigPane({ implementationId }: { implementationId: string }) {
  const impl = getImplementation(implementationId);
  const fields = mockModuleConfigFields[implementationId] ?? [];
  if (!impl) return null;

  return (
    <div>
      <p className="mb-3 text-xs text-ink-3">
        <code className="rounded bg-surface-2 px-1 py-0.5">
          ui://{implementationId}/config
        </code>{" "}
        ——banto の Configuration ではなく、{impl.name} 自身が持つ設定
      </p>
      <div className="rounded-lg border border-dashed border-border bg-surface-2/60 p-4">
        <div className="mb-3 flex items-center gap-1.5 text-xs text-ink-3">
          <ShieldCheck className="size-3.5" />
          sandboxed iframe（二重 iframe、`allow-same-origin` を含めない、§6.2）
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
      </div>
    </div>
  );
}
