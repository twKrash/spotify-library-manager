import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, loadEnvironment } from "../src/config.ts";

const validEnv = (): NodeJS.ProcessEnv => ({
  SPOTIFY_CLIENT_ID: "client-id",
  SPOTIFY_CLIENT_SECRET: "sensitive-test-secret",
  SPOTIFY_REDIRECT_URI: "http://127.0.0.1:8765/callback",
  PORT: "8765",
  RESULTS_DIR: "results",
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
    loadEnvironment(env, envPath);
    assert.equal(env.PORT, "9000");
    assert.equal(env.RESULTS_DIR, "from-env");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadEnvironment treats an absent optional .env file as an empty configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "liked-list-no-env-"));
  try {
    assert.doesNotThrow(() => loadEnvironment(validEnv(), path.join(directory, ".env")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
