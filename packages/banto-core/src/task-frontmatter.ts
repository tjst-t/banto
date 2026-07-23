/**
 * Task frontmatter schema and validator.
 *
 * Parses YAML frontmatter + Markdown body from a task definition file
 * (work/tasks/<id>-<slug>.md) and validates the required fields per spec-schemas §1.
 *
 * D3: this module is READ-ONLY with respect to the file system. It never writes back.
 * D6: no third-party YAML library. The frontmatter is shallow enough (1-2 levels)
 *     to parse with a minimal hand-rolled parser.
 * I2: validation errors are surfaced as { ok: false, reason } — not swallowed.
 */

/** Parsed task frontmatter (required + optional fields) */
export interface TaskFrontmatter {
  /** task-NNNN */
  id: string;
  /** Must be "task" */
  type: "task";
  /** feature / fix / batch / refactor / conflict / improvement */
  kind: string;
  /** 1-line title */
  title: string;
  /** draft / queued / done / failed / superseded / cancelled */
  status: string;
  /** Glob patterns defining task scope (required) */
  scope: { paths: string[] };
  /** Acceptance criteria (required, at least one entry) */
  acceptance: Array<{ id: string; text: string; verify?: string }>;
  // Optional fields
  parent?: string;
  depends?: string[];
  refs?: string[];
  environment?: string;
  governance?: boolean;
  hypothesis?: Record<string, unknown>;
  model_tier?: "reasoning" | "standard" | "fast";
  [key: string]: unknown;
}

/** Validation result */
export type FrontmatterValidation =
  | { ok: true; frontmatter: TaskFrontmatter }
  | { ok: false; reason: string };

// ── Minimal YAML frontmatter parser ─────────────────────────────────────────
//
// Handles the subset actually used in task files:
//   - scalar values: strings and booleans
//   - inline arrays: [a, b, c]
//   - block arrays (items starting with "- ")
//   - nested objects (keys followed by child lines indented by 2 spaces)
//   - scope.paths sub-object
//   - acceptance list (block array of inline objects { id: x, text: y })
//
// Limitations (by design — D6):
//   - No multi-line strings
//   - No anchors/aliases
//   - No quoted scalar multi-word values beyond simple quote stripping

/**
 * Strip outer quotes from a scalar value string.
 * Handles 'value' and "value" but NOT nested quotes.
 */
function stripQuotes(s: string): string {
  s = s.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Split a string by commas, but ignore commas inside single or double quotes.
 * Used for inline objects and inline arrays that may contain quoted values with commas.
 */
function splitRespectingQuotes(s: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "," && !inSingle && !inDouble) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current || parts.length > 0) {
    parts.push(current);
  }
  return parts;
}

/**
 * Parse a YAML inline array: [item1, item2, ...]
 * Items are unquoted or single/double-quoted scalars.
 * Handles quoted values containing commas (e.g. ["option A, option B"]).
 */
function parseInlineArray(s: string): string[] {
  s = s.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) return [];
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  return splitRespectingQuotes(inner).map((item) => stripQuotes(item.trim()));
}

/**
 * Parse a YAML inline object: {key: value, key2: value2}
 * Used for acceptance criteria entries.
 * Handles quoted values that contain commas (e.g. text: "option A, option B").
 */
function parseInlineObject(s: string): Record<string, string> {
  s = s.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return {};
  const inner = s.slice(1, -1).trim();
  if (!inner) return {};
  const result: Record<string, string> = {};
  const parts = splitRespectingQuotes(inner);
  for (const part of parts) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue;
    const key = part.slice(0, colonIdx).trim();
    const value = stripQuotes(part.slice(colonIdx + 1).trim());
    result[key] = value;
  }
  return result;
}

/**
 * Parse scalar: "true" → true, "false" → false, else string.
 */
function parseScalar(s: string): string | boolean {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  return stripQuotes(t);
}

/**
 * Parse raw YAML frontmatter text (between --- delimiters) into a plain object.
 *
 * Returns a shallow Record<string, unknown> where:
 *   - scalar values are strings or booleans
 *   - inline arrays [a,b] are string[]
 *   - nested keys (indented) are Record<string, unknown>
 *   - block arrays (- item) are string[] or object[]
 */
export function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    // Determine indentation level
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;

    // Only process top-level keys (indent=0) in this pass
    if (indent > 0) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (!rest) {
      // Value is on subsequent lines (block mapping or block sequence)
      // Collect child lines (indent > 0)
      const childLines: string[] = [];
      i++;
      while (i < lines.length) {
        const childLine = lines[i];
        if (!childLine.trim()) {
          // blank line: might be end of block
          childLines.push(childLine);
          i++;
          continue;
        }
        const childIndent = childLine.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (childIndent === 0) break; // back to top-level
        childLines.push(childLine);
        i++;
      }
      // Determine type: block array or block mapping
      const firstMeaningful = childLines.find((l) => l.trim());
      if (firstMeaningful?.trimStart().startsWith("- ")) {
        // Block sequence
        result[key] = parseBlockSequence(childLines);
      } else {
        // Block mapping (nested object)
        result[key] = parseBlockMapping(childLines);
      }
    } else if (rest.startsWith("[")) {
      // Inline array
      result[key] = parseInlineArray(rest);
      i++;
    } else {
      // Scalar
      result[key] = parseScalar(rest);
      i++;
    }
  }

  return result;
}

/**
 * Parse a block sequence (list of "- item" lines).
 * Items may be inline scalars or inline objects {k:v}.
 */
function parseBlockSequence(lines: string[]): Array<string | Record<string, string>> {
  const items: Array<string | Record<string, string>> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    if (trimmed.startsWith("- ")) {
      const item = trimmed.slice(2).trim();
      if (item.startsWith("{")) {
        items.push(parseInlineObject(item));
      } else {
        items.push(stripQuotes(item));
      }
    }
    i++;
  }
  return items;
}

/**
 * Parse a block mapping (indented key:value pairs).
 * Handles nested block sequences (- item) and nested block mappings
 * as child values when a key has no inline value (rest is empty).
 */
function parseBlockMapping(lines: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  // Determine the base indentation of these lines (indent of first non-blank line)
  const firstMeaningful = lines.find((l) => l.trim());
  const baseIndent = firstMeaningful?.match(/^(\s*)/)?.[1]?.length ?? 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    // Only process lines at the base indentation level
    if (lineIndent !== baseIndent) {
      i++;
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (!rest) {
      // Value is on subsequent lines — collect child lines (indent > baseIndent)
      const childLines: string[] = [];
      i++;
      while (i < lines.length) {
        const childLine = lines[i];
        if (!childLine.trim()) {
          childLines.push(childLine);
          i++;
          continue;
        }
        const childIndent = childLine.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (childIndent <= baseIndent) break; // back to same or outer level
        childLines.push(childLine);
        i++;
      }
      // Determine type: block sequence or nested block mapping
      const firstChild = childLines.find((l) => l.trim());
      if (firstChild?.trimStart().startsWith("- ")) {
        obj[key] = parseBlockSequence(childLines);
      } else if (firstChild) {
        obj[key] = parseBlockMapping(childLines);
      }
      // (if no child lines, key is omitted — empty value)
    } else if (rest.startsWith("[")) {
      obj[key] = parseInlineArray(rest);
      i++;
    } else {
      obj[key] = parseScalar(rest);
      i++;
    }
  }
  return obj;
}

// ── Extract frontmatter from markdown file content ───────────────────────────

/**
 * Extract the YAML frontmatter from a markdown file.
 * Returns null if the file does not start with "---".
 */
export function extractFrontmatter(content: string): string | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const afterFirst = trimmed.slice(3);
  // Find the closing "---"
  const closeIdx = afterFirst.search(/^---\s*$/m);
  if (closeIdx === -1) return null;

  return afterFirst.slice(0, closeIdx);
}

// ── Validation ────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ["id", "type", "kind", "title", "status", "scope", "acceptance"] as const;

const VALID_KINDS = new Set(["feature", "fix", "batch", "refactor", "conflict", "improvement"]);

const VALID_STATUSES = new Set(["draft", "queued", "done", "failed", "superseded", "cancelled"]);

/**
 * Parse and validate the frontmatter of a task definition file.
 *
 * Returns { ok: true, frontmatter } on success.
 * Returns { ok: false, reason } on validation failure (I2: reason is descriptive).
 */
export function validateTaskFrontmatter(fileContent: string): FrontmatterValidation {
  const rawFm = extractFrontmatter(fileContent);
  if (rawFm === null) {
    return { ok: false, reason: "missing or malformed YAML frontmatter (must start with ---)" };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYamlFrontmatter(rawFm);
  } catch (err) {
    return { ok: false, reason: `frontmatter parse error: ${String(err)}` };
  }

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") {
      return { ok: false, reason: `missing required field: ${field}` };
    }
  }

  // Validate id
  const id = String(parsed["id"]);
  if (!/^task-\d{4,}$/.test(id)) {
    return { ok: false, reason: `invalid id format: must be task-NNNN (got "${id}")` };
  }

  // Validate type
  if (parsed["type"] !== "task") {
    return { ok: false, reason: `invalid type: must be "task" (got "${String(parsed["type"])}")` };
  }

  // Validate kind
  const kind = String(parsed["kind"]);
  if (!VALID_KINDS.has(kind)) {
    return {
      ok: false,
      reason: `invalid kind: "${kind}" (valid: ${Array.from(VALID_KINDS).join(", ")})`,
    };
  }

  // Validate status
  const status = String(parsed["status"]);
  if (!VALID_STATUSES.has(status)) {
    return {
      ok: false,
      reason: `invalid status: "${status}" (valid: ${Array.from(VALID_STATUSES).join(", ")})`,
    };
  }

  // Validate scope.paths
  const scope = parsed["scope"] as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== "object") {
    return { ok: false, reason: "missing required field: scope.paths" };
  }
  const paths = scope["paths"];
  if (!Array.isArray(paths) || paths.length === 0) {
    return {
      ok: false,
      reason: "missing required field: scope.paths (must be a non-empty array of glob strings)",
    };
  }
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) {
      return { ok: false, reason: "scope.paths must contain non-empty strings" };
    }
  }

  // Validate acceptance
  const acceptance = parsed["acceptance"];
  if (!Array.isArray(acceptance) || acceptance.length === 0) {
    return {
      ok: false,
      reason: "missing required field: acceptance (must be a non-empty array)",
    };
  }
  for (let idx = 0; idx < acceptance.length; idx++) {
    const item = acceptance[idx] as Record<string, unknown>;
    if (!item || typeof item !== "object") {
      return { ok: false, reason: `acceptance[${idx}] must be an object with id and text` };
    }
    if (typeof item["id"] !== "string" || !item["id"]) {
      return { ok: false, reason: `acceptance[${idx}] missing required field: id` };
    }
    if (typeof item["text"] !== "string" || !item["text"]) {
      return { ok: false, reason: `acceptance[${idx}] missing required field: text` };
    }
  }

  // Build validated frontmatter
  const frontmatter: TaskFrontmatter = {
    id,
    type: "task",
    kind,
    title: String(parsed["title"]),
    status,
    scope: { paths: paths as string[] },
    acceptance: (acceptance as Array<Record<string, string>>).map((a) => ({
      id: a["id"],
      text: a["text"],
      ...(a["verify"] ? { verify: a["verify"] } : {}),
    })),
  };

  // Copy optional fields
  if (parsed["parent"] !== undefined) frontmatter.parent = String(parsed["parent"]);
  if (Array.isArray(parsed["depends"])) frontmatter.depends = parsed["depends"] as string[];
  if (Array.isArray(parsed["refs"])) frontmatter.refs = parsed["refs"] as string[];
  if (parsed["environment"] !== undefined) frontmatter.environment = String(parsed["environment"]);
  if (typeof parsed["governance"] === "boolean") frontmatter.governance = parsed["governance"];
  if (parsed["hypothesis"] !== undefined && typeof parsed["hypothesis"] === "object") {
    frontmatter.hypothesis = parsed["hypothesis"] as Record<string, unknown>;
  }
  if (parsed["model_tier"] !== undefined) {
    const mt = String(parsed["model_tier"]);
    if (mt === "reasoning" || mt === "standard" || mt === "fast") {
      frontmatter.model_tier = mt;
    }
  }

  return { ok: true, frontmatter };
}
