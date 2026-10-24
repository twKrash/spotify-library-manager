import { spawn } from "node:child_process";
import type { ToonExport } from "../domain/types.js";
import type { ToonEncoder } from "../ports/toon-encoder.js";

export class ToonCliEncoder implements ToonEncoder {
  async encode(data: ToonExport): Promise<string> {
    let input: string;
    try {
      input = JSON.stringify(data);
    } catch (error) {
      throw new Error("TOON encoding input is not valid JSON data.", { cause: error });
    }

    return new Promise((resolve, reject) => {
      let output = "";
      let settled = false;
      const child = spawn("toon", ["--encode"], { stdio: ["pipe", "pipe", "ignore"] });
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.on("error", (error) => {
        fail(new Error("TOON CLI could not be started. Run npm ci and try again.", { cause: error }));
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error("TOON CLI encoding failed."));
          return;
        }
        settled = true;
        resolve(output);
      });
      child.stdin.on("error", (error) => {
        fail(new Error("Unable to send JSON to the TOON CLI.", { cause: error }));
      });
      child.stdin.end(input, "utf8");
    });
  }
}
