export interface LibraryArtifactStore {
  writeArtifacts(toon: string, offlineHtml: string): Promise<void>;
}
