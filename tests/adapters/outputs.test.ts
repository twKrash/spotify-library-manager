import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileArtifactStore } from "../../src/adapters/file-artifact-store.ts";
import { FileOfflineHtmlRenderer } from "../../src/adapters/file-offline-html.ts";
import { FileSnapshotStore } from "../../src/adapters/file-snapshot-store.ts";
import { ToonCliEncoder } from "../../src/adapters/toon-cli.ts";
import { buildLibrary, toonExportData } from "../../src/domain/library.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "liked-list-output-test-"));
}

test("FileSnapshotStore atomically saves reports and persists stale/fresh state", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileSnapshotStore(directory);
  const report = buildLibrary([], undefined, new Date("2025-01-02T03:04:05Z"));

  assert.equal(await store.load(), null);
  assert.equal(await store.isStale(), false);
  await store.save(report);
  assert.deepEqual(await store.load(), report);
  assert.equal((await stat(path.join(directory, "library.json"))).mode & 0o777, 0o600);
  await store.markStale();
  assert.equal(await store.isStale(), true);
  await store.markFresh();
  assert.equal(await store.isStale(), false);
  assert.deepEqual((await readdir(directory)).sort(), ["library.json"]);
});

test("FileSnapshotStore rejects malformed reports without echoing persisted data", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = "private-local-report-value";
  await writeFile(path.join(directory, "library.json"), `{\"secret\":\"${secret}\"`, { mode: 0o600 });
  await assert.rejects(new FileSnapshotStore(directory).load(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /snapshot is invalid/i);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test("FileArtifactStore writes private TOON and offline HTML artifacts", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileArtifactStore(directory);

  await store.writeArtifacts("library: data\n", "<html>offline</html>");
  assert.equal(await readFile(path.join(directory, "library.toon"), "utf8"), "library: data\n");
  assert.equal(await readFile(path.join(directory, "index.html"), "utf8"), "<html>offline</html>");
  assert.equal((await stat(path.join(directory, "library.toon"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(directory, "index.html"))).mode & 0o777, 0o600);
});

test("FileOfflineHtmlRenderer embeds escaped JSON and an inline bundle", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const templatePath = path.join(directory, "dashboard.html");
  const bundlePath = path.join(directory, "dashboard.js");
  await writeFile(templatePath, '<body data-offline="__OFFLINE_MODE__"><script id="library-data">__LIBRARY_JSON__</script><script defer src="/dashboard.js"></script></body>');
  await writeFile(bundlePath, 'const marker = "</script>";');
  const report = buildLibrary([], undefined, new Date("2025-01-02T03:04:05Z"));

  const html = await new FileOfflineHtmlRenderer(templatePath, bundlePath).render(report);
  assert.match(html, /data-offline="true"/);
  assert.match(html, /\\u003c\/script>/);
  assert.ok(html.includes("JSON.parse("));
  assert.ok(html.includes("\\u003c/script>"));
  assert.equal(html.split("</script>").length - 1, 2);
  assert.doesNotMatch(html, /src="\/dashboard\.js"/);
});

test("ToonCliEncoder runs the local TOON CLI against JSON input", async () => {
  const report = buildLibrary([], undefined, new Date("2025-01-02T03:04:05Z"));
  const output = await new ToonCliEncoder().encode(toonExportData(report, []));
  assert.match(output, /generated_at/);
  assert.match(output, /liked_track_count/);
});
