#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import fastify, { type FastifyInstance } from "fastify";
import { SpotifyAuthService } from "../adapters/spotify-auth.js";
import { FileArtifactStore } from "../adapters/file-artifact-store.js";
import { FileManifestStore } from "../adapters/file-manifest-store.js";
import { FileOfflineHtmlRenderer } from "../adapters/file-offline-html.js";
import { FileSnapshotStore } from "../adapters/file-snapshot-store.js";
import { FileTokenStore } from "../adapters/file-token-store.js";
import { SpotifyHttpAdapter } from "../adapters/spotify-http-adapter.js";
import { ToonCliEncoder } from "../adapters/toon-cli.js";
import { OperationGate } from "../application/operation-gate.js";
import { LibraryService } from "../application/library-service.js";
import { RemovalService } from "../application/removal-service.js";
import { ConfigError, loadConfig, loadEnvironment, type AppConfig } from "../config.js";
import { registerRoutes, type DashboardAssets, type HttpServices } from "./routes.js";

const dashboardHtmlPath = fileURLToPath(new URL("../../dashboard.html", import.meta.url));
const dashboardBundlePath = fileURLToPath(new URL("../../public/dashboard.js", import.meta.url));
const dashboardAssets: DashboardAssets = { dashboardHtmlPath, dashboardBundlePath };

export function createServer(config: AppConfig, services: HttpServices, assets: DashboardAssets = {}): FastifyInstance {
  const app = fastify({ logger: false, bodyLimit: 64 * 1024 });
  registerRoutes(app, config, services, assets);
  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  loadEnvironment();
  const config = loadConfig();
  const snapshots = new FileSnapshotStore(config.resultsDir);
  const spotifyAuth = new SpotifyAuthService(config, new FileTokenStore());
  const spotify = new SpotifyHttpAdapter(spotifyAuth);
  const operationGate = new OperationGate();
  const library = new LibraryService(
    spotify,
    snapshots,
    new FileArtifactStore(config.resultsDir),
    new ToonCliEncoder(),
    new FileOfflineHtmlRenderer(dashboardHtmlPath, dashboardBundlePath),
    operationGate,
  );
  const removal = new RemovalService(
    spotify,
    snapshots,
    new FileManifestStore(config.resultsDir),
    operationGate,
  );
  const app = createServer(config, { library, removal, auth: spotifyAuth }, dashboardAssets);
  await app.listen({ host: "127.0.0.1", port: config.port });
  process.stdout.write(`Spotify Library Manager listening on http://127.0.0.1:${config.port}\n`);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void startServer().catch((error: unknown) => {
    process.stderr.write(`${error instanceof ConfigError ? error.message : "Unable to start Spotify Library Manager."}\n`);
    process.exitCode = 1;
  });
}
