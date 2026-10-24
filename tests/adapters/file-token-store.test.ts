import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileTokenStore } from "../../src/adapters/file-token-store.ts";

test("FileTokenStore saves a private refresh token and can clear it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "liked-list-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "private", "tokens.json");
  const store = new FileTokenStore(file);

  await store.save("refresh-secret");
  assert.equal(await store.load(), "refresh-secret");
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700);
  assert.match(await readFile(file, "utf8"), /"refresh_token":"refresh-secret"/);

  await store.clear();
  assert.equal(await store.load(), null);
});

test("FileTokenStore fails closed on malformed token data without echoing it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "liked-list-token-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "tokens.json");
  const secret = "malformed-sensitive-token";
  await writeFile(file, `{\"refresh_token\":\"${secret}\"`, { mode: 0o600 });

  await assert.rejects(new FileTokenStore(file).load(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /token file is invalid/i);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test("FileTokenStore rejects permissive files and symlinks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "liked-list-token-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const permissive = path.join(root, "permissive.json");
  await writeFile(permissive, JSON.stringify({ schema_version: 1, refresh_token: "secret" }), { mode: 0o644 });
  await assert.rejects(new FileTokenStore(permissive).load(), /private permissions/);

  const target = path.join(root, "target.json");
  await writeFile(target, JSON.stringify({ schema_version: 1, refresh_token: "secret" }), { mode: 0o600 });
  const link = path.join(root, "linked.json");
  await symlink(target, link);
  await assert.rejects(new FileTokenStore(link).load(), /regular private file/);
});
