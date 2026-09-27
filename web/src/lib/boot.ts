/** Reading the state the server embedded in the page. */
import type { Boot } from "../gen/Boot";

export async function readBoot(): Promise<Boot> {
  const el = document.getElementById("diffd-boot");
  if (el?.textContent) return JSON.parse(el.textContent) as Boot;
  // `npm run dev`: nothing is embedded, so ask the running server.
  const m = /^\/r\/([^/]+)/.exec(location.pathname);
  if (m) {
    const res = await fetch(`/api/reviews/${m[1]}`);
    if (!res.ok) return { page: "notFound", message: await res.text() };
    return { page: "review", state: await res.json() };
  }
  const res = await fetch("/api/reviews");
  return { page: "home", reviews: res.ok ? await res.json() : [] };
}
