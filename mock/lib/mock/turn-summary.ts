// ターンの終わりのまとめ（検討中のモック・2026-10-06）。
// AI が人に返すターンの最後に、core の tool（banto-thread の reportTurn）を1回呼んで、
// 「何を頼まれたか・どうなったか・人が決めること・返答の候補」を決まった形で渡す。
// 会話の画面はこの tool 呼び出しを普通の tool のカード（折りたたみ）には入れず、
// 専用のまとめのカードとして会話の流れに出す。

/** core の tool 名（会話の中ではこの名前で分岐する） */
export const TURN_SUMMARY_TOOL_NAME = "banto_report_turn";

/** 頼まれた仕事がどこまで進んだか。人の判断が要るかは decisions の有無で表す（別の軸） */
export type TurnOutcomeStatus = "done" | "partial" | "failed";

export const OUTCOME_LABEL: Record<TurnOutcomeStatus, string> = {
  done: "終わりました",
  partial: "途中まで",
  failed: "できませんでした",
};

export interface TurnSummaryOption {
  /** ボタンに出す短い言葉 */
  label: string;
  /** 押したら入力欄に入る文。そのまま送っても AI に通じる、具体的な文にする */
  reply: string;
  /** AI のおすすめ。1つの判断に1つまで */
  recommended?: boolean;
}

export interface TurnSummaryDecision {
  /** 人が決めること（1文、問いの形） */
  question: string;
  /** 決めるのに要る背景（1〜2文）。無くても決められるなら省く */
  context?: string;
  options: readonly TurnSummaryOption[];
}

export interface TurnSummaryArgs {
  request: {
    /** 依頼の中身。「それでお願い」のような発言でも、前の文脈から具体的に書き直す */
    text: string;
    /** 依頼の元になった人の発言（そのままの言葉と時刻）。text と同じなら省く */
    said?: { text: string; at: string };
  };
  outcome: {
    status: TurnOutcomeStatus;
    /** 結果を1文で。記憶が無くても分かる言葉で */
    headline: string;
    /** 分かったこと・変えたこと（3つまで） */
    points: readonly string[];
    /** 確かめていないこと・残っていること（あれば） */
    notVerified?: readonly string[];
    /** できたもの（コミット・ファイル・URL など） */
    artifacts?: readonly { label: string; detail: string }[];
  };
  /** 人が決めること。無ければ空 */
  decisions: readonly TurnSummaryDecision[];
  /** 判断が無いときの「次に頼めること」 */
  nextSuggestions?: readonly TurnSummaryOption[];
  /** ターンの始まりと終わり（画面の見出しに出す） */
  span: { from: string; to: string };
}

// ---- 台本の材料（threads.ts の Fork が使う） ----

export const vaultVariantSummary: TurnSummaryArgs = {
  span: { from: "14:02", to: "14:41" },
  request: {
    text: "Vault に「版」の仕組みを入れ、Project ごとに Infisical の環境（dev／prod）を選べるようにする。紐付けにだけ版を持つ形（案B）で、仕様を書いてから実装し、Fable にレビューさせる。",
    said: { text: "それでお願い", at: "14:02" },
  },
  outcome: {
    status: "done",
    headline: "実装して main と release に push しました。稼働中の banto にはまだ反映していません。",
    points: [
      "Project の設定の置き場ダイアログに「環境」の選択が出ます。選択肢には値の入った秘密の数が付きます。",
      "値が空の秘密は一覧に「空」と出て、渡すときは理由をつけて断ります。",
      "Fable のレビューを2回受け、指摘の5件はすべて直しました。",
    ],
    notVerified: ["本物の Infisical で環境の一覧を取れるか（偽のサーバでだけ確かめました）"],
    artifacts: [
      { label: "コミット", detail: "1a3dfb5e ほか2件" },
      { label: "仕様", detail: "docs/specs/v4-modules.md §2.1「グループの版」" },
    ],
  },
  decisions: [
    {
      question: "稼働中の banto に反映してよいですか？",
      context: "反映すると banto が起こし直され、動いている会話は区切りまで待ちます。",
      options: [
        {
          label: "反映して",
          reply: "稼働中の banto に反映して。AI が止まるまで待ってから起こし直して。",
          recommended: true,
        },
        { label: "あとで自分でやる", reply: "反映は自分でやるので、手順だけ教えて。" },
      ],
    },
    {
      question: "本物の Infisical での確かめをいまやりますか？",
      context: "Infisical の管理画面で dev の環境に試しの秘密を1つ置いてもらう必要があります。",
      options: [
        {
          label: "いまやる",
          reply: "本物の Infisical で環境の一覧を取れるか確かめて。試しの秘密は dev に置いておく。",
        },
        {
          label: "使うときでいい",
          reply: "本物の Infisical での確かめは、実際に使うときでいい。Backlog に積んでおいて。",
          recommended: true,
        },
      ],
    },
  ],
};

export const vaultVariantDeploySummary: TurnSummaryArgs = {
  span: { from: "14:52", to: "14:58" },
  request: {
    text: "Vault の「版」を稼働中の banto に反映する（AI が止まるまで待ってから起こし直す）。本物の Infisical での確かめは Backlog に積む。",
    said: { text: "稼働中の banto に反映して。AI が止まるまで…", at: "14:52" },
  },
  outcome: {
    status: "done",
    headline: "稼働中の banto を版 1a3dfb5e に上げました。起こし直したあとも Vault の一覧が出ることを確かめました。",
    points: [
      "待ったのは2分ほどで、途中で切れた会話はありません。",
      "本物の Infisical での確かめは Backlog に積みました。",
    ],
    artifacts: [{ label: "Backlog", detail: "Infisical の環境の一覧を本物で確かめる（準備できた）" }],
  },
  decisions: [],
  nextSuggestions: [
    { label: "この Fork を閉じる", reply: "ありがとう。この Fork はこれで終わりにする。" },
    { label: "積んだものもやる", reply: "Backlog に積んだ Infisical の確かめも、このまま続けてやって。" },
  ],
};

export const loginSummary: TurnSummaryArgs = {
  span: { from: "13:10", to: "13:34" },
  request: {
    text: "携帯で「端末を追加」の QR を読んだあと、パスキーの登録で止まる不具合を直す。",
    said: { text: "さっきのやつ直しておいて", at: "13:10" },
  },
  outcome: {
    status: "partial",
    headline: "原因は分かりました。直す方法が2つあり、どちらにするか決めてもらう必要があります。",
    points: [
      "足したばかりの端末にはパスキーが無いので、登録の前の本人確認が通りません。",
      "パソコンでは起きず、携帯の Safari と Chrome で再現しました。",
    ],
    notVerified: ["Android の Chrome は試していません（手元に端末が無いため）"],
  },
  decisions: [
    {
      question: "足したばかりの端末の本人確認をどう扱いますか？",
      context: "A は手間が増えず、B はより安全です。",
      options: [
        {
          label: "A：10分は確認済み",
          reply: "案A で。リンクで入った直後の10分は本人確認済みとして扱って。",
          recommended: true,
        },
        {
          label: "B：元の端末で許可",
          reply: "案B で。パスキーの登録は、元の端末で許可を押してからにして。",
        },
      ],
    },
  ],
};
