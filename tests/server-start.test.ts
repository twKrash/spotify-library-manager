import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("CLI reports actionable setup guidance when credentials are missing without a TTY", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "liked-list-server-start-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REDIRECT_URI", "PORT", "RESULTS_DIR"]) {
    delete env[key];
  }
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const serverPath = path.join(process.cwd(), "src", "http", "server.ts");
  const result = spawnSync(process.execPath, [tsxCli, serverPath], {
    cwd: home,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Spotify credentials are missing/i);
  assert.match(result.stderr, /interactive terminal|environment variables/i);
  await assert.rejects(lstat(path.join(home, ".config", "liked-list", "config.json")), { code: "ENOENT" });
});
