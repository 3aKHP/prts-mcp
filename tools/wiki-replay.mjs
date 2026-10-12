/**
 * Wiki HTTPS replay proxy (P5 differential harness).
 *
 * The TS oracle's endpoint is hardcoded (https://prts.wiki/api.php), so the
 * differential runner routes BOTH children through this local CONNECT MITM
 * proxy: bun's fetch honors lowercase `https_proxy` and trusts
 * `NODE_EXTRA_CA_CERTS`; the Rust client honors the same envs (reqwest
 * proxy defaults + the parity CA hook). The proxy terminates TLS with a
 * locally generated cert for prts.wiki / media.prts.wiki and answers from
 * fixed scripts under contracts/wiki-replay/ — no public network involved.
 *
 * Scripts: { "rules": [{ "match": { method, query? | form? }, "respond":
 * { status, json? | body?, content_type?, delay_ms? } }], "default": respond }
 * Matching is on the exact parameter set (GET query pairs / POST form pairs).
 */
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const WIKI_PROXY_DIR = join(ROOT, ".runtime", "wiki-proxy");
export const WIKI_REPLAY_DIR = join(ROOT, "contracts", "wiki-replay");

/** Generate the local CA + server cert once (30-day validity). */
export function ensureWikiCerts() {
  if (existsSync(join(WIKI_PROXY_DIR, "srv.pem"))) return;
  mkdirSync(WIKI_PROXY_DIR, { recursive: true });
  const run = (args) => execFileSync("openssl", args, { cwd: WIKI_PROXY_DIR, stdio: ["ignore", "ignore", "ignore"] });
  run(["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ca.key", "-out", "ca.pem",
    "-days", "30", "-nodes", "-subj", "/CN=PRTS-Diff-Replay-CA"]);
  writeFileSync(join(WIKI_PROXY_DIR, "san.cnf"),
    "subjectAltName=DNS:prts.wiki,DNS:media.prts.wiki,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  run(["req", "-newkey", "rsa:2048", "-keyout", "srv.key", "-out", "srv.csr",
    "-nodes", "-subj", "/CN=prts.wiki"]);
  run(["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", "srv.pem", "-days", "30", "-extfile", "san.cnf"]);
}

/**
 * Start the replay proxy for one script name. Returns
 * { port, close(), caPath } — the runner injects proxy/CA envs into children.
 */
export async function startWikiReplay(scriptName) {
  ensureWikiCerts();
  const scriptPath = join(WIKI_REPLAY_DIR, scriptName.endsWith(".json") ? scriptName : `${scriptName}.json`);
  const script = JSON.parse(readFileSync(scriptPath, "utf-8"));
  const tlsOptions = {
    key: readFileSync(join(WIKI_PROXY_DIR, "srv.key")),
    cert: readFileSync(join(WIKI_PROXY_DIR, "srv.pem")),
    // rustls (reqwest) negotiates ALPN and stalls without a shared protocol;
    // bun/undici accept plain http/1.1 either way.
    ALPNProtocols: ["http/1.1"],
  };

  const respondWith = (socket, respond, request) => {
    const send = () => {
      // Dynamic segment rendering for template batch POSTs: the request
      // text carries random PRTSMCP_<uuid> markers, so the response is
      // derived from the request itself. `render_segments` re-emits each
      // marked value wrapped by prefix/suffix (markers preserved in order),
      // with fault injections for the boundary-error branches.
      if (respond.render_segments) {
        const cfg = respond.render_segments;
        const chunks = (request?.text ?? "").split("\n\n");
        const parts = chunks.map((chunk) => {
          const lines = chunk.split("\n");
          const begin = lines[0];
          const end = lines[lines.length - 1];
          const value = lines.slice(1, -1).join("\n");
          const m = begin.match(/^PRTSMCP_[0-9a-f]+_BEGIN_(\d+)_$/);
          if (!m || !end.endsWith(`_END_${m[1]}_`)) {
            throw new Error(`replay: unparseable segment ${JSON.stringify(chunk.slice(0, 60))}`);
          }
          return { index: Number(m[1]), begin, end, value };
        });
        let rebuilt;
        if (cfg.scramble) {
          const swapped = [...chunks];
          if (swapped.length >= 2) {
            [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
          }
          rebuilt = swapped.join("\n\n");
        } else if (cfg.drop_end) {
          rebuilt = chunks[0].replace(/\nPRTSMCP_[0-9a-f]+_END_0_$/, "");
        } else if (cfg.empty) {
          rebuilt = "   ";
        } else {
          rebuilt = parts
            .map((p) => `${p.begin}\n${cfg.prefix ?? ""}${p.value}${cfg.suffix ?? ""}\n${p.end}`)
            .join("\n\n");
        }
        const body = JSON.stringify({
          parse: { text: { "*": cfg.html === false ? rebuilt : `<p>${rebuilt}</p>` } },
        });
        const head =
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`;
        socket.end(head + body);
        return;
      }
      let body;
      let contentType = respond.content_type;
      if (respond.json !== undefined) {
        body = JSON.stringify(respond.json);
        contentType = contentType ?? "application/json";
      } else {
        body = respond.body ?? "";
        contentType = contentType ?? "application/octet-stream";
      }
      const status = respond.status ?? 200;
      const reason = status === 200 ? "OK" : status === 404 ? "Not Found" : status === 500 ? "Internal Server Error" : "Status";
      const head =
        `HTTP/1.1 ${status} ${reason}\r\nContent-Type: ${contentType}\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`;
      socket.end(head + body);
    };
    if (respond.delay_ms) {
      setTimeout(send, respond.delay_ms);
    } else {
      send();
    }
  };

  const findRule = (method, params) => {
    const sorted = (obj) => {
      const keys = Object.keys(obj ?? {}).sort();
      return keys.map((k) => `${k}=${obj[k]}`);
    };
    const requestPairs = new Set(sorted(params));
    for (const rule of script.rules ?? []) {
      if ((rule.match?.method ?? "GET") !== method) continue;
      const rulePairs = sorted(rule.match?.query ?? rule.match?.form);
      if (method === "GET") {
        // GET rules pin the exact parameter set — the differential also
        // verifies WHICH parameters each implementation sends.
        if (rulePairs.length !== requestPairs.size) continue;
        if (rulePairs.every((p) => requestPairs.has(p))) return rule.respond;
      } else {
        // POST rules are subset matches: the template batch body carries a
        // random UUID marker text that cannot be pre-scripted.
        if (rulePairs.every((p) => requestPairs.has(p))) return rule.respond;
      }
    }
    return script.default ?? {
      status: 404,
      json: { error: { code: "replay-unmatched", info: "no replay rule matched this request" } },
    };
  };

  const handleTls = (socket) => {
    let buffer = "";
    let contentLength = 0;
    let headerDone = false;
    let method = "";
    let path = "";
    let responded = false;
    socket.on("data", (chunk) => {
      if (responded) return;
      buffer += chunk.toString("utf8");
      if (!headerDone) {
        const idx = buffer.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buffer.slice(0, idx);
        const body = buffer.slice(idx + 4);
        const lines = head.split("\r\n");
        [method, path] = lines[0].split(" ");
        const lengthHeader = lines.find((l) => l.toLowerCase().startsWith("content-length:"));
        contentLength = lengthHeader ? Number(lengthHeader.split(":")[1].trim()) : 0;
        headerDone = true;
        buffer = body;
      }
      if (buffer.length >= contentLength) {
        responded = true;
        let params = {};
        const q = path.indexOf("?");
        if (method === "GET" && q !== -1) {
          for (const pair of path.slice(q + 1).split("&")) {
            const eq = pair.indexOf("=");
            if (eq === -1) continue;
            params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, "%20"));
          }
        } else if (method === "POST") {
          for (const pair of buffer.split("&")) {
            const eq = pair.indexOf("=");
            if (eq === -1) continue;
            params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, "%20"));
          }
        }
        const request = { params, text: method === "POST" ? (params.text ?? "") : undefined };
        log(method, "params:", JSON.stringify(Object.fromEntries(
          Object.entries(params).filter(([k]) => k !== "text").map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 30) : v]),
        )), "text:", JSON.stringify(request.text?.slice(0, 80)));
        respondWith(socket, findRule(method, params), request);
      }
    });
    socket.on("error", () => {});
  };

  const debug = process.env.WIKI_REPLAY_DEBUG === "1";
  const log = (...a) => { if (debug) console.error("[replay]", ...a); };
  const server = createServer((socket) => {
    socket.once("data", (buf) => {
      const head = buf.toString("latin1");
      log("first chunk:", JSON.stringify(head.slice(0, 60)));
      if (!/^CONNECT /m.test(head)) {
        socket.destroy();
        return;
      }
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      log("CONNECT answered");
      const tlsSock = new tls.TLSSocket(socket, { isServer: true, ...tlsOptions });
      tlsSock.on("secure", () => log("tls handshake done, alpn:", tlsSock.alpnProtocol));
      tlsSock.on("error", (e) => log("tls error:", e.message));
      handleTls(tlsSock);
    });
    socket.on("error", (e) => log("socket error:", e.message));
  });

  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

  return {
    port,
    caPath: join(WIKI_PROXY_DIR, "ca.pem"),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
