// まとめて引く口のカードの「対象」——1行1件の表（v4-frontend.md「Module 間中継の承認」）。会話のカードと受信箱で同じものを使う
import type { SplitTargets } from "@/lib/relay-targets";

export function RelayTargetsTable({ targets }: { targets: NonNullable<SplitTargets["targets"]> }) {
  return (
    <div className="max-h-48 overflow-auto rounded-md bg-muted/60">
      <table data-testid="relay-targets" className="w-full text-left text-xs">
        <caption className="px-2 pt-1.5 text-left text-ink-3">対象（{targets.rows.length} 件）</caption>
        <thead>
          <tr>
            {targets.columns.map((c) => (
              <th key={c} className="px-2 py-1 font-medium text-ink-3">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {targets.rows.map((row, i) => (
            <tr key={i} className="border-t border-border/60">
              {targets.columns.map((c) => (
                <td key={c} className="px-2 py-1 font-mono break-all text-foreground">
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
