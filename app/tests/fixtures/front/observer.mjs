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
    // Distinct, CI-only upstream values. An outer response must never expose any of them.
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store",
      "X-Powered-By": "ci-observer-banner", "X-Frame-Options": "ci-upstream-frame",
      "X-Content-Type-Options": "ci-upstream-sniff", "Referrer-Policy": "unsafe-url",
      "Strict-Transport-Security": "max-age=1; ci-upstream" });
    res.end(JSON.stringify({ method: req.method, target: req.url, rawHeaders: req.rawHeaders,
      body: bodyLength <= 64 * 1024 ? Buffer.concat(chunks).toString("utf8") : undefined,
      bodyLength, bodySha256: digest.digest("hex") }));
  });
}).listen(3000, "0.0.0.0");
