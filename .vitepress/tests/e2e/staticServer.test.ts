// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticServer } from "../../../e2e/support/staticServer";

const TEST_CSP = "default-src 'self'";
let workspace: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "np-static-server-"));
  const distDir = join(workspace, "dist");
  mkdirSync(distDir);
  writeFileSync(join(distDir, "index.html"), "<p>home</p>");
  writeFileSync(join(distDir, "privacy.html"), "<p>privacy</p>");
  writeFileSync(join(workspace, "secret.txt"), "secret");
  server = createStaticServer(distDir, TEST_CSP);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(workspace, { recursive: true, force: true });
});

// fetch() collapses dot segments client-side, so a raw request is the only way
// to put a traversal path on the wire. The encoded-slash variants survive URL
// parsing and only turn into "../" once the server decodes them.
function rawGetStatus(path: string) {
  const { port } = server.address() as AddressInfo;
  return new Promise<number>((done, fail) => {
    request({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    })
      .on("error", fail)
      .end();
  });
}

describe("createStaticServer", () => {
  it("serves index.html at / with the CSP header", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(await response.text()).toBe("<p>home</p>");
    expect(response.headers.get("content-security-policy")).toBe(TEST_CSP);
  });

  it("rewrites /privacy to privacy.html like netlify.toml", async () => {
    const response = await fetch(`${baseUrl}/privacy`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>privacy</p>");
  });

  it("sends the CSP header on 404s too", async () => {
    const response = await fetch(`${baseUrl}/missing.js`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toBe(TEST_CSP);
  });

  it("refuses path traversal out of the dist directory", async () => {
    for (const path of [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e%2fsecret.txt",
    ]) {
      expect(await rawGetStatus(path)).toBe(404);
    }
  });

  it("answers 404 for malformed or NUL-byte paths instead of crashing", async () => {
    expect(await rawGetStatus("/%E0%A4%A")).toBe(404);
    expect(await rawGetStatus("/%00")).toBe(404);
    expect((await fetch(`${baseUrl}/`)).status).toBe(200);
  });
});
