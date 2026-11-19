// Reuse the original ten preview cases against the running, actual helper front; no Python server.
import { defineConfig } from "@playwright/test";
import preview from "./playwright.preview.config";

const baseURL = process.env.POD_FRONT_PREVIEW_URL ?? "";
if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(baseURL)) {
  throw new Error("front preview requires an isolated Actions runner and its loopback front URL");
}
const { webServer: _staticServer, ...original } = preview;
void _staticServer;
export default defineConfig({ ...original, use: { ...original.use, baseURL } });
