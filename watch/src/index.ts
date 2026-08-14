export interface Env {
  WATCH: Queue<Ticket>;
  TICKETS: KVNamespace;
  MUSE_WATCH_HMAC: string;
  JULES_API_KEY: string;
  GITHUB_DISPATCH_TOKEN: string;
}

export type Ticket = {
  session_id: string;
  repo: string;
  pr: number;
  deadline: number;
  start_run_id: number;
};

type JulesState = "pending" | "ready" | "failed";

const encoder = new TextEncoder();

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let out = 0;
  for (let i = 0; i < left.length; i++) out |= left[i] ^ right[i];
  return out === 0;
}

function ticketKey(repo: string, pr: number): string {
  return `pr:${repo}:${pr}`;
}

async function julesState(env: Env, sessionId: string): Promise<JulesState> {
  const res = await fetch(
    `https://jules.googleapis.com/v1alpha/sessions/${sessionId}/activities?pageSize=30`,
    { headers: { "x-goog-api-key": env.JULES_API_KEY } },
  );
  if (!res.ok) {
    throw new Error(`jules ${res.status}`);
  }
  const json = (await res.json()) as {
    activities?: Array<{
      originator?: string;
      agentMessaged?: { agentMessage?: string };
      sessionFailed?: unknown;
    }>;
  };
  const activities = json.activities ?? [];
  if (activities.some((a) => a.sessionFailed != null)) return "failed";
  if (
    activities.some(
      (a) => a.originator === "agent" && a.agentMessaged?.agentMessage,
    )
  ) {
    return "ready";
  }
  return "pending";
}

async function dispatch(env: Env, t: Ticket, outcome: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${t.repo}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "muse-watch",
    },
    body: JSON.stringify({
      event_type: "muse-pr-description-ready",
      client_payload: {
        session_id: t.session_id,
        pr: t.pr,
        outcome,
        start_run_id: t.start_run_id,
      },
    }),
  });
  if (res.ok || res.status === 204) return;
  const text = await res.text();
  const err = new Error(`dispatch ${res.status}`);
  // 4xx (except 429) will not succeed on retry — ack instead of looping.
  (err as Error & { fatal?: boolean }).fatal =
    res.status >= 400 && res.status < 500 && res.status !== 429;
  console.log(`dispatch failed ${res.status} ${text.slice(0, 200)}`);
  throw err;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return new Response("muse-watch", { status: 200 });
    }
    if (req.method !== "POST" || url.pathname !== "/watch") {
      return new Response("not found", { status: 404 });
    }

    const body = await req.text();
    const expected = await hmacHex(env.MUSE_WATCH_HMAC, body);
    const got = (req.headers.get("x-muse-signature") ?? "").toLowerCase();
    if (!timingSafeEqual(expected, got)) {
      return new Response("unauthorized", { status: 401 });
    }

    let t: Ticket;
    try {
      t = JSON.parse(body) as Ticket;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!t.session_id || !t.repo || !t.pr || !t.deadline || !t.start_run_id) {
      return new Response("missing fields", { status: 400 });
    }

    await env.TICKETS.put(ticketKey(t.repo, t.pr), t.session_id, {
      expirationTtl: 60 * 40,
    });
    await env.WATCH.send(t, { delaySeconds: 45 });
    return new Response("ok");
  },

  async queue(batch: MessageBatch<Ticket>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const t = msg.body;
      try {
        const current = await env.TICKETS.get(ticketKey(t.repo, t.pr));
        if (current && current !== t.session_id) {
          msg.ack();
          continue;
        }

        const now = Math.floor(Date.now() / 1000);
        if (now >= t.deadline) {
          await dispatch(env, t, "timeout");
          msg.ack();
          continue;
        }

        const state = await julesState(env, t.session_id);
        if (state === "pending") {
          msg.retry({ delaySeconds: 60 });
          continue;
        }
        await dispatch(env, t, state);
        msg.ack();
      } catch (err) {
        if ((err as { fatal?: boolean }).fatal) {
          msg.ack();
          continue;
        }
        msg.retry({ delaySeconds: 60 });
      }
    }
  },
};
