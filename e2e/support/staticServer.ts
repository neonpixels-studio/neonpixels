import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { CSP_HEADER_NAME } from "./enforcedCsp.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
// Mirrors the `/privacy` -> `/privacy.html` 200 rewrite in netlify.toml.
const REWRITES: Record<string, string> = { "/privacy": "/privacy.html" };

function resolveFilePath(distDir: string, urlPath: string) {
  const rewritten = REWRITES[urlPath] ?? urlPath;
  const relativePath = rewritten.endsWith("/")
    ? `${rewritten}index.html`
    : rewritten;
  const filePath = normalize(join(distDir, relativePath));
  // Refuses path traversal out of the dist directory.
  return filePath.startsWith(distDir + sep) ? filePath : null;
}

export function createStaticServer(distDir: string, csp: string): Server {
  const root = resolve(distDir);
  return createServer(async (request, response) => {
    const urlPath = decodeURIComponent(
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    const filePath = resolveFilePath(root, urlPath);
    try {
      if (!filePath) {
        throw new Error("outside dist");
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type":
          CONTENT_TYPES[extname(filePath)] ?? DEFAULT_CONTENT_TYPE,
        [CSP_HEADER_NAME]: csp,
      });
      response.end(body);
    } catch {
      response.writeHead(404, { [CSP_HEADER_NAME]: csp });
      response.end("Not found");
    }
  });
}
