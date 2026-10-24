import type { ToonExport } from "../domain/types.js";

export interface ToonEncoder {
  encode(data: ToonExport): Promise<string>;
}
