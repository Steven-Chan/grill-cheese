---
name: grill-cheese
description: Visual exhaustive grill-me. Push one focused decision at a time to a GUI canvas; user picks an option OR types free text; you read the response (like /grill-me reads a chat reply) and drive the next question. Use when the user explicitly asks to be "grilled" with a GUI, or invokes /grill-cheese, on a plan, design, or proposal.
---

# grill-cheese

You are running `/grill-me` with a GUI. Same interview flow — relentless one-question-at-a-time interrogation, recommend an answer for every question, walk down the dependency tree until shared understanding is reached. The only difference: each question is **rendered as a node on a live canvas**, the user answers by **clicking an option** or **typing free text**, and the chosen path becomes a permanent visual artifact.

## When to invoke

- User says some variant of "grill me with the GUI" / "grill cheese" / `/grill-cheese`.
- User has a plan, design, proposal, spec, or open question they want stress-tested.

## The grill loop

The MCP transport between Claude Code and the server has a ~60s request budget. Human steering takes longer. So each question is **two MCP calls** — one to push, then a long-poll loop to wait.

1. **Start session.** Call `start_session(brief=<the user's plan>)`. Save the returned `session_id`.

2. **Generate the next question.** Identify the *single most important live decision* given everything you know so far (the brief + every answer the user has given). Frame it as one focused question, like /grill-me would. Generate **2–4 candidate answers** as branches with one-sentence rationales; mark exactly one `is_recommended: true` (your honest pick).

3. **Push the node.** Call `present_branches(session_id, question, branches, reasoning, parent_node_id?, parent_branch_id?, depth)`. Returns immediately with `{node_id}`. Save it.

4. **Long-poll for the user's batched actions.** Loop:
   ```
   while True:
       result = wait_for_action(session_id, node_id)   # blocks up to ~50s
       if not result.actions:                          # empty list = transport
           continue                                    # timeout, NOT user inactivity
       break
   ```
   Server **buffers** every click on the node and **flushes** after a 750ms idle window OR immediately when a terminal-class click lands. The flushed batch is returned as `result.actions` — an ordered list of action records. Each item: `{node_id, chosen_branch_id?, chosen_branch_label?, note?, action, chain_markdown?}`. Per-item action values: `next` | `other` | `stop` | `chat` | `mark_rejected` | `unmark` | `stop_here` | `create_plan` | `implement_now` | `continue_grill`. The last four come from a SummaryNode (see "Ending"); only `create_plan` and `implement_now` populate `chain_markdown`.

   `wait_for_action` is idempotent: once flushed, every subsequent call returns the same list. Empty list = no flush yet — re-poll with the same `node_id`.

   **CRITICAL: do NOT call `present_branches` again on an empty `actions` result.** That duplicates the node on the canvas. Only re-poll `wait_for_action` with the same `node_id`.

   Each action item shape: `{node_id, chosen_branch_id?, chosen_branch_label?, note?, action, chain_markdown?}`. The `chain_markdown` field is set only on `create_plan` / `implement_now` (summary-node verdicts).

5. **Read the batch as a narrative and decide what to ask next.**

   The batch is an ordered story of clicks. Read it end-to-end, last terminal-class action is the user's final word, earlier entries are "changed mind" / context signals.

   - **Item with `action == "next"`** → user picked one of your branches at that point. Read `chosen_branch_label` (not the id). Earlier `mark_rejected` entries on other branches are useful signals: the user weighed and dropped them.
   - **Item with `action == "other"`** → user typed free text. `note` carries the text. Read it like a /grill-me chat reply — it may override branches or redirect the question.
   - **Item with `action == "stop"`** → user clicked **wrap up** in the toolbar — they want a verdict card next, NOT a hard stop. Call `present_summary(session_id, summary=<full chain markdown recap>, parent_node_id=<this node's id>, parent_branch_id=<chosen branch id from this node, if any>)`. Then `wait_for_action` on the returned summary node id. See "Ending" below for the verdict-action handlers. Do NOT call `end_session`.
   - **Item with `action == "chat"`** → user is pausing the grill to chat about this node in Claude Code. Server has marked the session paused AND locked this node (no more clicks). `chosen_branch_id` is set for per-branch chat; None for node-level. **Do NOT call `end_session`** — the session is alive, paused. Continue the conversation in plain chat. When the user signals "back to grilling", call `resume_session_tool(session_id)` and push a NEW `present_branches` (the original node is locked — you cannot keep grilling on it).
   - **Item with `action == "mark_rejected"` / `"unmark"`** → tagging signal only. The branch label tells you which option the user weighed. Useful context, not an answer.
   - **Item with `action == "stop_here"`** → summary verdict: user approved, no further action. Server has already ended the session. Point user at the export. Do NOT call `end_session`.
   - **Item with `action == "create_plan"`** → summary verdict: user approved, wants a detailed implementation plan first (not code). `chain_markdown` carries the full chosen-path recap. Use it to draft a plan (markdown doc, ordered task list, file-level breakdown). Server has already ended the session. Do NOT call `end_session`.
   - **Item with `action == "implement_now"`** → summary verdict: user approved, wants code now. `chain_markdown` carries the full chosen-path recap. Start coding immediately based on the decisions. Server has already ended the session. Do NOT call `end_session`.
   - **Item with `action == "continue_grill"`** → user wants more grilling. `chosen_branch_id` is the synthetic continuation branch id; `note` (if set) is the user's redirect for what to drill into next. Push a fresh `present_branches(parent_node_id=<summary node id>, parent_branch_id=<chosen_branch_id>, ...)` to resume. Session NOT ended.

   Then *you decide* what the next question is — exactly like /grill-me. Two natural moves:
   - **Drill down**: ask the follow-up that *only exists because of the chosen answer*. Pass `parent_node_id=node_id`, `parent_branch_id=<chosen_branch_id from the final next item>`, `depth+=1`.
   - **Move sideways**: ask a different decision the brief surfaces. Push as a new root or as a child of an already-chosen ancestor.

   No special button signals "drill" vs "sideways" — *you* judge. The user's `note` (when present) is your strongest signal: if they wrote "now I'm worried about X", drill into X.

## Hard rules

- **NEVER skip the present_branches → wait_for_action loop.** Every decision goes through the GUI. If you're tempted to just decide and move on, that decision is *implicit* — call `record_implicit_decision(session_id, decision, rationale)`. Implicit decisions surface in a separate lane for retroactive grilling.
- **One present_branches call per logical question.** On empty `actions` (transport timeout), re-poll the SAME `node_id`. Calling `present_branches` again duplicates the node — UX bug.
- **ASCII-only inside `branches` JSON.** The MCP harness silently drops the `branches` field when rationale/label strings contain non-ASCII (em-dash `—`, curly quotes `'` `"`, ellipsis `…`) or stray apostrophes that confuse JSON-in-XML escaping. Pydantic then errors with `branches Field required` even though you passed it. Use plain ASCII: hyphen `-` not `—`, straight `'` `"` only, spell out "and so on" not `…`. Keep rationales short — long strings raise the chance of an escape collision.
- **2–4 branches per node.** Two if truly binary; up to four when the design space splits more. Never one. Never five. The "Other / type your answer" option is added by the GUI automatically — do not add it as a branch yourself.
- **Mark exactly one branch `is_recommended: true`** — your honest pick *given the path so far*. Used as a tiebreaker when the user trusts you.
- **Each branch carries a `rationale` string** (one sentence, why this option is plausible). Don't pad. Don't repeat the question.
- **The node's `reasoning`** is *why this question matters now* — what makes it the next live decision. One or two sentences.
- **Explore the codebase before asking** when a question can be answered by reading code (file paths, existing patterns, type definitions). Use `Read` / `Glob` / `Grep` first; let what you find shape the branch rationales, not replace asking.
- **Branch labels are short** (≤ 6 words). Rationale carries the detail.
- **Take "other" answers literally.** If the user types "actually let's stop and look at X instead", do that. Don't paraphrase or pick the closest branch. The whole point of the text input is to let the user override your option set.
- **Respect rejection.** If the user marks a branch `rejected` (a tagging-only action) and answers a different way, do not re-surface the rejected branch as a child later.
- **On `chat`: NEVER call `end_session`.** Chat pauses the session, it does not end it. The chatted node is locked (cannot be answered further). Continue in plain chat; when ready to keep grilling, call `resume_session_tool(session_id)` then push a NEW `present_branches` — do not try to re-poll the locked node.
- **On `stop` (toolbar wrap-up): NEVER call `end_session` directly.** Always call `present_summary` first — the user gets a verdict card with four options (`stop_here` / `create_plan` / `implement_now` / `continue_grill`) and the session ends only after they pick a terminal verdict (server-side, automatically).
- **For summary verdicts (`stop_here` / `create_plan` / `implement_now`): NEVER call `end_session`.** The server has already ended the session. Calling it again is harmless but pointless. `end_session` remains only as an escape hatch for crashes / explicit bailout.

## Depth + breadth budget

- Soft cap: depth 15 from any root question. Beyond that, push a node whose branches are "go deeper" / "stop here" and let the user pick.
- Implicit decisions: cap at ~5 per session. If you find yourself recording many, you're not grilling — push them as real questions.

## Path context

When calling `present_branches` for a child, pass `parent_node_id` and `parent_branch_id`. The server uses these to wire the tree on the canvas. Carry the path in your own reasoning too — every question is conditioned on the chain of answers above it.

## Ending

End-of-session always goes through a **summary verdict card**. Never call `end_session` directly when the user signals they're done — push `present_summary` instead and let the user pick how to land.

Flow:

1. User clicks **wrap up** (toolbar) → you receive `action == "stop"` on the current pending DecisionNode.
2. Call `present_summary(session_id, summary=<markdown recap of the chain so far>, parent_node_id=<id of the node that just got the stop>, parent_branch_id=<chosen branch id on that node, if any>)`. Returns `{node_id}` for the new summary card. The server attaches it as a child of the parent so dagre renders it cleanly below the chain.
3. Long-poll `wait_for_action(session_id, summary_node_id)` as usual. The result's `actions[]` will contain ONE of:
   - `stop_here` — user approves, no follow-up. Server has ended the session. Point user at the export.
   - `create_plan` — user approves, wants a plan first. `chain_markdown` is the full chosen-path recap. Use it to write a detailed implementation plan (markdown doc, ordered tasks, file-level breakdown). Server has ended the session.
   - `implement_now` — user approves, wants code now. `chain_markdown` is the full recap. Start coding immediately. Server has ended the session.
   - `continue_grill` — user wants more grilling. `chosen_branch_id` is the synthetic continuation branch on the summary node; `note` (if set) is their direction. Push a fresh `present_branches(parent_node_id=<summary node id>, parent_branch_id=<chosen_branch_id>, depth=...)` to resume.
4. Always point the user at the markdown export when the session ends: `http://127.0.0.1:7878/export/<session_id>.md`.

The `summary` arg to `present_summary` should be a substantive markdown recap — headings, bullets, the actual chain of decisions. The card has breathing room (480px wide, scrollable body); use it. The summary is what the user reads to decide between the four verdicts, so make it actually useful.

## Example tool calls

```
start_session(brief="I want to add a billing system to my SaaS")
→ {session_id: "ab12cd34"}

present_branches(
  session_id="ab12cd34",
  question="Subscription model or usage-based?",
  reasoning="Pricing model is the keystone — every other billing decision (Stripe products, invoicing cadence, dunning) cascades from it.",
  branches=[
    {label: "Flat subscription", rationale: "Predictable revenue, simplest to implement", is_recommended: true},
    {label: "Usage-based", rationale: "Aligns price with value but needs metering infra"},
    {label: "Hybrid (base + overage)", rationale: "Compromise; common for B2B but adds billing complexity"}
  ],
  depth=0
)
→ {node_id: "n1"}

wait_for_action(session_id="ab12cd34", node_id="n1")
→ {node_id: "n1", actions: []}        # transport timeout / pre-flush; keep polling
wait_for_action(session_id="ab12cd34", node_id="n1")
→ {node_id: "n1", actions: [
    {node_id: "n1", chosen_branch_id: "b1", chosen_branch_label: "Flat subscription", action: "mark_rejected"},
    {node_id: "n1", chosen_branch_id: "b2", chosen_branch_label: "Usage-based", action: "next"},
  ]}
# user rejected "Flat" then picked "Usage-based" — drill into the dependent decision
present_branches(
  session_id="ab12cd34",
  parent_node_id="n1",
  parent_branch_id="b2",
  depth=1,
  question="Metering: track in-app or via Stripe Meters API?",
  ...
)
→ {node_id: "n2"}

wait_for_action(session_id="ab12cd34", node_id="n2")
→ {node_id: "n2", actions: [
    {node_id: "n2", note: "actually I haven't decided on Stripe yet — ask me about payment processor first", action: "other"},
  ]}

# user redirected via free text — drop the metering question, push the upstream one
present_branches(
  session_id="ab12cd34",
  question="Stripe, Paddle, or roll your own?",
  ...
)

# ... many turns later, user clicks "wrap up" in toolbar ...
wait_for_action(session_id="ab12cd34", node_id="n7")
→ {node_id: "n7", actions: [{node_id: "n7", action: "stop"}]}

# push the verdict card
present_summary(
  session_id="ab12cd34",
  summary="## Decisions\n\n- Pricing: usage-based\n- Processor: Stripe\n- Metering: Stripe Meters API\n\n## Open\n- Free-tier threshold still TBD",
  parent_node_id="n7",
  parent_branch_id="b14",
)
→ {node_id: "ns1"}

wait_for_action(session_id="ab12cd34", node_id="ns1")
→ {node_id: "ns1", actions: [
    {node_id: "ns1", action: "create_plan", chain_markdown: "# Grill Session ...\n\n## ...\n**Chose:** Usage-based\n..."}
  ]}
# server has auto-ended the session. write a plan from chain_markdown.
# do NOT call end_session.
```

## Reminder on style

You are *grilling*, not *teaching*. The user has the brief — you're stressing it. Do not summarise their plan back to them. Do not be polite about weak parts. Each question should make them think "huh, I hadn't decided that yet." Recommendations should be honest, not safe. When the user types free text in "Other", treat it as the most informative signal in the session — it tells you exactly what their mental model is doing.
