/** Reading the state the server embedded in the page. */

import type { Boot } from "../api";
import { boardItem, listBoard, listReviews, reviewState } from "../api";
import { openFromLocation } from "./board";

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
  const board = /^\/show(?:\/([^/]+))?/.exec(location.pathname);
  if (board) {
    const scope = board[1] ? decodeURIComponent(board[1]) : null;
    const id = openFromLocation(location);
    const [{ data: items }, open] = await Promise.all([
      listBoard({ query: scope === null ? {} : { scope } }),
      id ? boardItem({ path: { id } }) : Promise.resolve({ data: undefined }),
    ]);
    return { page: "board", scope, items: items ?? [], open: open.data ?? null };
  }
  const { data } = await listReviews();
  return { page: "home", reviews: data ?? [] };
}
