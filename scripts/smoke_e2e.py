"""In-process smoke for the buffered grill loop + chat-as-decision.

Tests:
  1. present_branches returns immediately with node_id
  2. wait_for_action times out cleanly when no clicks (returns empty actions)
  3. terminal click flushes immediately → wait_for_action returns batch
  4. wait_for_action is idempotent — re-poll returns same batch
  5. flushed node is locked — further enqueue_action rejected
  6. apply_chat_result(refine): merges adds, soft-deletes removes, unlocks
  7. apply_chat_result idempotency: replay with same chat_id is no-op
  8. apply_chat_result rejects unknown branch ids in removes
  9. apply_chat_result(redirect): node.redirected = True
 10. apply_chat_result(resolve): synthesizes chosen branch
 11. picking a chat-removed branch fails apply_action (would be 409 over HTTP)
"""
import asyncio
import uuid

from server.state import store, DEBOUNCE_SECONDS
from server.schemas import Branch, ChatOps, GuiAction


def push_click(sid: str, node_id: str, action: str, branch_id: str | None = None, note: str | None = None):
    a = GuiAction(
        session_id=sid, node_id=node_id, action=action, branch_id=branch_id, note=note
    )
    rec = store.apply_action(a)
    assert rec is not None, f"apply_action returned None for {action}"
    ok = store.enqueue_action(sid, node_id, rec)
    assert ok, "enqueue rejected"
    if action in ("next", "other", "stop", "chat"):
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
    push_click(sid, nid, "next", branch_id="b2")
    await asyncio.wait_for(ev.wait(), timeout=1.0)
    batch = store.get_actions(nid)
    assert batch is not None and len(batch) == 1
    assert batch[0].action == "next" and batch[0].chosen_branch_id == "b2"
    assert node.chosen_branch_id == "b2", "next must set node.chosen_branch_id"
    print(f"OK — terminal flushed batch={[a.action for a in batch]}")

    # 4. idempotent
    again = store.get_actions(nid)
    assert again == batch
    print("OK — idempotent on re-poll")

    # 5. locked: further enqueue rejected
    locked_a = GuiAction(session_id=sid, node_id=nid, action="next", branch_id="b1")
    rec = store.apply_action(locked_a)
    assert rec is None, "apply_action should reject locked node"
    print("OK — flushed node locked")

    # ---- chat-as-decision ----

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

    # simulate user clicking chat
    push_click(sid, nid2, "chat")
    store.pause_session(sid, nid2, None)
    assert store.is_flushed(nid2), "chat must flush + lock node"
    assert node2.chosen_branch_id is None, "chat must not set chosen"

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
    assert not store.is_flushed(nid2), "refine should unlock node"
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
    bad_pick = GuiAction(session_id=sid, node_id=nid2, action="next", branch_id="c1")
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
    push_click(sid, node3.id, "chat")
    store.pause_session(sid, node3.id, None)
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

    # ---- resolve ----
    node4 = store.add_node(
        sid=sid,
        question="Resolve?",
        reasoning="",
        branches=[Branch(id="e1", label="x")],
        parent_node_id=None,
        parent_branch_id=None,
        depth=1,
    )
    push_click(sid, node4.id, "chat")
    store.pause_session(sid, node4.id, None)
    n_v, redir_bid_v, err_v = store.apply_chat_result(
        sid=sid,
        node_id=node4.id,
        chat_id=uuid.uuid4().hex,
        chat_summary="chat itself answered: pick x",
        outcome="resolve",
        ops=None,
    )
    assert err_v is None and n_v is not None
    assert n_v.chosen_branch_id is not None, "resolve must set chosen_branch_id"
    chosen = next(b for b in n_v.branches if b.id == n_v.chosen_branch_id)
    assert chosen.label, "synthesized branch must have a label"
    print(f"OK — resolve synthesized chosen branch: '{chosen.label}'")

    print("\nALL SMOKE TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
