import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeUrl } from "./safe-url";

test("Rejects localhost", async () => {
  assert.equal(await isSafeUrl("http://localhost"), false);
});

test("Rejects private IP addresses", async () => {
  assert.equal(await isSafeUrl("http://192.168.1.1"), false);
  assert.equal(await isSafeUrl("http://10.0.0.1"), false);
});

test("Rejects invalid protocols", async () => {
  assert.equal(await isSafeUrl("ftp://example.com"), false);
});

test("Rejects URLs with credentials", async () => {
  assert.equal(
    await isSafeUrl("https://user:pass@example.com"),
    false
  );
});