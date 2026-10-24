import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@twkrash/spotify-library-manager";
const expectedFiles = [
  "dist/http/server.js",
  "dashboard.html",
  "public/dashboard.js",
  ".env.example",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
];

const temporaryRoot = await mkdtemp(join(tmpdir(), "spotify-library-manager-smoke-"));
const npmConfig = join(temporaryRoot, "npmrc");
const npmCache = join(temporaryRoot, "npm-cache");
const homeDirectory = join(temporaryRoot, "home");
let appProcess;

try {
  await mkdir(homeDirectory);
  await writeFile(npmConfig, "registry=https://registry.npmjs.org/\n");
  const npmEnvironment = {
    PATH: process.env.PATH ?? "",
    HOME: homeDirectory,
    TMPDIR: temporaryRoot,
  };

  const packDirectory = join(temporaryRoot, "pack");
  await mkdir(packDirectory);
  const { stdout: packOutput } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", packDirectory, "--userconfig", npmConfig, "--cache", npmCache],
    { cwd: projectRoot, env: npmEnvironment, timeout: 180_000 },
  );
  const [packageEntry] = JSON.parse(packOutput);
  assert.equal(packageEntry.name, packageName, "the packed archive must use the approved package name");
  const packagedFiles = new Set(packageEntry.files.map(({ path }) => path));
  for (const file of expectedFiles) assert(packagedFiles.has(file), `package is missing ${file}`);
  const forbiddenFiles = [...packagedFiles].filter((file) =>
    file === ".env" ||
    (file.startsWith(".env.") && file !== ".env.example") ||
    file === "results" ||
    file.startsWith("results/") ||
    file === "tests" ||
    file.startsWith("tests/") ||
    file === "src" ||
    file.startsWith("src/") ||
    file.startsWith(".venv/") ||
    file.startsWith(".ruff_cache/") ||
    file.endsWith(".py") ||
    file.endsWith(".pyc"),
  );
  assert.deepEqual(forbiddenFiles, [], "the package must exclude local data and development files");

  const tarball = join(packDirectory, packageEntry.filename);
  const installDirectory = join(temporaryRoot, "install");
  await execFileAsync(
    "npm",
    ["install", "--prefix", installDirectory, "--no-audit", "--no-fund", "--userconfig", npmConfig, "--cache", npmCache, tarball],
    { cwd: temporaryRoot, env: npmEnvironment, timeout: 300_000 },
  );

  const workDirectory = join(temporaryRoot, "work");
  const dataDirectory = join(workDirectory, "results");
  await mkdir(workDirectory);
  const port = await findAvailablePort();
  const executable = join(installDirectory, "node_modules", ".bin", "spotify-library-manager");
  await access(executable);
  appProcess = spawn(executable, [], {
    cwd: workDirectory,
    env: {
      ...npmEnvironment,
      SPOTIFY_CLIENT_ID: "package-smoke-client",
      SPOTIFY_CLIENT_SECRET: "package-smoke-secret",
      SPOTIFY_REDIRECT_URI: `http://127.0.0.1:${port}/callback`,
      PORT: String(port),
      RESULTS_DIR: dataDirectory,
    },
    stdio: "ignore",
  });

  const htmlResponse = await waitForResponse(appProcess, `http://127.0.0.1:${port}/`);
  assert.equal(htmlResponse.status, 200);
  assert.match(await htmlResponse.text(), /data-offline="false"/);
  const bundleResponse = await fetch(`http://127.0.0.1:${port}/dashboard.js`);
  assert.equal(bundleResponse.status, 200);
  assert.match(bundleResponse.headers.get("content-type") ?? "", /javascript/);
  const bundle = await bundleResponse.text();
  assert.ok(bundle.length > 0, "the installed dashboard bundle must be served");

  process.stdout.write(`Package smoke passed for ${packageEntry.name}@${packageEntry.version}.\n`);
} finally {
  if (appProcess) await stopProcess(appProcess);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForResponse(child, url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`The packaged CLI exited with status ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The local server may need a moment to bind.
    }
    await delay(100);
  }
  throw new Error("The packaged CLI did not serve the dashboard within five seconds.");
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => undefined);
  child.kill("SIGTERM");
  const terminated = await Promise.race([exited.then(() => true), delay(2_000).then(() => false)]);
  if (!terminated && child.exitCode === null) {
    const killed = once(child, "exit").catch(() => undefined);
    child.kill("SIGKILL");
    await killed;
  }
}
