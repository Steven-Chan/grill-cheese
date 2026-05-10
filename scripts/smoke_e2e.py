"""In-process smoke for the long-poll grill loop.

Tests:
  1. present_branches returns immediately with node_id
  2. wait_for_action times out cleanly when no user click (returns skip)
  3. set_action commits → next wait_for_action returns the action
  4. wait_for_action is idempotent — re-calling after commit returns same action
"""
import asyncio

from server.state import store
from server.schemas import Branch, GuiAction, AskBranchesResult


async def fake_action_after(node_id: str, sid: str, branch_id: str, delay: float):
    await asyncio.sleep(delay)
    action = GuiAction(
        session_id=sid,
        node_id=node_id,
        branch_id=branch_id,
        action="next",
    )
    result = store.apply_action(action)
    assert result is not None
    committed = store.set_action(node_id, result)
    assert committed, "expected first commit to succeed"
    print(f"committed action node={node_id} → {result.action}")


async def main():
    sid = store.new_session(brief="smoke long-poll").id
    print(f"session={sid}")

    # 1. push node
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
    print(f"node={node.id}")

    # 2. wait_for_action times out cleanly
    ev = store.get_event(node.id)
    try:
        await asyncio.wait_for(ev.wait(), timeout=0.3)
        raise AssertionError("expected timeout")
    except asyncio.TimeoutError:
        skip = store.get_action(node.id)
        assert skip is None, "expected no action committed"
        print("OK — short poll times out without commit")

    # 3. fake user action commits
    asyncio.create_task(fake_action_after(node.id, sid, "b2", 0.1))
    await asyncio.wait_for(ev.wait(), timeout=2.0)
    a1 = store.get_action(node.id)
    assert a1 is not None and a1.action == "next" and a1.chosen_branch_id == "b2"
    print(f"OK — wait returns action={a1.action}")

    # 4. idempotent
    a2 = store.get_action(node.id)
    assert a2 == a1
    print("OK — idempotent on re-poll")

    # 5. second commit ignored
    again = store.set_action(
        node.id, AskBranchesResult(node_id=node.id, action="stop")
    )
    assert not again, "expected second set_action to be ignored"
    final = store.get_action(node.id)
    assert final.action == "next", "first action should win"
    print("OK — second commit ignored, first-write-wins")


if __name__ == "__main__":
    asyncio.run(main())
