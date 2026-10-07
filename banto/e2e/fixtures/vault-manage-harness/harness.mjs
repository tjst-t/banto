// **Vault の管理画面を、偽の host の中で開く**（2026-10-07）。版を名乗る Vault（Infisical の環境）は E2E で立てられない
// ——`vault` は同梱だけが名乗れる役割で（module-contract の RESERVED_ROLES）、外から足した試験用の Module では名乗れず、
// 開発用の Infisical は docker が要る。窓口・kit の側（`g@prod` の中継・置く先の空きの検査）は単体試験が押さえ、
// ここは**本物の画面の HTML と JS を本物の Chromium で**動かして、版の欄と渡す置き場を見る。
// host は MCP Apps の約束（postMessage の JSON-RPC）に答えるだけで、tool の呼び出しは window.__calls に記録する
export function harnessHtml() {
  return `<!doctype html><html><body style="margin:0;background:var(--bg)">
<iframe id="app" style="width:900px;height:640px;border:0"></iframe>
<script>
window.__calls = [];
window.__state = null;
window.__theme = "light";
const VARS = {
  light: { "--color-text-primary": "rgb(20, 20, 20)", "--color-background-primary": "rgb(255, 255, 255)", "--color-border-primary": "rgb(210, 210, 210)", "--color-text-info": "rgb(47, 111, 222)" },
  dark: { "--color-text-primary": "rgb(235, 235, 235)", "--color-background-primary": "rgb(28, 28, 30)", "--color-border-primary": "rgb(70, 70, 75)", "--color-text-info": "rgb(120, 160, 255)" },
};
window.__ctx = () => ({ theme: window.__theme, styles: { variables: VARS[window.__theme] }, "dev.banto/project": { id: "P", name: "Banto開発" } });
window.addEventListener("message", (e) => {
  const m = e.data; if (!m || m.jsonrpc !== "2.0" || m.id === undefined) return;
  const reply = (result) => e.source.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  const text = (v) => reply({ content: [{ type: "text", text: JSON.stringify(v) }] });
  if (m.method === "ui/initialize") return reply({ hostContext: window.__ctx() });
  if (m.method !== "tools/call") return reply({});
  const { name, arguments: args } = m.params;
  window.__calls.push({ name, args });
  const s = window.__state;
  if (name === "listVaults") return text(s.vaults.map((v) => v.implementation));
  if (name === "listAliases") return text({ aliases: s.aliases, failures: [] });
  if (name === "getPlacements") return text({ shared: s.shared, project: s.project, vaults: s.vaults });
  if (name === "countVariants") return text([]);
  if (name === "planProjectPlacement") return text({ moving: [], conflicts: [], sharedWith: [], strandedIfNotMigrated: [], blockedAcrossVaults: [] });
  return text({ ok: true });
});
window.__setTheme = (t) => {
  window.__theme = t;
  document.body.style.setProperty("--bg", t === "dark" ? "rgb(28, 28, 30)" : "rgb(255, 255, 255)");
  document.getElementById("app").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: window.__ctx() }, "*");
};
window.__open = (html, state) => { window.__state = state; document.getElementById("app").srcdoc = html; };
</script></body></html>`;
}

export const PROJECT_GROUP = "2ced47c4-d4dc-40f3-a6fe-7d2d86a07b89";
/** 版を名乗る Vault（Infisical の形）。この Project は homelab の prod に紐付いている */
export function variantState() {
  return {
    shared: { implementation: "vault-infisical", group: "instance" },
    project: { implementation: "vault-infisical", group: "homelab@prod", baseGroup: "homelab", variant: "prod" },
    vaults: [
      {
        implementation: "vault-infisical",
        groups: ["homelab", "instance", PROJECT_GROUP, "tools"],
        variantGroups: ["homelab@prod"],
        variants: { label: "環境", options: ["dev", "staging", "prod"], default: "dev" },
      },
      // 版を名乗らない Vault——版の欄は出さない
      { implementation: "vault-local", groups: ["instance", "local-a"], variantGroups: [], variants: null },
      // 版を読めなかった Vault——黙って「版が無い」にせず、理由を出す
      { implementation: "vault-broken", groups: ["b"], variantGroups: [], variants: null, variantsError: "接続できませんでした" },
    ],
    aliases: [
      { name: "HOST", kind: "secret", implementation: "vault-infisical", group: "homelab@prod", scope: "project", projects: ["P"] },
      { name: "CF_TOKEN", kind: "secret", implementation: "vault-infisical", group: "tools", scope: "unbound", projects: [] },
      { name: "OLD", kind: "secret", implementation: "vault-infisical", group: PROJECT_GROUP, scope: "unbound", projects: [] },
    ],
  };
}
