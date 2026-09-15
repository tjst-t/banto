export * from "./visibility.js";
export * from "./agent-proxy.js";
export * from "./agent-relay-endpoint.js";
export * from "./health.js";
export * from "./host-relay-endpoint.js";
// **入れ子の中継で「誰のための呼び出しか」を運ぶ台帳**。本番（cli.ts）は必ず
// 渡している——試験も同じ形で繋げるように出しておく（省くと、本番には無い
// 「刻印が付かない」状態で試験することになる・2026-09-15）
export * from "./module-calls.js";
