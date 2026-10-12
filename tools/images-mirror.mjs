/**
 * Local GitHub mirror for the P6 images interop tests: an HTTP server whose
 * paths ARE the full upstream URLs (`GET /https://github.com/...`), matching
 * how GITHUB_MIRRORS candidates are composed by both implementations.
 *
 * Serves from a fixture directory:
 *   releases.json   — the /releases?per_page=100&... response body
 *   assets.txt      — lines "<url-path> <fixture-file>" served as downloads
 *
 * Usage: node tools/images-mirror.mjs <fixtureDir>  (prints the port line)
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [fixtureDir] = process.argv.slice(2);
const releasesBody = readFileSync(join(fixtureDir, "releases.json"));
const assetLines = readFileSync(join(fixtureDir, "assets.txt"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => {
    const sep = l.indexOf(" ");
    return [l.slice(0, sep), l.slice(sep + 1)];
  });

const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.replace(/^\//, ""));
  if (url.startsWith("https://api.github.com/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(releasesBody);
    return;
  }
  const hit = assetLines.find(([prefix]) => prefix === url);
  if (hit) {
    const stream = createReadStream(join(fixtureDir, hit[1]));
    res.writeHead(200, { "content-type": "application/octet-stream" });
    stream.pipe(res);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "mirror: not found" }));
});

server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
