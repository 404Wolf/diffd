import { createResource, Show } from "solid-js";
import { match } from "ts-pattern";
import { Home } from "./components/Home";
import { ReviewPage } from "./components/ReviewPage";
import { readBoot } from "./lib/boot";

export function App() {
  const [boot] = createResource(readBoot);
  return (
    <Show when={boot()} fallback={<p class="p-6 text-muted">Loading…</p>}>
      {(b) =>
        match(b())
          .with({ page: "home" }, ({ reviews }) => <Home reviews={reviews} />)
          .with({ page: "review" }, ({ state }) => <ReviewPage state={state} />)
          .with({ page: "notFound" }, ({ message }) => (
            <div class="p-8">
              <p class="mb-2 font-semibold">{message}</p>
              <a href="/" class="text-accent">
                See recent reviews
              </a>
            </div>
          ))
          .exhaustive()
      }
    </Show>
  );
}
