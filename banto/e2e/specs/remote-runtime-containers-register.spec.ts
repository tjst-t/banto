// **別のサーバの動かし方 containers の登録と断り**（Backlog #367、`docs/specs/v4-security.md` §1「別のサーバの中のコンテナ」の
// 「実行場所の種類」「root の要る準備は core が sudo -n で済ませる」）。相手は SSH で入れる入れ子のコンテナ（`ssh-host.ts`）——
// Incus も入っておらず、sudo もできない（本番の containers の VM ではない）。準備が本当に通ることは偽の Incus・偽の sudo の
// 単体試験（`containers-host.test.ts`）と、まっさらな VM で人が別に確かめる。
//
// 見るもの（規則14——押せたで終わらせず、画面が出している値と、本当にそうなったかまで）：
//   1. 登録の画面で動かし方（machine／containers）を選べ、選んだ方の注意が出る
//   2. 同じサーバの同じユーザーが machine で登録されていると、containers の「繋いで確かめる」は名指しして断る（画面に出る・
//      登録されない）。一覧の machine の行には動かし方が出る
//   3. machine を外すと、containers の前提の確かめまで進み、Incus が無い・sudo -n が通らないことと、打つコマンドを名指しする。
//      machine だけの項目（tmux・Docker・rsync・ユーザーの systemd）は出さず、linger は注意でなく断る。登録は押せない
//   4. 画面を通さず登録を頼んでも、host がもう一度確かめて断る（一覧に増えない）。相手には何かを変えた跡が無い（グループ・subuid・linger）
import { test, expect, type Locator } from "../test-base.js";
import { randomBytes } from "node:crypto";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";
import { withSshHost, type SshHost } from "../ssh-host.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台（sshd 入りのイメージ）を作る
test.setTimeout(900_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: { ...headers, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** 前提の一覧の、項目ごとの結果 */
async function checkStatuses(list: Locator): Promise<Record<string, string>> {
  const items = list.getByTestId("runtime-check");
  const out: Record<string, string> = {};
  for (let i = 0; i < (await items.count()); i++) {
    const item = items.nth(i);
    out[(await item.getAttribute("data-check"))!] = (await item.getAttribute("data-status"))!;
  }
  return out;
}

/** 相手の、変わっていてはいけないもの（banto が sudo で整えた跡が無いことを見る） */
async function untouched(host: SshHost): Promise<string> {
  return (
    await host.rootExec(
      `id -nG ${host.user}; grep -c '^root:' /etc/subuid /etc/subgid || true; ls /var/lib/systemd/linger 2>/dev/null || true`,
    )
  ).stdout;
}

test("containers を選んで登録する画面：machine と同じ宛先・sudo できない相手は名指しして断る", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const alias = `e2e-rc-${Date.now()}`;
  const machineName = `m-${randomBytes(3).toString("hex")}`;
  const containersName = `c-${randomBytes(3).toString("hex")}`;

  await withSshHost(
    async (host) => {
      const before = await untouched(host);

      // ---- 2 の下ごしらえ：同じ相手を machine で登録する（画面の登録は remote-runtime-registry.spec.ts で見ている） ----------
      const machine = { name: machineName, host: host.address, user: host.user, port: host.port, identity: alias, mode: "machine" };
      const scanned = await api<{ hostKey: { type: string; key: string } }>("/api/runtimes/scan", { method: "POST", body: machine });
      expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
      const registered = await api<{ mode: string }>("/api/runtimes", { method: "POST", body: { runtime: machine, hostKey: scanned.body.hostKey } });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      expect(registered.body.mode).toBe("machine");

      // ---- 1. 動かし方を選ぶ -------------------------------------------------------------------------------------
      await openApp(page);
      await page.goto("/settings?section=runtimes");
      const panel = page.getByTestId("runtimes-panel");
      const machineRow = panel.getByTestId(`runtime-${machineName}`);
      await expect(machineRow.getByTestId("runtime-mode")).toHaveText("サーバ丸ごと（machine）", { timeout: 30_000 });
      await expect(machineRow.getByTestId("runtime-mode")).toHaveAttribute("data-mode", "machine");

      await panel.getByTestId("runtime-add").click();
      const form = panel.getByTestId("runtime-add-form");
      await expect(form.getByTestId("runtime-mode-machine")).toHaveAttribute("aria-checked", "true");
      await expect(form.getByTestId("runtime-mode-containers")).toHaveAttribute("aria-checked", "false");
      await expect(form.getByTestId("runtime-cautions")).toContainText("1つのサーバで動かせる Project は1つです");
      await expect(form.getByTestId("runtime-cautions-containers")).toHaveCount(0);
      await form.getByTestId("runtime-mode-containers").click();
      await expect(form.getByTestId("runtime-mode-containers")).toHaveAttribute("aria-checked", "true");
      await expect(form.getByTestId("runtime-mode-machine")).toHaveAttribute("aria-checked", "false");
      const cautions = form.getByTestId("runtime-cautions-containers");
      await expect(cautions).toContainText("banto が sudo -n で root の要る準備");
      await expect(cautions).toContainText("サーバは banto 専用にしてください");
      await expect(cautions).toContainText("サーバ丸ごと（machine）と並べて登録できません");
      // Module はコンテナの中で起きる（#368）。道と移すことはまだ無い
      await expect(cautions).toContainText("Module はその Project のコンテナの中で動きます");
      await expect(cautions).toContainText("ここへ・ここから移すことは、まだ作っていません");
      await expect(cautions).not.toContainText("コンテナで Module を起こすところはまだ作っていません");
      await expect(form.getByTestId("runtime-cautions")).toHaveCount(0);
      await expect(form.getByText("banto 専用のユーザー（パスワード無しで sudo できること）")).toBeVisible();

      await form.getByLabel("名前").fill(containersName);
      await form.getByLabel("ホスト").fill(host.address);
      await form.getByLabel("ユーザー").fill(host.user);
      await form.getByTestId("runtime-identity-select").click();
      await page.getByRole("option", { name: new RegExp(`^${alias}\\s*（`) }).click();
      await expect(form.getByTestId("runtime-identity-select")).toContainText(alias);

      // ---- 2. machine と同じ宛先は断る ------------------------------------------------------------------------------
      await form.getByTestId("runtime-connect").click();
      await expect(form.getByTestId("runtime-host-key-step")).toBeVisible({ timeout: 60_000 });
      await form.getByTestId("runtime-trust").click();
      const mixed = form.getByTestId("runtime-add-error");
      await expect(mixed).toContainText(`実行場所「${machineName}」として サーバ丸ごと（machine） で登録されています`, { timeout: 60_000 });
      await expect(mixed).toContainText(`同じサーバの同じユーザー（${host.user}）`);
      await expect(form.getByTestId("runtime-add-checks")).toHaveCount(0);
      // host も断る（画面を通さずに頼んでも）
      const containers = { ...machine, name: containersName, mode: "containers" };
      const direct = await api<{ code?: string; error: string }>("/api/runtimes", {
        method: "POST",
        body: { runtime: containers, hostKey: scanned.body.hostKey },
      });
      expect(direct.status, JSON.stringify(direct.body)).toBe(409);
      expect(direct.body.code).toBe("mixed-modes");

      // ---- 3. machine を外すと前提の確かめまで進み、足りないものを名指しする ----------------------------------------------
      expect((await api(`/api/runtimes/${machineName}`, { method: "DELETE" })).status).toBe(200);
      await form.getByTestId("runtime-trust").click();
      const addChecks = form.getByTestId("runtime-add-checks");
      await expect(addChecks).toBeVisible({ timeout: 90_000 });
      expect(await checkStatuses(addChecks)).toEqual({
        platform: "ok",
        "silent-login": "ok",
        tools: "ok",
        "data-root": "ok",
        sshd: "ok",
        incus: "fail",
        "incus-project": "fail",
        "user-manager": "ok",
        "incus-proxy": "fail",
        "incus-idmap": "fail",
        "incus-pool": "fail",
        linger: "fail",
        // 入れ子の KVM は表示だけ——仮想化（KVM）を許していない実行場所では ok（#458）
        "nested-kvm": "ok",
        sudo: "fail",
      });
      await expect(addChecks.locator('[data-check="incus"]')).toContainText("Incus が入っていません。");
      await expect(addChecks.locator('[data-check="linger"]')).toContainText(`sudo loginctl enable-linger ${host.user}`);
      await expect(addChecks.locator('[data-check="incus-proxy"]')).toContainText(
        `sudo incus project set user-${host.uid} restricted.devices.proxy=allow`,
      );
      await expect(addChecks.locator('[data-check="incus-idmap"]')).toContainText(`sudo usermod --add-subuids ${host.uid}-${host.uid} root`);
      await expect(addChecks.locator('[data-check="incus-idmap"]')).toContainText("sudo -n が通らないので、banto は整えられません");
      await expect(addChecks.locator('[data-check="sudo"]')).toContainText(`${host.user} は sudo -n できません`);
      await expect(form.getByTestId("runtime-add-blocked")).toBeVisible();
      await expect(form.getByTestId("runtime-add-prepare")).toHaveCount(0);
      await expect(form.getByTestId("runtime-register")).toBeDisabled();
      // sudo -n が通らないので banto が整えるものは無い——ただの「登録する」（押せない）
      await expect(form.getByTestId("runtime-register")).toHaveText("登録する");

      // ---- 4. 画面を通さず登録を頼んでも断る。相手は何も変わっていない ------------------------------------------------------
      const refused = await api<{ error: string; checks?: Array<{ id: string; status: string }> }>("/api/runtimes", {
        method: "POST",
        body: { runtime: containers, hostKey: scanned.body.hostKey },
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error).toContain("足りない前提があるので登録できません");
      expect(refused.body.checks?.find((c) => c.id === "sudo")?.status).toBe("fail");
      const list = await api<{ runtimes: Array<{ name: string }> }>("/api/runtimes");
      expect(list.body.runtimes.map((r) => r.name)).not.toContain(containersName);
      expect(list.body.runtimes.map((r) => r.name)).not.toContain(machineName);
      expect(await untouched(host)).toBe(before);
      expect(pageErrors).toEqual([]);
    },
    { vaultAlias: alias },
  );
});
