/**
 * 設定画面（settings モジュール提供・決定41・prototype の設定面）。
 *
 * **このファイルはどの設定も知らない。** 区画の宣言（`fields`）を受け取って描くだけで、
 * モジュールが設定項目を増やしても、新しいモジュールが加わっても、ここは変わらない
 * ——それが「GUI ではなく項目の宣言を渡す」ことの意味。
 *
 * 左のナビと右の内容は prototype（`banto-shell.html` の設定面）に合わせている。
 */

import { useEffect, useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import { resolveCanvasView, type CanvasViewProps } from "./registry.js";
import { Button, ErrorNote, Note } from "./ui.js";
import { Icon } from "../icons.js";
import type { ModeChoice } from "../theme/themes.js";
import { useThemeState } from "../theme/ThemeProvider.js";

/** 画面側の区画の ID。ホストが同じ ID を配ってきたら、こちらが先に出る。 */
const APPEARANCE_ID = "appearance";

/** 中核の Tool 面（ADR-0011 決定42）。中核の区画が描くビューはここからデータを取る。 */
const CORE_TOOL_BASE_URL = "/api/core";

interface SettingField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "list";
  description?: string;
  options?: Array<{ value: string; label: string }>;
  unit?: string;
  placeholder?: string;
  restartRequired?: boolean;
  secret?: boolean;
}

interface SettingsSectionView {
  id: string;
  title: string;
  description?: string;
  origin: string;
  originTitle: string;
  fields: SettingField[];
  /** 項目で表せない中核の区画が指定する描き先（ADR-0011 決定43）。 */
  view?: string;
  values: Record<string, unknown>;
}

interface SettingsDescription {
  sections: SettingsSectionView[];
  storedAt: string;
}

export interface SettingsPanelProps extends CanvasViewProps {
  /**
   * 開いている区画。**真実は URL**（`viewLocation.ts`）——自分で持つと、リロードや
   * 戻る／進むで先頭の区画に戻ってしまう。未指定なら先頭の区画を出す。
   */
  section?: string;
  /**
   * 区画を選ぶ。**undefined で一覧へ戻る**——狭い画面では区画の一覧と中身が別の面に
   * なるので、「どれも選んでいない」状態が要る（広い画面では先頭の区画を出す）。
   */
  onSection(sectionId: string | undefined): void;
}

export function SettingsPanel(props: SettingsPanelProps): React.ReactElement {
  const { endpoint, section: openSectionId, onSection } = props;
  const description = useModuleTool<SettingsDescription>(endpoint, "settings.describe");
  const theme = useThemeState();
  /**
   * **見た目だけは画面側の区画**（spec-design §6.2）。他の区画はホストが宣言を配るが、
   * テーマはホストが持たない状態なので、ここに1つだけ足す。ホスト由来の区画と
   * 混ざらないよう、出所を `surface` として区別する。
   */
  const sections: SettingsSectionView[] = [
    {
      id: APPEARANCE_ID,
      title: "見た目",
      description: "この画面の地の明暗。端末ごとに覚えます（他の人や他の端末には移りません）。",
      origin: "surface",
      originTitle: "この画面",
      fields: [],
      values: {},
    },
    ...(description.data?.sections ?? []),
  ];
  /** 触った項目だけを送る（触っていない項目まで上書きしないため）。 */
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const active = sections.find((s) => s.id === openSectionId) ?? sections[0];

  // 区画を切り替えたら、書きかけを持ち越さない
  useEffect(() => {
    setDraft({});
    setNotice(undefined);
    setError(undefined);
  }, [active?.id]);

  const valueOf = (field: SettingField): unknown =>
    field.key in draft ? draft[field.key] : active?.values[field.key];

  const save = async (): Promise<void> => {
    if (!active || Object.keys(draft).length === 0) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await callModuleTool<{ applied: boolean; message?: string }>(
        endpoint,
        "settings.update",
        { section: active.id, values: draft }
      );
      setDraft({});
      description.reload();
      setNotice(result.message ?? (result.applied ? "変えました。" : "保存しました。"));
    } catch (err) {
      // I2: 保存できなかったのに保存したように見せない
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    /* 狭いときは「区画の一覧 → その中身」のドリルダウン（ファイル閲覧と同じ運び） */
    <div className={`sp ${openSectionId ? "is-detail" : "is-list"}`}>
      <nav className="sp-nav">
        {sections.map((section) => (
          <button
            key={section.id}
            className={section.id === active?.id ? "sp-nav-btn sp-nav-on" : "sp-nav-btn"}
            onClick={() => onSection(section.id)}
          >
            <span className="sp-nav-main">
              {section.title}
              {/* どのモジュールが公開している設定かを、一覧でも分かるようにする */}
              {section.origin !== "core" && section.origin !== "surface" && (
                <span className="sp-origin">{section.origin}</span>
              )}
            </span>
            <Icon name="chevron-right" size={15} className="sp-nav-caret" />
          </button>
        ))}
        {sections.length === 0 && <p className="cv-muted">{description.loading ? "…" : "設定なし"}</p>}
      </nav>

      <div className="sp-content">
        <button className="sp-back" type="button" onClick={() => onSection(undefined)}>
          ‹ 設定の一覧
        </button>
        <div className={`sp-inner${active?.view ? " sp-inner-wide" : ""}`}>
        {description.error && <ErrorNote onRetry={description.reload}>{description.error}</ErrorNote>}
        {!active ? null : (
          <>
            <h2 className="sp-title">
              {active.title}
              {/* 「これは誰の設定か」を内容側にも出す。モジュールが増えたとき、
                  どの機能を触っているのか分からないまま値を変えるのを避ける */}
              <span className={active.origin === "core" || active.origin === "surface" ? "sp-badge sp-badge-core" : "sp-badge"}>
                {active.origin === "core"
                  ? "Banto 本体"
                  : active.origin === "surface"
                    ? "この画面"
                    : `モジュール: ${active.originTitle}（${active.origin}）`}
              </span>
            </h2>
            {active.description && <p className="sp-desc">{active.description}</p>}

            {/* 項目で表せない中核の区画は、宣言された名前のビューを描く（決定43）。
                モジュールには決定41 がそのまま効く——ここへは来ない */}
            {active.id === APPEARANCE_ID ? (
              <ThemePicker theme={theme} />
            ) : active.view ? (
              <SectionView
                name={active.view}
                origin={active.origin}
                endpointOf={props.endpointOf}
                bridge={{
                  values: active.values,
                  busy,
                  reload: () => description.reload(),
                  save: async (next) => {
                    setBusy(true);
                    try {
                      const result = await callModuleTool<{ applied: boolean; message?: string }>(
                        endpoint,
                        "settings.update",
                        { section: active.id, values: next }
                      );
                      description.reload();
                      return result.message;
                    } finally {
                      setBusy(false);
                    }
                  },
                }}
              />
            ) : (
              <>
            {active.fields.map((field) => (
              <label key={field.key} className="sp-field">
                <span className="sp-label">
                  {field.label}
                  {field.unit && <span className="sp-unit">（{field.unit}）</span>}
                  {field.restartRequired && <span className="sp-restart">要再起動</span>}
                </span>
                {renderInput(field, valueOf(field), (next) =>
                  setDraft((prev) => ({ ...prev, [field.key]: next }))
                )}
                {field.description && <span className="sp-hint">{field.description}</span>}
              </label>
            ))}

            {error && <ErrorNote onRetry={() => setError(undefined)}>{error}</ErrorNote>}
            {notice && <Note tone="ok">{notice}</Note>}

            <div className="sp-actions">
              <Button
                variant="primary"
                disabled={busy || Object.keys(draft).length === 0}
                onClick={save}
              >
                {busy ? "保存中…" : "保存する"}
              </Button>
              {Object.keys(draft).length > 0 && (
                <Button variant="ghost" onClick={() => setDraft({})}>
                  やめる
                </Button>
              )}
            </div>

            <p className="cv-muted sp-where">
              保存先: <code>{description.data?.storedAt}</code>
              <br />
              番頭はこの場所に書けません（設定を書き換えて自分の権限を広げられないように）
            </p>
              </>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}

/** 項目の型ごとの入力欄。ここに無い型は宣言側でも使えない。 */
function renderInput(
  field: SettingField,
  value: unknown,
  onChange: (next: unknown) => void
): React.ReactElement {
  if (field.type === "boolean") {
    return (
      <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
    );
  }
  if (field.type === "select") {
    return (
      <select className="sp-input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "list") {
    // **1件1行のカード**（prototype の設定面に合わせる）。テキスト塊にすると、
    // 1件足す・1件消すのに行の編集が要り、消したつもりで残る事故が起きる
    const items = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    const replace = (next: string[]): void => onChange(next);
    return (
      <div className="sp-rows">
        {items.map((item, index) => (
          <div className="sp-row" key={index}>
            <input
              className="sp-input sp-row-input"
              value={item}
              placeholder={field.placeholder}
              spellCheck={false}
              onChange={(e) => replace(items.map((v, i) => (i === index ? e.target.value : v)))}
            />
            <button
              className="sp-row-remove"
              type="button"
              title="この行を消す"
              onClick={() => replace(items.filter((_, i) => i !== index))}
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        ))}
        <button className="sp-row-add" type="button" onClick={() => replace([...items, ""])}>
          <Icon name="plus" size={14} /> 追加
        </button>
      </div>
    );
  }
  return (
    <input
      className="sp-input"
      type={field.type === "number" ? "number" : field.secret ? "password" : "text"}
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={field.placeholder}
      spellCheck={false}
      onChange={(e) => onChange(field.type === "number" ? Number(e.target.value) : e.target.value)}
    />
  );
}

/**
 * 中核の区画が宣言したビューを描く（決定43）。
 *
 * I2: 名前が解決できないときは黙って空白にしない——設定が消えたように見えるため。
 */
function SectionView({
  name,
  origin,
  endpointOf,
  bridge,
}: {
  name: string;
  origin: string;
  endpointOf: CanvasViewProps["endpointOf"];
  bridge: NonNullable<CanvasViewProps["settings"]>;
}): React.ReactElement {
  const Component = resolveCanvasView(name);
  if (!Component) {
    return <ErrorNote title="この設定を描けません">ビュー「{name}」がUI側の解決表にありません。</ErrorNote>;
  }
  // キャンバスの面と同じ契約で描く（決定43。**モジュールにも開いた**・2026-08-10）。
  // 到達先は区画の出どころ——中核なら中核の Tool 面、モジュールならそのモジュール。
  //
  // **他のモジュールの到達先も引けるようにする**（決定27 のレジストリ方式）。中核の区画でも、
  // モジュールが持つ口を要ることがある——場所の許可は workspace が持っている。
  // URLを直書きさせないための口であって、直接呼び合うこと自体は決定27 のとおり
  const endpoint = origin === "core" ? CORE_TOOL_BASE_URL : (endpointOf(origin) ?? CORE_TOOL_BASE_URL);
  return (
    <Component
      params={{}}
      tabId={`settings:${name}`}
      kind={`settings.${name}`}
      module={origin}
      endpoint={endpoint}
      endpointOf={endpointOf}
      // 設定の区画から別の面は開かない（キャンバスのタブではないので開き先が無い）
      openCanvas={() => undefined}
      // 値の読み書きは設定画面の口のまま（GUI を宣言しても経路は増やさない）
      settings={bridge}
    />
  );
}

/**
 * 見た目を選ぶ（spec-design §6）。
 *
 * **テーマは家、明暗はその中の別**として別々に選ばせる（PO報告 2026-08-06）。
 * 一緒にすると、明暗ボタンを押しただけで家が戻ってしまう。
 */
function ThemePicker({ theme }: { theme: ReturnType<typeof useThemeState> }): React.ReactElement {
  const modes: Array<{ id: ModeChoice; label: string }> = [
    { id: "system", label: "端末に合わせる" },
    { id: "light", label: "明" },
    { id: "dark", label: "暗" },
  ];
  return (
    <>
      <h3 className="sp-sub">意匠</h3>
      <div className="sp-themes">
        {theme.families.map((f) => {
          const on = theme.choice.family === f.id;
          // 見本は**いま当たっている明暗**で出す。選んだ結果がそのまま見える
          const [bg, shu, ai] = f.swatch[theme.mode];
          return (
            <button
              key={f.id}
              type="button"
              className={`sp-theme ${on ? "is-on" : ""}`}
              onClick={() => theme.setFamily(f.id)}
            >
              <span className="sp-theme-swatch">
                <i style={{ background: bg, flex: 2 }} />
                <i style={{ background: shu }} />
                <i style={{ background: ai }} />
              </span>
              <span className="sp-theme-main">
                <span className="sp-theme-name">{f.name}</span>
                <span className="sp-theme-desc">{f.description}</span>
              </span>
              <span className="sp-theme-changes">{f.changes}が変わります</span>
              {on && <Icon name="check" size={16} className="sp-theme-check" />}
            </button>
          );
        })}
      </div>

      <h3 className="sp-sub">明るさ</h3>
      <div className="cv-seg" role="group" aria-label="明るさ">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`cv-seg-opt ${theme.choice.mode === m.id ? "is-on" : ""}`}
            onClick={() => theme.setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="sp-hint">
        いま当たっているのは <b>{theme.family.name}（{theme.mode === "dark" ? "暗" : "明"}）</b> です。
        上段の明暗ボタンは<b>選んだ意匠の中で</b>切り替わります。
      </p>
    </>
  );
}
