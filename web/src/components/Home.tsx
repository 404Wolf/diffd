import { createSignal, For, Show } from "solid-js";
import type { ReviewSummary } from "../gen/ReviewSummary";
import { ago } from "../lib/time";

/** The landing page: recent reviews, newest first. */
export function Home(props: { reviews: ReviewSummary[] }) {
  const [reviews, setReviews] = createSignal(props.reviews);
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const remove = async (id: string) => {
    const res = await fetch(`/api/reviews/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setReviews((r) => r.filter((x) => x.review.id !== id));
    setConfirming(null);
  };
  document.title = "diffd";
  return (
    <div class="min-h-full bg-page px-4 py-8">
      <div class="mx-auto max-w-3xl">
        <h1 class="mb-1 flex items-center gap-2 font-mono text-lg font-semibold">
          <i class="size-2.5 rotate-45 rounded-[2px] bg-accent" />
          diffd
        </h1>
        <p class="mb-6 text-muted">
          Reviews your agents have shared with you. Ask an agent to share its changes to start one.
        </p>
        <Show
          when={reviews().length > 0}
          fallback={
            <div class="rounded-lg border border-line-strong bg-bg p-6 text-muted">
              No reviews yet. With diffd running, run{" "}
              <code class="font-mono text-fg">diffd setup claude</code> once, then ask Claude Code to “share
              your changes with diffd”.
            </div>
          }
        >
          <ul class="overflow-hidden rounded-lg border border-line-strong bg-bg">
            <For each={reviews()}>
              {({ review, unread }) => (
                <li class="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-hover">
                  <a href={`/r/${review.id}`} class="min-w-0 flex-1 text-fg no-underline">
                    <div class="flex items-center gap-2">
                      <span class="truncate font-semibold">{review.title}</span>
                      <Show when={unread > 0}>
                        <span class="rounded-full bg-accent px-1.5 text-[10px] leading-4 font-semibold text-accent-fg">
                          {unread}
                        </span>
                      </Show>
                    </div>
                    <div class="mt-0.5 truncate font-mono text-[11.5px] text-muted">
                      {review.repoName} · {review.from} → {review.to ?? "working tree"} · rev{" "}
                      {review.revision} · {ago(review.updatedAt)}
                    </div>
                  </a>
                  <Show
                    when={confirming() === review.id}
                    fallback={
                      <button
                        type="button"
                        class="cursor-pointer rounded px-2 py-1 text-xs text-muted hover:bg-inset hover:text-fg"
                        onClick={() => setConfirming(review.id)}
                      >
                        Delete
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="cursor-pointer rounded bg-del px-2 py-1 text-xs text-white"
                      onClick={() => remove(review.id)}
                    >
                      Delete for good
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
