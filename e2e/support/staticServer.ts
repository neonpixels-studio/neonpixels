import { createServer, type Server, type ServerResponse } from "node:http";
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
// A missing file or a directory path is a plain 404; any other read failure
// (permissions, I/O) is a broken build output and must surface as a 500.
const NOT_FOUND_ERROR_CODES = new Set(["ENOENT", "EISDIR", "ENOTDIR"]);
// Netlify serves the built 404.html with a 404 status for any missing path.
const NOT_FOUND_PAGE = "/404.html";

function decodeUrlPath(rawUrl: string | undefined) {
  try {
    const decoded = decodeURIComponent(
      new URL(rawUrl ?? "/", "http://localhost").pathname,
    );
    // A NUL byte makes readFile throw; treat it as a bad path, not a server error.
    return decoded.includes("\0") ? null : decoded;
  } catch {
    return null;
  }
}

function resolveFilePath(distDir: string, urlPath: string) {
  const rewritten = REWRITES[urlPath] ?? urlPath;
  const relativePath = rewritten.endsWith("/")
    ? `${rewritten}index.html`
    : rewritten;
  const filePath = normalize(join(distDir, relativePath));
  // Refuses path traversal out of the dist directory.
  return filePath.startsWith(distDir + sep) ? filePath : null;
}

function send(
  response: ServerResponse,
  status: number,
  csp: string,
  contentType: string,
  body: Buffer | string,
) {
  response.writeHead(status, {
    "Content-Type": contentType,
    [CSP_HEADER_NAME]: csp,
  });
  response.end(body);
}

function errorCode(error: unknown) {
  return (error as { code?: string }).code ?? "";
}

async function sendNotFound(
  response: ServerResponse,
  csp: string,
  distDir: string,
) {
  try {
    const body = await readFile(join(distDir, NOT_FOUND_PAGE));
    send(response, 404, csp, CONTENT_TYPES[".html"], body);
  } catch (error) {
    // No built 404.html (e.g. a bare test fixture): fall back to plain text.
    if (NOT_FOUND_ERROR_CODES.has(errorCode(error))) {
      send(response, 404, csp, "text/plain", "Not found");
      return;
    }
    console.error("e2e static server failed to read the 404 page", error);
    send(response, 500, csp, "text/plain", "Server error");
  }
}

async function sendFailure(
  response: ServerResponse,
  csp: string,
  distDir: string,
  error: unknown,
) {
  if (NOT_FOUND_ERROR_CODES.has(errorCode(error))) {
    await sendNotFound(response, csp, distDir);
    return;
  }
  console.error("e2e static server failed to read a file", error);
  send(response, 500, csp, "text/plain", "Server error");
}

export function createStaticServer(distDir: string, csp: string): Server {
  const root = resolve(distDir);
  return createServer(async (request, response) => {
    const urlPath = decodeUrlPath(request.url);
    const filePath = urlPath === null ? null : resolveFilePath(root, urlPath);
    if (!filePath) {
      await sendNotFound(response, csp, root);
      return;
    }
    try {
      const body = await readFile(filePath);
      const contentType =
        CONTENT_TYPES[extname(filePath)] ?? DEFAULT_CONTENT_TYPE;
      send(response, 200, csp, contentType, body);
    } catch (error) {
      await sendFailure(response, csp, root, error);
    }
  });
}
