// Dev server. Uses Bun.serve so static files under public/ are
// served alongside the hot-reloaded HTML bundle. The GitHub Pages
// build is static (bun build ... --outdir dist), so this server
// exists only for local dev.
//
// Usage: bun run viewer:dev

import index from "./index.html" with { type: "html" };

const PORT = Number(process.env.PORT ?? 3000);

Bun.serve({
  port: PORT,
  development: true,
  // Route table. `/` and any unknown path render the React app (SPA);
  // all files under `public/` map to `/<name>` at the root so the
  // fetchSource can do `fetch("/index.json")` and `fetch("/bundle.json")`.
  routes: {
    "/": index,
    "/index.json": () => new Response(Bun.file("./viewer/public/index.json")),
    "/bundle.json": () => new Response(Bun.file("./viewer/public/bundle.json")),
    "/bundle-greenberg-ibm.json": () => new Response(Bun.file("./viewer/public/bundle-greenberg-ibm.json")),
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`[serve] http://localhost:${PORT}`);
