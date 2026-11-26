// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticServer } from "../../../e2e/support/staticServer";

const TEST_CSP = "default-src 'self'";
const TEST_HEADERS = {
  "Content-Security-Policy": TEST_CSP,
  "X-Content-Type-Options": "nosniff",
};
let workspace: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "np-static-server-"));
  const distDir = join(workspace, "dist");
  mkdirSync(distDir);
  writeFileSync(join(distDir, "index.html"), "<p>home</p>");
  writeFileSync(join(distDir, "privacy.html"), "<p>privacy</p>");
  writeFileSync(join(distDir, "404.html"), "<p>not found page</p>");
  writeFileSync(join(workspace, "secret.txt"), "secret");
  server = createStaticServer(distDir, TEST_HEADERS);
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

async function getFromServer(distDir: string, path: string) {
  const isolatedServer = createStaticServer(distDir, TEST_HEADERS);
  await new Promise<void>((done) =>
    isolatedServer.listen(0, "127.0.0.1", done),
  );
  try {
    const { port } = isolatedServer.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { response, body: await response.text() };
  } finally {
    await new Promise((done) => isolatedServer.close(done));
  }
}

describe("createStaticServer", () => {
  it("serves index.html at / with the CSP header", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(await response.text()).toBe("<p>home</p>");
    expect(response.headers.get("content-security-policy")).toBe(TEST_CSP);
  });

  it("sends every generated header, not just the CSP", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps the content type of the file over a generated header", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.headers.get("content-type")).toContain("text/html");
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

  it("serves the built 404.html with a 404 status for missing paths", async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<p>not found page</p>");
    expect(response.headers.get("content-security-policy")).toBe(TEST_CSP);
  });

  it("falls back to plain text when the build has no 404.html", async () => {
    const bareDist = join(workspace, "bare-dist");
    mkdirSync(bareDist);
    const { response, body } = await getFromServer(bareDist, "/missing");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toBe("Not found");
    expect(response.headers.get("content-security-policy")).toBe(TEST_CSP);
  });

  // root can read a chmod 000 file, so the failure cannot be provoked there.
  it.skipIf(process.getuid?.() === 0)(
    "answers 500 when 404.html exists but cannot be read",
    async () => {
      const brokenDist = join(workspace, "broken-dist");
      mkdirSync(brokenDist);
      const pagePath = join(brokenDist, "404.html");
      writeFileSync(pagePath, "<p>hidden</p>");
      chmodSync(pagePath, 0o000);
      const { response, body } = await getFromServer(brokenDist, "/missing");
      expect(response.status).toBe(500);
      expect(body).toBe("Server error");
    },
  );

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
    const malformed = await fetch(`${baseUrl}/%E0%A4%A`);
    expect(await malformed.text()).toBe("<p>not found page</p>");
    expect(await rawGetStatus("/%00")).toBe(404);
    expect((await fetch(`${baseUrl}/`)).status).toBe(200);
  });
});
