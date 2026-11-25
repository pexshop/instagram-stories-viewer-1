import worker from "../worker.js";

// Run the shared Worker API implementation inside Cloudflare Pages Functions.
// Requests outside the API are passed through to the Pages static asset handler.
export async function onRequest(context) {
  const env = {
    ...context.env,
    ASSETS: {
      fetch: () => context.next()
    }
  };
  return worker.fetch(context.request, env);
}
