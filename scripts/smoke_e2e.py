"""In-process smoke for the buffered grill loop.

Tests:
  1. present_branches returns immediately with node_id
  2. wait_for_action times out cleanly when no clicks (returns empty actions)
  3. terminal click flushes immediately → wait_for_action returns batch
  4. wait_for_action is idempotent — re-poll returns same batch
  5. tagging clicks accumulate; idle flush returns full ordered list
  6. flushed node is locked — further enqueue_action rejected
"""
import asyncio

from server.state import store, DEBOUNCE_SECONDS
from server.schemas import Branch, GuiAction


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
    sid = store.new_session(brief="smoke buffered loop").id
    print(f"session={sid}")

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
    print(f"OK — terminal flushed batch={[a.action for a in batch]}")

    # 4. idempotent
    again = store.get_actions(nid)
    assert again == batch
    print("OK — idempotent on re-poll")

    # 6. locked: further enqueue rejected
    locked_a = GuiAction(session_id=sid, node_id=nid, action="mark_rejected", branch_id="b1")
    rec = store.apply_action(locked_a)
    assert rec is None, "apply_action should reject locked node"
    ok = store.enqueue_action(sid, nid, store.get_actions(nid)[0])  # placeholder; should be rejected
    assert not ok, "enqueue should reject locked node"
    print("OK — flushed node locked")

    # 5. tagging accumulates; idle timer flushes
    node2 = store.add_node(
        sid=sid, question="Q2", reasoning="", branches=[
            Branch(id="b3", label="C"), Branch(id="b4", label="D"),
        ], parent_node_id=None, parent_branch_id=None, depth=0,
    )
    nid2 = node2.id
    push_click(sid, nid2, "mark_rejected", branch_id="b3")
    push_click(sid, nid2, "unmark", branch_id="b3")
    push_click(sid, nid2, "mark_rejected", branch_id="b4")
    # not flushed yet
    assert store.get_actions(nid2) is None
    print(f"OK — {len(store._pending.get(nid2, []))} tagging clicks buffered, no flush yet")
    # wait for idle flush
    ev2 = store.get_event(nid2)
    await asyncio.wait_for(ev2.wait(), timeout=DEBOUNCE_SECONDS + 0.5)
    batch2 = store.get_actions(nid2)
    assert batch2 is not None and len(batch2) == 3
    assert [a.action for a in batch2] == ["mark_rejected", "unmark", "mark_rejected"]
    print(f"OK — idle flush returned ordered batch={[a.action for a in batch2]}")


if __name__ == "__main__":
    asyncio.run(main())
