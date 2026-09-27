/** Reading the state the server embedded in the page. */
import { listReviews, reviewState } from "../api";
import type { Boot } from "../gen/Boot";

export async function readBoot(): Promise<Boot> {
  const el = document.getElementById("diffd-boot");
  if (el?.textContent) return JSON.parse(el.textContent) as Boot;
  // `npm run dev`: nothing is embedded, so ask the running server.
  const m = /^\/r\/([^/]+)/.exec(location.pathname);
  if (m?.[1]) {
    const { data, error } = await reviewState({ path: { id: decodeURIComponent(m[1]) } });
    return data
      ? { page: "review", state: data }
      : { page: "notFound", message: String(error ?? "Not found") };
  }
  const { data } = await listReviews();
  return { page: "home", reviews: data ?? [] };
}
