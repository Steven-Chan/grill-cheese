---
name: verify-in-browser
description: Probe-driven loop for grill-cheese GUI work. Drive the app via its own MCP tools (start_session/present_branches), probe DOM via mcp__claude-in-chrome__javascript_tool, edit-build-reverify until the observed transform/state matches expectation. Three modes — debug (UI bug), feature (new GUI behavior), investigate (understand current behavior). Use when user says "verify in browser", "fix this UI bug", "build and check on chrome", "investigate the canvas behavior", "/verify-in-browser", or any frontend work that needs live confirmation past tsc.
---

# verify-in-browser

Edit-build-probe-iterate loop for the grill-cheese GUI. The app's own MCP control surface (`mcp__grill-cheese__*`) drives the canvas; `mcp__claude-in-chrome__javascript_tool` reads the live DOM. No GIF, no screenshot, no manual click — pure programmatic repro.

## When to invoke

Auto-triggers + explicit `/verify-in-browser`. Use for any of:

- **debug** — UI bug. Repro → root-cause → patch → reverify.
- **feature** — new GUI behavior. Build → drive in browser → confirm visible effect matches spec.
- **investigate** — understand existing behavior before touching anything. Drive + probe to map the actual runtime, not the assumed one.

DON'T use for: pure server/MCP work without GUI surface, type-only refactors, doc edits.

## Hard rules

- **Spawn one `Agent` (subagent_type=Explore) before editing.** Trace SSE → store → component. Ask for `file:line`. Always.
- **Drive the app via `mcp__grill-cheese__present_branches` etc., not manual clicks.** Reproducible, scriptable, no human in loop.
- **One `start_session` per attempt.** Fresh `session_id` each iteration → clean canvas, no stale state.
- **Wrap every probe in `new Promise(r => setTimeout(r, 1500-2500)).then(...)`.** React Flow needs time to mount/measure before `transform` settles.
- **Bundle-hash check after every `npm run build`:** `grep -c "<new-symbol>" gui/dist/assets/index-*.js`. Catches stale-bundle false negatives.
- **Patch is "done" only when a probe confirms the observable state changed as expected.** `tsc` green ≠ feature works.
- **End every session.** `mcp__grill-cheese__end_session(session_id)` before next attempt.
- **Final review.** Spawn `Agent subagent_type=feature-dev:code-reviewer` against the diff with HIGH-confidence-only filter.

## The spine (all three modes share this)

Steps below in order. Mode-specific entry/exit at the end of this doc.

### 1. Investigate first (always, even for "small" bugs)

Spawn one `Agent`:

```
subagent_type: Explore
prompt: |
  Trace <feature> end-to-end in this repo. Goal: <bug | new behavior | current shape>.
  Walk SSE -> store.ts -> components/<X>.tsx. Look for <transform setters | gating effects | etc>.
  Recent commits to consider: <git log -5 oneline output>.
  Report with file:line. ≤300 words.
```

Read the report. Read the named files yourself (don't trust summary alone for the lines you'll edit).

### 2. Confirm server alive

```bash
curl -s http://127.0.0.1:7878/ | head -c 200
```

If 404/connection refused → ask user to run `uv run python -m server.server` (don't auto-start; user owns server lifecycle).

### 3. Pre-load Chrome MCP tool schemas

```
ToolSearch query: select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool
```

Add `mcp__claude-in-chrome__find` only if you'll click DOM directly. Skip `gif_creator`, `read_console_messages`, `read_page` unless mode-specific need (see below).

### 4. Get a tab

```
mcp__claude-in-chrome__tabs_context_mcp
```

Reuse if a `127.0.0.1:7878` tab already open (cheaper). Else `mcp__claude-in-chrome__tabs_create_mcp`.

### 5. Start a fresh session

```
mcp__grill-cheese__start_session(brief="<verify-in-browser: what you're testing>")
```

Save `session_id`. Each attempt gets its own.

### 6. Navigate

```
mcp__claude-in-chrome__navigate(tabId=<id>, url="http://127.0.0.1:7878/")
```

GUI does NOT parse a `?session=` query param. `App.tsx` auto-selects the **last** session in the server's list (the one you just created in step 5). Navigate AFTER `start_session`, not before — order matters.

If a tab is already on `127.0.0.1:7878` and the canvas shows a stale session, force a reload via `mcp__claude-in-chrome__navigate` to the same URL — store re-fetches `listSessions()` and picks your new session.

### 7. Drive the app

Push 1–3 nodes via `mcp__grill-cheese__present_branches` to populate the canvas. Skip `wait_for_action` — you're not asking the user, you're scripting state.

```
mcp__grill-cheese__present_branches(
  session_id=<id>,
  question="probe-1",
  branches=[{id:"a",label:"A",is_recommended:true},{id:"b",label:"B"}],
  reasoning="verify-in-browser drive",
  depth=0
)
```

### 8. Probe DOM

```
mcp__claude-in-chrome__javascript_tool(
  tabId=<id>,
  code: |
    new Promise(r => setTimeout(r, 2000)).then(() => {
      const vp = document.querySelector('.react-flow__viewport');
      const nodes = document.querySelectorAll('.react-flow__node');
      return {
        transform: vp?.style.transform,
        nodeCount: nodes.length,
        // mode-specific extras: pendingId, classNames, attribute values, fiber walk results
      };
    })
)
```

Patterns:
- **Read transform**: viewport pan/zoom verified by `transform: translate(x, y) scale(z)`.
- **Read measured dims**: `rf.getInternalNode(id)?.measured` via fiber walk if needed.
- **Fiber walk** (last resort to inspect React Flow internals):
  ```js
  const el = document.querySelector('.react-flow');
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
  // walk el[key].return chain, read .stateNode / .memoizedProps
  ```

### 9. Form hypothesis → edit → build

Edit the file you identified in step 1. Then:

```bash
cd gui && npm run build && cd ..
```

Catches: type errors, bundle generation. If build fails, fix and rebuild — don't proceed to verify.

### 10. Bundle-hash check

```bash
ls gui/dist/assets/index-*.js 2>/dev/null || { echo "NO BUNDLE — build silently failed?"; exit 1; }
grep -c "<distinctive-symbol-from-your-edit>" gui/dist/assets/index-*.js
```

Vite emits `index-<hash>.js`; glob matches it. Count should be ≥1.
- 0 with bundle present → edit didn't land in bundle (wrong file? tree-shaken?). Stop.
- Glob matched nothing → build failed silently OR Vite output renamed. Fix build first.

### 11. Reverify

End old session, start a new one, repeat steps 5–8. Diff observed against expected.

```
mcp__grill-cheese__end_session(session_id=<old>)
```

If observation matches expectation → done with this iteration. Else iterate from step 9 with a new hypothesis. (Transcript precedent: 4 iterations is normal, not failure.)

### 12. Final review

After verified fix:

```
Agent(
  subagent_type: feature-dev:code-reviewer
  prompt: |
    Review diff at <files:lines>. Bug was <X>. Root cause <Y>. Patched by <Z>. Verified observable: <transform / state diff>.
    HIGH-confidence issues only — no nits, no style, no speculation.
    ≤200 words.
)
```

Address any HIGH issue, re-verify (steps 9–11), re-review.

## Mode adjustments

### debug

- Step 1: phrase Explore prompt as "find what controls X — likely broken at <symptom>".
- Step 8: probe must capture both **broken state** (before fix) and **fixed state** (after) for the same input. The diff is the proof.
- If symptom is timing-sensitive, stretch `setTimeout` to 3000ms before declaring "doesn't pan".

### feature

- Step 1: phrase Explore as "where does X currently happen / not happen — best place to add Y".
- Skip step 8's "before" probe (no broken state). Instead: probe for absence of new behavior, build, probe for presence.
- More likely to need 2–3 nodes pushed in step 7 to exercise the new path.

### investigate

- No edit. Steps 1–8 only. End at step 8 with a written `<findings>` block describing observed runtime, file:line evidence, surprises vs assumptions.
- Useful before any non-trivial GUI feature/bug — call this skill in investigate mode first to ground the plan.
- Skip steps 9–12.

## Tool quick-ref

| Step | Tool |
|------|------|
| Trace | `Agent` (Explore) |
| Server check | `Bash` curl |
| Schema load | `ToolSearch` |
| Tab | `mcp__claude-in-chrome__tabs_context_mcp` / `tabs_create_mcp` |
| Session | `mcp__grill-cheese__start_session` / `end_session` |
| Navigate | `mcp__claude-in-chrome__navigate` |
| Drive | `mcp__grill-cheese__present_branches` |
| Probe | `mcp__claude-in-chrome__javascript_tool` (always Promise+setTimeout) |
| Edit | `Edit` / `Write` |
| Build | `Bash` `cd gui && npm run build` |
| Bundle check | `Bash` `grep -c <symbol> gui/dist/assets/index-*.js` |
| Review | `Agent` (feature-dev:code-reviewer) |

## Anti-patterns

- ❌ Skip Explore agent, jump to edit. Wastes iterations on wrong file.
- ❌ Reuse `session_id` across attempts. Stale canvas state masks regressions.
- ❌ `tsc` green → claim done. Type-correct ≠ behavior-correct.
- ❌ Read DOM without `setTimeout`. React Flow not measured yet → false negative.
- ❌ Skip bundle-hash check. Browser serves cached JS, you "verify" old code.
- ❌ Ask user to manually click. Not reproducible across iterations.
- ❌ Skip final review agent. Self-review misses class of bugs (gating logic, race, cleanup).
- ❌ Single-call wrapper around `present_branches`+`wait_for_action`. CLAUDE.md forbids the *wrapper pattern* (causes duplicate nodes on transport retry). For verification you intentionally **omit** `wait_for_action` entirely — you're scripting state, not waiting for a human. That's correct, not a violation.
