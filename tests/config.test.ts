import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getUserConfigDirectory, loadConfig, loadEnvironment } from "../src/config.ts";

const validEnv = (): NodeJS.ProcessEnv => ({
  SPOTIFY_CLIENT_ID: "client-id",
  SPOTIFY_CLIENT_SECRET: "sensitive-test-secret",
  SPOTIFY_REDIRECT_URI: "http://127.0.0.1:8765/callback",
  PORT: "8765",
  RESULTS_DIR: "results",
});

test("loadConfig defaults results to the absolute user config directory", () => {
  const env = validEnv();
  delete env.RESULTS_DIR;
  const config = loadConfig(env);

  assert.equal(config.resultsDir, getUserConfigDirectory());
  assert.equal(path.isAbsolute(config.resultsDir), true);
});

test("loadConfig accepts a loopback Spotify callback and typed local settings", () => {
  assert.deepEqual(loadConfig(validEnv()), {
    clientId: "client-id",
    clientSecret: "sensitive-test-secret",
    redirectUri: "http://127.0.0.1:8765/callback",
    port: 8765,
    resultsDir: "results",
  });
});

test("loadConfig rejects a missing Spotify client secret without echoing secret data", () => {
  const env = validEnv();
  delete env.SPOTIFY_CLIENT_SECRET;

  assert.throws(() => loadConfig(env), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /SPOTIFY_CLIENT_SECRET/);
    assert.doesNotMatch(error.message, /sensitive-test-secret/);
    return true;
  });
});

test("loadConfig rejects non-loopback or malformed redirect URIs", () => {
  for (const redirectUri of ["not a URL", "https://example.com/callback", "http://localhost:8765/wrong", "http://127.0.0.1:8765/auth/callback"]) {
    assert.throws(() => loadConfig({ ...validEnv(), SPOTIFY_REDIRECT_URI: redirectUri }));
  }
});

test("loadConfig rejects invalid ports rather than silently coercing them", () => {
  for (const port of ["0", "65536", "12x"]) {
    assert.throws(() => loadConfig({ ...validEnv(), PORT: port }));
  }
});

test("loadEnvironment loads .env values into the supplied environment without overriding existing values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "liked-list-env-"));
  const envPath = path.join(directory, ".env");
  const env: NodeJS.ProcessEnv = { PORT: "9000" };
  try {
    await writeFile(envPath, "PORT=8000\nRESULTS_DIR=from-env\n", "utf8");
    loadEnvironment(env, envPath, path.join(directory, "config.json"));
    assert.equal(env.PORT, "9000");
    assert.equal(env.RESULTS_DIR, "from-env");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadEnvironment treats absent optional files as an empty configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "liked-list-no-config-"));
  try {
    assert.doesNotThrow(() => loadEnvironment(validEnv(), path.join(directory, ".env"), path.join(directory, "config.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadEnvironment applies process, local, and user config precedence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "liked-list-config-precedence-"));
  const envPath = path.join(directory, ".env");
  const configPath = path.join(directory, "config.json");
  try {
    await writeFile(envPath, "SPOTIFY_CLIENT_ID=local-id\nRESULTS_DIR=from-local\n", "utf8");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      clientId: "user-id",
      clientSecret: "user-secret",
      redirectUri: "http://127.0.0.1:8765/callback",
      port: 3000,
      resultsDir: "from-user",
    }), { encoding: "utf8", mode: 0o600 });
    const env: NodeJS.ProcessEnv = { PORT: "8765", SPOTIFY_CLIENT_SECRET: "process-secret" };

    loadEnvironment(env, envPath, configPath);

    assert.deepEqual(loadConfig(env), {
      clientId: "local-id",
      clientSecret: "process-secret",
      redirectUri: "http://127.0.0.1:8765/callback",
      port: 8765,
      resultsDir: "from-local",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadEnvironment uses the user config results directory without an environment override", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "liked-list-user-results-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const env: NodeJS.ProcessEnv = {
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REDIRECT_URI: "http://127.0.0.1:3000/callback",
    PORT: "3000",
  };
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, resultsDir: "from-user" }), { encoding: "utf8", mode: 0o600 });

  loadEnvironment(env, path.join(directory, ".env"), configPath);

  assert.equal(loadConfig(env).resultsDir, "from-user");
});

test("loadEnvironment rejects malformed or unsupported config JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "liked-list-invalid-config-"));
  const configPath = path.join(directory, "config.json");
  try {
    for (const content of ["{invalid", JSON.stringify({ schemaVersion: 2 }), JSON.stringify({ schemaVersion: 1, port: "3000" })]) {
      await writeFile(configPath, content, { encoding: "utf8", mode: 0o600 });
      assert.throws(() => loadEnvironment({}, path.join(directory, ".env"), configPath), /config/i);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadEnvironment rejects permissive files and symlinked user config", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "liked-list-config-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const content = JSON.stringify({ schemaVersion: 1, clientId: "id", clientSecret: "secret" });
  await writeFile(configPath, content, { encoding: "utf8", mode: 0o644 });
  await chmod(configPath, 0o644);
  assert.throws(() => loadEnvironment({}, path.join(directory, ".env"), configPath), /private/i);

  const targetPath = path.join(directory, "target.json");
  await writeFile(targetPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(targetPath, 0o600);
  await rm(configPath);
  await symlink(targetPath, configPath);
  assert.throws(() => loadEnvironment({}, path.join(directory, ".env"), configPath), /regular private file/i);
  assert.equal((await lstat(configPath)).isSymbolicLink(), true);
});

test("loadConfig defaults redirect URI to the selected loopback port", () => {
  const env = validEnv();
  delete env.SPOTIFY_REDIRECT_URI;
  assert.equal(loadConfig(env).redirectUri, "http://127.0.0.1:8765/callback");
});
