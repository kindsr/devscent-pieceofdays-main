// CI-only receiving-byte control. This replaces the upstream temporarily; it is not Next evidence.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

createServer((req, res) => {
  const chunks = [];
  const digest = createHash("sha256");
  let bodyLength = 0;
  req.on("data", (chunk) => {
    bodyLength += chunk.length;
    digest.update(chunk);
    if (bodyLength <= 64 * 1024) chunks.push(chunk);
    else chunks.length = 0;
  });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ method: req.method, target: req.url, rawHeaders: req.rawHeaders,
      body: bodyLength <= 64 * 1024 ? Buffer.concat(chunks).toString("utf8") : undefined,
      bodyLength, bodySha256: digest.digest("hex") }));
  });
}).listen(3000, "0.0.0.0");
