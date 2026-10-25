import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { ConfigError, getUserConfigDirectory, getUserConfigPath, loadConfig, type AppConfig } from "./config.js";

export interface SetupPrompts {
  text(question: string, defaultValue: string): Promise<string>;
  secret(question: string): Promise<string>;
  info(message: string): void;
}

interface SetupOptions {
  configPath?: string;
  isInteractive?: boolean;
  prompts?: SetupPrompts;
}

export function createTerminalPrompts(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): SetupPrompts {
  return {
    async text(question, defaultValue) {
      const readline = createInterface({ input, output });
      try {
        const suffix = defaultValue ? ` [${defaultValue}]` : "";
        const answer = await readline.question(`${question}${suffix}: `);
        return answer.trim() || defaultValue;
      } finally {
        readline.close();
      }
    },
    secret: (question) => readSecret(input, output, question),
    info(message) {
      output.write(`${message}\n`);
    },
  };
}

export async function ensureInteractiveConfig(
  env: NodeJS.ProcessEnv,
  options: SetupOptions = {},
): Promise<void> {
  const missingClientId = !env.SPOTIFY_CLIENT_ID?.trim();
  const missingClientSecret = !env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!missingClientId && !missingClientSecret) {
    loadConfig(env);
    return;
  }

  const isInteractive = options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive) {
    throw new ConfigError(
      "Spotify credentials are missing. Run spotify-library-manager in an interactive terminal or set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.",
    );
  }

  const prompts = options.prompts ?? createTerminalPrompts();
  prompts.info(
    "Create an app in the Spotify Developer Dashboard (https://developer.spotify.com/documentation/web-api/concepts/apps) and register the redirect URI shown below.",
  );
  const clientId = missingClientId
    ? await prompts.text("Spotify Client ID", "")
    : env.SPOTIFY_CLIENT_ID?.trim() ?? "";
  const clientSecret = missingClientSecret
    ? await prompts.secret("Spotify Client Secret")
    : env.SPOTIFY_CLIENT_SECRET?.trim() ?? "";
  const port = env.PORT === undefined ? await prompts.text("Local server port", "3000") : env.PORT;
  const redirectUri = env.SPOTIFY_REDIRECT_URI === undefined
    ? await prompts.text("Spotify redirect URI", `http://127.0.0.1:${port}/callback`)
    : env.SPOTIFY_REDIRECT_URI;
  const resultsDir = env.RESULTS_DIR === undefined
    ? await prompts.text("Results directory", getUserConfigDirectory())
    : env.RESULTS_DIR;
  const config = loadConfig({
    ...env,
    SPOTIFY_CLIENT_ID: clientId,
    SPOTIFY_CLIENT_SECRET: clientSecret,
    PORT: port,
    SPOTIFY_REDIRECT_URI: redirectUri,
    RESULTS_DIR: resultsDir,
  });

  await writeUserConfig(options.configPath ?? getUserConfigPath(), config);
  prompts.info("Configuration saved securely.");
}

async function readSecret(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  question: string,
): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new ConfigError("Secret input requires an interactive terminal.");
  }

  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let value = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      input.removeListener("data", onData);
      try {
        input.setRawMode(false);
      } catch {
        // Keep the prompt outcome; terminal mode cleanup is best effort.
      }
      input.pause();
      output.write("\n");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of typeof chunk === "string" ? chunk : decoder.write(chunk)) {
        if (character === "\u0003") {
          finish(new ConfigError("Configuration setup was cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    try {
      output.write(question);
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
    } catch (error) {
      finish(error instanceof Error ? error : new ConfigError("Unable to read secret input."));
    }
  });
}

async function writeUserConfig(filePath: string, config: AppConfig): Promise<void> {
  const directory = dirname(filePath);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) {
      throw new ConfigError("The local config directory must have private permissions.");
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError("Unable to prepare the private config directory.");
  }

  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, ...config })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* Preserve the original persistence error. */ }
    }
    try { await unlink(temporary); } catch { /* Preserve the original persistence error. */ }
    throw new ConfigError("Unable to persist the local config securely.");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
