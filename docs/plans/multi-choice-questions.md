# Multi-choice question support

Source: grill session `7f39bd455c0a` (2026-05-10).
Verdict: `create_plan`.

Goal: let `present_branches` push a question where the user picks **N** branches (a set), GUI renders checkboxes + Submit, server commits the set, channel delivers the chosen list, skill drills off the combined choice. Same plural model collapses single-mode into "list of length 1" and kills the `action=other` special case in the process.

---

## 0. Decision recap

| # | Question | Pick |
|---|----------|------|
| 1 | MCP surface | Flag `multi_select: bool = False` on `present_branches` |
| 2 | Commit UX | Checkboxes + Submit button (single POST per question) |
| 3 | Chosen state shape | Plural-only: `chosen_branch_ids: list[str]` (radio = list of length 1) |
| 4 | Drill-edge wiring | Single `parent_branch_id` — Claude folds the rest of the set into the question text |
| 5 | "Other" semantics | Full-unify: kill `action=other` + `Node.user_note`. Typed text → synth `Branch(user_authored=true)` + `action=next` |
| 6 | Submission constraints | Hardcoded min=1, no max |
| 7 | `is_recommended` (★) | Multi-★ allowed, GUI auto-checks all ★ on render |
| 8 | Chat during pending checks | Discard — clicking chat clears checks/text |

Implicit: multi-submit goes through the existing 750ms idle buffer (same path as `next`). No new flush class.

---

## 1. Schema (`server/schemas.py`)

### `Branch`
```python
class Branch(BaseModel):
    id: str = Field(default_factory=_bid)
    label: str
    rationale: str = ""
    is_recommended: bool = False
    user_authored: bool = False        # NEW: synth from typed text
    child_node_id: Optional[str] = None
```

### `Node`
```python
class Node(BaseModel):
    ...
    multi_select: bool = False         # NEW: render mode
    chosen_branch_ids: list[str] = Field(default_factory=list)  # REPLACES chosen_branch_id
    # DROP: user_note
    # DROP: chosen_branch_id (singular)
    ...
```

### `GuiAction`
```python
class GuiAction(BaseModel):
    session_id: str
    node_id: str
    branch_ids: list[str] = Field(default_factory=list)   # REPLACES branch_id (singular kept for chat-only single-branch)
    branch_id: Optional[str] = None                        # KEEP — only used by action=chat (chat-on-branch)
    note: Optional[str] = None
    action: Literal[
        "next", "stop", "chat",
        "stop_here", "create_plan", "implement_now", "continue_grill",
    ]
    # DROP: "other" from the literal
```

Rationale for keeping `branch_id` alongside `branch_ids`: chat-on-branch is a per-row click that scopes a chat to one branch. It does not pick the branch — picking is a separate path. Overloading `branch_ids[0]` for chat-scoping muddles the contract. Two fields, two purposes.

### `AskBranchesInput`
```python
class AskBranchesInput(BaseModel):
    session_id: str
    parent_node_id: Optional[str] = None
    parent_branch_id: Optional[str] = None
    question: str
    reasoning: str = ""
    branches: list[Branch]
    depth: int = 0
    implicit: bool = False
    multi_select: bool = False         # NEW
```

### `AskBranchesResult`
```python
class AskBranchesResult(BaseModel):
    node_id: str
    chosen_branch_ids: list[str] = Field(default_factory=list)   # REPLACES chosen_branch_id
    chosen_branch_labels: list[str] = Field(default_factory=list) # REPLACES chosen_branch_label
    note: Optional[str] = None         # KEEP — Other-text echo (pre-synth fallback for analytics)
    action: Literal[
        "next", "stop", "chat",
        "stop_here", "create_plan", "implement_now", "continue_grill",
    ] = "next"
    chain_markdown: Optional[str] = None
    # chat scope (single-branch chat keeps a single id field for clarity)
    chat_branch_id: Optional[str] = None
    chat_branch_label: Optional[str] = None
```

Rationale: chat result is structurally different from a pick result (single optional branch vs. set). Separate fields keep the discriminated-union story honest.

### Pydantic validator (multi-mode ★ rule)
Drop the implicit "exactly one ★" expectation. No validator needed — multi-★ is allowed in both modes; single-mode just renders ★ as a tiebreaker hint, multi-mode pre-checks all ★.

---

## 2. Server state machine (`server/state.py`)

### `apply_action` rewrite

```python
if action.action == "next":
    if not action.branch_ids and not action.note:
        return None  # min=1: must check ≥1 OR type something
    chosen_ids: list[str] = []
    chosen_labels: list[str] = []
    for bid in action.branch_ids:
        if bid in node.removed_branch_ids:
            return None
        b = next((x for x in node.branches if x.id == bid), None)
        if b is None:
            return None
        chosen_ids.append(b.id)
        chosen_labels.append(b.label)
    # synth-branch path: typed text → new user_authored branch
    if action.note:
        synth = Branch(
            label=action.note[:60],
            rationale=action.note,
            is_recommended=False,
            user_authored=True,
        )
        node.branches.append(synth)
        chosen_ids.append(synth.id)
        chosen_labels.append(synth.label)
    node.chosen_branch_ids = chosen_ids
    return AskBranchesResult(
        node_id=action.node_id,
        chosen_branch_ids=chosen_ids,
        chosen_branch_labels=chosen_labels,
        note=action.note,
        action="next",
    )
```

### `apply_action` deletes
- Drop the entire `if action.action == "other":` block.
- Drop assignment to `node.user_note`.

### `apply_action` chat branch
Keep `chat` block but read `action.branch_id` (singular) instead of `action.branch_ids[0]`. Populate `chat_branch_id` / `chat_branch_label` on the result instead of `chosen_branch_id` / `chosen_branch_label`.

### `apply_action` continue_grill
Continue branch synthesis stays the same conceptually but writes `chosen_branch_ids = [cont.id]` and emits `chosen_branch_ids=[cont.id], chosen_branch_labels=[cont.label]`.

### `_chosen_branch` helper
Today returns `Optional[Branch]`. Two options:
- Replace with `_chosen_branches(n) -> list[Branch]` (returns the list).
- Keep singular shim: return `node.branches[i]` for the **first** id in `chosen_branch_ids` (back-compat for chain markdown rendering on single-mode nodes).

Pick the second: `_build_chain_md` only uses one branch as "next hop", so a singular shim is cleaner. Add a `_chosen_branches` plural helper for the multi-mode rendering case.

### `_build_chain_md`
- Drop the `if n.user_note:` block (~lines 694–696).
- For multi-mode nodes, render `**Chose:** A, B, [user-typed: …]` instead of single label. Walk `_chosen_branches(n)`; mark `user_authored` ones with a `[typed]` tag.
- "Advance" logic stays unchanged — uses the first chosen branch's `child_node_id` to continue the chain.

### Persistence
- `_persist` is field-agnostic — Pydantic dump handles new/dropped fields.
- On load, old session JSONs (with `chosen_branch_id` / `user_note`) are silently dropped via `extra=ignore` on `Session`. Node has no such config — add `model_config = {"extra": "ignore"}` to `Node` to mirror, OR explicitly delete affected sessions on disk before first run.
  - **Decision (per session):** old sessions dropped. Add `model_config = {"extra": "ignore"}` to `Node` so removed fields are quietly ignored; sessions still load but lose chosen state. User opted out of migration — acceptable.

---

## 3. Internal dispatch (`server/internal_dispatch.py`)

No semantic changes. The `present_branches` tool input now accepts `multi_select`; routing is unchanged.

---

## 4. Shim (`server/shim.py`)

### Channel payload (`_emit_channel`)
Per-action item shape becomes:
```json
{
  "node_id": "...",
  "chosen_branch_ids": ["b1", "b2"],
  "chosen_branch_labels": ["Stripe", "Paddle"],
  "note": null,
  "action": "next"
}
```

For `chat` action, swap `chosen_branch_*` keys for `chat_branch_id` / `chat_branch_label`. For terminal verdicts, no branch fields needed.

Drop any code path that handles `action=="other"`.

---

## 5. SSE (`server/sse.py`)

`node_committed` payload shape mirrors the channel payload (already serializes `AskBranchesResult` directly). No code change beyond schema-driven re-serialization.

---

## 6. GUI types (`gui/src/types.ts`)

```ts
export interface Branch {
  id: string;
  label: string;
  rationale: string;
  is_recommended: boolean;
  user_authored?: boolean;             // NEW
  child_node_id: string | null;
}

export interface DecisionNode {
  ...
  multi_select?: boolean;              // NEW
  chosen_branch_ids?: string[];        // REPLACES chosen_branch_id
  // DROP: user_note
  // DROP: chosen_branch_id
  ...
}
```

`SseEvent` `node_resolved` and `node_committed` payload action shape:
```ts
{
  node_id: string;
  chosen_branch_ids?: string[];
  chosen_branch_labels?: string[];
  note?: string | null;
  action: string;
  chat_branch_id?: string | null;
  chat_branch_label?: string | null;
}
```

---

## 7. GUI api (`gui/src/api.ts`)

```ts
export type ActionKind =
  | "next"
  | "stop"
  | "chat"
  | "stop_here"
  | "create_plan"
  | "implement_now"
  | "continue_grill";   // DROP "other"

export async function postAction(
  session_id: string,
  node_id: string,
  action: ActionKind,
  opts?: { branch_ids?: string[]; branch_id?: string; note?: string }
): Promise<void> {
  const body = {
    session_id,
    node_id,
    action,
    branch_ids: opts?.branch_ids ?? [],
    branch_id: opts?.branch_id,
    note: opts?.note,
  };
  ...
}
```

Update all call sites in `DecisionNode.tsx`.

---

## 8. GUI component (`gui/src/components/DecisionNode.tsx`)

### State
- Replace `otherOpen` / `otherText` with always-present `pendingChecks: Set<string>` + `pendingNote: string`.
- Initialize `pendingChecks` from `node.branches.filter(b => b.is_recommended).map(b => b.id)` on first render of a non-committed node (single useEffect keyed on `node.id`).

### Render
- `node.multi_select` true → checkboxes per branch row, no per-row "pick →" button; one Submit button at the bottom.
- `node.multi_select` false (or unset) → keep current radio-style `pick →` per row. **Both modes** share the synth-branch path: typed text in the always-visible text input flows through Submit (single-mode Submit becomes available when text typed even without a checked branch).
- ★ branches: pre-checked + visual ★ marker. Same in both modes (single-mode pre-check selects radio default; multi-mode pre-checks all).
- Per-branch chat button: render in both modes (clears `pendingChecks` + `pendingNote` before posting `chat`).
- Submit button disabled while `pendingChecks.size === 0 && pendingNote.trim() === ""`.

### Synth-branch render
- `BranchRow` reads `branch.user_authored`; renders a small `typed` tag next to the label (similar to existing `gc-rec` styling).

### "Other" textarea
- Always present (in both modes), inline below the branches. No separate "Other / type your answer" expand button. Smaller `<textarea>` (1–2 rows by default, expands on focus).

### Submit handler
```ts
const submit = async () => {
  if (pendingChecks.size === 0 && !pendingNote.trim()) return;
  await postAction(sid, node.id, "next", {
    branch_ids: Array.from(pendingChecks),
    note: pendingNote.trim() || undefined,
  });
  // server will mutate node + flush; SSE node_updated re-renders
};
```

### Chat handler
```ts
const sendChat = async (branch_id?: string) => {
  setPendingChecks(new Set());
  setPendingNote("");
  await postAction(sid, node.id, "chat", { branch_id });
};
```

### Display chosen state
- Read `node.chosen_branch_ids` (array). Render each chosen branch with a `state-chosen` class + `●` glyph. Multi-mode: multiple checked rows show as chosen.
- Drop the `node.user_note` rendering block (~lines 180–185); user notes are now synth branches and render inline like any other.

---

## 9. Skill (`skill/grill-cheese/SKILL.md`)

### Tool surface section
Add `multi_select: bool = False` to `present_branches` signature in the tool example.

### Action handler section
- Drop `**`action == "other"`**` row.
- Update `**`action == "next"`**` row: "user picked one or more of your branches OR typed text. Read `chosen_branch_labels` (list, not the singular). If `note` is set AND no synth branch in chosen_branch_ids, treat note as user-typed answer."
  - Note: with full-unify, server already creates the synth branch and includes it in `chosen_branch_ids`. So `note` becomes redundant on the wire (still echoed for analytics). Skill can prefer reading branches; falls back to `note` if needed.

### Hard rules section
- Update "Take 'other' answers literally" to "Take user-typed answers (synth branches with `user_authored=true`) literally."
- Update "2–4 branches per node" — still applies; synth branches don't count toward the 2–4 cap (they're added by user post-push).

### Multi-mode usage rule (new)
> Use `multi_select=True` when the question genuinely admits multiple simultaneous picks (e.g. "which of these concerns matter to you?"). Default is single-mode. Multi-★ is allowed in multi-mode — mark every branch you'd recommend; GUI pre-checks them.

### Channel payload section
- Update example block to show `chosen_branch_ids` / `chosen_branch_labels`.

### Example calls
Replace `chosen_branch_label` reads with `chosen_branch_labels` (list).
Add a multi-mode `present_branches` example with 4 branches, 2 ★, multi_select=true.

---

## 10. Smoke test (`scripts/smoke_e2e.py`)

Add a multi-mode case:
1. `start_session`
2. `present_branches(multi_select=true, branches=[…4…], with 2 ★)`
3. Simulate GUI POST `/actions` with `branch_ids=[b1, b3], note="extra context"`.
4. Assert: `node.chosen_branch_ids == [b1, b3, synth_id]`; `node.branches[-1].user_authored is True`; `chosen_labels == ["L1", "L3", "extra context"[:60]]`.
5. Assert channel notification carries the same plural shape.

---

## 11. Cleanup

- Delete old session JSONs under `~/.grill-cheese/project-*/sessions/` after the rewrite lands. (One bash command; user confirmed acceptable.)
- Search for any remaining `user_note` / `chosen_branch_id` / `action.*other` references and remove. Likely culprits:
  - `gui/src/store.ts` (SSE event handler may set `chosen_branch_id` from `node_resolved`)
  - `gui/src/components/Canvas.tsx` (edge wiring — uses `chosen_branch_id` to mark active path?)
  - Tests / smoke scripts

---

## 12. Build sequence

| Order | Step | Verifies |
|-------|------|----------|
| 1 | Schema rewrite (`schemas.py`) — add new fields, drop old. | `uv run python -c "from server.schemas import Node, Branch; ..."` |
| 2 | `state.py` apply_action + helpers + chain md. | `PYTHONPATH=. uv run python -m scripts.smoke_e2e` (single-mode regression) |
| 3 | Shim payload shape. | Manual: start session, push single-mode node, click pick — verify channel block matches new shape. |
| 4 | GUI types + api + DecisionNode (single-mode only first). | `cd gui && npm run build` (tsc clean) |
| 5 | GUI multi-mode render path. | Browser smoke: push `multi_select=true` node, click 2 boxes + type text + submit. |
| 6 | Synth-branch path end-to-end. | Browser smoke: typed text appears as new `user_authored` branch in canvas + export. |
| 7 | Skill doc update + multi-mode example. | Re-read SKILL.md; spot-check; run a /grill-cheese against this project to confirm. |
| 8 | Smoke test addition + green run. | `PYTHONPATH=. uv run python -m scripts.smoke_e2e` |
| 9 | Delete old session JSONs. | `rm -rf ~/.grill-cheese/project-*/sessions/*.json` |

Estimated agent-time: **~2–3 hours** including verification loops + the GUI multi-mode render which is the most fiddly part.

---

## 13. Risks / known unknowns

- **Pre-check on render race**: useEffect keyed on `node.id` initialises `pendingChecks` from ★ branches. If `node_updated` SSE arrives mid-think (e.g. chat applied refine adds a new ★), the effect should NOT re-initialise — pre-check is a one-shot. Guard with a ref `initialisedFor: string | null`.
- **`node.multi_select` mutation**: should be immutable post-creation. Don't allow chat refine to flip the mode mid-question.
- **Pydantic `extra=ignore` on Node**: required for old sessions to load without crashes after `user_note` / `chosen_branch_id` removal. Confirm Session-level extra=ignore doesn't already cover nested Node (it does NOT — pydantic configs don't cascade).
- **`Branch.user_authored` default false**: existing branches in old sessions deserialize fine (Pydantic fills the default).
- **Smoke test brittleness**: existing smoke covers single-mode. Don't break it; the plural rewrite must produce the same chain markdown for single-mode runs.
