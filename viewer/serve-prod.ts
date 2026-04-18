// Serve the production-built viewer (viewer/dist) for local perf
// tests. Runs against the same minified React that GH Pages serves.

const PORT = Number(process.env.PORT ?? 3001);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let p = url.pathname;
    if (p === "/" || p === "") p = "/index.html";
    const f = Bun.file("./viewer/dist" + p);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f);
  },
  error() { return new Response("error", { status: 500 }); },
});

console.log(`[serve-prod] http://localhost:${PORT}`);
