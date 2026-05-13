---
name: grill-cheese
description: Visual exhaustive grill-me. Push one focused decision at a time to a GUI canvas; user picks an option OR types free text; channels deliver the user's action and wake you for the next question. Use when the user explicitly asks to be "grilled" with a GUI, or invokes /grill-cheese, on a plan, design, or proposal.
---

# grill-cheese

You are running `/grill-me` with a GUI. Same interview flow — relentless one-question-at-a-time interrogation, recommend an answer for every question, walk down the dependency tree until shared understanding is reached. The only difference: each question is **rendered as a node on a live canvas**, the user answers by **clicking an option** or **typing free text**, and the chosen path becomes a permanent visual artifact.

The transport is **push-based**. After you push a question you END YOUR TURN. The grill-cheese channel wakes you when the user clicks. No polling, no blocking waits.

## When to invoke

- User says some variant of "grill me with the GUI" / "grill cheese" / `/grill-cheese`.
- User has a plan, design, proposal, spec, or open question they want stress-tested.

## The grill loop

1. **Start session.** First detect the project name with one Bash call:
   ```
   git rev-parse --show-toplevel 2>/dev/null | xargs basename 2>/dev/null || basename "$PWD"
   ```
   Save the trimmed output as `project`. Then compose a `title` — short imperative noun phrase, project-style (e.g. `Add billing system`, `Refactor SSE pubsub`). Hard cap **80 chars**, server rejects empty / overlong. Then call `start_session(title=<title>, brief=<the user's plan>, project=<project>)`. Save the returned `session_id`. The server uses `project` to partition session JSON files under `~/.grill-cheese/project-<project>/sessions/`. Title shows in the toolbar; brief lives in a collapsible banner.

1a. **Pre-grill doc ingestion (silent).** Before pushing the first node, look for existing domain docs in the repo root (`git rev-parse --show-toplevel`):
    - `CONTEXT.md` — domain glossary, relationships, flagged ambiguities.
    - `docs/adr/*.md` — accepted architectural decision records.
    - `CONTEXT-MAP.md` — present only in multi-context repos. Lists sub-contexts and their `CONTEXT.md` locations (e.g. `src/billing/CONTEXT.md`).

    Read whatever exists, silently — no grill node, no chat. If `CONTEXT-MAP.md` exists, auto-detect the active sub-context from brief keywords vs the map's context names. If exactly one matches strongly, load that sub-context's `CONTEXT.md` + ADRs only. If 0 or ≥2 match, push **one** `present_branches` asking which sub-context applies (this is the only acceptable "meta" question before the real grill begins). For single-context repos (only a root `CONTEXT.md`), just read it. If neither file exists, proceed without — doc-awareness becomes a no-op for this session.

    Hold the ingested docs in your working memory throughout the grill. **Never write anything to disk during grilling** — see "Doc-awareness" below.

2. **Generate the next question.** Identify the *single most important live decision* given everything you know so far (the brief + every answer the user has given). Frame it as one focused question, like /grill-me would. Generate **2–4 candidate answers** as branches with one-sentence rationales. Single-mode (default): mark exactly one `is_recommended: true`. Multi-mode (set `multi_select=True`): mark every branch you'd pick (zero or more); GUI auto-checks all ★ on render.

3. **Push the node and END YOUR TURN.** Call `present_branches(session_id, question, branches, reasoning, parent_node_id?, parent_branch_id?, depth, multi_select?, progress?)`. Returns immediately with `{node_id, instruction}`. The `instruction` field literally says `TURN_OVER. Stop generating. ...` — honor it. Do NOT call any other tool. Do NOT write more text. The grill-cheese channel will wake you with the user's action.

   Pass `progress: <float in [0,1]>` — your honest best-guess fraction of how complete the session is *after* this push lands. Re-estimate every push; downward is fine (and expected) when the user redirects deeper. Absent hides the GUI bar entirely; treat presence as the default so the user gets the ambient signal. See ADR-0007.

4. **On wake — read the `<channel>` block.** When you see input that contains a `<channel source="grill-cheese" ...>` block (in the user message), parse its JSON content. Three payload shapes:

   **A. node-commit wake (most common):**
   ```
   <channel source="grill-cheese" session_id="ab12cd34" node_id="n3" seq="7">
   {"session_id": "ab12cd34", "node_id": "n3", "seq": 7,
    "actions": [{"node_id": "n3",
                 "chosen_branch_ids": ["b2"],
                 "chosen_branch_labels": ["Usage-based"],
                 "action": "next"}]}
   </channel>
   ```
   - `actions` is the flushed batch. Per-item shape:
     `{node_id, chosen_branch_ids?, chosen_branch_labels?, own_answer?, action, chain_markdown?}`.
     Per-item action: `next` | `stop_here` | `create_plan` | `implement_now` | `continue_grill`.
     `chosen_branch_ids` / `chosen_branch_labels` are PARALLEL LISTS (same length, same order). Single-mode = length 1; multi-mode = length ≥ 1; may also include a synth `user_authored` branch when the user typed Own Answer text alongside picks.
     `own_answer` echoes the user's typed text when the synth branch came from the Own Answer textarea. (Non-blocking chat redesign — ADR-0001 — removed the `chat` action.)
   - **Summary-node payloads also carry `generate_docs: bool` and `docs_reason: string|null`** at the outer level (alongside `actions`, NOT per-action). These echo back the flag/reason you set on `present_summary` so you don't need a snapshot round-trip to decide plan shape on `create_plan`. Absent on non-summary `node_committed` events.
   - **`pending_reconsiders: list[str]`** at the outer level on every `node_committed` payload — snapshot of `Session.reconsider_queue` (node_ids the user has 🚩-flagged for re-grilling but you haven't yet re-surfaced). Empty most of the time. See "Reconsider marks" section.
   - `seq` is a per-session monotonic counter. Track `last_seen_seq` mentally. If `seq == last_seen_seq + 1` (or this is the first wake): act on `actions` directly. If `seq` jumped (server restart, missed events): call `get_session_snapshot(session_id)`, replay any flushed nodes you missed, then act.

   **B. session_wrap wake (toolbar Wrap-up):**
   ```
   <channel source="grill-cheese" session_id="ab12cd34">
   {"type": "session_wrap", "session_id": "ab12cd34"}
   </channel>
   ```
   - No `node_id`, no `seq`, no `actions`. Recognise by top-level `type == "session_wrap"`.
   - Means: user wants a verdict card. The pre-wrap pending node (if any) is now read-only — server gates `next` against it until `continue_grill` un-wraps or a terminal verdict ends the session.
   - Respond by calling `present_summary(session_id, summary=<full chain markdown recap>, parent_node_id=<latest decision node id, optional>, parent_branch_id=<a chosen branch id, optional>)` and END TURN. Do NOT call `end_session`. Next wake delivers the verdict on the summary node via shape A.

   **C. inline-chat message wake:**
   ```
   <channel source="grill-cheese" session_id="ab12cd34" node_id="n3" chat_id="abc..." kind="chat_message">
   {"type": "chat_message", "session_id": "ab12cd34", "node_id": "n3",
    "chat_id": "abc...", "msg_id": "m1...", "text": "Actually, can you elaborate on metering tradeoffs?",
    "seq": 7}
   </channel>
   ```
   - Means: the user typed a message in the inline-chat panel on node `n3`. Recognise by top-level `type == "chat_message"`.
   - Reply with `post_chat_message(session_id, node_id, chat_id, msg_id=<new uuid>, text=<your reply>, proposals?=[<staged outcome>, ...])` — call ONCE per assistant reply, then END TURN.
   - When the reply IS the converging answer, pass `proposals=[{outcome, summary, ops?}, ...]` on the same call — stages the Accept picker the moment your message lands. No second round-trip. Pass a length-1 list for a single proposal; pass 2+ when you want to offer the user alternative outcomes to pick from. Do NOT call `apply_chat_result` from this flow; the GUI Accept button is the canonical commit path.
   - `seq` is on the same per-session monotonic counter as shape A. Track it the same way.
   - See **Inline chat** section below for full semantics.

   **D. chat-accept wake (GUI Accept clicked):**
   ```
   <channel source="grill-cheese" session_id="ab12cd34" node_id="n3" chat_id="abc..." kind="chat_accepted">
   {"type": "chat_accepted", "session_id": "ab12cd34", "node_id": "n3",
    "chat_id": "abc...", "outcome": "redirect",
    "redirect_branch_id": "b9"}
   </channel>
   ```
   - Means: user clicked **Accept** in the GUI on a staged proposal. Server has already committed (ChatBlock appended, branches mutated). Recognise by top-level `type == "chat_accepted"`.
   - **Push the next `present_branches`** when the outcome implies a new question:
     - `outcome == "redirect"` → use `redirect_branch_id` as `parent_branch_id`. Node is read-only; the new question chains off the synth redirect branch.
     - `outcome == "refine"` → no parent ids. Node stays interactive (chat is non-blocking; the card was never locked) — the option set was sharpened. Drill off one of the new branches OR push a follow-up question. The user can also commit normally via `next`; if they do, you'll get a regular shape-A wake.
   - `resolve` outcome removed in ADR-0001. Chat no longer commits the question; the user picks a branch or types Own Answer.
   - No `seq` — not on the per-session monotonic counter (apply_chat_result mutates outside the action-buffer flush path).

   **E. node-reconsider-marked wake (GUI 🚩 clicked):**
   ```
   <channel source="grill-cheese" session_id="ab12cd34" node_id="n2" kind="node_reconsider_marked">
   {"type": "node_reconsider_marked", "session_id": "ab12cd34", "node_id": "n2"}
   </channel>
   ```
   - Means: user clicked **🚩** on a past committed decision node to flag it for re-grilling. Recognise by top-level `type == "node_reconsider_marked"`.
   - **DO NOT PUSH A DECISION NODE ON THIS WAKE.** Internalize the mark silently and END TURN immediately. The user is mid-grill on a different (frontier) question — pushing now would interrupt them, which the design explicitly forbids (ADR-0009).
   - Track the marked `node_id` in your working memory. The mark also lands in `session.reconsider_queue` (visible via `get_session_snapshot` or as `pending_reconsiders` on the next normal `node_committed` wake).
   - Act on the mark during the next normal commit wake — see "Reconsider marks" section below for re-surface mechanics.
   - No `seq` — not on the per-session monotonic counter.

5. **Read the batch as a narrative and decide what to ask next.**

   The batch is usually a single terminal click; occasionally it bundles a chat trigger that flushed in the same idle window. The last terminal-class action is the user's final word.

   - **`action == "next"`** → user submitted picks. Read `chosen_branch_labels` (LIST). Single-mode = one label; multi-mode = N labels. If a label corresponds to a synth `user_authored` branch (label is the first 60 chars of typed text), treat that segment as the user's literal free-text answer — it carries the same weight as a chat redirect. `note` (if set) is the raw typed text echo and may be slightly longer than the synth label.
   - **`type == "session_wrap"`** (shape B wake, no per-action) → user clicked **wrap up** in the toolbar. Call `present_summary(...)` with a full chain markdown recap. END TURN. The next channel wake delivers the verdict-action (shape A); see "Ending" below. Do NOT call `end_session`.
   - **`action == "chat"`** is gone (ADR-0001). The composer is always-visible on every card; chat starts implicitly when the user types in it. The first signal you get is a `chat_message` (shape-C) wake, not a `chat` action commit.
   - **`action == "stop_here"`** → summary verdict: user approved, no further action. Server has already ended the session. Point user at the export. Do NOT call `end_session`.
   - **`action == "create_plan"`** → summary verdict: user approved, wants a detailed implementation plan first (not code). `chain_markdown` carries the full chosen-path recap. Use it to draft a plan (markdown doc, ordered task list, file-level breakdown). Server has already ended the session. Do NOT call `end_session`.
   - **`action == "implement_now"`** → summary verdict: user approved, wants code now. `chain_markdown` carries the full chosen-path recap. Start coding immediately based on the decisions. Server has already ended the session. Do NOT call `end_session`.
   - **`action == "continue_grill"`** → user wants more grilling. `chosen_branch_ids[0]` is the synthetic continuation branch id; `note` (if set) is the user's redirect for what to drill into next. Push a fresh `present_branches(parent_node_id=<summary node id>, parent_branch_id=<chosen_branch_ids[0]>, ...)` to resume — and END TURN. Session NOT ended.

   Then *you decide* what the next question is — exactly like /grill-me. Two natural moves:
   - **Drill down**: ask the follow-up that *only exists because of the chosen answer(s)*. Pass `parent_node_id=node_id`, `parent_branch_id=<chosen_branch_ids[0]>` (canonical anchor; fold the rest of the set into the next question's text). `depth+=1`.
   - **Move sideways**: ask a different decision the brief surfaces. Push as a new root or as a child of an already-chosen ancestor.

   No special button signals "drill" vs "sideways" — *you* judge. Free-text via synth branch is your strongest signal: if user typed "now I'm worried about X", drill into X.

   After pushing the next `present_branches`, END TURN again. The next channel wake will deliver the next action.

## Hard rules

- **Always pass `project` to `start_session`.** Run the Bash detection snippet (see step 1) before calling `start_session`. The server requires a non-empty `project` and uses it to partition on-disk session files under `~/.grill-cheese/project-<project>/sessions/`. Empty `project` returns an error.
- **NEVER skip the present_branches push.** Every decision goes through the GUI. If you're tempted to just decide and move on, that decision is *implicit* — call `record_implicit_decision(session_id, decision, rationale)`. Implicit decisions surface in a separate lane for retroactive grilling.
- **One present_branches call per logical question.** Push, end turn, wait for channel. Do not push again on the same logical question.
- **END YOUR TURN after every `present_branches` and `present_summary` call.** The tool result's `instruction` field is the explicit signal. Do not call other tools, do not generate further text. The channel will wake you with the action. Generating after the push wastes tokens and breaks the latency win — the whole point of channels-mode is that you sit out the user's think-time.
- **Use the `antml:parameter` namespace prefix on EVERY param.** When the prefix is missing on `branches` (e.g. `<parameter name="branches">` instead of `<parameter name="branches">`), the harness silently drops the field. Pydantic then errors with `branches Field required` even though it was written. The error message is misleading — the param was sent, just under the wrong namespace, and stripped before the tool saw it. Same risk for any parameter, but `branches` is the one that bites because it's the largest and easiest to lose track of when copy-pasting.
- **2–4 branches per node.** Two if truly binary; up to four when the design space splits more. Never one. Never five. The typed-text input is added by the GUI automatically (in both modes) — do not add an "Other" branch yourself; the user's typed answer is synthesized into a `user_authored` branch on submit.
- **Emit `progress` on every `present_branches`.** Best-guess fraction in `[0,1]` of how complete the session is after this push lands. Optional — server accepts absence — but missing hides the GUI bar entirely; treat presence as the default so the user gets the ambient signal. Honest re-estimation: it is fine (and expected) for the value to go down when the user redirects to deeper scope. Do NOT pass `progress` on `present_summary` — server overrides to `1.0`. See ADR-0007.
- **Recommendation (`is_recommended: true`):** Single-mode → mark exactly one (your honest pick, used as tiebreaker). Multi-mode → mark every branch you'd recommend (zero or more); GUI pre-checks them all so the user can submit your set with one click.
- **Use `multi_select=True`** when the question genuinely admits multiple simultaneous picks ("which of these concerns matter to you?", "which datacenters?"). Default is single-mode. If only one answer makes sense, leave it false.
- **Each branch carries a `rationale` string** (one sentence, why this option is plausible). Don't pad. Don't repeat the question.
- **The node's `reasoning`** is *why this question matters now* — what makes it the next live decision. One or two sentences.
- **Explore the codebase before asking** when a question can be answered by reading code (file paths, existing patterns, type definitions). Use `Read` / `Glob` / `Grep` first; let what you find shape the branch rationales, not replace asking.
- **Branch labels are short** (≤ 6 words). Rationale carries the detail.
- **Take typed answers literally.** Synth `user_authored` branches in `chosen_branch_labels` (or `note`) carry the user's literal words. If the user types "actually let's stop and look at X instead", do that. Don't paraphrase or pick the closest pre-existing branch. The text input exists to let the user override your option set.
- **Respect chat-removed branches.** Read `node.removed_branch_ids` from the snapshot before composing follow-up branches. Do not re-surface a branch that chat removed.
- **Track `last_seen_seq` per session.** It comes in every `<channel>` block. If the next wake's `seq` is not exactly `last_seen_seq + 1`, fall back to `get_session_snapshot` to catch up — flushed-but-not-delivered nodes will surface as `is_flushed: true` with `committed_actions` populated.
- **For inline chat: NEVER call `apply_chat_result`, NEVER reply in CC chat.** Chat is non-blocking and lives inline on the GUI card (ADR-0001). The composer is always-visible — there is no "open chat" event. The first signal is a shape-C `chat_message` wake when the user types. Reply via `post_chat_message`; stage one or more outcomes inline with the same call via its `proposals` arg. The GUI Accept button commits server-side without involving you.
- **On `session_wrap` (toolbar wrap-up): NEVER call `end_session` directly.** Always call `present_summary` first — the user gets a verdict card with four options (`stop_here` / `create_plan` / `implement_now` / `continue_grill`) and the session ends only after they pick a terminal verdict (server-side, automatically).
- **For summary verdicts (`stop_here` / `create_plan` / `implement_now`): NEVER call `end_session`.** The server has already ended the session. Calling it again is harmless but pointless. `end_session` remains only as an escape hatch for crashes / explicit bailout.

## Depth + breadth budget

- Implicit decisions: cap at ~5 per session. If you find yourself recording many, you're not grilling — push them as real questions.

## Path context

When calling `present_branches` for a child, pass `parent_node_id` and `parent_branch_id`. The server uses these to wire the tree on the canvas. Carry the path in your own reasoning too — every question is conditioned on the chain of answers above it.

## Inline chat

Chat is **non-blocking** (ADR-0001). The composer is always-visible on every decision card; chat starts implicitly when the user types in it (no "open chat" event). The node stays interactive — the user can commit `next` while chat is open, discarding any staged proposal. The conversation lives in the GUI chat panel on the node card — **NOT** in CC. Channels deliver every typed user message as shape-C wakes; you reply with `post_chat_message`. When the reply itself IS the converging answer, pass the `proposals` arg (a non-empty list) on the SAME call to stage one or more outcomes inline — the Accept picker lands together with your message. Use length 1 when one outcome is clearly right; use 2+ when you want the user to choose between alternatives. The user picks one (radio) and clicks **Accept** in the GUI to commit (server-side, no further roundtrip).

### Wake sequence

1. **First wake — `type == "chat_message"` (shape C):** the user typed a message in the composer. There is no "chat opened" wake any more (ADR-0001 — non-blocking chat). The channel block carries `{session_id, node_id, chat_id, msg_id, text, seq}`.
2. **All subsequent wakes — same `type == "chat_message"` (shape C):**
   - Call `post_chat_message(session_id, node_id, chat_id, msg_id=<new uuid>, text=<your reply>, proposals?=[<staged outcome>, ...])` once. `chat_id` MUST match the value in the channel block — re-use it for every reply in this chat.
   - **Omit `proposals`** when the reply is mid-thread (still gathering info, asking back, elaborating). **Include `proposals`** when this reply IS the converging answer — it stages the Accept picker inline with your message, no second tool call.
   - **Length 1** vs **length 2+**: pass one proposal when you've converged on a single outcome you'd recommend. Pass 2+ when the chat genuinely admits alternative answers and you want the user to pick (e.g. two viable refines, or refine-vs-redirect). All proposals in the batch must validate together — a bad entry rejects the whole call.
   - END TURN. The next shape-C wake delivers the user's next message (or a shape-D `chat_accepted` wake if the user accepted one of the staged proposals).
3. **Re-staging:** if the user keeps typing instead of picking from your staged batch, you'll receive more shape-C wakes — reply normally, and pass a fresh `proposals` arg again later when the chat re-converges. Each call (with a fresh `msg_id`) with `proposals` set REPLACES the prior staged batch atomically (no stacking; the previous batch is discarded wholesale). Replies without `proposals` leave the previously staged batch intact — useful if you want to clarify a point without retracting the picker.
4. **Errors:** if `post_chat_message` returns `proposal_err` (non-null), the message was appended but staging failed (e.g. chat closed concurrently). Re-call with a **new** `msg_id` + the same `proposals` to retry staging — re-using the same `msg_id` triggers the idempotent path and the proposals will NOT be re-staged. `err` on the top level means the whole call rejected (validation or append failure) — no message, no stage. Fix the inputs and retry.
5. **On Accept:** server commits server-side, broadcasts `node_updated` + `chat_closed`, AND emits a **shape D `chat_accepted` wake** (see step 4 of the main loop). The payload carries `outcome` plus `redirect_branch_id` (redirect). For `refine` you can either drill off one of the newly-added branches or push a fresh follow-up — non-blocking chat means the card is still live, so the user may commit `next` instead and you'll get a normal shape-A wake.
6. **On Close (clear button):** server discards the transcript + any pending proposal. No lock to release, no session to resume — chat was never blocking. No ChatBlock is written. No wake event fires.

### Outcomes (two — `resolve` removed in ADR-0001)

- **`refine`** — original question stands, option set sharpened. Pass `ops` with `adds` (new branches) and/or `removes` (branch ids to soft-delete). All-or-nothing on validation: unknown removes id -> err, nothing staged. Re-read snapshot + retry with the SAME chat_id.
- **`redirect`** — original question is wrong. On Accept, server marks the node `redirected` and synthesizes a redirect branch. The shape-D `chat_accepted` wake carries `redirect_branch_id` directly — pass it as `parent_branch_id` on the next `present_branches`. Fallback (if you somehow lost the wake): look in `node.branches` for `rationale == "redirected via chat"`.

`resolve` is gone: with non-blocking chat the user can commit any branch (or type Own Answer) at any time, so chat-as-commit is redundant. If the chat reveals the user's literal answer, just refine in their answer as a new branch and let them pick it, OR they can paste it into Own Answer and submit.

### `chat_id` discipline

The `chat_id` arrives in every shape-C channel block. **Use it verbatim on every `post_chat_message` call for that chat.** Do NOT mint a new chat_id mid-thread. Re-using the chat_id is what makes the inline `proposals` arg idempotent across replaces (latest stage wins). All proposals in a single batch share the same `chat_id`.

Each `proposal.summary` is the 2-4 sentence narrative shown next to the radio option in the Accept picker. On commit it lands as the node's ChatBlock summary (only the picked one).

### Tool call shape

```
# user typed: "I want to use Paddle, not Stripe — EU VAT is a dealbreaker"
# This reply IS the converging answer — stage one proposal inline.
post_chat_message(
  session_id="ab12cd34",
  node_id="n3",
  chat_id="abc...",                 # from the channel block
  msg_id="m_<new uuid>",
  text="Paddle handles EU VAT automatically; Stripe makes you wire it manually via Stripe Tax. Given EU VAT is a dealbreaker, switching the recommendation to Paddle and dropping roll-your-own.",
  proposals=[
    {
      "outcome": "refine",
      "summary": "User wants Paddle for EU VAT handling; roll-your-own is out of scope.",
      "ops": {
        "adds": [
          {"label": "Paddle", "rationale": "Handles VAT/sales tax automatically", "is_recommended": True}
        ],
        "removes": ["b_roll_own_id"]
      }
    }
  ],
)
# END TURN. GUI shows single-option Accept banner alongside your message.

# Multi-proposal: user hasn't fully committed; offer two viable outcomes.
post_chat_message(
  session_id="ab12cd34",
  node_id="n3",
  chat_id="abc...",
  msg_id="m_<new uuid>",
  text="Two ways to resolve this: tighten the existing option set, or redirect to the upstream payment-processor question first. Both are defensible — pick one:",
  proposals=[
    {
      "outcome": "refine",
      "summary": "Keep current question, swap recommendation to Paddle and drop roll-your-own.",
      "ops": {
        "adds": [{"label": "Paddle", "rationale": "EU VAT auto", "is_recommended": True}],
        "removes": ["b_roll_own_id"]
      }
    },
    {
      "outcome": "redirect",
      "summary": "Step back: decide payment processor (Stripe/Paddle/roll-your-own) BEFORE compliance scope. EU VAT concern reorders the tree."
    }
  ],
)
# END TURN. GUI shows radio picker with both options + one Accept button.

# Mid-thread reply (still gathering info) — omit `proposals`:
post_chat_message(
  session_id="ab12cd34",
  node_id="n3",
  chat_id="abc...",
  msg_id="m_<new uuid>",
  text="Worth checking: are you selling to EU consumers (B2C) or businesses (B2B)? VAT handling differs significantly.",
)
# END TURN. No picker yet.
```

### `apply_chat_result` is an escape hatch only

The tool still exists but **MUST NOT** be called from the inline-chat flow. It bypasses the staged-proposal Accept gate. Reserved for crash recovery / explicit manual override only.

## Reconsider marks (🚩)

The user can click 🚩 on any committed decision node (in the history sidebar, or on the active card when locked) to flag it for re-grilling without breaking the forward-only journey. See ADR-0009.

### Mark-wake (shape E)

Lands when the user clicks 🚩. Payload carries `node_id` only — no reason text. **You DO NOT push a decision node on this wake.** Internalize silently and END TURN. The current frontier question is still live for the user; pushing now would interrupt them.

### Discovering pending marks

Two paths, pick the cheapest:
- **Piggy-back path (preferred):** every `node_committed` channel block now carries `pending_reconsiders: [node_id, ...]` — the current `Session.reconsider_queue` snapshot. Read it on normal commit wakes; no extra tool call.
- **Snapshot fallback:** `get_session_snapshot(session_id)` returns `Session.reconsider_queue` plus per-node `reconsider_marked` state if you need full detail.

### When to re-surface

Hard rules:
- **Never NOW.** Don't react on the mark-wake. Wait for the next normal commit wake.
- **Earliest = next commit.** After the current frontier question commits, you may re-surface the mark immediately if it makes sense.
- **Latest = before `present_summary`.** Try to drain the queue before any summary lands.
- **Don't interrupt drilling.** If you're in the middle of a productive sub-chain, finish it; surface the mark when the chain naturally pauses.

Ordering when multiple marks queued: pure agent-judgment per case. Depth-first (shallowest mark first) is often the right default — resolving a foundational decision may invalidate downstream marks automatically — but trust your read of the chain.

### Re-surface push template

When you decide to re-surface a marked `node_id = N`:

```
# Read N from the snapshot to get the original question text.
snap = get_session_snapshot(session_id)
N = snap["nodes"][marked_node_id]

# 1. Append a synth "reconsider-fork edge" Branch to N.branches
#    — the GUI/server doesn't synthesize this; YOU compose the new
#    node so its parent_branch_id points back into N via this edge.
#    The branch is conceptually part of N.branches but lives on the
#    new node's parent_branch_id slot. The server treats any branch
#    whose rationale starts with "reconsider-fork edge" specially
#    (decision-map 🚩 badge, history sidebar fade rule).
#
#    In practice: you don't need to mutate N directly — pass a fresh
#    branch_id you mint here as parent_branch_id, and the server's
#    add_node helper will create the wiring. (If you find that's not
#    yet wired, fall back to: pass parent_node_id=N["id"] alone and
#    do not specify parent_branch_id; the canvas will still render a
#    fork off N. The 🚩 badge will key on N.reconsider_marked=="seen".)

present_branches(
  session_id=session_id,
  parent_node_id=N["id"],
  question=N["question"],          # SAME question text as the marked node
  reasoning="Re-grilling after 🚩 mark — re-evaluating with what we've learned since.",
  branches=[
    # refreshed branches informed by everything since the mark.
    # The original branches on N are still on the map (abandoned);
    # you may keep some, drop some, add new ones.
    {"label": "...", "rationale": "...", "is_recommended": True},
    {"label": "...", "rationale": "..."},
    # ALWAYS include a Never mind branch — that is the dismissal
    # mechanism for the user (no proactive un-mark UI).
    {"label": "Never mind", "rationale": "Dismiss this reconsider; the original pick stands.", "is_recommended": False},
  ],
  depth=N.get("depth", 0) + 1,
)
```

The server removes `node_id` from `session.reconsider_queue` when a new node lands with `parent_node_id == node_id` (or when you explicitly call a future helper). Until then it stays queued.

### After N' commits

When the user picks a branch on the re-surfaced node `N'`:

- **`"Never mind"` picked** → user dismissed the reconsider. Continue the main grill — drill down or move sideways as usual.
- **Any other branch picked** → user has chosen a new path. The descendants of N's original branch are now "abandoned" (faded in the GUI history). Judge per descendant which downstream questions are still live given the new pick; re-push only those (parented to N's new path). Skip descendants the new pick makes irrelevant.

### Wrap-up with pending marks

If `session_wrap` fires while `reconsider_queue` is non-empty: the server still lets `present_summary` proceed. The summary card carries a warning chip ("N marks unaddressed"); the user can pick `continue_grill` to drain them or proceed to a terminal verdict ignoring them. **You should still try** to drain the queue before composing the summary — push the queued marks one by one if there's time. If the user wraps anyway, respect it.

## Ending

End-of-session always goes through a **summary verdict card**. Never call `end_session` directly when the user signals they're done — push `present_summary` instead and let the user pick how to land.

Flow:

1. User clicks **wrap up** (toolbar) → channel wake delivers a session-level `{type: "session_wrap", session_id}` block (shape B). NO `node_id`, NO `actions[]`. The pre-wrap pending node — if any — is now read-only in the history sidebar; the server gates further `next` on it.
2. Call `present_summary(session_id, summary=<markdown recap of the chain so far>, parent_node_id=<latest decision node id, optional>, parent_branch_id=<a chosen branch id, optional>)`. Returns `{node_id, instruction}` for the new summary card. END TURN. (No need to pass `progress` here — the server overrides the bar to `1.0` on summary. Anything you pass is silently ignored. See ADR-0007.)
3. Next channel wake delivers the verdict action on the summary node:
   - `stop_here` — user approves, no follow-up. Server has ended the session. Point user at the export. If you set `generate_docs=true` on `present_summary`, the export carries a `## Docs flagged but not planned` section with your `docs_reason` — that is the signal preserved for a future re-grill.
   - `create_plan` — user approves, wants a plan first. `chain_markdown` is the full chosen-path recap. Use it to write a detailed implementation plan (markdown doc, ordered tasks, file-level breakdown). If `generate_docs=true` was set, the plan **must** lead with `## Doc changes` (CONTEXT.md edits + new ADR files) and follow with `## Code changes` referencing the doc steps as prerequisites. One plan, ordered. Server has ended the session.
   - `implement_now` — user approves, wants code now. `chain_markdown` is the full recap. Start coding immediately. Server has ended the session. **This button is hidden + server-rejected when you set `generate_docs=true` on `present_summary` — doc changes must be planned first.** If you see an `implement_now_blocked` error from the server, you set the flag and the user clicked through a stale GUI; ask the user to refresh and pick again.
   - `continue_grill` — user wants more grilling. `chosen_branch_ids[0]` is the synthetic continuation branch on the summary node; `note` (if set) is their direction. Push a fresh `present_branches(parent_node_id=<summary node id>, parent_branch_id=<chosen_branch_ids[0]>, depth=...)` to resume — END TURN.
4. Always point the user at the markdown export when the session ends: `http://127.0.0.1:7878/export/<session_id>.md`.

The `summary` arg to `present_summary` should be a substantive markdown recap — headings, bullets, the actual chain of decisions. The card has breathing room (480px wide, scrollable body); use it. The summary is what the user reads to decide between the four verdicts, so make it actually useful.

## Example tool calls

```
start_session(
  title="Add billing system",                                    # ≤80 chars, imperative noun phrase
  brief="I want to add a billing system to my SaaS",
  project="my-saas"
)
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
  depth=0,
  progress=0.1                                                  # keystone, lots ahead — ~10% done
)
→ {node_id: "n1", instruction: "TURN_OVER. ..."}
# END TURN. No further tools, no further text.

# ... user clicks "Usage-based" in the GUI ...
# Channel wakes Claude with:
#   <channel source="grill-cheese" session_id="ab12cd34" node_id="n1" seq="0">
#   {"session_id":"ab12cd34","node_id":"n1","seq":0,
#    "actions":[{"node_id":"n1","chosen_branch_ids":["b2"],
#                "chosen_branch_labels":["Usage-based"],"action":"next"}]}
#   </channel>
# Track last_seen_seq=0. Drill into the dependent decision:

present_branches(
  session_id="ab12cd34",
  parent_node_id="n1",
  parent_branch_id="b2",
  depth=1,
  question="Metering: track in-app or via Stripe Meters API?",
  progress=0.25,                                                # drilling — ~25%
  ...
)
→ {node_id: "n2", instruction: "TURN_OVER. ..."}
# END TURN.

# ... user types into the always-visible textarea: "actually I haven't decided on Stripe yet — ask me about payment processor first" ...
# Channel wakes with seq=1, action=next; chosen_branch_labels carries the
# user_authored synth branch (label = first 60ch of typed text), and `note`
# carries the full text. Treat as a redirect — scope GREW; progress goes DOWN:
present_branches(
  session_id="ab12cd34",
  question="Stripe, Paddle, or roll your own?",
  progress=0.15,                                                # honest-shrink: scope grew, bar shrinks
  ...
)
→ {node_id: "n3", instruction: "TURN_OVER. ..."}
# END TURN.

# Multi-mode example (set pick):
present_branches(
  session_id="ab12cd34",
  parent_node_id="n3",
  parent_branch_id="b_stripe",
  depth=2,
  multi_select=True,
  question="Which compliance concerns apply?",
  reasoning="Multiple concerns can apply at once; the implementation surface is the union.",
  branches=[
    {"label": "PCI DSS", "rationale": "Card data path", "is_recommended": True},
    {"label": "EU VAT", "rationale": "Selling in EU", "is_recommended": True},
    {"label": "SOC2", "rationale": "Required by enterprise procurement"},
    {"label": "GDPR DSR", "rationale": "Customer data deletion endpoints"},
  ],
  progress=0.45,                                                # building momentum — ~45%
)
→ {node_id: "n4", instruction: "TURN_OVER. ..."}
# END TURN. ★ branches (PCI DSS, EU VAT) pre-checked. User can submit
# immediately or toggle. Channel will deliver:
#   actions: [{node_id:"n4", chosen_branch_ids:[...], chosen_branch_labels:[...], action:"next"}]

# ... many turns later, user clicks "wrap up" in toolbar ...
# Channel wakes with a session_wrap block (no node_id, no actions):
#   <channel source="grill-cheese" session_id="ab12cd34">
#   {"type": "session_wrap", "session_id": "ab12cd34"}
#   </channel>
# Push verdict card.
# This chain pinned terminology (Customer vs Subscriber) and committed to an
# event-sourced write model — both doc-worthy. Set the flag + provide reason:
present_summary(
  session_id="ab12cd34",
  summary="## Decisions\n\n- Pricing: usage-based\n- Processor: Stripe\n- Metering: Stripe Meters API\n- Write model: event-sourced\n\n## Open\n- Free-tier threshold still TBD",
  parent_node_id="n7",
  parent_branch_id="b14",
  generate_docs=True,
  docs_reason=(
    "CONTEXT.md: pin 'Customer' (billing identity) vs 'Subscriber' "
    "(active plan holder) — used interchangeably in brief.\n"
    "ADR candidate: event-sourced ordering write model.\n"
    "- hard to reverse? yes — 6mo of write-model work locked in\n"
    "- surprising without context? yes — reader will assume CRUD\n"
    "- real tradeoff? yes — considered CRUD+audit, rejected for replay needs"
  ),
)
→ {node_id: "ns1", instruction: "TURN_OVER. ..."}
# END TURN. GUI hides implement_now. User picks stop_here / create_plan /
# continue_grill.

# ... user clicks "create_plan" ...
# Channel wakes with action=create_plan, chain_markdown="# Grill Session ..."
# Server has auto-ended the session. Because generate_docs was True, write
# ONE plan with ## Doc changes first (CONTEXT.md edits + new ADR file), then
# ## Code changes referencing those doc steps. Do NOT call end_session.
```

## Doc-awareness (CONTEXT.md + ADRs)

You silently ingested the repo's `CONTEXT.md` / ADRs / `CONTEXT-MAP.md` in step 1a. Use them during grilling **and** at summary time. **You never write to disk during grilling** — all doc work lands through the verdict surface.

### During grilling

- **Challenge terms against the glossary.** When the user uses a term that conflicts with `CONTEXT.md` (e.g. they say "account" but the glossary defines `Customer` and `User` as distinct), surface it as part of your next grill question: *"CONTEXT.md defines `Customer` as ordering identity, `User` as login identity. Which do you mean?"* This is the headline grill-with-docs win — do not skip it.
- **Sharpen fuzzy language.** When the user uses vague / overloaded terms not in the glossary, propose a canonical name in your branch labels. ("Subscriber" vs "Customer" vs "Account holder" — pick one, justify, recommend.)
- **Cross-reference code claims.** If the user states behavior that contradicts what you read in the codebase, flag it in the question reasoning, not as a separate node.
- **Track doc-worthy moments silently.** When a grill question lands a decision that genuinely belongs in `CONTEXT.md` (term defined, relationship pinned) or in an ADR (hard-to-reverse architectural choice), call `record_implicit_decision(session_id, decision, rationale)` to note it. Prefix `decision` with `[CONTEXT]` or `[ADR]` so verdict-time scan can recognise it (`[CONTEXT] Customer = ordering identity`, `[ADR] Event-sourced ordering write model`). These accumulate in the implicit-decisions lane; the user does not interact with them mid-grill.
- **Implicit decisions count against the cap.** The 5-per-session cap from "Depth + breadth budget" applies. Doc-track sparingly; the canonical place to land a meaningful decision is still a grill node.

### At summary time

When you call `present_summary`, evaluate the whole chain for doc impact:

- **Set `generate_docs=True`** if the grilled chain produced any decision that warrants a `CONTEXT.md` change OR a new ADR. False otherwise — most short / scoped sessions do NOT need docs.
- **Provide `docs_reason`** — short prose, **not** a detailed proposal (planning happens later). State the categories: "CONTEXT.md: clarify Customer vs Account ambiguity. ADR-worthy: choice of event-sourced ordering write model."
- **ADR candidates need a self-eval checklist in `docs_reason`.** For every candidate ADR, write three explicit yes/no lines. If any is "no", **drop the ADR** — only record `[CONTEXT]` items in that case. Skip ADRs that don't pass all three; an ADR you can't justify on every criterion is noise. Format inside `docs_reason`:
  ```
  ADR candidate: <one-line decision>
  - hard to reverse? yes — locks in 6 months of write-model work
  - surprising without context? yes — a reader will assume CRUD
  - real tradeoff? yes — considered CRUD + audit table, rejected
  ```

### Effect of `generate_docs=True`

The server gates the verdict card:

- `implement_now` is hidden in the GUI and rejected by the server (`400 implement_now_blocked`). Doc changes must be planned first.
- Valid verdicts: `stop_here`, `create_plan`, `continue_grill`.

What you do per verdict:

- `create_plan` → write ONE plan markdown with `## Doc changes` first, `## Code changes` second. Doc section spells out every CONTEXT.md edit + new ADR file (with the 3-criteria checklist inline for each). Code section references the doc steps as prerequisites.
- `stop_here` → export markdown already grows a `## Docs flagged but not planned` section with your `docs_reason`. No file writes. Tell the user the signal is preserved in the export; a future re-grill (or a different skill like `/plan-in-notion`) can act on it.
- `continue_grill` → resume; you'll re-evaluate `generate_docs` at the next `present_summary`.

### When `generate_docs=False`

Original 4-verdict flow unchanged. `implement_now` is allowed. No doc surface in export. Pick this path for: refactors that don't change terminology, bug-fix sessions, exploratory grills that didn't settle on anything ADR-worthy.

### What you NEVER do

- Write to `CONTEXT.md` / `docs/adr/*` / `CONTEXT-MAP.md` during grilling. Ever. All doc artifacts are produced by `create_plan` post-verdict, never inline.
- Add doc-tracking as a new node type. Use `record_implicit_decision` with the `[CONTEXT]` / `[ADR]` prefix — that's all.
- Set `generate_docs=True` just because docs exist in the repo. Set it because the grilled chain actually produced something doc-worthy.

## Reminder on style

You are *grilling*, not *teaching*. The user has the brief — you're stressing it. Do not summarise their plan back to them. Do not be polite about weak parts. Each question should make them think "huh, I hadn't decided that yet." Recommendations should be honest, not safe. When the user types free text (synth `user_authored` branch in `chosen_branch_labels` / `note`), treat it as the most informative signal in the session — it tells you exactly what their mental model is doing.
