// 公開サイト（site/）のスクリーンショットに写す場面の中身（追加・2026-10-14）。
//
// 個人開発の4つの Project と、その会話。AI は偽物（`fake-runner.ts`）で、人の発言の文面から指示を引く
// （`BANTO_FAKE_SCRIPT`、下の SCRIPT を JSON にして渡す——`playwright.config.ts`）。tool は本物を呼ぶので、
// `npm test` の出力などは Project のコンテナの中で実際に走らせたもの。
//
// 発言は、実際に開発者が書く普通の日本語にする。人名・メールアドレス・本物のトークンは書かない。
import type { FakePlan, FakeScriptEntry } from "../fake-runner.js";

/** Project の根に置くファイル（パス → 中身） */
export type Files = Record<string, string>;

export interface Turn {
  /** 人の発言（画面に出る）。SCRIPT の鍵でもある */
  prompt: string;
  plan: FakePlan;
}

// ---- 家計簿アプリ ----------------------------------------------------------------------------------

export const KAKEIBO = "家計簿アプリ";

export const KAKEIBO_FILES: Files = {
  "package.json": JSON.stringify(
    {
      name: "kakeibo",
      version: "0.3.2",
      private: true,
      type: "module",
      scripts: {
        dev: "node scripts/dev-server.js",
        test: "node --test --test-reporter=spec",
        e2e: "node scripts/e2e.js",
      },
    },
    null,
    2,
  ) + "\n",
  "src/csv.js": `// カード会社の明細 CSV を、家計簿の取引の形に直す

/** "2026/10/01" や "2026-10-01" を年・月・日に分ける（Date にしない——タイムゾーンで日付がずれる） */
export function parseDate(text) {
  const [year, month, day] = String(text).trim().split(/[/-]/).map(Number);
  return { year, month, day };
}

/** "1,280円" → 1280 */
export function parseAmount(text) {
  return Number(String(text).replace(/[,円\\s"]/g, ""));
}

/** 1行目はヘッダ。空行は読み飛ばす */
export function parseCsv(text) {
  return text
    .split(/\\r?\\n/)
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [date, shop, amount] = line.split(",");
      return { date: parseDate(date), shop: shop.trim(), amount: parseAmount(amount) };
    });
}
`,
  "src/category.js": `const RULES = [
  { category: "食費", words: ["セブン", "ローソン", "ファミリーマート", "スーパー"] },
  { category: "交通費", words: ["JR", "メトロ", "バス"] },
];

/** 店の名前から、家計簿のカテゴリを推定する */
export function guessCategory(shop) {
  return RULES.find((rule) => rule.words.some((w) => shop.includes(w)))?.category ?? "その他";
}
`,
  "src/budget.js": `/** カテゴリごとの合計 */
export function totalsByCategory(entries) {
  const totals = {};
  for (const { category, amount } of entries) totals[category] = (totals[category] ?? 0) + amount;
  return totals;
}

/** 予算の残り（使いすぎたらマイナス） */
export function remaining(budget, spent) {
  return budget - spent;
}
`,
  "test/csv.test.js": `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, parseCsv, parseDate } from "../src/csv.js";

describe("CSV の読み取り", () => {
  it("日付を年・月・日に分けて読む", () => {
    assert.deepEqual(parseDate("2026/10/01"), { year: 2026, month: 10, day: 1 });
  });
  it("日付の区切りがハイフンでも読める", () => {
    assert.deepEqual(parseDate("2026-10-31"), { year: 2026, month: 10, day: 31 });
  });
  it("月末の日付がずれない", () => {
    assert.equal(parseDate("2026/09/30").day, 30);
  });
  it("金額のカンマと「円」を取り除く", () => {
    assert.equal(parseAmount("1,280円"), 1280);
  });
  it("ヘッダ行は取引に含めない", () => {
    assert.equal(parseCsv("日付,店,金額\\n2026/10/01,ローソン,540").length, 1);
  });
  it("空行は読み飛ばす", () => {
    assert.equal(parseCsv("日付,店,金額\\n\\n2026/10/01,ローソン,540\\n\\n").length, 1);
  });
});
`,
  "test/category.test.js": `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guessCategory } from "../src/category.js";

describe("カテゴリの推定", () => {
  it("コンビニは食費に分ける", () => {
    assert.equal(guessCategory("セブン-イレブン 渋谷店"), "食費");
  });
  it("電車とバスは交通費に分ける", () => {
    assert.equal(guessCategory("JR東日本 モバイルSuica"), "交通費");
    assert.equal(guessCategory("都営バス"), "交通費");
  });
  it("知らない店はその他に分ける", () => {
    assert.equal(guessCategory("喫茶ひだまり"), "その他");
  });
});
`,
  "test/budget.test.js": `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { remaining, totalsByCategory } from "../src/budget.js";

describe("予算", () => {
  it("予算の残りを計算する", () => {
    assert.equal(remaining(30000, 12480), 17520);
  });
  it("使いすぎたら残りはマイナスになる", () => {
    assert.equal(remaining(10000, 12000), -2000);
  });
  it("カテゴリごとに合計する", () => {
    assert.deepEqual(
      totalsByCategory([
        { category: "食費", amount: 540 },
        { category: "食費", amount: 1280 },
        { category: "交通費", amount: 220 },
      ]),
      { 食費: 1820, 交通費: 220 },
    );
  });
});
`,
  "src/login/LoginForm.jsx": `export function LoginForm({ onSubmit }) {
  return (
    <form onSubmit={onSubmit} className="login-form">
      <label>
        メールアドレス
        <input type="email" name="email" autoComplete="username" required />
      </label>
      <label>
        パスワード
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      <button type="submit">ログイン</button>
    </form>
  );
}
`,
  "src/payment/README.md": "# 決済\n\nプレミアムプランの決済の試作を置く。\n",
  "scripts/dev-server.js": `import { createServer } from "node:http";

createServer((req, res) => res.end("kakeibo dev server")).listen(5173, () => {
  console.log("開発サーバを起動しました: http://localhost:5173/");
});
`,
  "scripts/e2e.js": `// ログイン画面の E2E（ブラウザで 12 件）
const cases = 12;
console.log(\`ログイン画面の E2E を始めます（\${cases} 件）\`);
let done = 0;
const timer = setInterval(() => {
  done += 1;
  console.log(\`\${done}/\${cases} 件目を確認しています\`);
  if (done === cases) clearInterval(timer);
}, 300_000);
`,
};

/**
 * Base Thread：テストを流し、通ったらタグを打って push する。テストの実行は人が許可した（`npm test` の結果が
 * 会話に残る）、push はいま人の判断を待っている
 */
export const KAKEIBO_RELEASE: Turn = {
  prompt: "リリース前にテストを全部流して、通ったら v0.4.0 のタグを打って main と一緒に push してください。",
  plan: {
    say: "テストを流します。",
    tools: [
      { server: "shell", name: "runCommand", args: { command: "npm test" } },
      {
        server: "shell",
        name: "runCommand",
        args: { command: "git tag v0.4.0 && git push origin main --tags" },
        say:
          "テストは 12 件すべて通りました。CSV の読み取りに足した日付のテスト（月末・ハイフン区切り）も通っています。\n\n" +
          "v0.4.0 のタグを打って、origin に push します。",
      },
    ],
    then: "v0.4.0 のタグを打って、main と一緒に push しました。",
  },
};

export const FORK_LOGIN = "ログイン画面の改修";
export const FORK_CSV = "CSV 取り込みの不具合";
export const FORK_PAY_A = "決済の比較（案A）";
export const FORK_PAY_B = "決済の比較（案B）";

export const LOGIN_BACKGROUND: Turn = {
  prompt: "ログイン画面を新しいデザインに合わせて直したいので、開発サーバを立ち上げて、ログイン画面の E2E を流しておいてください。",
  plan: {
    say: "開発サーバと E2E を待たずに流しておきます。",
    tools: [
      { server: "shell", name: "runCommand", args: { command: "npm run dev", runInBackground: true, label: "開発サーバ" } },
      { server: "shell", name: "runCommand", args: { command: "npm run e2e", runInBackground: true, label: "ログイン画面の E2E" } },
    ],
    then: "開発サーバ（http://localhost:5173/）とログイン画面の E2E を流しています。E2E が終わったら結果を確認します。",
  },
};

/** いま作業中のターン（tool の返事を長く待つ——サイドバーで回り続ける） */
export const LOGIN_WORKING: Turn = {
  prompt: "その間に、パスワードを表示・非表示にするボタンをフォームに足してください。",
  plan: {
    say: "パスワード欄に表示・非表示の切り替えボタンを足します。まず今のフォームを確認します。",
    tools: [{ server: "filesystem", name: "readFile", args: { path: "src/login/LoginForm.jsx" } }],
    toolDelayMs: 1_800_000,
  },
};

export const CSV_FIX: Turn = {
  prompt: "楽天カードの CSV を取り込むと、日付が1日ずれることがあります。原因を調べて直してください。",
  plan: {
    say: "日付の読み取りを確認します。",
    tools: [{ server: "shell", name: "runCommand", args: { command: 'grep -rn "new Date" src/ || echo "new Date は使っていません"' } }],
    then:
      "原因が分かりました。取り込み画面のプレビューで `new Date(\"2026/10/01\")` のように日付を Date に直しており、" +
      "保存するときに UTC に変換されて前日になっていました。\n\n" +
      "取り込み処理（`src/csv.js`）と同じく、年・月・日に分けたまま扱うように直す方針でよいか確認してください。" +
      "よければ修正とテストの追加まで進めます。",
  },
};

export const PAY_A: Turn = {
  prompt: "決済を Stripe で組む場合の手順と手数料をまとめて、試作を作ってください。",
  plan: {
    say: "Stripe で組む場合を調べて、試作を作ります。",
    tools: [
      {
        server: "filesystem",
        name: "writeFile",
        args: {
          path: "src/payment/stripe-checkout.js",
          content: `// 試作：Stripe Checkout でプレミアムプランを申し込む
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function createCheckoutSession(userId) {
  return stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_PREMIUM_PRICE_ID, quantity: 1 }],
    client_reference_id: userId,
    success_url: "http://localhost:5173/premium/thanks",
    cancel_url: "http://localhost:5173/premium",
  });
}
`,
        },
      },
    ],
    then: [
      "Stripe で組む場合をまとめました。",
      "",
      "| 項目 | Stripe |",
      "|---|---|",
      "| 手数料 | 国内カード 3.6% |",
      "| 初期費用・月額 | なし |",
      "| 決済画面 | Stripe Checkout（Stripe 側のページに移る） |",
      "| 定期課金 | Stripe Billing でそのまま組める |",
      "",
      "試作は `src/payment/stripe-checkout.js` に置きました。テスト用の鍵で動くので、`npm run dev` で開いて「プレミアムにする」から試せます。",
      "",
      "決済画面は Stripe 側のページに移るので、デザインは家計簿アプリと完全には揃えられません。案B と比べるときはこの点を見てください。",
    ].join("\n"),
  },
};

export const PAY_A_CANCEL: Turn = {
  prompt: "月の途中で解約したときはどうなりますか。日割りで返金されますか。",
  plan: {
    say: [
      "Stripe Billing の既定では、解約しても日割りの返金はありません。解約すると、支払い済みの期間の終わりまでプレミアムを使えて、次の請求が止まります（`cancel_at_period_end`）。",
      "",
      "すぐに止めて日割りで返したい場合は、解約のときに日割りの指定を付けて、差額を返金する処理を自分で書く必要があります。",
      "",
      "家計簿アプリは月ごとに使う人が多いので、期間の終わりまで使える形のほうが分かりやすいと思います。案B でも同じことができるかを確認してください。",
    ].join("\n"),
  },
};

/**
 * 案B：試作を作って、ターンの終わりのまとめ（report_turn）で「どちらで組むか」を人に聞く——受信箱の「決めることがあります」
 */
export const PAY_B: Turn = {
  prompt: "決済を PAY.JP で組む場合の手順と手数料をまとめて、試作を作ってください。",
  plan: {
    say: "PAY.JP で組む場合を調べて、試作を作ります。",
    tools: [
      {
        server: "filesystem",
        name: "writeFile",
        args: {
          path: "src/payment/payjp-checkout.js",
          content: `// 試作：PAY.JP の定期課金でプレミアムプランを申し込む
import Payjp from "payjp";

const payjp = Payjp(process.env.PAYJP_SECRET_KEY);

/** カードの入力欄（payjp.js）で作ったトークンから顧客を作り、月額のプランに申し込む */
export async function subscribePremium(userId, cardToken) {
  const customer = await payjp.customers.create({ card: cardToken, metadata: { userId } });
  return payjp.subscriptions.create({ customer: customer.id, plan: process.env.PAYJP_PREMIUM_PLAN_ID });
}
`,
        },
      },
      {
        server: "banto-thread",
        name: "report_turn",
        say: [
          "PAY.JP で組む場合をまとめました。",
          "",
          "| 項目 | PAY.JP |",
          "|---|---|",
          "| 手数料 | Visa・Mastercard 3.0%、JCB・American Express 3.3% |",
          "| 初期費用・月額 | なし |",
          "| 決済画面 | カードの入力欄を家計簿アプリの画面に埋め込める（payjp.js） |",
          "| 定期課金 | PAY.JP の定期課金でそのまま組める |",
          "",
          "試作は `src/payment/payjp-checkout.js` に置きました。案A（Stripe）と比べると、手数料が安く、決済画面を家計簿アプリのデザインに揃えられます。",
          "一方で、解約したときの扱いは案A ほど細かく決められません。",
        ].join("\n"),
        args: {
          request: "プレミアムプランの決済を PAY.JP で組む場合の手順と手数料を調べ、試作を作る（案A の Stripe と比べるため）",
          outcome: {
            status: "done",
            headline: "PAY.JP の試作を作りました。手数料は Stripe より安く、決済画面を家計簿アプリに揃えられます。",
            points: [
              "手数料は Visa・Mastercard で 3.0%（Stripe は 3.6%）",
              "カードの入力欄を家計簿アプリの画面に埋め込める",
              "月の途中の解約は、期間の終わりまで使える形にできる（Stripe と同じ）",
            ],
            notVerified: ["本番の審査にかかる日数", "試作は鍵を入れて動かしていない"],
            artifacts: [{ label: "試作", detail: "src/payment/payjp-checkout.js" }],
          },
          decisions: [
            {
              question: "プレミアムプランの決済は、どちらで組みますか？",
              context: "Stripe は決済画面が Stripe 側のページに移ります。PAY.JP は画面を揃えられ、手数料も安くなります。",
              options: [
                { label: "PAY.JP で組む", reply: "PAY.JP で組んでください。申し込みと決済の画面を作るところまで進めてください。", recommended: true },
                { label: "Stripe で組む", reply: "Stripe で組んでください。申し込みと決済の画面を作るところまで進めてください。" },
                { label: "審査の日数を調べてから", reply: "決める前に、両方の本番の審査にかかる日数を調べてください。" },
              ],
            },
          ],
        },
      },
    ],
  },
};

// ---- Backlog（家計簿アプリの仕事の一覧）---------------------------------------------------------------

const at = (day: string, time = "10:00") => `2026-${day}T${time}:00+09:00`;
const item = (
  number: number,
  id: string,
  kind: "story" | "task" | "bug",
  title: string,
  status: "backlog" | "ready" | "in-progress" | "done" | "dropped",
  more: Record<string, unknown> = {},
) => ({
  id,
  number,
  kind,
  title,
  status,
  parent: null,
  dependsOn: [],
  milestone: null,
  priority: "normal",
  labels: [],
  body: "",
  doneWhen: "",
  resolution: null,
  refs: [],
  threads: [],
  createdAt: at("10-01"),
  updatedAt: at("10-12"),
  closedAt: status === "done" || status === "dropped" ? at("10-10") : null,
  extra: {},
  ...more,
});

export const KAKEIBO_BACKLOG = {
  format: "banto-backlog/1",
  milestones: [
    { id: "v0-4", title: "v0.4 カード明細の取り込み", status: "open" },
    { id: "v0-5", title: "v0.5 プレミアムプラン", status: "open" },
  ],
  items: [
    item(1, "csv-import", "story", "カード明細の CSV を取り込む", "in-progress", {
      milestone: "v0-4",
      body: "カード会社の明細 CSV を読み込んで、家計簿の取引にする。まずは楽天カードと三井住友カード。",
      doneWhen: "2社の CSV を取り込んで、一覧で確かめてから保存できる",
    }),
    item(2, "csv-rakuten", "task", "楽天カードの CSV に対応する", "done", { parent: "csv-import", milestone: "v0-4" }),
    item(3, "csv-smbc", "task", "三井住友カードの CSV に対応する", "done", { parent: "csv-import", milestone: "v0-4" }),
    item(4, "csv-preview", "task", "取り込む前に一覧で確認できるようにする", "in-progress", { parent: "csv-import", milestone: "v0-4" }),
    item(5, "csv-duplicate", "task", "同じ明細を二重に取り込まない", "ready", {
      parent: "csv-import",
      milestone: "v0-4",
      dependsOn: ["csv-preview"],
    }),
    item(6, "csv-date-shift", "bug", "取り込むと日付が1日ずれることがある", "in-progress", {
      milestone: "v0-4",
      priority: "high",
      body: "楽天カードの明細で、プレビューの日付が前日になる。保存したものもずれている。",
    }),
    item(7, "login-redesign", "story", "ログイン画面を新しいデザインにする", "in-progress", { milestone: "v0-4" }),
    item(8, "login-password-toggle", "task", "パスワードの表示・非表示を切り替える", "in-progress", {
      parent: "login-redesign",
      milestone: "v0-4",
    }),
    item(9, "login-error-message", "task", "ログインに失敗したときの文言を直す", "ready", { parent: "login-redesign", milestone: "v0-4" }),
    item(10, "release-v0-4", "task", "v0.4.0 をリリースする", "ready", {
      milestone: "v0-4",
      dependsOn: ["csv-preview", "csv-date-shift"],
    }),
    item(11, "budget-rounding", "bug", "予算の残りが1円ずれる（端数の丸め）", "ready"),
    item(12, "graph-dark-mode", "bug", "ダークモードでグラフの目盛りが読めない", "backlog", { priority: "low" }),
    item(13, "payment", "story", "プレミアムプランの決済", "in-progress", { milestone: "v0-5" }),
    item(14, "payment-compare", "task", "決済サービスを比べる（Stripe と PAY.JP）", "in-progress", {
      parent: "payment",
      milestone: "v0-5",
    }),
    item(15, "payment-checkout", "task", "申し込みと決済の画面を作る", "backlog", {
      parent: "payment",
      milestone: "v0-5",
      dependsOn: ["payment-compare"],
    }),
    item(16, "export-pdf", "task", "月ごとのまとめを PDF で書き出す", "dropped", {
      resolution: "CSV の書き出しで足りると分かったので、やめる",
    }),
  ],
};

// ---- 社内ポータル -----------------------------------------------------------------------------------

export const PORTAL = "社内ポータル";

export const PORTAL_FILES: Files = {
  "package.json": JSON.stringify(
    { name: "intra-portal", version: "1.8.0", private: true, scripts: { deploy: "node scripts/deploy.js" } },
    null,
    2,
  ) + "\n",
  "scripts/deploy.js": 'console.log("デプロイ先:", process.argv.slice(2).join(" "));\n',
};

export const PORTAL_DEPLOY: Turn = {
  prompt: "お知らせ一覧にページ送りを付けたので、ステージングに反映してください。",
  plan: {
    say: "ステージングに反映します。",
    tools: [{ server: "shell", name: "runCommand", args: { command: "npm run deploy -- --env staging" } }],
    then: "ステージングに反映しました。",
  },
};

// ---- qemu-bmc ---------------------------------------------------------------------------------------

export const QEMU = "qemu-bmc";

export const QEMU_FILES: Files = {
  "go.mod": "module example.com/qemu-bmc\n\ngo 1.23\n",
  "scripts/integration-test.sh": `#!/bin/sh
# QEMU を起動して、IPMI のコマンドを一通り送る
echo "QEMU を起動しています（q35・2 vCPU・2 GiB）"
sleep 2
for t in "電源の状態を読む" "電源オン" "電源オフ（ACPI）" "電源オフ（強制）" "リセット" "起動デバイスを PXE にする" "センサーを読む" "SOL に繋ぐ"; do
  sleep 0.5
  echo "ok   $t"
done
echo "8 件中 8 件が通りました"
`,
};

export const QEMU_INTEGRATION: Turn = {
  prompt: "IPMI で電源オフを送っても、QEMU がすぐ止まらないことがあります。結合テストを流しつつ、原因を見てください。",
  plan: {
    say: "結合テストを待たずに流して、その間に電源まわりの処理を確認します。",
    tools: [
      {
        server: "shell",
        name: "runCommand",
        args: { command: "sh scripts/integration-test.sh", runInBackground: true, label: "結合テスト" },
      },
    ],
    then: "結合テストを流しています。終わったら結果と合わせて報告します。",
  },
};

/**
 * 結合テストが終わって届いたとき（banto が「コマンドが終わりました：結合テスト」を届ける）。原因と直し方の案を、まとめの
 * 「決めること」で人に聞く
 */
const QEMU_DELIVERED: FakePlan = {
  tools: [
    {
      server: "banto-thread",
      name: "report_turn",
      say:
        "結合テストは 8 件すべて通りました。\n\n" +
        "電源オフ（ACPI）は QMP の `system_powerdown` を送るだけなので、ACPI に応えないゲストではいつまでも止まりません。" +
        "UEFI の画面で止まっているときや、OS が起動しきる前に送ったときがこれに当たります。",
      args: {
        request: "IPMI で電源オフを送っても QEMU がすぐ止まらないことがある原因を、結合テストを流しながら調べる",
        outcome: {
          status: "done",
          headline: "原因が分かりました。ゲストが ACPI に応えないと、電源オフを送っても止まりません。",
          points: [
            "結合テストは 8 件すべて通った",
            "電源オフ（ACPI）は QMP の system_powerdown を送るだけで、ゲストが応えるまで待ち続ける",
            "UEFI の画面や起動の途中では、ゲストが応えない",
          ],
          notVerified: ["Windows のゲストでの動き"],
        },
        decisions: [
          {
            question: "ゲストが電源オフに応えないとき、どうしますか？",
            context: "本物のサーバの BMC も、ACPI の電源オフに応えなければ待ち続けます。強制的に止めるとゲストのディスクが壊れることがあります。",
            options: [
              { label: "30 秒待って強制的に止める", reply: "30 秒待っても止まらなければ、QMP の quit で強制的に止めるようにしてください。", recommended: true },
              { label: "待つ時間を設定で変えられるようにする", reply: "待つ時間を設定で変えられるようにして、既定は 30 秒にしてください。" },
              { label: "いまのままにする", reply: "本物の BMC と同じなので、いまのままにしてください。" },
            ],
          },
        ],
      },
    },
  ],
};

// ---- ブログ ------------------------------------------------------------------------------------------

export const BLOG = "ブログ";

export const BLOG_FILES: Files = {
  "package.json": JSON.stringify(
    { name: "blog", version: "2.1.0", private: true, scripts: { build: "node scripts/build.js" } },
    null,
    2,
  ) + "\n",
  "scripts/build.js": `setTimeout(() => console.log("記事 42 件をビルドしました（dist/）"), 2000);\n`,
  "drafts/incus-dev-env.md": `# Incus で開発環境を分ける

案件ごとに開発環境を分けたくて、Incus のコンテナを使うことにしました。Docker と違って、systemd がそのまま動くので、
普段の Linux と同じように使えます。

## 作り方

\`incus launch images:ubuntu/24.04 dev-kakeibo\` で作って、\`incus exec\` で入ります。
`,
};

export const BLOG_PROOFREAD: Turn = {
  prompt: "下書きの「Incus で開発環境を分ける」を読んで、誤字や分かりにくいところを教えてください。サイトのビルドも流しておいてください。",
  plan: {
    say: "下書きを読みます。",
    tools: [
      { server: "filesystem", name: "readFile", args: { path: "drafts/incus-dev-env.md" } },
      { server: "shell", name: "runCommand", args: { command: "npm run build", runInBackground: true, label: "サイトのビルド" } },
    ],
    then:
      "読みました。直したほうがよいところは2か所です。\n\n" +
      "1. 「Docker と違って、systemd がそのまま動くので」は、Docker でも動かせる方法があるので「Docker と違って、" +
      "何もしなくても systemd が動くので」のほうが正確です。\n" +
      "2. 「作り方」の節に、コンテナからホストのフォルダを見せる手順（`incus config device add`）があると親切です。\n\n" +
      "サイトのビルドは待たずに流しています。",
  },
};

/** ビルドが終わって届いたとき。決めることは無いので、まとめは「次に頼めること」を添える */
const BLOG_DELIVERED: FakePlan = {
  tools: [
    {
      server: "banto-thread",
      name: "report_turn",
      say: "サイトのビルドが通りました（記事 42 件）。",
      args: {
        request: "下書き「Incus で開発環境を分ける」の誤字や分かりにくいところを見つけ、サイトのビルドを流す",
        outcome: {
          status: "done",
          headline: "直したほうがよいところは2か所でした。サイトのビルドも通っています。",
          points: [
            "「systemd がそのまま動く」は、Docker でも動かす方法があるので言い方を変えたほうが正確",
            "ホストのフォルダをコンテナに見せる手順（incus config device add）が抜けている",
          ],
          notVerified: ["下書きの中のコマンドは実際に流していない"],
        },
        decisions: [],
        nextSuggestions: [
          { label: "2か所とも直して", reply: "指摘の2か所を下書きに反映してください。" },
          { label: "コマンドも流して確かめて", reply: "下書きの中のコマンドを実際に流して、書いてあるとおりに動くか確かめてください。" },
        ],
      },
    },
  ],
};

// ---- 偽の AI への対応表 -------------------------------------------------------------------------------

/** 人の発言（の一部）→ 指示。`playwright.config.ts` が JSON にして `BANTO_FAKE_SCRIPT` で渡す */
export const SCRIPT: FakeScriptEntry[] = [
  ...[KAKEIBO_RELEASE, LOGIN_BACKGROUND, LOGIN_WORKING, CSV_FIX, PAY_A, PAY_A_CANCEL, PAY_B, PORTAL_DEPLOY, QEMU_INTEGRATION, BLOG_PROOFREAD].map(
    (t) => ({ prompt: t.prompt, plan: t.plan }),
  ),
  // 待たずに流したコマンドが終わると、banto がその題（「コマンドが終わりました：<呼び名>」）で届けて AI を起こす
  { prompt: "コマンドが終わりました：結合テスト", plan: QEMU_DELIVERED },
  { prompt: "コマンドが終わりました：サイトのビルド", plan: BLOG_DELIVERED },
];
