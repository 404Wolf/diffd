// Act as the user on a review's page, over its WebSocket: leave a comment
// and/or a chat message, then wait for the agent to answer them.
//
//   node scripts/as-user.mjs <port> <review-id> [--comment path:line text] [--chat text] [--wait secs]
//
// Exits 0 once every thread commented on has an agent reply and every chat
// message an agent answer after it; 1 on timeout. Prints what the agent said.
const args = process.argv.slice(2);
const [port, reviewId] = args;
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.slice(i + 1, i + 3) : null;
};
const comment = opt("--comment");
const chat = opt("--chat")?.[0];
const waitSecs = Number(opt("--wait")?.[0] ?? 120);
const id = (p) => `${p}-e2e-${Math.random().toString(36).slice(2, 12)}`;

const ws = new WebSocket(`ws://127.0.0.1:${port}/api/reviews/${reviewId}/ws`);
const threadId = id("t");
let startedAt = 0;
let done = false;
const state = async () => (await fetch(`http://127.0.0.1:${port}/api/reviews/${reviewId}`)).json();
ws.onopen = () => {
  startedAt = Date.now();
  if (comment) {
    const [where, body] = comment;
    const [path, line] = [where.slice(0, where.lastIndexOf(":")), Number(where.slice(where.lastIndexOf(":") + 1))];
    ws.send(JSON.stringify({ type: "comment", threadId, messageId: id("m"), anchor: { path, side: "new", start: line, end: line, text: "" }, body }));
  }
  if (chat) ws.send(JSON.stringify({ type: "chat", messageId: id("m"), body: chat }));
  console.log(`sent${comment ? " a comment" : ""}${chat ? " a chat message" : ""}; waiting for the agent…`);
};
ws.onerror = (e) => {
  console.error("socket error", e.message ?? e);
  process.exit(1);
};
const deadline = Date.now() + waitSecs * 1000;
while (!done && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  if (!startedAt) continue;
  const s = await state();
  const thread = s.threads.find((t) => t.id === threadId);
  const replied = !comment || thread?.messages.some((m) => m.author === "agent");
  const lastUser = Math.max(0, ...s.chat.filter((m) => m.author === "user").map((m) => m.createdAt));
  const answered = !chat || s.chat.some((m) => m.author === "agent" && m.createdAt >= lastUser);
  if (replied && answered) {
    done = true;
    for (const m of thread?.messages.filter((m) => m.author === "agent") ?? []) console.log(`agent replied in the thread: ${m.body}`);
    for (const m of s.chat.filter((m) => m.author === "agent" && m.createdAt >= lastUser)) console.log(`agent said: ${m.body}`);
    console.log(`answered after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
}
ws.close();
if (!done) console.log("timed out: the agent didn't answer");
process.exit(done ? 0 : 1);
