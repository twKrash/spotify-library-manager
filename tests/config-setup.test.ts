import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getUserConfigDirectory } from "../src/config.ts";
import { createTerminalPrompts, ensureInteractiveConfig, type SetupPrompts } from "../src/config-setup.ts";

function successfulPrompts(overrides: Partial<SetupPrompts> = {}) {
  const questions: Array<{ question: string; defaultValue: string }> = [];
  const messages: string[] = [];
  const prompts: SetupPrompts = {
    text: async (question, defaultValue) => {
      questions.push({ question, defaultValue });
      if (question.includes("Client ID")) return "test-client-id";
      return defaultValue;
    },
    secret: async () => "test-client-secret",
    info: (message) => messages.push(message),
    ...overrides,
  };
  return { prompts, questions, messages };
}

async function makeTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("ensureInteractiveConfig prompts for missing credentials and defaults", async (t) => {
  const root = await makeTempDirectory("liked-list-setup-prompts-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const { prompts, questions, messages } = successfulPrompts();

  await ensureInteractiveConfig({}, {
    configPath: path.join(root, "private", "config.json"),
    isInteractive: true,
    prompts,
  });

  assert.deepEqual(questions.map(({ question, defaultValue }) => [question, defaultValue]), [
    ["Spotify Client ID", ""],
    ["Local server port", "3000"],
    ["Spotify redirect URI", "http://127.0.0.1:3000/callback"],
    ["Results directory", getUserConfigDirectory()],
  ]);
  assert.ok(messages.some((message) => message.includes("Developer Dashboard")));
});

test("ensureInteractiveConfig writes a private JSON config and round-trips secrets", async (t) => {
  const root = await makeTempDirectory("liked-list-setup-write-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "private");
  const configPath = path.join(directory, "config.json");
  const secret = "quoted\"secret\\part\ninside#";
  const { prompts } = successfulPrompts({ secret: async () => secret });

  await ensureInteractiveConfig({}, { configPath, isInteractive: true, prompts });

  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(config, {
    schemaVersion: 1,
    clientId: "test-client-id",
    clientSecret: secret,
    redirectUri: "http://127.0.0.1:3000/callback",
    port: 3000,
    resultsDir: getUserConfigDirectory(),
  });
  assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
});

test("terminal secret prompt does not echo entered characters", async () => {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
  const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
  const rawModes: boolean[] = [];
  const outputChunks: string[] = [];
  Object.assign(input, { isTTY: true, setRawMode: (mode: boolean) => { rawModes.push(mode); return input; } });
  Object.assign(output, { isTTY: true });
  output.on("data", (chunk: Buffer) => outputChunks.push(chunk.toString("utf8")));
  const secret = "invisible-secret";
  const result = createTerminalPrompts(input, output).secret("Spotify Client Secret: ");
  input.write(`${secret}\n`);

  assert.equal(await result, secret);
  assert.equal(outputChunks.join(""), "Spotify Client Secret: \n");
  assert.deepEqual(rawModes, [true, false]);
});

test("ensureInteractiveConfig rejects an insecure config directory", async (t) => {
  const root = await makeTempDirectory("liked-list-setup-mode-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "public");
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);
  const configPath = path.join(directory, "config.json");
  const { prompts } = successfulPrompts();

  await assert.rejects(
    ensureInteractiveConfig({}, { configPath, isInteractive: true, prompts }),
    /private permissions/i,
  );
  await assert.rejects(lstat(configPath), { code: "ENOENT" });
});

test("ensureInteractiveConfig writes nothing when canceled", async (t) => {
  const root = await makeTempDirectory("liked-list-setup-cancel-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "private", "config.json");
  const { prompts } = successfulPrompts({
    text: async (question, defaultValue) => question.includes("Client ID") ? "" : defaultValue,
  });

  await assert.rejects(
    ensureInteractiveConfig({}, { configPath, isInteractive: true, prompts }),
    /missing required configuration/i,
  );
  await assert.rejects(lstat(configPath), { code: "ENOENT" });
});

test("ensureInteractiveConfig does not prompt for complete config", async () => {
  const env: NodeJS.ProcessEnv = {
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REDIRECT_URI: "http://127.0.0.1:8765/callback",
    PORT: "8765",
    RESULTS_DIR: "results",
  };
  const prompts: SetupPrompts = {
    text: async () => assert.fail("complete config must not prompt"),
    secret: async () => assert.fail("complete config must not prompt"),
    info: () => assert.fail("complete config must not print setup instructions"),
  };

  await ensureInteractiveConfig(env, { isInteractive: false, prompts });
});

test("ensureInteractiveConfig fails actionably without a TTY", async (t) => {
  const root = await makeTempDirectory("liked-list-setup-no-tty-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "private", "config.json");

  await assert.rejects(
    ensureInteractiveConfig({}, { configPath, isInteractive: false }),
    /interactive|environment variables/i,
  );
  await assert.rejects(lstat(configPath), { code: "ENOENT" });
});
