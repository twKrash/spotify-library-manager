import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import type { LibraryReport } from "../domain/types.js";
import type { OfflineHtmlRenderer } from "../ports/offline-html.js";

const LIVE_BUNDLE_TAG = '<script defer src="/dashboard.js"></script>';

export class FileOfflineHtmlRenderer implements OfflineHtmlRenderer {
  constructor(
    private readonly templatePath = resolve(process.cwd(), "dashboard.html"),
    private readonly bundlePath = resolve(process.cwd(), "public/dashboard.js"),
  ) {}

  async render(report: LibraryReport): Promise<string> {
    let template: string;
    let bundle: string;
    try {
      [template, bundle] = await Promise.all([
        fs.readFile(this.templatePath, "utf8"),
        fs.readFile(this.bundlePath, "utf8"),
      ]);
    } catch (error) {
      throw new Error("Unable to load the dashboard template or client bundle.", { cause: error });
    }
    if (!template.includes("__LIBRARY_JSON__") || !template.includes(LIVE_BUNDLE_TAG)) {
      throw new Error("The dashboard template is missing its offline embedding points.");
    }

    const libraryJson = JSON.stringify(report).replace(/</g, "\\u003c");
    const bundleJson = JSON.stringify(bundle).replace(/</g, "\\u003c");
    const inlineBundle = `<script>const client=document.createElement("script");client.textContent=JSON.parse(${bundleJson});document.body.append(client);</script>`;
    return template
      .replace("__LIBRARY_JSON__", libraryJson)
      .replace("__OFFLINE_MODE__", "true")
      .replace(LIVE_BUNDLE_TAG, inlineBundle);
  }
}
