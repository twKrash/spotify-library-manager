import type { LibraryReport } from "../domain/types.js";

export interface OfflineHtmlRenderer {
  render(report: LibraryReport): Promise<string>;
}
