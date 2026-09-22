"use client";

// **MCP Registry から選ぶ**（追加・2026-09-21、ユーザー要望
// 「MCP Registry の一覧からのインストールのタブを追加して欲しい。server.json を
// 参照して、リモートならつなぐ。ローカルならインストールして、つなぐまで、
// 一貫してできる手段が欲しい」）。
//
// **並べ替えない。** 順序を決めるのは host（`modules/registry/rank.ts`）で、
// ここは返ってきた順に描くだけ——2箇所に順序があると、どちらが正しいのか
// 分からなくなる（規則3）。
//
// **「公式」は registry が保証していない**（2026-09-21 に確認）。registry の
// `_meta` にあるのは status と日付だけで、verified の欄は無い。唯一の手がかりは
// **名前空間**（registry が公開時にドメイン所有を検証している）なので、
// banto はそこから見立てて**札で出す**——並び順だけに判断を預けない（規則13）。

import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/banto/shell/segmented-tabs";
import {
  searchRealModuleRegistry,
  type RealCuratedEntry,
  type RealRegistryAnswer,
  type RealRegistryEntry,
  type RealRegistryProvenance,
  type RealRegistrySearch,
} from "@/lib/backend/client";

/** 出所の札。**「公式」と言い切らない**——banto の見立てであることを文言で示す。 */
const PROVENANCE: Record<RealRegistryProvenance, { label: string; hint: string; tone: string }> = {
  vendor: {
    label: "提供元",
    hint: "このサービスのドメインの持ち主が公開しています",
    tone: "border-accent bg-accent-soft/40 text-foreground",
  },
  "third-party-domain": {
    label: "第三者",
    hint: "ドメインは確認済みですが、このサービスの提供元ではありません",
    tone: "border-border text-ink-2",
  },
  "github-account": {
    label: "個人・GitHub",
    hint: "GitHub アカウントの確認だけがされています",
    tone: "border-border text-ink-3",
  },
  pasted: {
    label: "貼り付け",
    hint: "あなたが貼った内容です。banto は出所を確かめていません",
    tone: "border-border text-ink-3",
  },
};

/**
 * **その1件を、いま入れられるか**（追加・2026-09-21、実機で発覚）。
 *
 * 対応していない配布形式（pypi など）でも**押せてしまっていた**——押すと host が
 * 断るので壊れはしないが、**押せるように見えること自体が誤り**（規則13）。
 * 入れられない理由が在るなら、押す前に出す。
 */
export function notInstallableReason(entry: RealRegistryEntry): string | undefined {
  if (entry.connect.kind === "none") return entry.connect.reason;
  if (entry.connect.kind === "local" && !entry.connect.supported) {
    return entry.connect.reason ?? "この配布形式にはまだ対応していません";
  }
  return undefined;
}

/** いま選ばれているもの一式（親が「追加」を押すのに要る分）。 */
export interface RegistryPick {
  entry: RealRegistryEntry;
  name: string;
  answers: RealRegistryAnswer[];
  /** 必須の欄が全部埋まっているか。**押せるかどうかはここで決まる**。 */
  ready: boolean;
}

export interface RegistryModulePickerProps {
  /** いま在る Module の名前。**同じ名前を付けさせない**ために使う。 */
  existingNames: readonly string[];
  onChange(pick: RegistryPick | null): void;
  /**
   * **banto が選んだ目録**（追加・2026-09-22）。渡されたときは検索欄を出さず、
   * この並びだけを出す。**解決と入力欄と取得は、registry を探すときと同じ道**
   * を通る（規則3——「目録から入れる」と「自分で探して入れる」で別々の経路を
   * 作ると、片方だけ直る）。
   */
  pinned?: readonly RealCuratedEntry[];
  /**
   * **その1件だけを扱う**（追加・2026-09-22、貼られた `server.json` 用）。
   * 渡されたときは探す面を出さず、**選んだ後の画面**（名前・要る設定・承知）
   * だけを出す——貼り付け専用の画面を別に作らない（規則3）。
   */
  only?: RealRegistryEntry | null;
}

export function RegistryModulePicker({
  existingNames,
  onChange,
  pinned,
  only,
}: RegistryModulePickerProps) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<RealRegistrySearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<RealRegistryEntry | null>(null);
  const [name, setName] = useState("");
  /** 欄ごとの答え。**秘密は既定で Vault から**——直書きは記録に残り続ける。 */
  const [answers, setAnswers] = useState<Record<string, { source: "vault" | "plain"; value: string }>>({});
  // **古い応答で新しい結果を上書きしない**——打つたびに投げるので、
  // 遅れて返ってきたものが後から画面を巻き戻す（規則2 の「黙って別の状態へ落ちない」）
  const runId = useRef(0);

  const search = useCallback(async (q: string) => {
    const mine = ++runId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await searchRealModuleRegistry(q);
      if (runId.current !== mine) return;
      setResult(res);
    } catch (err) {
      if (runId.current !== mine) return;
      // **繋がらなかったことを「0 件」にしない**（規則2）
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (runId.current === mine) setLoading(false);
    }
  }, []);

  // **検索するまで一覧を出さない**（訂正・2026-09-21、実データで測って変えた）。
  //
  // 最初は空の検索で先頭を並べていた。**それは名前順の数千件の頭**でしかなく、
  // しかも「提供元を優先」が効かない——**どれがその製品の提供元か**は、
  // どの製品の話かが決まって初めて言えるため（`rank.ts`）。
  // 優先の効いていない並びを「目録」として見せると、**効いているように見えて
  // しまう**（規則13）。答えられない問いに、それらしい答えを返さない。
  useEffect(() => {
    if (query.trim() === "") {
      setResult(null);
      setError(null);
      return;
    }
    // 打ち終わってから引く（1文字ごとに registry を叩かない）
    const t = setTimeout(() => void search(query), 350);
    return () => clearTimeout(t);
  }, [query, search]);

  /** 選ばれているもの一式を親へ渡す。**押せるかどうかもここで決める**（規則3）。 */
  const report = useCallback(
    (
      entry: RealRegistryEntry | null,
      nextName: string,
      nextAnswers: Record<string, { source: "vault" | "plain"; value: string }>,
    ) => {
      if (!entry) return onChange(null);
      const list: RealRegistryAnswer[] = Object.entries(nextAnswers)
        .filter(([, a]) => a.value.trim() !== "")
        .map(([n, a]) => ({ name: n, source: a.source, value: a.value.trim() }));
      const filled = new Set(list.map((a) => a.name));
      const ready =
        // **入れられないものは押させない**（規則13——押せるように見せない）
        notInstallableReason(entry) === undefined &&
        nextName.trim().length > 0 &&
        entry.inputs.filter((i) => i.required).every((i) => filled.has(i.name));
      onChange({ entry, name: nextName.trim(), answers: list, ready });
    },
    [onChange],
  );

  /**
   * **目録の1件を、registry から引き直して選ぶ**。
   *
   * 目録は「registry のどれか」しか持っていない（`curated.ts`——起動の指定を
   * 写しで持つと、相手が版を上げたときに食い違う）。なのでここで引き直す。
   */
  const pickPinned = useCallback(
    async (e: RealCuratedEntry) => {
      setLoading(true);
      setError(null);
      try {
        const res = await searchRealModuleRegistry(e.registryName);
        const found = res.entries.find((x) => x.name === e.registryName);
        if (!found) {
          // **黙って諦めない**（規則2）——目録と registry が食い違ったら、そう言う
          throw new Error(
            `${e.label} が目録にある名前（${e.registryName}）で registry に見つかりませんでした。` +
              "相手が公開をやめた可能性があります",
          );
        }
        pick(found);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pick は描画ごとに作られるが中身は安定
    [],
  );

  function pick(entry: RealRegistryEntry) {
    setPicked(entry);
    // **名前を決めるのは host**（規則3——`suggestedName`）。`/` の後ろをそのまま
    // 使うと Stripe が `mcp` になる。同じ名前が在れば番号を足す（人に考えさせない）
    const base = entry.suggestedName || entry.name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const taken = new Set(existingNames);
    let next = base;
    for (let i = 2; taken.has(next); i += 1) next = `${base}-${i}`;
    setName(next);
    // **選び直したら、前の答えは捨てる**——別の Module の欄に前の値が残らない
    const fresh: Record<string, { source: "vault" | "plain"; value: string }> = {};
    for (const i of entry.inputs) {
      // **秘密は Vault を既定に**（楽な道を安全なほうに置く）。既定値が在れば入れておく
      fresh[i.name] = { source: i.secret ? "vault" : "plain", value: i.secret ? "" : (i.default ?? "") };
    }
    setAnswers(fresh);
    report(entry, next, fresh);
  }

  // **外から1件渡されたら、それを選んだことにする**（貼られた `server.json`）
  useEffect(() => {
    if (only) pick(only);
    else if (only === null) setPicked(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同じ1件を選び直さない
  }, [only?.name, only?.version]);

  function setAnswer(inputName: string, patch: Partial<{ source: "vault" | "plain"; value: string }>) {
    setAnswers((prev) => {
      const next = { ...prev, [inputName]: { ...(prev[inputName] ?? { source: "plain", value: "" }), ...patch } };
      report(picked, name, next);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="add-module-registry">
      {only ? null : pinned ? (
        <p className="text-xs text-ink-3">
          <strong>banto が出所を確かめたもの</strong>——そのサービスのドメインの持ち主が
          公開していることまで確認しています。
          <strong className="text-foreground">中のコードは監査していません</strong>
          （何をするかは提供元の責任です）。
        </p>
      ) : (
        <>
          <p className="text-xs text-ink-3">
            公開されている MCP サーバの目録（
            <code>registry.modelcontextprotocol.io</code>）。
            <strong className="text-danger">誰でも公開でき、banto は中身を確かめていません。</strong>
            探しているサービスの名前で検索してください。
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-module-registry-search">検索</Label>
            <Input
              id="add-module-registry-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="stripe、notion、github…"
            />
          </div>
        </>
      )}

      {error ? (
        <p className="text-xs text-danger" data-testid="add-module-registry-error">
          {error}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-2 h-6 px-1.5 text-xs"
            onClick={() => void search(query)}
          >
            やり直す
          </Button>
        </p>
      ) : null}

      <div className={only ? "hidden" : "flex max-h-72 flex-col gap-1 overflow-y-auto"}>
        {pinned ? (
          pinned.map((e) => (
            <button
              key={e.id}
              type="button"
              data-testid={`add-module-curated-${e.id}`}
              data-state={picked?.name === e.registryName ? "active" : "inactive"}
              onClick={() => void pickPinned(e)}
              className={
                "flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left " +
                (picked?.name === e.registryName ? "border-accent bg-accent-soft/40" : "border-border")
              }
            >
              <span className="text-sm font-medium text-foreground">{e.label}</span>
              <span className="text-xs text-ink-3">{e.description}</span>
              {/* **なぜ載っているか**をそのまま出す（規則2——根拠を隠さない） */}
              <span className="text-[10px] text-ink-3">{e.why}</span>
            </button>
          ))
        ) : query.trim() === "" ? (
          // **検索していないときに、それらしい一覧を出さない**（上の useEffect）
          <p
            className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-3"
            data-testid="add-module-registry-prompt"
          >
            探しているサービスの名前を入れてください（例：stripe、notion、github）
          </p>
        ) : result === null && loading ? (
          <p className="text-xs text-ink-3">読み込み中…</p>
        ) : result !== null && result.entries.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-3">
            見つかりませんでした
          </p>
        ) : (
          (result?.entries ?? []).map((e) => {
            const prov = PROVENANCE[e.provenance];
            const isPicked = picked?.name === e.name;
            return (
              <button
                key={e.name}
                type="button"
                data-testid={`add-module-registry-${e.name}`}
                data-provenance={e.provenance}
                data-connect={e.connect.kind}
                data-state={isPicked ? "active" : "inactive"}
                onClick={() => pick(e)}
                className={
                  "flex flex-col items-start gap-1 rounded-md border p-2.5 text-left " +
                  (isPicked ? "border-accent bg-accent-soft/40" : "border-border")
                }
              >
                <span className="flex w-full items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {e.label}
                  </span>
                  <span
                    title={prov.hint}
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${prov.tone}`}
                  >
                    {prov.label}
                  </span>
                  {e.status !== "active" ? (
                    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-ink-3">
                      {e.status}
                    </span>
                  ) : null}
                </span>
                <span className="line-clamp-2 text-xs text-ink-3">{e.description}</span>
                <span className="truncate text-[10px] text-ink-3">{e.name}</span>
                {/* **押す前に、何が起きるかを出す**（§6.1）——繋ぎ方と、
                    こちらで動かすのかどうか */}
                <span className="text-xs text-ink-2">{describeConnect(e)}</span>
              </button>
            );
          })
        )}
        {result?.nextCursor ? (
          // **続きが在ることを隠さない**（「これで全部」に見せない）
          <p className="p-2 text-center text-[10px] text-ink-3">
            まだ続きがあります——検索で絞り込んでください
          </p>
        ) : null}
      </div>

      {picked && notInstallableReason(picked) ? (
        // **押す前に、なぜ入れられないかを出す**（黙って押せなくしない・規則2）
        <p
          className="rounded-md bg-surface-2 px-3 py-2 text-xs text-ink-2"
          data-testid="add-module-registry-not-installable"
        >
          これは入れられません：{notInstallableReason(picked)}
          。「カスタム」から手で書けば足せます
        </p>
      ) : null}

      {picked && !notInstallableReason(picked) ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="add-module-registry-name">名前</Label>
          <Input
            id="add-module-registry-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              report(picked, e.target.value, answers);
            }}
          />
          {picked.inputs.length > 0 ? (
            <div className="flex flex-col gap-2.5" data-testid="add-module-registry-inputs">
              <p className="text-xs text-ink-3">
                繋ぐのに要る{picked.inputs[0]!.target === "header" ? "ヘッダ" : "設定"}
                ——<strong>registry には値が書かれていません</strong>ので、ここで入れます
              </p>
              {picked.inputs.map((i) => {
                const a = answers[i.name] ?? { source: "plain" as const, value: "" };
                return (
                  <div key={i.name} className="flex flex-col gap-1" data-testid={`add-module-registry-input-${i.name}`}>
                    <Label htmlFor={`add-module-registry-in-${i.name}`}>
                      {i.name}
                      {i.required ? <span className="ml-1 text-danger">必須</span> : null}
                    </Label>
                    {i.description ? <p className="text-xs text-ink-3">{i.description}</p> : null}
                    {i.choices?.length ? (
                      // **選択肢が在るなら選ばせる**（自由入力にしない）
                      <select
                        id={`add-module-registry-in-${i.name}`}
                        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                        value={a.value}
                        onChange={(e) => setAnswer(i.name, { value: e.target.value, source: "plain" })}
                      >
                        <option value="">選んでください</option>
                        {i.choices.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        id={`add-module-registry-in-${i.name}`}
                        value={a.value}
                        onChange={(e) => setAnswer(i.name, { value: e.target.value })}
                        placeholder={a.source === "vault" ? "Vault に入れた名前" : (i.default ?? "")}
                      />
                    )}
                    {i.secret ? (
                      // **秘密は既定で Vault から**（`add-instance-module-dialog` の手書きの道と同じ形）
                      // ——直書きは宣言に残り、記録から消せない
                      <>
                        <PillTabs
                          label={`${i.name} の渡し方`}
                          testId={`add-module-registry-source-${i.name}`}
                          size="xs"
                          value={a.source}
                          onChange={(id) => setAnswer(i.name, { source: id as "vault" | "plain" })}
                          tabs={[
                            { id: "vault", label: "Vault から" },
                            { id: "plain", label: "直接入力" },
                          ]}
                        />
                        <p className={a.source === "vault" ? "text-xs text-ink-3" : "text-xs text-danger"}>
                          {a.source === "vault"
                            ? "Vault に預けた名前を書きます。起動のたびに引いて渡すので、記録には名前だけが残ります"
                            : "この値は banto の記録に残り続けます（後から消せません）"}
                        </p>
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

    </div>
  );
}

/** その1件を、banto がどう繋ぐことになるか（1行）。 */
function describeConnect(e: RealRegistryEntry): string {
  if (e.connect.kind === "remote") {
    return `${e.connect.host} に接続します（こちらでは動かしません／会話の内容が外に出ます）`;
  }
  if (e.connect.kind === "local") {
    const what = `${e.connect.identifier}${e.connect.packageVersion ? `@${e.connect.packageVersion}` : ""}`;
    return e.connect.supported
      ? `${what} を取得して、このサーバで動かします（閉じ込めます）`
      : `${what}：${e.connect.reason ?? "この配布形式にはまだ対応していません"}`;
  }
  return e.connect.reason;
}
