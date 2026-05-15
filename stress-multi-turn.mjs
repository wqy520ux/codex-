// Stress test: simulate Codex's multi-turn flow against the adapter,
// with reasoning + function_call + function_call_output round-trips.
// Catches the "reasoning_content must be passed back" class of bug
// for any reasoning-capable provider.
//
// Usage:
//   node stress-multi-turn.mjs <provider-alias>
//   e.g. node stress-multi-turn.mjs mimo-via-adapter
//
// The script reads the adapter at 127.0.0.1:18787 / 11434 (whatever
// the running config has). It performs 3 turns of:
//   user → reasoning + function_call → adapter → upstream
//   tool result + reasoning → adapter → upstream
//   final assistant text

const ADAPTER = process.env.ADAPTER_BASE ?? "http://127.0.0.1:11434/v1";
const ALIAS = process.argv[2] ?? "gpt-4o";

let pass = 0;
let fail = 0;

async function step(name, fn) {
  process.stdout.write(`  ▸ ${name} … `);
  try {
    const out = await fn();
    pass += 1;
    console.log(`✓${out ? "  " + out : ""}`);
    return true;
  } catch (err) {
    fail += 1;
    console.log(`✗ ${err.message}`);
    return false;
  }
}

async function postSse(body) {
  const res = await fetch(`${ADAPTER}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
  let lastType = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith("event: ")) lastType = line.slice(7).trim();
      else if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const evt = JSON.parse(data);
          evt.type = evt.type ?? lastType;
          events.push(evt);
        } catch {}
        lastType = null;
      }
    }
  }
  return events;
}

function findOutput(events) {
  const completed = events.findLast?.((e) => e.type === "response.completed");
  return completed?.response?.output ?? [];
}

async function runScenario(modelAlias, prompt) {
  console.log(`\n--- ${modelAlias}: "${prompt}" ---`);

  const tools = [
    {
      type: "function",
      name: "shell",
      description: "Run a shell command and return its output",
      parameters: {
        type: "object",
        properties: { command: { type: "array", items: { type: "string" } } },
        required: ["command"],
      },
    },
  ];

  // Maintain Codex-style conversation history.
  const inputItems = [];
  inputItems.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: prompt }],
  });

  let turn = 1;
  while (turn <= 5) {
    const turnOk = await step(`turn ${turn}`, async () => {
      const events = await postSse({
        model: modelAlias,
        input: inputItems,
        tools,
        tool_choice: "auto",
        stream: true,
      });
      const output = findOutput(events);
      if (output.length === 0) {
        throw new Error("no output items in response.completed");
      }

      // Append every output item as input for next turn (mimics Codex).
      for (const item of output) {
        inputItems.push(item);
      }

      // If there's a function_call, simulate executing it and feed
      // the result back. Otherwise we're done.
      const fc = output.find((o) => o.type === "function_call");
      if (fc !== undefined) {
        // Synthesise a tool result.
        const fakeOutput = "ok: count=40";
        inputItems.push({
          type: "function_call_output",
          call_id: fc.call_id,
          output: fakeOutput,
        });
        return `tool_call ${fc.name}(${fc.arguments?.slice(0, 60)})`;
      }
      const msg = output.find((o) => o.type === "message");
      const text = msg?.content?.[0]?.text ?? "(empty)";
      return `final: "${text.slice(0, 50)}"`;
    });
    if (!turnOk) return;
    const lastItem = inputItems[inputItems.length - 1];
    if (lastItem.type !== "function_call_output") break;
    turn += 1;
  }
}

await runScenario(ALIAS, "Use the shell tool to count something. Then report back.");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
