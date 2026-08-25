import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const PROXY_PATHS = new Set(["/health", "/v1"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function loadWebServerConfig(env = process.env) {
  const host = env.ACP_WEB_HOST?.trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("ACP_WEB_HOST must be a loopback host");

  const rawPort = env.ACP_WEB_PORT ?? "4173";
  if (!/^\d+$/.test(rawPort)) throw new Error("ACP_WEB_PORT must be an integer from 1 to 65535");
  const port = Number(rawPort);
  if (port < 1 || port > 65_535) throw new Error("ACP_WEB_PORT must be an integer from 1 to 65535");

  const upstream = new URL(env.ACP_WEB_API_ORIGIN?.trim() || "http://127.0.0.1:8787");
  if (upstream.protocol !== "http:" || !LOOPBACK_HOSTS.has(upstream.hostname) || upstream.username || upstream.password) {
    throw new Error("ACP_WEB_API_ORIGIN must be an unauthenticated loopback HTTP origin");
  }
  if (upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("ACP_WEB_API_ORIGIN must not contain a path, query, or fragment");
  }

  const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const root = resolve(packageRoot, env.ACP_WEB_STATIC_DIRECTORY?.trim() || "dist");
  return { host, port, upstream, root };
}

export function isProxyPath(pathname) {
  return PROXY_PATHS.has(pathname) || pathname.startsWith("/v1/");
}

function withoutHopByHop(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())));
}

function requestTarget(request) {
  const raw = request.url ?? "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) throw new Error("Absolute request targets are not accepted");
  return new URL(raw, "http://owner-host.invalid");
}

function proxyHttp(request, response, upstream) {
  const incoming = requestTarget(request);
  const target = new URL(`${incoming.pathname}${incoming.search}`, upstream);
  const proxy = httpRequest(target, {
    method: request.method,
    headers: {
      ...withoutHopByHop(request.headers),
      host: upstream.host,
      "x-forwarded-host": request.headers.host ?? "",
      "x-forwarded-proto": "http",
    },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, withoutHopByHop(upstreamResponse.headers));
    upstreamResponse.pipe(response);
  });
  proxy.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("Owner-host API unavailable");
  });
  request.pipe(proxy);
}

async function serveStatic(request, response, root) {
  let url;
  let requestedPath;
  try {
    url = requestTarget(request);
    requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid request target");
    return;
  }
  const filePath = resolve(root, `.${requestedPath}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(filePath)]);
    if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(resolvedFile);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": types[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    createReadStream(resolvedFile).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

function proxyWebSocket(request, socket, head, upstream) {
  const incoming = requestTarget(request);
  const target = new URL(`${incoming.pathname}${incoming.search}`, upstream);
  const proxy = httpRequest(target, {
    method: request.method,
    headers: { ...request.headers, host: upstream.host },
  });
  proxy.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
    const headerLines = [];
    for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
      headerLines.push(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`);
    }
    socket.write(`${statusLine}${headerLines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  proxy.on("response", (response) => {
    socket.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
    response.pipe(socket);
  });
  proxy.on("error", () => socket.destroy());
  proxy.end();
}

export function createWebServer(config) {
  const server = createServer((request, response) => {
    let url;
    try {
      url = requestTarget(request);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid request target");
      return;
    }
    if (isProxyPath(url.pathname)) {
      proxyHttp(request, response, config.upstream);
      return;
    }
    void serveStatic(request, response, config.root);
  });
  server.on("upgrade", (request, socket, head) => {
    let url;
    try {
      url = requestTarget(request);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.pathname !== "/v1/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    proxyWebSocket(request, socket, head, config.upstream);
  });
  return server;
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const config = loadWebServerConfig();
  const server = createWebServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`Relayroom preview: http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`);
  });
}
