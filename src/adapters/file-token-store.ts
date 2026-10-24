import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { TokenStore } from "../ports/token-store.js";

interface TokenFile {
  schema_version: 1;
  refresh_token: string;
}

export class FileTokenStore implements TokenStore {
  private readonly path: string;

  constructor(filePath = join(homedir(), ".config", "liked-list", "tokens.json")) {
    this.path = resolve(filePath);
  }

  async load(): Promise<string | null> {
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      info = await fs.lstat(this.path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new Error("Unable to read the local token file.", { cause: error });
    }
    if (!info.isFile()) throw new Error("The local token file must be a regular private file.");
    if ((info.mode & 0o077) !== 0) throw new Error("The local token file must have private permissions.");

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.path, "utf8"));
    } catch (error) {
      throw new Error("The local token file is invalid.", { cause: error });
    }
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
      (parsed as Partial<TokenFile>).schema_version !== 1 ||
      typeof (parsed as Partial<TokenFile>).refresh_token !== "string" ||
      !(parsed as Partial<TokenFile>).refresh_token?.trim()
    ) {
      throw new Error("The local token file is invalid.");
    }
    return (parsed as TokenFile).refresh_token;
  }

  async save(refreshToken: string): Promise<void> {
    if (typeof refreshToken !== "string" || !refreshToken.trim()) {
      throw new Error("A non-empty refresh token is required.");
    }

    const directory = dirname(this.path);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await fs.stat(directory);
    if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) {
      throw new Error("The local token directory must have private permissions.");
    }

    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ schema_version: 1, refresh_token: refreshToken } satisfies TokenFile)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.path);
      await syncDirectory(directory);
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* Preserve the original persistence error. */ }
      }
      try { await fs.unlink(temporary); } catch { /* Preserve the original persistence error. */ }
      throw new Error("Unable to persist the local token securely.", { cause: error });
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.path);
      await syncDirectory(dirname(this.path));
    } catch (error) {
      if (isNotFound(error)) return;
      throw new Error("Unable to clear the local token file.", { cause: error });
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
