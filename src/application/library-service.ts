import { buildLibrary, toonExportData } from "../domain/library.js";
import type { LibraryReport } from "../domain/types.js";
import type { LibraryArtifactStore } from "../ports/library-artifacts.js";
import type { OfflineHtmlRenderer } from "../ports/offline-html.js";
import type { SnapshotStore } from "../ports/snapshot-store.js";
import type { SpotifyApiPort } from "../ports/spotify-api.js";
import type { ToonEncoder } from "../ports/toon-encoder.js";
import { OperationGate } from "./operation-gate.js";

export class LibraryService {
  constructor(
    private readonly spotify: SpotifyApiPort,
    private readonly snapshots: SnapshotStore,
    private readonly artifacts: LibraryArtifactStore,
    private readonly toonEncoder: ToonEncoder,
    private readonly offlineHtml: OfflineHtmlRenderer,
    private readonly operationGate = new OperationGate(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  getSnapshot(): Promise<LibraryReport | null> {
    return this.snapshots.load();
  }

  isSnapshotStale(): Promise<boolean> {
    return this.snapshots.isStale();
  }

  sync(): Promise<LibraryReport> {
    return this.operationGate.run(async () => {
      const tracks = await this.spotify.listSavedTracks();
      const apiStatistics = await this.spotify.getStatistics();
      const report = buildLibrary(tracks, apiStatistics, this.now());
      const toon = await this.toonEncoder.encode(toonExportData(report, tracks));
      const html = await this.offlineHtml.render(report);
      await this.artifacts.writeArtifacts(toon, html);
      await this.snapshots.save(report);
      await this.snapshots.markFresh();
      return report;
    });
  }
}
