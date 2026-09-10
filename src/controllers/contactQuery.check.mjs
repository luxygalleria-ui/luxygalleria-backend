// Self-check for the contact list filter logic.
// Run: node src/controllers/contactQuery.check.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Pull the two pure helpers out of the controller so the check needs no DB.
const src = readFileSync(new URL("./contactController.ts", import.meta.url), "utf8");
const from = src.indexOf("/** Escape regex");
const to = src.indexOf("// @desc    Get all contacts");
const { buildContactQuery, escapeRegex } = await import(
  "data:text/javascript," +
  encodeURIComponent(
    ts.transpileModule(
      "const CONTACT_STATUSES = ['NEW','READ','RESOLVED'];\n" + src.slice(from, to),
      { compilerOptions: { target: "es2022" } }
    ).outputText
  )
);

// No filters -> match everything.
assert.deepEqual(buildContactQuery(undefined, undefined), { ok: true, query: {} });
assert.deepEqual(buildContactQuery("ALL", ""), { ok: true, query: {} });

// Status filter is case-insensitive and constrains the query.
assert.deepEqual(buildContactQuery("new"), { ok: true, query: { status: "NEW" } });
assert.deepEqual(buildContactQuery("RESOLVED"), { ok: true, query: { status: "RESOLVED" } });

// An unknown status is rejected rather than silently ignored.
const bad = buildContactQuery("DELETED");
assert.equal(bad.ok, false);
assert.match(bad.message, /NEW, READ, RESOLVED/);

// Search spans the four text fields.
const s = buildContactQuery(undefined, "acme");
assert.equal(s.ok, true);
assert.deepEqual(s.query.$or.map((c) => Object.keys(c)[0]), ["name", "email", "subject", "message"]);
assert.deepEqual(s.query.$or[0].name, { $regex: "acme", $options: "i" });

// Regex metacharacters are escaped, so this is a literal search, not a pattern.
assert.equal(escapeRegex("a+b"), "a\\+b");
assert.equal(escapeRegex(".*"), "\\.\\*");
assert.doesNotThrow(() => new RegExp(escapeRegex("(unclosed[")));
assert.ok(new RegExp(escapeRegex("a+b"), "i").test("a+b"));
assert.ok(!new RegExp(escapeRegex("a+b"), "i").test("aab"));

// Status and search combine.
const both = buildContactQuery("NEW", "acme");
assert.equal(both.query.status, "NEW");
assert.equal(both.query.$or.length, 4);

console.log("contactQuery: all checks passed");
