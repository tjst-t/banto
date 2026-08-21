import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react';

import { ScrollArea } from './ui/scroll-area';
import { fetchResource, fetchViews } from '../lib/api';
import { inPageView } from '../views/registry';
import { SandboxedView } from '../views/SandboxedView';
import type { ResourceResponse, ViewAssignment } from '../lib/types';

/**
 * **AI が指したものを開く面**（要件 C14・決定19）。
 *
 * 開くのは人である。**指しただけでは開かない**——AI が画面を飛ばせると、
 * 「AI が開いたつもりの面」と「実際に開いている面」が別々に存在することになる（規則3）。
 *
 * **中身を覚えない。** 開くたびに `/api/resource` で持ち主のモジュールに聞くので、
 * 指した時点の写しと現物が食い違うことがない。だから「読み直す」も自然に置ける。
 *
 * **描き方は mimeType だけを手がかりにする。** 分からないものは**素のまま出す**
 * ——当てずっぽうで整形すると、壊れているのか元からそうなのかが分からなくなる。
 */
export function ResourceViewer({ uri, name, onClose }: { uri: string; name: string; onClose: () => void }) {
  const [resource, setResource] = useState<ResourceResponse | null>(null);
  const [assignment, setAssignment] = useState<ViewAssignment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * その URI を開ける面を、台帳から選ぶ（決定20）。
   * **無ければホストの汎用の面で出す**——素のまま出すのは、面が無いことを
   * 隠していることにはならない（当てずっぽうで整形するのが隠すこと）。
   */
  useEffect(() => {
    void fetchViews().then(
      (views) => setAssignment(views.find((v) => uri.startsWith(v.uriPrefix)) ?? null),
      // 面の割り当てが引けなくても、中身は出せる。**そこで止めない。**
      () => setAssignment(null),
    );
  }, [uri]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResource(await fetchResource(uri));
      setError(null);
    } catch (cause) {
      // 握りつぶさない（規則2）。読めなかったことと理由を出す。
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [uri]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-resource-viewer={uri}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink">{name}</h3>
          {/* **どこから来たものかを隠さない。** 持ち主は uri の先頭に書いてある。 */}
          <p className="truncate font-mono text-[10px] text-ink-muted">{uri}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          title="読み直す"
          className="ml-auto rounded p-1 text-ink-muted hover:bg-paper hover:text-ink"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="閉じる"
          className="rounded p-1 text-ink-muted hover:bg-paper hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {error !== null ? (
        <div className="m-3 flex items-start gap-2 rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-xs text-critical">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p className="whitespace-pre-wrap">{error}</p>
        </div>
      ) : resource === null ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-ink-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          読み込み中…
        </div>
      ) : (
        renderBody(assignment, resource)
      )}

      {resource !== null && (
        <p className="border-t border-border px-3 py-1.5 text-[10px] text-ink-muted">
          {assignment === null
            ? 'banto の汎用の面'
            : `${assignment.moduleId} の面（${assignment.kind}）`}{' '}
          ・ {resource.mimeType ?? '形は分からない'} ・ {resource.text.length.toLocaleString()} 文字
        </p>
      )}
    </div>
  );
}

/**
 * 中身を描く。**面が無ければ素のまま出す**（規則2：当てずっぽうで整形しない）。
 *
 * `sandboxed` は iframe の中で走らせる約束だが、**その実行はまだ書いていない。**
 * 黙って空にすると「面が在るのに何も出ない」になるので、**そう言う**。
 */
function renderBody(assignment: ViewAssignment | null, resource: ResourceResponse) {
  if (assignment?.kind === 'in-page' && assignment.entry !== null) {
    const View = inPageView(assignment.entry);
    if (View !== null) {
      return <View uri={resource.uri} text={resource.text} mimeType={resource.mimeType} />;
    }
    // 台帳には在るのに束ねに無い。**黙って汎用へ落ちない**（規則2）。
    return (
      <div className="m-3 rounded-md border border-waiting/40 bg-waiting-soft px-3 py-2 text-xs text-ink">
        {assignment.moduleId} の面「{assignment.entry}」が束ねに入っていない。
        素のまま出す：
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono">{resource.text}</pre>
      </div>
    );
  }

  if (assignment?.kind === 'sandboxed') {
    // **閉じ込めて走らせる**（決定20）。ページの権限は渡らない。
    return (
      <SandboxedView
        moduleId={assignment.moduleId}
        uri={resource.uri}
        text={resource.text}
        mimeType={resource.mimeType}
      />
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      {/* 分からない形は素で出す。**整形して見せかけない。** */}
      <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-ink">
        {resource.text}
      </pre>
    </ScrollArea>
  );
}
