"""In-process smoke for the buffered grill loop + non-blocking chat outcomes.

Non-blocking chat (ADR-0001): the `chat` action and session pause/lock are
gone; chat starts implicitly when the first chat_user_msg lands. `resolve`
outcome dropped — only `refine` and `redirect` remain.

Tests:
  1. present_branches returns immediately with node_id
  2. unflushed node has no committed actions (parking on the per-node Event)
  3. terminal click flushes immediately → committed batch present
  4. flushed batch is idempotent on re-read
  5. flushed node is locked — further enqueue_action rejected
  6. apply_chat_result(refine): merges adds, soft-deletes removes
  7. apply_chat_result idempotency: replay with same chat_id is no-op
  8. apply_chat_result rejects unknown branch ids in removes
  9. apply_chat_result(redirect): node.redirected = True
 10. apply_chat_result rejects `resolve` outcome (dropped in ADR-0001)
 11. picking a chat-removed branch fails apply_action (would be 409 over HTTP)
 12. multi-mode submit synthesizes a user_authored branch from own_answer
"""
import asyncio
import uuid

from server.state import store
from server.schemas import Branch, ChatOps, GuiAction, ParkedSlot


def push_click(
    sid: str,
    node_id: str,
    action: str,
    branch_ids: list[str] | None = None,
    own_answer: str | None = None,
):
    a = GuiAction(
        session_id=sid,
        node_id=node_id,
        action=action,
        branch_ids=branch_ids or [],
        own_answer=own_answer,
    )
    rec = store.apply_action(a)
    assert rec is not None, f"apply_action returned None for {action}"
    ok = store.enqueue_action(sid, node_id, rec)
    assert ok, "enqueue rejected"
    if action == "next":
        store.flush_now(sid, node_id)


async def main():
    s_obj = store.new_session(
        title="Smoke buffered loop",
        brief="smoke buffered loop",
        project="smoke",
    )
    sid = s_obj.id
    assert s_obj.title == "Smoke buffered loop", "title round-trip"
    print(f"session={sid}")

    # MCP boundary validation: empty title / overlong title / empty project
    from server.mcp_app import start_session as _start
    r_empty = await _start(title="", brief="b", project="p")
    assert r_empty.get("error"), "empty title must error"
    r_long = await _start(title="x" * 81, brief="b", project="p")
    assert r_long.get("error"), "overlong title must error"
    r_empty_proj = await _start(title="ok", brief="b", project="")
    assert r_empty_proj.get("error"), "empty project must error"
    print("OK — MCP start_session rejects empty/overlong title and empty project")

    branches = [
        Branch(id="b1", label="A", rationale="", is_recommended=True),
        Branch(id="b2", label="B", rationale=""),
    ]
    node = store.add_node(
        sid=sid,
        question="Smoke?",
        reasoning="r",
        branches=branches,
        parent_node_id=None,
        parent_branch_id=None,
        depth=0,
    )
    nid = node.id
    print(f"node={nid}")

    # 2. timeout returns no actions
    ev = store.get_event(nid)
    try:
        await asyncio.wait_for(ev.wait(), timeout=0.2)
        raise AssertionError("expected timeout")
    except asyncio.TimeoutError:
        assert store.get_actions(nid) is None
        print("OK — empty buffer waits without flushing")

    # 3. terminal click flushes immediately
    push_click(sid, nid, "next", branch_ids=["b2"])
    await asyncio.wait_for(ev.wait(), timeout=1.0)
    batch = store.get_actions(nid)
    assert batch is not None and len(batch) == 1
    assert batch[0].action == "next" and batch[0].chosen_branch_ids == ["b2"]
    assert batch[0].chosen_branch_labels == ["B"]
    assert node.chosen_branch_ids == ["b2"], "next must set node.chosen_branch_ids"
    print(f"OK — terminal flushed batch={[a.action for a in batch]}")

    # 4. idempotent
    again = store.get_actions(nid)
    assert again == batch
    print("OK — idempotent on re-poll")

    # 5. locked: further enqueue rejected
    locked_a = GuiAction(session_id=sid, node_id=nid, action="next", branch_ids=["b1"])
    rec = store.apply_action(locked_a)
    assert rec is None, "apply_action should reject locked node"
    print("OK — flushed node locked")

    # ---- non-blocking chat outcomes (refine / redirect; no resolve) ----

    node2 = store.add_node(
        sid=sid,
        question="Chat refine?",
        reasoning="",
        branches=[
            Branch(id="c1", label="opt1"),
            Branch(id="c2", label="opt2", is_recommended=True),
        ],
        parent_node_id=None,
        parent_branch_id=None,
        depth=1,
    )
    nid2 = node2.id

    # non-blocking: no chat action, no pause. Chat doesn't flush/lock the node.
    assert not store.is_flushed(nid2), "fresh node must not be flushed"
    assert node2.chosen_branch_ids == [], "fresh node must have no chosen"

    # 6. refine: add 1, remove c1
    chat_id = uuid.uuid4().hex
    ops = ChatOps(
        adds=[Branch(id="c3", label="new opt", rationale="from chat")],
        removes=["c1"],
    )
    n_after, redir_bid_after, err = store.apply_chat_result(
        sid=sid,
        node_id=nid2,
        chat_id=chat_id,
        chat_summary="discussed; sharpened set",
        outcome="refine",
        ops=ops,
    )
    assert err is None, f"refine failed: {err}"
    assert n_after is not None
    assert "c1" in n_after.removed_branch_ids, "c1 should be soft-removed"
    assert any(b.id == "c3" for b in n_after.branches), "c3 should be added"
    assert len(n_after.chats) == 1, "chats should accumulate"
    assert n_after.chats[0].outcome == "refine"
    assert not store.is_flushed(nid2), "non-blocking chat — node stays unlocked"
    print(f"OK — refine: removed={n_after.removed_branch_ids} branches={[b.id for b in n_after.branches]}")

    # 7. idempotency: replay same chat_id is no-op
    n_again, redir_bid_again, err2 = store.apply_chat_result(
        sid=sid,
        node_id=nid2,
        chat_id=chat_id,
        chat_summary="ignored on replay",
        outcome="refine",
        ops=ChatOps(adds=[Branch(id="c4", label="should not appear")], removes=[]),
    )
    assert err2 is None
    assert n_again is not None
    assert not any(b.id == "c4" for b in n_again.branches), "replay must not mutate"
    assert len(n_again.chats) == 1, "replay must not append chat block"
    print("OK — apply_chat_result idempotent on chat_id replay")

    # 8. unknown branch id in removes → error, no mutation
    bad_chat = uuid.uuid4().hex
    nbad, redir_bid_bad, errbad = store.apply_chat_result(
        sid=sid,
        node_id=nid2,
        chat_id=bad_chat,
        chat_summary="should fail",
        outcome="refine",
        ops=ChatOps(adds=[], removes=["nonexistent_id"]),
    )
    assert nbad is None and errbad is not None
    assert "nonexistent_id" in errbad
    # node unchanged
    n_check = store.get(sid).nodes[nid2]
    assert len(n_check.chats) == 1, "failed apply must not append chat"
    print(f"OK — unknown branch id rejected: {errbad}")

    # 11. picking a chat-removed branch fails (HTTP layer would return 409)
    bad_pick = GuiAction(session_id=sid, node_id=nid2, action="next", branch_ids=["c1"])
    rec_bad = store.apply_action(bad_pick)
    assert rec_bad is None, "picking a removed branch must fail"
    print("OK — pick on removed branch rejected (would be 409 over HTTP)")

    # ---- redirect ----
    node3 = store.add_node(
        sid=sid,
        question="Redirect?",
        reasoning="",
        branches=[Branch(id="d1", label="x"), Branch(id="d2", label="y")],
        parent_node_id=None,
        parent_branch_id=None,
        depth=1,
    )
    n_r, redir_bid, err_r = store.apply_chat_result(
        sid=sid,
        node_id=node3.id,
        chat_id=uuid.uuid4().hex,
        chat_summary="this question is wrong",
        outcome="redirect",
        ops=None,
    )
    assert err_r is None and n_r is not None
    assert n_r.redirected is True, "redirect must set node.redirected"
    assert redir_bid is not None, "redirect must return synthesized branch_id"
    assert any(b.id == redir_bid for b in n_r.branches), "redirect branch must exist on node"
    print(f"OK — redirect marks node.redirected; synthesized branch={redir_bid}")

    # ---- resolve dropped (ADR-0001) ----
    node4 = store.add_node(
        sid=sid,
        question="Resolve dead?",
        reasoning="",
        branches=[Branch(id="e1", label="x")],
        parent_node_id=None,
        parent_branch_id=None,
        depth=1,
    )
    n_v, redir_bid_v, err_v = store.apply_chat_result(
        sid=sid,
        node_id=node4.id,
        chat_id=uuid.uuid4().hex,
        chat_summary="should not apply",
        outcome="resolve",
        ops=None,
    )
    assert n_v is None and err_v is not None
    assert "resolve" in err_v.lower() or "outcome" in err_v.lower(), \
        f"resolve must be rejected: got {err_v}"
    print(f"OK — resolve outcome rejected: {err_v}")

    # ---- multi-mode + synth user_authored branch from own_answer ----
    node5 = store.add_node(
        sid=sid,
        question="Pick all that apply?",
        reasoning="multi smoke",
        branches=[
            Branch(id="m1", label="alpha", is_recommended=True),
            Branch(id="m2", label="beta", is_recommended=True),
            Branch(id="m3", label="gamma"),
        ],
        parent_node_id=None,
        parent_branch_id=None,
        depth=0,
        multi_select=True,
    )
    nid5 = node5.id
    # user submits 2 checks + Own Answer text → server synthesizes a 3rd branch.
    push_click(
        sid,
        nid5,
        "next",
        branch_ids=["m1", "m3"],
        own_answer="extra context the user typed",
    )
    batch5 = store.get_actions(nid5)
    assert batch5 and len(batch5) == 1
    rec5 = batch5[0]
    assert rec5.action == "next"
    assert len(rec5.chosen_branch_ids) == 3, f"expected 3 picks (2 + synth), got {len(rec5.chosen_branch_ids)}"
    assert rec5.chosen_branch_ids[:2] == ["m1", "m3"]
    assert rec5.chosen_branch_labels[:2] == ["alpha", "gamma"]
    synth_id = rec5.chosen_branch_ids[2]
    synth = next(b for b in node5.branches if b.id == synth_id)
    assert synth.user_authored is True, "synth branch must be user_authored"
    assert synth.rationale == "extra context the user typed"
    assert rec5.chosen_branch_labels[2] == synth.label
    print(f"OK — multi-mode submit synthesized branch '{synth.label}' alongside picks")

    # min=1: empty submit (no picks, no own_answer) is rejected
    node6 = store.add_node(
        sid=sid,
        question="Empty submit?",
        reasoning="min=1 smoke",
        branches=[Branch(id="z1", label="x")],
        parent_node_id=None,
        parent_branch_id=None,
        depth=0,
        multi_select=True,
    )
    empty = GuiAction(
        session_id=sid, node_id=node6.id, action="next", branch_ids=[], own_answer="   "
    )
    rec_empty = store.apply_action(empty)
    assert rec_empty is None, "empty multi-submit must be rejected"
    print("OK — empty multi-submit rejected (min=1)")

    # `chat` action removed from the literal — Pydantic must reject
    try:
        GuiAction(session_id=sid, node_id=node6.id, action="chat")
        raise AssertionError("action=chat should no longer validate")
    except Exception:
        print("OK — action=chat rejected by schema literal (ADR-0001)")

    # ---- speculation queue (ADR-0010) ----
    ok, err = store.enqueue_speculation(
        sid,
        [
            ParkedSlot(
                question="Sideways Q1?",
                reasoning="parked by speculator",
                branches=[
                    Branch(id="p1", label="opt-a", is_recommended=True),
                    Branch(id="p2", label="opt-b"),
                ],
            ),
            ParkedSlot(
                question="Sideways Q2?",
                branches=[Branch(id="q1", label="only")],
            ),
        ],
    )
    assert ok and err is None, f"enqueue_speculation failed: {err}"
    s_check = store.get(sid)
    assert s_check is not None
    assert len(s_check.parked_queue) == 2, "queue must have 2 slots"
    assert all(p.enqueued_at is not None for p in s_check.parked_queue), \
        "server must stamp enqueued_at"
    slot_id_consume = s_check.parked_queue[0].slot_id
    print(f"OK — enqueue_speculation parked {len(s_check.parked_queue)} slots")

    # 13a. consume_parked happy path
    consumed, err2 = store.consume_parked(sid, slot_id_consume)
    assert consumed is not None and err2 is None
    assert consumed.slot_id == slot_id_consume
    assert len(s_check.parked_queue) == 1, "consume must pop one slot"
    print(f"OK — consume_parked popped slot={slot_id_consume[:8]}")

    # 13b. consume again → slot_not_found (race-safety)
    again, err3 = store.consume_parked(sid, slot_id_consume)
    assert again is None and err3 == "slot_not_found"
    print("OK — consume_parked returns slot_not_found on race / missing slot")

    # 13c. enqueue replace: full queue swap drops the survivor
    survivor_id = s_check.parked_queue[0].slot_id
    ok2, err4 = store.enqueue_speculation(
        sid,
        [ParkedSlot(question="Fresh round", branches=[Branch(id="f1", label="ok")])],
    )
    assert ok2 and err4 is None
    assert len(s_check.parked_queue) == 1
    assert s_check.parked_queue[0].slot_id != survivor_id, "replace must drop prior slots"
    print("OK — enqueue_speculation wholesale-replaces prior queue")

    # 13d. present_parked MCP tool dequeues + emits node
    from server.mcp_app import present_parked as _present_parked
    fresh_id = s_check.parked_queue[0].slot_id
    res = await _present_parked(session_id=sid, slot_id=fresh_id, progress=0.42)
    assert res.get("ok") is True, f"present_parked failed: {res}"
    promoted_nid = res.get("node_id")
    assert promoted_nid and promoted_nid in s_check.nodes
    promoted = s_check.nodes[promoted_nid]
    assert promoted.question == "Fresh round"
    assert promoted.progress == 0.42, "main-supplied progress must land on node"
    # Plan: parked slots are root-level sideways moves — no parent. Regression
    # guard against a future leak of parent fields from slot payload.
    assert promoted.parent_node_id is None, "promoted node must be root-level"
    assert promoted.parent_branch_id is None, "promoted node must have no parent branch"
    assert len(s_check.parked_queue) == 0, "queue empty after consume"
    print(f"OK — present_parked promoted slot to node={promoted_nid}")

    # 13e. present_parked on missing slot → ok:false
    miss = await _present_parked(session_id=sid, slot_id="ffffffff", progress=0.5)
    assert miss.get("ok") is False and "slot_not_found" in (miss.get("err") or "")
    print("OK — present_parked surfaces slot_not_found cleanly")

    print("\nALL SMOKE TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
