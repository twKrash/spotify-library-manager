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

export function loadEnvironment(env: NodeJS.ProcessEnv = process.env, envPath = ".env"): void {
  const { error } = dotenv.config({ path: envPath, processEnv: env, quiet: true });
  if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw new ConfigError("Unable to read the environment file");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const clientId = requiredValue(env, "SPOTIFY_CLIENT_ID");
  const clientSecret = requiredValue(env, "SPOTIFY_CLIENT_SECRET");
  const redirectUri = requiredValue(env, "SPOTIFY_REDIRECT_URI");
  const port = parsePort(env.PORT ?? "3000");
  const callback = parseRedirectUri(redirectUri);

  if (callback.port !== String(port)) {
    throw new ConfigError("SPOTIFY_REDIRECT_URI must use the configured PORT");
  }

  return {
    clientId,
    clientSecret,
    redirectUri: callback.toString(),
    port,
    resultsDir: env.RESULTS_DIR?.trim() || "results",
  };
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
