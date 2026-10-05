import { createServer } from "node:http";
import { MockPriceAdapter } from "./price-adapter.mjs";

const port = Number(process.env.PORT ?? 8787);
const adapter = new MockPriceAdapter();
const sampleRound = {
  id: "demo-0001", phase: "OPEN", token: "$TIKTOK", tokenAgeSeconds: 360,
  opensAt: Date.now() - 20_000, cutoffAt: Date.now() + 15_000,
  startsAt: Date.now() + 20_000, endsAt: Date.now() + 80_000,
  source: "MOCK_ONLY", poolAddress: "mock-pool", pools: { UP: "2300000000", DOWN: "1800000000" },
};

createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("access-control-allow-origin", "*");
  if (request.url === "/health") return response.end(JSON.stringify({ ok: true, source: "MOCK_ONLY" }));
  if (request.url === "/v1/arena/current") return response.end(JSON.stringify(sampleRound));
  if (request.url === "/v1/arena/current/observations") {
    const now = Math.floor(Date.now() / 1000);
    const [p0, p1] = await Promise.all([
      adapter.quoteWindow({ windowStart: now - 65, windowEnd: now - 60, kind: "P0" }),
      adapter.quoteWindow({ windowStart: now - 5, windowEnd: now, kind: "P1" }),
    ]);
    return response.end(JSON.stringify({ p0: { ...p0, price: p0.price.toString() }, p1: { ...p1, price: p1.price.toString() } }));
  }
  response.statusCode = 404;
  return response.end(JSON.stringify({ error: "NOT_FOUND" }));
}).listen(port, () => console.log(`FlipTheMeme mock keeper on http://localhost:${port}`));
