/**
 * キャンバスGUIの共通部品（ADR-0010 決定18・25・§8）。
 *
 * **どのモジュールのGUIも同じ骨格で描く**ための土台。番頭がキャンバスへ出すものは
 * モジュールごとにバラバラの見た目でよいはずがない——POから見れば「番頭が出した面」で
 * ひと続きだから、道具立て（見出し・空状態・失敗の出方・一覧と詳細の関係）を揃える。
 *
 * D5: ここに判断は無い。姿と操作の型だけを持つ。
 * §8（モバイル対応必須）: 画面の広さではなく**キャンバス自身の幅**（コンテナクエリ）で
 *   姿を変える。チャット欄を広げてキャンバスが細くなったときと、スマホで見たときは、
 *   POにとって同じ「狭い」であって、ビューポート幅で分けると前者が崩れる。
 */

import React, { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../icons.js";

// ── 骨格 ─────────────────────────────────────────────────────────────────────

/** GUI 1枚の外枠。高さいっぱいに広がり、中のスクロールは自分で決める。 */
export function ViewShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return <div className={`cv ${className}`}>{children}</div>;
}

/**
 * 上端の道具立て。**狭いときは折り返す**——横に溢れると、右端の操作へ届かなくなる。
 * 押せるものは右へ、状態を表すものは左へ置く。
 */
export function ViewBar({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return <div className={`cv-bar ${className}`}>{children}</div>;
}

/** 道具立ての中の見出し。件数は分かっているときだけ出す（0 と不明を混ぜない）。 */
export function ViewTitle({
  children,
  count,
  icon,
}: {
  children: React.ReactNode;
  count?: number;
  icon?: IconName;
}): React.ReactElement {
  return (
    <span className="cv-title">
      {icon && <Icon name={icon} size={17} className="cv-title-icon" />}
      <span className="cv-title-text">{children}</span>
      {count !== undefined && <span className="cv-count">{count}</span>}
    </span>
  );
}

/** 道具立ての中で、以降を右端へ寄せる。 */
export function Spacer(): React.ReactElement {
  return <span className="cv-spacer" />;
}

/** 区切りのある帯（一覧の中の小見出しなど）。 */
export function SectionHead({
  children,
  count,
  actions,
}: {
  children: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="cv-sechead">
      <h3 className="cv-sechead-title">
        {children}
        {count !== undefined && <span className="cv-count">{count}</span>}
      </h3>
      {actions && <div className="cv-sechead-actions">{actions}</div>}
    </div>
  );
}

/** 中身をそのまま流すスクロール領域。余白は中に置く（器に置くと影が切れる）。 */
export const Scroll = React.forwardRef<
  HTMLDivElement,
  { children: React.ReactNode; className?: string; pad?: boolean }
>(function Scroll({ children, className = "", pad = true }, ref) {
  return (
    <div className={`cv-scroll ${pad ? "is-pad" : ""} ${className}`} ref={ref}>
      {children}
    </div>
  );
});

/**
 * 一覧と詳細の2枚組。
 *
 * **広いときは横に並べ、狭いときは一覧→詳細のドリルダウン**（プロトタイプ四次改訂）。
 * 両方を常に描いて CSS で出し分ける——切り替えのたびに作り直すと、詳細側のスクロール位置も
 * 読み込み済みの中身も毎回消える。
 */
export function SplitView({
  list,
  detail,
  showDetail,
  onBack,
  backLabel = "一覧へ",
  size = "md",
}: {
  list: React.ReactNode;
  detail: React.ReactNode;
  /** 詳細を見ている最中か（狭いときだけ意味を持つ）。 */
  showDetail: boolean;
  /** 狭いときの「戻る」。渡さなければ戻れない面として描く。 */
  onBack?: () => void;
  backLabel?: string;
  /** 一覧側の幅。扱う情報量で選ぶ。 */
  size?: "sm" | "md" | "lg";
}): React.ReactElement {
  return (
    <div className={`cv-split is-${size} ${showDetail ? "is-detail" : "is-list"}`}>
      <div className="cv-pane cv-pane-list">{list}</div>
      <div className="cv-pane cv-pane-detail">
        {onBack && (
          <button className="cv-back" type="button" onClick={onBack}>
            <Icon name="chevron-left" size={14} /> {backLabel}
          </button>
        )}
        {detail}
      </div>
    </div>
  );
}

/**
 * **主が広く、詳細は選んだときだけ**の2枚組（PO報告 2026-08-07）。
 *
 * `SplitView` は「一覧（狭い）＋詳細（広い）」の形で、一覧が主役でないものに使うと逆になる。
 * 工場のボードは**横に流すカンバン**——狭い方に入れると列がほとんど見えず、
 * 隣に空の「選んでください」が広く居座る。実際そうなっていた（PO報告のスクリーンショット）。
 *
 * ここでは主（ボード）が残り全部を取り、詳細は**選んだときだけ**決まった幅で右に出る。
 * 狭いときは詳細が全面に被さる（`SplitView` と同じドリルダウン）。
 */
export function WorkView({
  main,
  detail,
  onBack,
  backLabel = "ボードへ",
}: {
  main: React.ReactNode;
  /** 選ばれていなければ `null`。**空の詳細ペインを描かない**のが要点。 */
  detail: React.ReactNode | null;
  onBack?: () => void;
  backLabel?: string;
}): React.ReactElement {
  return (
    <div className={`cv-work ${detail ? "is-detail" : "is-main"}`}>
      <div className="cv-pane cv-work-main">{main}</div>
      {detail && (
        <div className="cv-pane cv-work-detail">
          {onBack && (
            <button className="cv-back" type="button" onClick={onBack}>
              <Icon name="chevron-left" size={14} /> {backLabel}
            </button>
          )}
          {detail}
        </div>
      )}
    </div>
  );
}

// ── 押すもの ─────────────────────────────────────────────────────────────────

type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "ok";

/**
 * 押しボタン。**指で押せる大きさを既定にする**（§8）——狭い画面では CSS が
 * さらに広げる。危険な操作は `danger` にして、色と間隔で取り違えを防ぐ。
 */
export function Button({
  variant = "default",
  small = false,
  className = "",
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  small?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`cv-btn is-${variant} ${small ? "is-small" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** 記号だけのボタン。読み上げ用の名前を必ず取る。 */
export function IconButton({
  label,
  className = "",
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): React.ReactElement {
  return (
    <button
      type="button"
      className={`cv-iconbtn ${className}`}
      aria-label={label}
      title={rest.title ?? label}
      {...rest}
    >
      {children}
    </button>
  );
}

/** 押すと内容を写す。**写したことを見せる**——押しただけでは起きたか分からない。 */
export function CopyButton({
  text,
  label = "コピー",
  small = true,
}: {
  text: string;
  label?: string;
  small?: boolean;
}): React.ReactElement {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <Button
      small={small}
      variant="ghost"
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} />
      {done ? "写しました" : label}
    </Button>
  );
}

/**
 * 択一の切替（表示モードなど）。選択肢が3つ以内で、並べて比べたいときに使う。
 * 4つ以上・可変長なら `<select>`（`Select`）を使う——横に溢れて押せなくなる。
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: ReadonlyArray<{ value: T; label: string; title?: string; disabled?: boolean }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <span className="cv-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={`cv-seg-opt ${option.value === value ? "is-on" : ""}`}
          disabled={disabled || option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

/** 入切の札。絞り込みのように、複数を同時に選べるものに使う。 */
export function Chip({
  on = false,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }): React.ReactElement {
  return (
    <button type="button" className={`cv-chip ${on ? "is-on" : ""}`} aria-pressed={on} {...rest}>
      {children}
    </button>
  );
}

/** チェックボックス付きの札。文言が要る入切に使う。 */
export function Toggle({
  checked,
  onChange,
  children,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
  title?: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <label className="cv-toggle" title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

/** 選ぶ欄。選択肢が多いもの・可変のものはこちら。 */
export function Select({
  className = "",
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  return (
    <select className={`cv-select ${className}`} {...rest}>
      {children}
    </select>
  );
}

/** 1行の入力欄。 */
export function TextInput({
  className = "",
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  return <input className={`cv-input ${className}`} spellCheck={false} {...rest} />;
}

/**
 * 絞り込みの入力欄。
 *
 * **その場で絞るもの（onChange）と、投げて探すもの（onSubmit）を分ける**——
 * 手元にある一覧はキーを打つたびに絞れるが、サーバへ問い合わせるものを毎打鍵で
 * 投げると、打ち終わる前に何度も走る。
 *
 * 絞った先を上下と Enter で選ぶ一覧（`useListNav`）は、その鍵さばきを `onKeyDown` で
 * 差し込む。**先に見るのは差し込まれた側**——Enter を一覧の確定に使う欄では、
 * ここの onSubmit を二重に走らせない（`preventDefault` したかどうかで見分ける）。
 */
export function SearchField({
  value,
  onChange,
  onSubmit,
  onKeyDown,
  placeholder,
  autoFocus,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (value: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <span className={`cv-search ${className}`}>
      <Icon name="search" size={15} className="cv-search-icon" />
      <input
        type="search"
        className="cv-search-input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Enter" && !e.nativeEvent.isComposing) onSubmit?.(value);
          // Esc は「絞り込みをやめる」。IME の変換取り消しとは競合しない（変換中は無視）
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            onChange("");
            onSubmit?.("");
          }
        }}
      />
      {value.length > 0 && (
        <button
          type="button"
          className="cv-search-clear"
          aria-label="絞り込みをやめる"
          title="やめる"
          onClick={() => {
            onChange("");
            onSubmit?.("");
          }}
        >
          <Icon name="close" size={13} />
        </button>
      )}
    </span>
  );
}

// ── 状態を表すもの ───────────────────────────────────────────────────────────

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

/**
 * 小さな札。状態・分類を1語で表す。
 *
 * `onClick` を渡すと**押せる札**になる（PO要望 2026-08-11）。読み取り専用の札の隣に
 * 直す口を別途置くより、その札自身を押せる方が短い——見えているものが操作対象になる。
 * 押せるときは `button` にする（キーボードでも届く）。
 */
export function Badge({
  tone = "neutral",
  children,
  title,
  className = "",
  onClick,
}: {
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
  className?: string;
  onClick?(): void;
}): React.ReactElement {
  if (onClick) {
    return (
      <button
        type="button"
        className={`cv-badge is-${tone} is-pressable ${className}`}
        title={title}
        onClick={onClick}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={`cv-badge is-${tone} ${className}`} title={title}>
      {children}
    </span>
  );
}

/** 生き死にの点。動いているものだけ脈を打たせる（止まっているのかが一目で分かる）。 */
export function StatusDot({
  tone = "neutral",
  pulse = false,
  title,
}: {
  tone?: Tone;
  pulse?: boolean;
  title?: string;
}): React.ReactElement {
  return <span className={`cv-dot is-${tone} ${pulse ? "is-pulse" : ""}`} title={title} />;
}

/** 何も無いときの面。**次の一手まで書く**——空白だけだと、壊れているのか空なのか分からない。 */
export function EmptyState({
  icon = "canvas",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="cv-empty">
      <Icon name={icon} size={26} stroke={1.3} className="cv-empty-icon" />
      <p className="cv-empty-title">{title}</p>
      {children && <p className="cv-empty-sub">{children}</p>}
      {action && <div className="cv-empty-actions">{action}</div>}
    </div>
  );
}

/**
 * 読み込み中。**骨組みを出す**——「読み込み中…」の一行だけだと、
 * 何が出てくるのか分からないまま画面が跳ねる。
 */
export function Loading({ label = "読み込んでいます…", rows = 3 }: { label?: string; rows?: number }): React.ReactElement {
  return (
    <div className="cv-loading" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="cv-skel" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}

/**
 * 失敗の知らせ（I2）。**握りつぶさない**。取り直せるものは、その場で取り直せるようにする
 * ——失敗のたびにタブを開き直させない。
 */
export function ErrorNote({
  children,
  onRetry,
  title = "うまくいきませんでした",
}: {
  children: React.ReactNode;
  onRetry?: () => void;
  title?: string;
}): React.ReactElement {
  return (
    <div className="cv-error" role="alert">
      <span className="cv-error-icon" aria-hidden="true">
        !
      </span>
      <span className="cv-error-body">
        <span className="cv-error-title">{title}</span>
        <span className="cv-error-detail">{children}</span>
      </span>
      {onRetry && (
        <Button small variant="ghost" onClick={onRetry}>
          もう一度
        </Button>
      )}
    </div>
  );
}

/** 気づいてほしい注意（消し忘れ・広すぎる許可など）。 */
export function Note({
  tone = "warn",
  children,
  icon,
}: {
  tone?: Tone;
  children: React.ReactNode;
  icon?: IconName;
}): React.ReactElement {
  // 絵を渡されなければ、色の役から決める（警告＝気をつける、失敗＝止まった）
  const mark: IconName = icon ?? (tone === "ok" ? "check" : tone === "danger" ? "error" : "warn");
  return (
    <div className={`cv-note is-${tone}`}>
      <Icon name={mark} size={15} className="cv-note-icon" />
      <span>{children}</span>
    </div>
  );
}

/** 1件分の器。一覧の行にも、詳細の区画にも使う。 */
export function Card({
  children,
  tone,
  className = "",
  onClick,
  selected,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
}): React.ReactElement {
  const cls = `cv-card ${tone ? `is-${tone}` : ""} ${selected ? "is-selected" : ""} ${className}`;
  if (onClick) {
    return (
      <button type="button" className={`${cls} is-clickable`} onClick={onClick}>
        {children}
      </button>
    );
  }
  return <div className={cls}>{children}</div>;
}

/**
 * 画面の上に重ねる面。
 *
 * **ドロップダウンにしない**——押した場所の脇に開くものは、狭い画面では必ず端から
 * はみ出す（横スクロールが生える）。画面に対して置けば、広さに関係なく収まる。
 * 閉じ方は3つとも効かせる：背景を押す・×・Esc。
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 入力中の Esc は IME の変換取り消しに使われる。変換中は閉じない
      if (e.key === "Escape" && !e.isComposing) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="cv-modal-backdrop" onMouseDown={onClose}>
      <div
        className="cv-modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cv-modal-head">
          <span className="cv-modal-title">{title}</span>
          <IconButton label="閉じる" onClick={onClose}>
            <Icon name="close" size={15} />
          </IconButton>
        </div>
        <div className="cv-modal-body">{children}</div>
        {footer && <div className="cv-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** 名前と値の並び。詳細の見出し下に置く。 */
export function MetaList({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: React.ReactNode; mono?: boolean }>;
}): React.ReactElement {
  return (
    <dl className="cv-meta">
      {items.map((item) => (
        <React.Fragment key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? "is-mono" : ""}>{item.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** 折り畳める区画。既定は閉じておく——開いたままだと本題が押し出される。 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = "",
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`cv-disc ${open ? "is-open" : ""} ${className}`}>
      <button
        type="button"
        className="cv-disc-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} className="cv-disc-caret" />
        <span className="cv-disc-summary">{summary}</span>
      </button>
      {open && <div className="cv-disc-body">{children}</div>}
    </div>
  );
}

// ── 読みやすさのための小道具 ─────────────────────────────────────────────────

/** バイト数を人の単位に。生の数字は桁を数えないと大きさが分からない。 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 大きい数を短く（1200 → 1.2k）。 */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return String(n);
}

/** 経過・残りを日本語で。**分からないものは空文字**（I1：時刻を騙らない）。 */
export function formatRelative(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const diff = at - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000
      ? `${Math.max(1, Math.round(abs / 1000))}秒`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)}分`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)}時間`
          : `${Math.round(abs / 86_400_000)}日`;
  return diff >= 0 ? `あと${unit}` : `${unit}前`;
}

/** 絶対時刻（画面に出す既定の形）。分からないものはそのまま返す。 */
export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ja-JP", { hour12: false, dateStyle: "short", timeStyle: "short" });
}

/**
 * 会話の日時表示に使う **JST 固定** のフォーマッタ（task-0279）。
 *
 * 記録は UTC ISO（ホスト側）、表示は出口で JST に直す（task-0180 の方針）。
 * ブラウザ任せの既存 `formatTime` とは別物——会話の時刻は誰の環境で見ても同じ見え方にする。
 * タイムゾーン名はここに1箇所だけ置く。
 */
const JST_TIME_ZONE = "Asia/Tokyo";

/** 時刻のみ（`14:05`・JST 固定）。読めないものは空文字。 */
export function formatJstTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** 日付（`8/18(火)`・JST 固定）。区切り線の「日付が変わったか」の判定にも使う。 */
export function formatJstDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST_TIME_ZONE,
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

/**
 * 狭いとき、読んでいる間だけ道具立てを退かせる（`spec-canvas-ui` §3.1・PO報告 2026-08-08）。
 *
 * 390×780 でファイルを開くと、本文に残るのは 411px＝画面の 53% だった。畳めるものを
 * 畳んでも屋号の帯と面の頭が常に載っている——**読んでいる最中の頭には仕事が無い**ので、
 * 下へ送っている間は退かせ、上へ少しでも送れば戻す。
 *
 * 戻す仕草は、いましている仕草（上へ送る）と同じ。**戻すための新しい操作を作らない。**
 *
 * 屋号の帯（`.topbar`）はこの面の持ち物ではないので、`<html data-retract>` の1属性で
 * 伝える——効かせるかどうかは受け取る側の CSS が決める（面に判断を持たせない・D5）。
 * 実際に退くのはスマホ幅のときだけで、キャンバスが細いだけの広い画面では退かない。
 *
 * **器は ref ではなく実体で受け取る。** 送られる器は「読み込み中 → 中身」で作り直されるので、
 * `RefObject` を見ていると *効果が張られたときには居なかった* 器を掴んだままになり、
 * 一度も動かない（実装中に踏んだ）。呼ぶ側は callback ref で state に持つ。
 *
 * @param scroller 送られる器（無ければ null）
 * @param active   退かせてよい状況か（詳細を見ている間だけ true にする）
 * @returns 退いているか。呼ぶ側は自分の頭にクラスを当てる
 */
export function useRetractOnScroll(scroller: HTMLElement | null, active: boolean): boolean {
  const [retracted, setRetracted] = useState(false);
  /** 面自身の幅。狭さの判定はキャンバスの幅（`spec-canvas-ui` §3）に揃える */
  const [narrow, setNarrow] = useState(false);
  const lastTop = useRef(0);

  const on = active && narrow && retracted;

  useEffect(() => {
    if (!scroller || !active) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width <= 760);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller, active]);

  useEffect(() => {
    const el = scroller;
    if (!el || !active || !narrow) {
      setRetracted(false);
      return;
    }
    lastTop.current = el.scrollTop;
    const onScroll = (): void => {
      const top = el.scrollTop;
      const delta = top - lastTop.current;
      // 小さな揺れで出たり入ったりさせない（指を置いただけで動くと落ち着かない）
      if (Math.abs(delta) < 8) return;
      lastTop.current = top;
      // いちばん上まで戻ったら必ず出す。頭が無いまま先頭に居る状態を作らない
      setRetracted(top > 48 && delta > 0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- el は scroller そのもの
  }, [scroller, active, narrow]);

  useEffect(() => {
    if (on) document.documentElement.dataset["retract"] = "";
    else delete document.documentElement.dataset["retract"];
    return () => {
      delete document.documentElement.dataset["retract"];
    };
  }, [on]);

  return on;
}

/** 一定の間隔で再描画する（残り時間の表示など）。止まった表示を放置しないため。 */
export function useTicker(intervalMs = 30_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

/**
 * 押している間だけ走る操作（承認・畳む・取り込む…）の受け皿。
 *
 * I2: 失敗を握りつぶさない。**どれを押したかまで覚える**——一覧の中の1件を押したとき、
 * どの行が動いているのかが見えないと二度押しになる。
 */
export function useAction(): {
  busy: string | undefined;
  error: string | undefined;
  notice: string | undefined;
  setNotice: (text: string | undefined) => void;
  clearError: () => void;
  run: (key: string, fn: () => Promise<unknown>, done?: (result: unknown) => string | void) => Promise<void>;
} {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async (
    key: string,
    fn: () => Promise<unknown>,
    done?: (result: unknown) => string | void
  ): Promise<void> => {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await fn();
      if (!alive.current) return;
      const message = done?.(result);
      if (typeof message === "string") setNotice(message);
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  return {
    busy,
    error,
    notice,
    setNotice,
    clearError: () => setError(undefined),
    run,
  };
}
