import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { LibraryArtifactStore } from "../ports/library-artifacts.js";

export class FileArtifactStore implements LibraryArtifactStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async writeArtifacts(toon: string, offlineHtml: string): Promise<void> {
    await atomicWrite(this.directory, resolve(this.directory, "library.toon"), toon);
    await atomicWrite(this.directory, resolve(this.directory, "index.html"), offlineHtml);
  }
}

async function atomicWrite(directory: string, target: string, contents: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* Preserve the original artifact error. */ }
    }
    try { await fs.unlink(temporary); } catch { /* Preserve the original artifact error. */ }
    throw new Error("Unable to write library output artifacts.", { cause: error });
  }
}
