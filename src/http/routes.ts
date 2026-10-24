import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { SpotifyApiError } from "../adapters/spotify-http-adapter.js";
import { SpotifyAuthError, type SpotifyAuthService } from "../adapters/spotify-auth.js";
import type { LibraryService } from "../application/library-service.js";
import type { RemovalService } from "../application/removal-service.js";

export interface HttpServices {
  library: Pick<LibraryService, "getSnapshot" | "isSnapshotStale" | "sync">;
  removal: Pick<RemovalService, "previewCleanup" | "previewCleanupForSongs" | "applyCleanup" | "removeOne" | "previewRestore" | "applyRestore" | "listOperations">;
  auth: Pick<SpotifyAuthService, "beginAuthorization" | "completeAuthorization" | "getAccessToken" | "isConnected">;
}

export interface DashboardAssets {
  dashboardHtmlPath?: string;
  dashboardBundlePath?: string;
}

const htmlPath = (assets: DashboardAssets) => assets.dashboardHtmlPath ?? resolve(process.cwd(), "dashboard.html");
const bundlePath = (assets: DashboardAssets) => assets.dashboardBundlePath ?? resolve(process.cwd(), "public/dashboard.js");

export function registerRoutes(app: FastifyInstance, config: AppConfig, services: HttpServices, assets: DashboardAssets = {}): void {
  const originGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isLocalSameOrigin(request, config.port)) {
      await reply.code(403).send({ error: "Requests must come from this local app." });
    }
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error !== null && typeof error === "object" && "validation" in error && error.validation) {
      return reply.code(400).send({ error: "Invalid request." });
    }
    if (error instanceof SpotifyAuthError) return reply.code(401).send({ error: "Spotify authorization is required." });
    if (error instanceof SpotifyApiError) return reply.code(502).send({ error: "Spotify API request failed." });
    if (error instanceof Error && /stale|changed after|expired or already used/i.test(error.message)) {
      return reply.code(409).send({ error: "The library or preview changed. Sync and create a new preview." });
    }
    if (error instanceof Error && /confirmation|not present|invalid|select at least|no duplicate|no missing tracks|no library snapshot|sync first|repeats/i.test(error.message)) {
      return reply.code(400).send({ error: "The requested operation is invalid." });
    }
    return reply.code(500).send({ error: "The request could not be completed." });
  });

  app.get("/", async (_request, reply) => {
    const template = await fs.readFile(htmlPath(assets), "utf8");
    return reply.type("text/html; charset=utf-8").send(
      template.replace("__LIBRARY_JSON__", "").replace("__OFFLINE_MODE__", "false"),
    );
  });

  app.get("/dashboard.js", async (_request, reply) => {
    const bundle = await fs.readFile(bundlePath(assets), "utf8");
    return reply.type("text/javascript; charset=utf-8").header("x-content-type-options", "nosniff").send(bundle);
  });

  app.get("/api/library", async () => {
    const [library, stale, connected] = await Promise.all([
      services.library.getSnapshot(),
      services.library.isSnapshotStale(),
      services.auth.isConnected(),
    ]);
    return { library, stale, connected };
  });

  app.get("/api/operations", async () => services.removal.listOperations());

  app.post("/api/sync", { preHandler: originGuard, schema: { body: emptyObjectSchema } }, async () => {
    await requireAccessToken(services.auth);
    const library = await services.library.sync();
    return { library };
  });

  app.post<{ Body: { group_ids?: string[] } }>("/api/cleanup/preview", {
    preHandler: originGuard,
    schema: { body: { type: "object", properties: { group_ids: { type: "array", items: { type: "string", pattern: "^[a-f0-9]{64}$" }, minItems: 1 } }, additionalProperties: false } },
  }, (request) => services.removal.previewCleanup(request.body.group_ids));

  app.post<{ Body: { song_ids: string[] } }>("/api/cleanup/preview-group", {
    preHandler: originGuard,
    schema: {
      body: {
        type: "object",
        required: ["song_ids"],
        properties: { song_ids: { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } } },
        additionalProperties: false,
      },
    },
  }, (request) => services.removal.previewCleanupForSongs(request.body.song_ids));

  app.post<{ Body: { preview_id: string; confirmation_text: string } }>("/api/cleanup/apply", {
    preHandler: originGuard,
    schema: { body: previewSchema },
  }, async (request) => {
    await requireAccessToken(services.auth);
    return services.removal.applyCleanup(request.body.preview_id, request.body.confirmation_text);
  });

  app.post<{ Params: { id: string }; Body: { confirmation_text: string } }>("/api/tracks/:id/remove", {
    preHandler: originGuard,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[A-Za-z0-9]{22}$" } }, additionalProperties: false },
      body: { type: "object", required: ["confirmation_text"], properties: { confirmation_text: { type: "string", minLength: 1, maxLength: 300 } }, additionalProperties: false },
    },
  }, async (request) => {
    await requireAccessToken(services.auth);
    return services.removal.removeOne(request.params.id, request.body.confirmation_text);
  });

  app.post<{ Body: { operation_id: string } }>("/api/restore/preview", {
    preHandler: originGuard,
    schema: { body: { type: "object", required: ["operation_id"], properties: { operation_id: { type: "string", pattern: "^operation-[0-9TZ]+-[0-9a-f-]+\\.json$" } }, additionalProperties: false } },
  }, async (request) => {
    await requireAccessToken(services.auth);
    return services.removal.previewRestore(request.body.operation_id);
  });

  app.post<{ Body: { preview_id: string; confirmation_text: string } }>("/api/restore/apply", {
    preHandler: originGuard,
    schema: { body: previewSchema },
  }, async (request) => {
    await requireAccessToken(services.auth);
    return services.removal.applyRestore(request.body.preview_id, request.body.confirmation_text);
  });

  app.get("/auth/login", async (_request, reply) => reply.redirect(services.auth.beginAuthorization()));

  app.get("/callback", async (request, reply) => {
    const parameters = new URL(request.url, config.redirectUri).searchParams;
    await services.auth.completeAuthorization(parameters);
    return reply.redirect("/");
  });
}

const emptyObjectSchema = { type: "object", additionalProperties: false } as const;
const previewSchema = {
  type: "object",
  required: ["preview_id", "confirmation_text"],
  properties: {
    preview_id: { type: "string", minLength: 1, maxLength: 100 },
    confirmation_text: { type: "string", minLength: 1, maxLength: 300 },
  },
  additionalProperties: false,
} as const;

async function requireAccessToken(auth: HttpServices["auth"]): Promise<void> {
  try {
    await auth.getAccessToken();
  } catch {
    throw new SpotifyAuthError("Spotify authorization is required.");
  }
}

function isLocalSameOrigin(request: FastifyRequest, port: number): boolean {
  const host = request.headers.host?.toLowerCase();
  if (!host || ![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === host &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}
