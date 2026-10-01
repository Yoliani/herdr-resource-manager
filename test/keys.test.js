import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../lib/keys.js";

test("coalesced printable keys split into single tokens", () => {
  assert.deepEqual(tokenize("gjjj"), { tokens: ["g", "j", "j", "j"], pending: null });
});

test("escape sequences stay whole", () => {
  assert.deepEqual(tokenize("\x1b[A"), { tokens: ["\x1b[A"], pending: null });
  assert.deepEqual(tokenize("\x1b[B\x1b[C"), { tokens: ["\x1b[B", "\x1b[C"], pending: null });
});

test("SS3 arrow keys stay whole", () => {
  assert.deepEqual(tokenize("\x1bOA"), { tokens: ["\x1bOA"], pending: null });
});

test("mixed printable and escape sequences", () => {
  assert.deepEqual(tokenize("j\x1b[Aq"), { tokens: ["j", "\x1b[A", "q"], pending: null });
});

test("incomplete escape sequences are held back as pending", () => {
  assert.deepEqual(tokenize("\x1b"), { tokens: [], pending: "\x1b" });
  assert.deepEqual(tokenize("\x1b["), { tokens: [], pending: "\x1b[" });
  assert.deepEqual(tokenize("\x1b[1;2"), { tokens: [], pending: "\x1b[1;2" });
  assert.deepEqual(tokenize("\x1bO"), { tokens: [], pending: "\x1bO" });
});

test("printable keys before a pending tail still dispatch", () => {
  assert.deepEqual(tokenize("j\x1b["), { tokens: ["j"], pending: "\x1b[" });
});

test("lone ESC among printables completes after flush semantics", () => {
  // ESC followed by a non-sequence char is treated as a bare ESC token.
  assert.deepEqual(tokenize("\x1bq"), { tokens: ["\x1b", "q"], pending: null });
});
