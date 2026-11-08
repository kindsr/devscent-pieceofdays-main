// CI-only receiving-byte control. This replaces the upstream temporarily; it is not Next evidence.
import { createServer } from "node:http";

createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ method: req.method, target: req.url, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString("utf8") }));
  });
}).listen(3000, "0.0.0.0");
