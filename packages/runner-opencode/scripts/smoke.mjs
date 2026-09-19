// smoke.mjs — drives a running runner-opencode facade exactly as packages/dispatcher does:
// health → POST /session → GET /event → POST message → poll for session.idle → GET transcript,
// then a second turn that writes a file. Env: BASE_URL, MODEL (provider/model), AGENT, TASK, SECOND_TURN=0.
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4396';
const MODEL = process.env.MODEL ?? 'opencode-go/deepseek-v4.1-flash';
const AGENT = process.env.AGENT ?? 'builder';
const TASK =
  process.env.TASK ??
  'Reply with exactly one word: PONG. Then, on the next line, state which agent you are according to your system prompt, in five words or less.';
const out = (step, data) => console.log(JSON.stringify({ step, ...data }).slice(0, 1600));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// waitForHealthy
const deadline = Date.now() + 90_000;
while (true) {
  try {
    const r = await fetch(`${BASE}/global/health`);
    if (r.ok) {
      out('health', await r.json());
      break;
    }
  } catch {}
  if (Date.now() > deadline) {
    out('health', { error: 'timeout' });
    process.exit(1);
  }
  await sleep(1000);
}

// SSE consumer (opened concurrently with session creation, like the dispatcher)
const events = [];
const ac = new AbortController();
void (async () => {
  const res = await fetch(`${BASE}/event`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      for (; idx !== -1; idx = buf.indexOf('\n\n')) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (data) {
          try {
            events.push(JSON.parse(data));
          } catch {}
        }
      }
    }
  } catch {}
})();

const created = await (
  await fetch(`${BASE}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'run/it-local' }),
  })
).json();
out('session.create', created);
out('session.list', { list: await (await fetch(`${BASE}/session`)).json() });

const [providerID, ...rest] = MODEL.split('/');
const body = {
  parts: [{ type: 'text', text: TASK }],
  agent: AGENT,
  model: { providerID, modelID: rest.join('/') },
};
const t0 = Date.now();
const post = await fetch(`${BASE}/session/${created.id}/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
out('prompt.post', { status: post.status, body: await post.json(), ms: Date.now() - t0 });

// poll like runPollStatusLoop until session.idle arrives (or 120s)
const idleDeadline = Date.now() + 120_000;
while (Date.now() < idleDeadline && !events.some((e) => e.type === 'session.idle'))
  await sleep(1000);
out('turn', { ms: Date.now() - t0, idle: events.some((e) => e.type === 'session.idle') });

const msgs = await (await fetch(`${BASE}/session/${created.id}/message`)).json();
out('messages', {
  count: msgs.length,
  roles: msgs.map((m) => m.info?.role),
  partTypes: msgs.map((m) => (m.parts ?? []).map((p) => p.type).join(',')),
});
for (const m of msgs) out('message', { info: m.info, parts: m.parts });
out('events', {
  types: events.map((e) => e.type),
  updated: events
    .filter((e) => e.type === 'message.updated')
    .map((e) => ({
      id: e.properties?.info?.id,
      tokens: e.properties?.info?.tokens,
      cost: e.properties?.info?.cost,
    })),
  idle: events.filter((e) => e.type === 'session.idle').map((e) => e.properties),
});

// second turn (interactive-style follow-up on same session)
if (process.env.SECOND_TURN !== '0') {
  const n = events.length;
  await fetch(`${BASE}/session/${created.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [
        {
          type: 'text',
          text: 'Now create a file named hello.txt in the workspace containing the word hello, then reply DONE.',
        },
      ],
    }),
  });
  const d2 = Date.now() + 120_000;
  while (Date.now() < d2 && !events.slice(n).some((e) => e.type === 'session.idle'))
    await sleep(1000);
  const msgs2 = await (await fetch(`${BASE}/session/${created.id}/message`)).json();
  out('turn2', {
    count: msgs2.length,
    newParts: msgs2
      .slice(msgs.length)
      .map((m) =>
        (m.parts ?? [])
          .map((p) =>
            p.type === 'tool'
              ? `tool:${p.tool}:${p.state?.status}`
              : p.type === 'file'
                ? `file:${p.filename}`
                : p.type,
          )
          .join(','),
      ),
  });
  out('turn2.tools', {
    tools: msgs2
      .slice(msgs.length)
      .flatMap((m) => (m.parts ?? []).filter((p) => p.type === 'tool'))
      .map((p) => ({
        tool: p.tool,
        input: JSON.stringify(p.input ?? p.state?.input).slice(0, 160),
        output: String(p.state?.output ?? '').slice(0, 120),
      })),
  });
}
ac.abort();
process.exit(0);
