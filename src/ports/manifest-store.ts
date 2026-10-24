import type { ManifestProgressField, OperationManifest } from "../domain/types.js";

export interface ManifestStore {
  create(manifest: OperationManifest): Promise<string>;
  read(id: string): Promise<OperationManifest>;
  list(): Promise<Array<{ id: string; manifest: OperationManifest }>>;
  recordBatch(path: string, field: ManifestProgressField, ids: string[]): Promise<void>;
}
