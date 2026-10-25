import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";

export interface AppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  port: number;
  resultsDir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function getUserConfigDirectory(): string {
  return join(homedir(), ".config", "liked-list");
}

export function getUserConfigPath(): string {
  return join(getUserConfigDirectory(), "config.json");
}

export function loadEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  envPath = ".env",
  configPath = getUserConfigPath(),
): void {
  const { error } = dotenv.config({ path: envPath, processEnv: env, quiet: true });
  if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw new ConfigError("Unable to read the environment file");
  }

  const userConfig = readUserConfig(configPath);
  for (const [field, key] of Object.entries(userConfigEnvKeys)) {
    const value = userConfig[field as keyof UserConfig];
    if (env[key] === undefined && value !== undefined) {
      env[key] = String(value);
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const clientId = requiredValue(env, "SPOTIFY_CLIENT_ID");
  const clientSecret = requiredValue(env, "SPOTIFY_CLIENT_SECRET");
  const port = parsePort(env.PORT ?? "3000");
  const redirectUri = env.SPOTIFY_REDIRECT_URI === undefined
    ? `http://127.0.0.1:${port}/callback`
    : requiredValue(env, "SPOTIFY_REDIRECT_URI");
  const callback = parseRedirectUri(redirectUri);

  if (callback.port !== String(port)) {
    throw new ConfigError("SPOTIFY_REDIRECT_URI must use the configured PORT");
  }

  return {
    clientId,
    clientSecret,
    redirectUri: callback.toString(),
    port,
    resultsDir: env.RESULTS_DIR?.trim() || getUserConfigDirectory(),
  };
}

interface UserConfig {
  schemaVersion: 1;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  port?: number;
  resultsDir?: string;
}

const userConfigEnvKeys = {
  clientId: "SPOTIFY_CLIENT_ID",
  clientSecret: "SPOTIFY_CLIENT_SECRET",
  redirectUri: "SPOTIFY_REDIRECT_URI",
  port: "PORT",
  resultsDir: "RESULTS_DIR",
} as const;

function readUserConfig(filePath: string): UserConfig | Record<string, never> {
  let content: string;
  try {
    const fileInfo = lstatSync(filePath);
    if (!fileInfo.isFile() || (fileInfo.mode & 0o077) !== 0) {
      throw new ConfigError("The user config file must be a regular private file.");
    }
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError("Unable to read the user config file");
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ConfigError("The user config file is invalid");
  }
  if (!isUserConfig(value)) {
    throw new ConfigError("The user config file is invalid or uses an unsupported schema version");
  }
  return value;
}

function isUserConfig(value: unknown): value is UserConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const config = value as Record<string, unknown>;
  const allowedKeys = new Set(["schemaVersion", ...Object.keys(userConfigEnvKeys)]);
  return config.schemaVersion === 1
    && Object.keys(config).every((key) => allowedKeys.has(key))
    && (config.clientId === undefined || typeof config.clientId === "string")
    && (config.clientSecret === undefined || typeof config.clientSecret === "string")
    && (config.redirectUri === undefined || typeof config.redirectUri === "string")
    && (config.port === undefined || (Number.isInteger(config.port) && Number(config.port) >= 1 && Number(config.port) <= 65535))
    && (config.resultsDir === undefined || typeof config.resultsDir === "string");
}

function requiredValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigError(`Missing required configuration: ${key}`);
  }
  return value;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError("PORT must be an integer between 1 and 65535");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseRedirectUri(value: string): URL {
  let redirectUri: URL;
  try {
    redirectUri = new URL(value);
  } catch {
    throw new ConfigError("SPOTIFY_REDIRECT_URI must be a valid local callback URL");
  }

  if (
    redirectUri.protocol !== "http:" ||
    redirectUri.hostname !== "127.0.0.1" ||
    redirectUri.pathname !== "/callback" ||
    redirectUri.username !== "" ||
    redirectUri.password !== "" ||
    redirectUri.search !== "" ||
    redirectUri.hash !== ""
  ) {
    throw new ConfigError("SPOTIFY_REDIRECT_URI must be http://127.0.0.1:<PORT>/callback");
  }
  return redirectUri;
}
