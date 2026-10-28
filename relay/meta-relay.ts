// Supabase Edge Function "meta-relay": forwards First Answer's Meta Model API calls.
// Why: Meta's API currently returns empty model lists / model_not_found for calls from some
// cloud hosts (Render, Railway), while other hosts get through. This relay runs on Supabase's
// edge and passes requests straight to https://api.meta.ai/v1.
//
// - Our server sends its own Authorization: Bearer <Meta key>; the relay forwards it untouched.
//   The Meta key is never stored here.
// - Only calls carrying x-relay-key = this project's anon key are accepted, and only Meta
//   Model API paths are forwarded, so it is not an open proxy.
// - Deploy with "Verify JWT" turned OFF (the x-relay-key check replaces it).

const META = "https://api.meta.ai/v1";
const ALLOWED = /^\/(models(\/[\w.\-]+)?|chat\/completions|responses(\/[\w\-]+)?|images\/(edits|generations)|asr\/transcribe|files(\/[\w\-]+)?)$/;
const PASS_BACK = ["content-type", "x-request-id", "x-route"];

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/meta-relay/, "") || "/";

  if (path === "/health") return Response.json({ ok: true, relay: "meta-relay" });

  const expected = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!expected || req.headers.get("x-relay-key") !== expected) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (!ALLOWED.test(path)) return Response.json({ error: "path not allowed" }, { status: 404 });
  const auth = req.headers.get("authorization");
  if (!auth) return Response.json({ error: "missing authorization" }, { status: 401 });

  const headers = new Headers({ authorization: auth });
  for (const h of ["content-type", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const upstream = await fetch(META + path + url.search, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    // @ts-ignore: streaming request bodies need half duplex
    duplex: hasBody ? "half" : undefined,
  });

  const out = new Headers();
  for (const h of PASS_BACK) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("x-relayed-by", "supabase-meta-relay");
  return new Response(upstream.body, { status: upstream.status, headers: out });
});
