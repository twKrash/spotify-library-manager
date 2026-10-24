import type { LibraryReport } from "../domain/types.js";

export interface SnapshotStore {
  load(): Promise<LibraryReport | null>;
  save(report: LibraryReport): Promise<void>;
  isStale(): Promise<boolean>;
  markStale(): Promise<void>;
  markFresh(): Promise<void>;
}
