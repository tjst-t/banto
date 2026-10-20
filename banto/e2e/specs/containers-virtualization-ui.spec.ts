// **仮想化の実験の画面**（Backlog 462 番、`docs/specs/v4-security.md` §1「`containers` で仮想化の実験——/dev/kvm と特権」の 1.・2.・4.）。
//
// 相手の作り方：仮想化を許した `containers` の実行場所は、Incus と sudo -n が通るサーバが無いと作れない（E2E の SSH の相手
// `ssh-host.ts` には Incus も sudo も無い——`remote-runtime-containers-register.spec.ts`）。そこで **host の返事を `page.route` で
// 差し替える**：差し替えないときの本物の返事（この機械の Project は「使えない」）で節が出ないことを見てから、使える返事に替えて
// 画面を見る。画面が送った中身（打った名前・モジュールの名前・Docker も入れたか）は、差し替えた口で受けて1つずつ確かめる。
// core の側（区画・装置・hugepages・特権の切り替えと断り）は偽の Incus・偽の sudo の単体試験（`containers-virt.test.ts`）が見る。
//
// 見るもの（規則14——押せたで終わらせず、画面が出している値と、送った中身まで）：
//   1. 許していない（本物の返事：この機械の Project）では「仮想化の実験」の節が出ない
//   2. 許すと3つ（/dev/kvm・hugepages・特権）が出て、仕様の警告の文言と「このサーバには特権の Project があります（名前）」が出る
//   3. /dev/kvm：形の違う名前は止める・br_netfilter で注意・「中で Docker を使う」が切れていれば小窓で聞き、両方を送る
//   4. hugepages：断られたら理由、通れば確保できた数
//   5. 特権：小窓の警告・止めて起こし直すこと。名前を打たないと押せない（違う名前でも押せない）。押すと打った名前を送り、
//      設定に「特権コンテナです」、サイドバーの行に印
//   6. 実行場所の「仮想化の実験を許す」：説明の文言・断られたら残っている Project の名前・許すとスイッチが入る
import { test, expect, type Page, type Route } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT = `E2E 仮想化 ${Date.now().toString(36)}`;

interface Virt {
  kvm: boolean;
  modules: string[];
  hugepages: number;
  privileged: boolean;
  available: boolean;
  reason?: string;
  privilegedOnServer: Array<{ id: string; name: string }>;
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function openGeneral(page: Page, projectId: string): Promise<void> {
  const loaded = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${projectId}/container`) && r.request().method() === "GET");
  await page.goto(`/settings?project=${projectId}&section=project-general`);
  await expect(page.getByTestId("project-general-panel")).toBeVisible({ timeout: 30_000 });
  await loaded;
}

test("仮想化の実験：許していなければ出ず、許すと3つが出て、特権は名前を打たないと押せない", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const project = (await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: PROJECT, root: mkdtempSync(join(tmpdir(), "banto-e2e-virt-")) },
    })
  ).json()) as { id: string };
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });

  // ---- 1. 本物の返事：この機械の Project は使えない → 節は出ない ----------------------------------------------------------
  const real = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/container`, { headers })).json()) as {
    virtualization: Virt | null;
  };
  expect(real.virtualization, "host が仮想化の様子を返していない").not.toBeNull();
  expect(real.virtualization!.available).toBe(false);
  expect(real.virtualization!.reason).toContain("containers");

  await openApp(page);
  await openGeneral(page, project.id);
  await expect(page.getByTestId("project-runtime")).toBeVisible();
  await expect(page.getByTestId("project-virtualization")).toHaveCount(0);
  await expect(page.getByTestId("project-virt-privileged-on-server")).toHaveCount(0);

  // ---- 2. 許した実行場所の返事に差し替える --------------------------------------------------------------------------------
  const state: { virt: Virt; nesting: boolean } = {
    virt: {
      kvm: false,
      modules: [],
      hugepages: 0,
      privileged: false,
      available: true,
      privilegedOnServer: [{ id: "other", name: "ほかの実験" }],
    },
    nesting: false,
  };
  const sent: Record<string, unknown[]> = { kvm: [], nesting: [], hugepages: [], privileged: [] };
  let hugepagesRefuse = true;
  await page.route(`**/api/projects/${project.id}/container`, async (route) => {
    if (route.request().method() === "PUT") {
      sent.nesting!.push(route.request().postDataJSON());
      state.nesting = true;
      return json(route, 200, { ok: true, nesting: true, released: [] });
    }
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    return json(route, 200, { ...body, nesting: state.nesting, virtualization: state.virt });
  });
  await page.route(`**/api/projects/${project.id}/container/kvm`, async (route) => {
    const body = route.request().postDataJSON() as { enabled: boolean; modules: string[] };
    sent.kvm!.push(body);
    state.virt = { ...state.virt, kvm: body.enabled, modules: body.modules };
    return json(route, 200, {
      warnings: ["br_netfilter はサーバのブリッジ全部に効きます（host の注意）"],
      ran: [],
      kvm: body.enabled,
      modules: body.modules,
      nesting: state.nesting,
    });
  });
  await page.route(`**/api/projects/${project.id}/container/hugepages`, async (route) => {
    const body = route.request().postDataJSON() as { count: number };
    sent.hugepages!.push(body);
    if (hugepagesRefuse) {
      return json(route, 409, { error: "hugepages の合計（2048 個＝4096 MiB）がサーバのメモリの半分を越えます", code: "hugepages-too-many" });
    }
    state.virt = { ...state.virt, hugepages: body.count };
    return json(route, 200, { warnings: ["hugepages は 4 個頼みましたが、確保できたのは 3 個です"], ran: [], hugepages: body.count, total: 4, allocated: 3 });
  });
  await page.route(`**/api/projects/${project.id}/container/privileged`, async (route) => {
    const body = route.request().postDataJSON() as { enabled: boolean; confirmName: string };
    sent.privileged!.push(body);
    state.virt = { ...state.virt, privileged: body.enabled };
    return json(route, 200, { warnings: [], ran: [], privileged: body.enabled, released: [] });
  });
  // サイドバーの印の元（host の Project の一覧の `privileged`）。本物の一覧に、差し替えた状態を重ねる
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const list = (await (await route.fetch()).json()) as Array<Record<string, unknown>>;
    return json(
      route,
      200,
      list.map((p) => (p.id === project.id && state.virt.privileged ? { ...p, privileged: true } : p)),
    );
  });

  await openGeneral(page, project.id);
  const section = page.getByTestId("project-virtualization");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByRole("heading", { name: "仮想化の実験" })).toBeVisible();
  await expect(page.getByTestId("project-virt-privileged-on-server")).toContainText("このサーバには特権の Project があります（ほかの実験）");
  const kvm = section.getByTestId("project-virt-kvm");
  const huge = section.getByTestId("project-virt-hugepages");
  const priv = section.getByTestId("project-virt-privileged");
  await expect(kvm).toBeVisible();
  await expect(huge).toBeVisible();
  await expect(priv).toBeVisible();
  await expect(kvm.getByTestId("project-virt-kvm-warning")).toHaveText(
    "この Project の AI はサーバのカーネルの KVM と vhost-net を直に使います。同じサーバのほかの Project を守るのは、" +
      "カーネルのこの部分の堅さだけになります。読み込んだモジュールはサーバ全体に効きます。",
  );
  // 3つとも既定はオフ
  await expect(kvm.getByTestId("project-virt-kvm-switch")).toHaveAttribute("aria-checked", "false");
  await expect(huge.getByTestId("project-virt-hugepages-count")).toHaveValue("0");
  await expect(priv.getByTestId("project-virt-privileged-on")).toHaveCount(0);

  // ---- 3. /dev/kvm ------------------------------------------------------------------------------------------------------
  const modules = kvm.getByTestId("project-virt-kvm-modules");
  await modules.fill("vxlan ../x");
  await expect(kvm.getByTestId("project-virt-kvm-modules-invalid")).toContainText("../x");
  await expect(kvm.getByTestId("project-virt-kvm-switch")).toBeDisabled();
  await modules.fill("vxlan br-netfilter");
  await expect(kvm.getByTestId("project-virt-kvm-modules-invalid")).toHaveCount(0);
  await expect(kvm.getByTestId("project-virt-br-netfilter")).toContainText("サーバのブリッジ全部の通り方を変えます");
  await kvm.getByTestId("project-virt-kvm-switch").click();
  // 「中で Docker を使う」が切れている → 一緒に入れるか聞く。押す前は何も送らない
  const nestingDialog = page.getByTestId("project-virt-nesting-dialog");
  await expect(nestingDialog).toContainText("「中で Docker を使う」も入れますか");
  expect(sent.kvm).toEqual([]);
  await nestingDialog.getByTestId("project-virt-nesting-yes").click();
  await expect(nestingDialog).toHaveCount(0);
  // 成功したときにだけ出るもの（host の注意）を待ってから、スイッチと送った中身を見る
  await expect(kvm.getByTestId("project-virt-kvm-result-warning")).toHaveText("br_netfilter はサーバのブリッジ全部に効きます（host の注意）");
  await expect(kvm.getByTestId("project-virt-kvm-switch")).toHaveAttribute("aria-checked", "true");
  expect(sent.kvm).toEqual([{ enabled: true, modules: ["vxlan", "br-netfilter"] }]);
  expect(sent.nesting).toEqual([{ nesting: true }]);
  // オンのまま名前を変えると「保存」が出る
  await modules.fill("vxlan");
  await kvm.getByTestId("project-virt-kvm-modules-save").click();
  await expect.poll(() => sent.kvm!.length).toBe(2);
  expect(sent.kvm![1]).toEqual({ enabled: true, modules: ["vxlan"] });
  await expect(kvm.getByTestId("project-virt-kvm-modules-save")).toHaveCount(0);

  // ---- 4. hugepages ----------------------------------------------------------------------------------------------------
  const count = huge.getByTestId("project-virt-hugepages-count");
  await count.fill("2048");
  await huge.getByTestId("project-virt-hugepages-save").click();
  await expect(huge.getByTestId("project-virt-hugepages-error")).toHaveText("hugepages の合計（2048 個＝4096 MiB）がサーバのメモリの半分を越えます");
  await expect(huge.getByTestId("project-virt-hugepages-result")).toHaveCount(0);
  hugepagesRefuse = false;
  await count.fill("4");
  await huge.getByTestId("project-virt-hugepages-save").click();
  await expect(huge.getByTestId("project-virt-hugepages-result")).toHaveText("このサーバで確保できたのは 3 個です（この実行場所の合計 4 個）");
  await expect(huge.getByTestId("project-virt-hugepages-error")).toHaveCount(0);
  await expect(count).toHaveValue("4");
  expect(sent.hugepages).toEqual([{ count: 2048 }, { count: 4 }]);

  // ---- 5. 特権：名前を打たないと押せない -------------------------------------------------------------------------------------
  await expect(page.getByTestId("sidebar-project-privileged")).toHaveCount(0);
  await priv.getByTestId("project-virt-privileged-open").click();
  const dialog = page.getByTestId("project-virt-privileged-dialog");
  await expect(dialog.getByTestId("project-virt-privileged-warning")).toHaveText(
    "この Project の AI はこのサーバの root になれます。同じサーバの全 Project が動かす banto のコードと土台のイメージを" +
      "書き換えられ、ほかの Project のコンテナの中身（合言葉・Claude のログイン・環境変数）と鍵の窓口・トンネルのソケットにも届きます。",
  );
  await expect(dialog).toContainText("コンテナを止めて、特権で起こし直します");
  const submit = dialog.getByTestId("project-virt-privileged-submit");
  await expect(submit).toBeDisabled();
  await dialog.getByTestId("project-virt-privileged-confirm").fill(PROJECT.slice(0, -1));
  await expect(submit).toBeDisabled();
  await dialog.getByTestId("project-virt-privileged-confirm").fill(`${PROJECT} `);
  await expect(submit).toBeDisabled();
  expect(sent.privileged).toEqual([]);
  await dialog.getByTestId("project-virt-privileged-confirm").fill(PROJECT);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(priv.getByTestId("project-virt-privileged-on")).toHaveText("特権コンテナです");
  expect(sent.privileged).toEqual([{ enabled: true, confirmName: PROJECT }]);
  // サイドバーの行の印（この Project だけ）
  const row = page.locator("li", { has: page.getByTestId("sidebar-project-name").filter({ hasText: PROJECT }) }).first();
  await expect(row.getByTestId("sidebar-project-privileged")).toBeVisible({ timeout: 15_000 });
  await expect(row.getByTestId("sidebar-project-privileged")).toHaveAttribute("aria-label", `${PROJECT} は特権コンテナです`);
  await expect(page.getByTestId("sidebar-project-privileged")).toHaveCount(1);
  // やめるときも名前を打たせる
  await priv.getByTestId("project-virt-privileged-open").click();
  await expect(dialog).toContainText("特権無しで起こし直します");
  await expect(dialog.getByTestId("project-virt-privileged-warning")).toHaveCount(0);
  await expect(dialog.getByTestId("project-virt-privileged-submit")).toBeDisabled();
  await dialog.getByRole("button", { name: "やめる" }).click();
  expect(sent.privileged).toHaveLength(1);

  // ---- 6. 実行場所の「仮想化の実験を許す」 ------------------------------------------------------------------------------------
  const rt = {
    name: "virt-e2e",
    host: "192.0.2.10",
    user: "banto",
    port: 22,
    identity: "e2e-virt",
    dataRoot: "~/.local/share/banto-remote",
    mode: "containers",
    runtime: "remote:virt-e2e",
    hostKey: { type: "ssh-ed25519", key: "AAAA", fingerprint: "SHA256:e2e", confirmedAt: new Date().toISOString() },
    checks: [{ id: "nested-kvm", label: "入れ子の KVM", status: "ok" }],
    checkedAt: new Date().toISOString(),
    usedBy: [],
  };
  let allowed = true;
  const allowSent: unknown[] = [];
  await page.route("**/api/runtimes", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return json(route, 200, { runtimes: [{ ...rt, ...(allowed ? { virtualization: true } : {}) }] });
  });
  await page.route("**/api/runtimes/virt-e2e/virtualization", async (route) => {
    const body = route.request().postDataJSON() as { allowed: boolean };
    allowSent.push(body);
    if (!body.allowed) {
      return json(route, 409, {
        error: `実行場所「virt-e2e」の仮想化の実験を止められません——まだ使っている Project があります（閉じたもの・眠っているものも含む）：「${PROJECT}」（/dev/kvm）`,
        code: "virtualization-in-use",
      });
    }
    allowed = true;
    return json(route, 200, { warnings: [], ran: [], runtime: { ...rt, virtualization: true } });
  });
  await page.goto("/settings?section=runtimes");
  const rtRow = page.getByTestId("runtime-virt-e2e");
  await rtRow.getByRole("button").first().click();
  const virt = rtRow.getByTestId("runtime-virtualization");
  await expect(virt).toContainText("仮想化の実験を許す");
  await expect(virt).toContainText("このサーバの Project に /dev/kvm や特権を与えられるようにします。どれに与えるかは Project ごとに選びます。");
  await expect(rtRow.locator('[data-check="nested-kvm"]')).toContainText("入れ子の KVM");
  const sw = virt.getByTestId("runtime-virtualization-switch");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(virt.getByTestId("runtime-virtualization-error")).toContainText(`まだ使っている Project があります`);
  await expect(virt.getByTestId("runtime-virtualization-error")).toContainText(`「${PROJECT}」（/dev/kvm）`);
  await expect(sw).toHaveAttribute("aria-checked", "true");
  allowed = false;
  // 読み直すと切れている → 許す
  await page.reload();
  await rtRow.getByRole("button").first().click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(virt.getByTestId("runtime-virtualization-error")).toHaveCount(0);
  expect(allowSent).toEqual([{ allowed: false }, { allowed: true }]);

  expect(pageErrors).toEqual([]);
});
