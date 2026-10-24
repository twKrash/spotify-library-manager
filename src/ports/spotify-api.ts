import type { ApiStatistics, SpotifyTrack } from "../domain/types.js";

export interface SpotifyApiPort {
  listSavedTracks(): Promise<SpotifyTrack[]>;
  getStatistics(): Promise<ApiStatistics>;
  removeSavedTrackUris(uris: string[]): Promise<void>;
  addSavedTrackUris(uris: string[]): Promise<void>;
}
