/**
 * Regression tests for task-frontmatter parser fixes.
 *
 * Fix-2: parseBlockMapping now handles nested block sequences.
 *   scope.paths expressed as block sequence (- src/**) was silently parsed as
 *   an empty object, causing validateTaskFrontmatter to reject valid files.
 *
 * Fix-3: parseInlineObject uses splitRespectingQuotes instead of split(",").
 *   acceptance text containing commas inside quotes (e.g. text: "A, B") was
 *   split incorrectly, breaking acceptance[N].text.
 *
 * These tests call validateTaskFrontmatter directly (unit-level) to verify
 * parser behaviour without daemon setup overhead.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTaskFrontmatter } from "@banto/core";

// ── Helper ────────────────────────────────────────────────────────────────────

function makeTaskFm(overrides: string): string {
  return `---
id: task-0099
type: task
kind: feature
title: Parser regression test task
status: draft
${overrides}
---

Body.
`;
}

// ── Fix-2: block-sequence scope.paths ─────────────────────────────────────────

describe("[Fix-2] scope.paths in block-sequence format", () => {
  it("[Fix-2] scope.paths as block sequence is accepted and parsed correctly", () => {
    const content = makeTaskFm(`scope:
  paths:
    - src/**
    - tests/**
acceptance:
  - { id: a1, text: 確認 }`);

    const result = validateTaskFrontmatter(content);
    assert.ok(result.ok, `expected ok=true, got reason: ${result.ok ? "" : result.reason}`);
    assert.deepEqual(
      result.frontmatter.scope.paths,
      ["src/**", "tests/**"],
      "scope.paths must contain both glob patterns from block sequence"
    );
  });

  it("[Fix-2] scope.paths as block sequence with single entry is accepted", () => {
    const content = makeTaskFm(`scope:
  paths:
    - packages/**
acceptance:
  - { id: a1, text: 確認 }`);

    const result = validateTaskFrontmatter(content);
    assert.ok(result.ok, `expected ok=true, got reason: ${result.ok ? "" : result.reason}`);
    assert.deepEqual(
      result.frontmatter.scope.paths,
      ["packages/**"],
      "scope.paths must contain the single path from block sequence"
    );
  });

  it("[Fix-2] scope.paths as inline array still works (regression guard)", () => {
    const content = makeTaskFm(`scope:
  paths: [src/**, tests/**]
acceptance:
  - { id: a1, text: 確認 }`);

    const result = validateTaskFrontmatter(content);
    assert.ok(result.ok, `expected ok=true, got reason: ${result.ok ? "" : result.reason}`);
    assert.deepEqual(
      result.frontmatter.scope.paths,
      ["src/**", "tests/**"],
      "inline array scope.paths must still work"
    );
  });
});

// ── Fix-3: quoted comma in acceptance text ────────────────────────────────────

describe("[Fix-3] acceptance text with quoted commas", () => {
  it("[Fix-3] acceptance text containing a comma inside quotes is parsed correctly", () => {
    const content = makeTaskFm(`scope:
  paths: [src/**]
acceptance:
  - { id: a1, text: "option A, option B" }`);

    const result = validateTaskFrontmatter(content);
    assert.ok(result.ok, `expected ok=true, got reason: ${result.ok ? "" : result.reason}`);
    assert.equal(
      result.frontmatter.acceptance[0].text,
      "option A, option B",
      "acceptance text with comma inside quotes must be preserved as-is"
    );
  });

  it("[Fix-3] acceptance text with single-quoted commas is parsed correctly", () => {
    const content = makeTaskFm(`scope:
  paths: [src/**]
acceptance:
  - { id: a1, text: 'read, write, execute' }`);

    const result = validateTaskFrontmatter(content);
    assert.ok(result.ok, `expected ok=true, got reason: ${result.ok ? "" : result.reason}`);
    assert.equal(
      result.frontmatter.acceptance[0].text,
      "read, write, execute",
      "acceptance text with single-quoted commas must be preserved as-is"
    );
  });

  it("[Fix-3] acceptance with verify field containing comma is parsed correctly", () => {
    const content = makeTaskFm(`scope:
  paths: [src/**]
acceptance:
  - { id: a1, text: "動作確認", verify: "curl -s, jq ." }`);

    const result = validateTaskFrontmatter(content);
    assert.ok(result.ok, `expected ok=true, got reason: ${result.ok ? "" : result.reason}`);
    assert.equal(result.frontmatter.acceptance[0].text, "動作確認");
    assert.equal(result.frontmatter.acceptance[0].verify, "curl -s, jq .");
  });

  it("[Fix-3] multiple acceptance items without quoted commas still work (regression guard)", () => {
    const content = makeTaskFm(`scope:
  paths: [src/**]
acceptance:
  - { id: a1, text: 初回確認 }
  - { id: a2, text: 二回目確認 }`);

    const result = validateTaskFrontmatter(content);
    assert.ok(result.ok, `expected ok=true, got reason: ${result.ok ? "" : result.reason}`);
    assert.equal(result.frontmatter.acceptance.length, 2);
    assert.equal(result.frontmatter.acceptance[0].text, "初回確認");
    assert.equal(result.frontmatter.acceptance[1].text, "二回目確認");
  });
});
