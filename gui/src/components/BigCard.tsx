import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import {
  EditorContent,
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  mergeAttributes,
  useEditor,
} from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import type { Editor as CoreEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Plugin } from "@tiptap/pm/state";
import {
  logShortcutPrefill,
  postAction,
  type ActionKind,
  type ActionRejection,
} from "../api";
import { useSession } from "../SessionContext";
import type { Branch, ChatMessage, DecisionNode, PendingProposal } from "../types";
import { HistoryEntry } from "./HistoryEntry";
import { FOCUS_COMPOSER_EVENT } from "../hooks/useShortcuts";

// Decision map is the sole xyflow + dagre surface in the GUI (ADR-0002).
// Lazy-loaded so the ~150KB xyflow bundle never touches the initial paint
// of the active grill surface — only fetched when the user opens the
// retrospective overlay from the summary card.
const DecisionMap = lazy(() => import("./DecisionMap"));

// MIME used for branch-row drag payloads. Plain JSON in the body:
// `{branch_id, label}`. Read by the Tiptap drop handler + the Own Answer
// textarea drop listener.
const CHIP_MIME = "application/x-grill-chip";

// uuid for chat_id / msg_id. crypto.randomUUID() is available in all
// browsers we target (Chrome/Edge/FF/Safari from 2022 onward) and in
// secure contexts only — localhost qualifies.
function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

interface Props {
  onToast: (msg: string) => void;
  selectedNodeId: string | null;
  onClearSelection: () => void;
}

export function BigCard({ onToast, selectedNodeId, onClearSelection }: Props) {
  const { state } = useSession();

  // if pinned to a past node AND it's not the current pending, render read-only view
  if (selectedNodeId && selectedNodeId !== state.pendingNodeId) {
    const pinned = state.nodes[selectedNodeId];
    if (!pinned) return null;
    return (
      <div className="gc-bigcard-pastview">
        <button
          type="button"
          className="gc-btn gc-btn-toolbar gc-pastview-back"
          onClick={onClearSelection}
        >
          ← back to current question
        </button>
        <HistoryEntry node={pinned} expanded />
      </div>
    );
  }

  // when there's no live pending question, keep the most recent card on screen
  // (force-locked) so the view doesn't flash to a placeholder between submit
  // and the next node arriving over SSE. Skip implicit (silent record-only)
  // and redirected (settled-via-chat) nodes — neither should resurface as
  // the visible card.
  let pendingId = state.pendingNodeId;
  const fromFallback = !pendingId;
  if (!pendingId) {
    for (let i = state.nodeOrder.length - 1; i >= 0; i--) {
      const id = state.nodeOrder[i];
      const n = state.nodes[id];
      if (!n) continue;
      if (n.implicit) continue;
      if (n.redirected) continue;
      pendingId = id;
      break;
    }
  }
  if (!pendingId) {
    return (
      <div className="gc-bigcard gc-bigcard-idle">
        <p className="gc-dim">waiting for the next question…</p>
      </div>
    );
  }
  const node = state.nodes[pendingId];
  if (!node) return null;
  return node.kind === "summary" ? (
    <SummaryCard key={node.id} node={node} sid={state.sid} onToast={onToast} forceLocked={fromFallback} />
  ) : (
    <DecisionCard
      key={node.id}
      node={node}
      sid={state.sid}
      onToast={onToast}
      forceLocked={fromFallback}
    />
  );
}

// ---------- branch chip (Tiptap node) ----------

interface ChipAttrs {
  branchId: string;
  label: string;
}

function ChipView(props: NodeViewProps) {
  const attrs = props.node.attrs as ChipAttrs;
  return (
    <NodeViewWrapper as="span" className="gc-branch-chip" contentEditable={false} draggable={false}>
      <span className="gc-branch-chip-label">{attrs.label || "branch"}</span>
      <button
        type="button"
        className="gc-chip-x"
        title="Remove"
        aria-label="Remove chip"
        // mousedown so we beat ProseMirror's selection handling — by the time
        // click fires, focus may have shifted off the editor and the node
        // selection that deleteNode() needs is gone.
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.deleteNode();
        }}
      >
        ×
      </button>
    </NodeViewWrapper>
  );
}

const BranchChipNode = Node.create({
  name: "branchChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      branchId: { default: "" },
      label: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-branch-chip]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ "data-branch-chip": "true", class: "gc-branch-chip" }, HTMLAttributes),
      0,
    ];
  },
  renderText({ node }) {
    const a = node.attrs as ChipAttrs;
    return `[Branch ${a.branchId}: ${a.label}]`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(ChipView);
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            drop: (view, raw) => {
              const event = raw as DragEvent;
              const json = event.dataTransfer?.getData(CHIP_MIME);
              if (!json) return false;
              event.preventDefault();
              let payload: { branch_id?: string; label?: string };
              try {
                payload = JSON.parse(json);
              } catch {
                return true;
              }
              if (!payload.branch_id) return true;
              const pos = view.posAtCoords({
                left: event.clientX,
                top: event.clientY,
              });
              if (!pos) return true;
              // posAtCoords can resolve INSIDE an existing atom (e.g. drop
              // onto an existing chip). Resolve to the nearest valid text
              // gap before inserting, otherwise the insert position lands
              // mid-atom and ProseMirror clips it.
              const $pos = view.state.doc.resolve(pos.pos);
              const node = view.state.schema.nodes.branchChip.create({
                branchId: payload.branch_id,
                label: payload.label ?? "",
              });
              // Replace-on-drop: if the drop landed on an empty placeholder
              // chip, swap the placeholder out for the real branch chip
              // instead of inserting alongside it. nodeAfter / nodeBefore
              // because posAtCoords resolves to the atom boundary.
              const placeholderType = view.state.schema.nodes.branchChipPlaceholder;
              let phStart: number | null = null;
              let phEnd: number | null = null;
              if ($pos.nodeAfter && $pos.nodeAfter.type === placeholderType) {
                phStart = $pos.pos;
                phEnd = $pos.pos + $pos.nodeAfter.nodeSize;
              } else if ($pos.nodeBefore && $pos.nodeBefore.type === placeholderType) {
                phStart = $pos.pos - $pos.nodeBefore.nodeSize;
                phEnd = $pos.pos;
              }
              const tr =
                phStart != null && phEnd != null
                  ? view.state.tr.replaceWith(phStart, phEnd, node)
                  : view.state.tr.insert($pos.pos, node);
              view.dispatch(tr);
              return true;
            },
            dragover: (_view, raw) => {
              const event = raw as DragEvent;
              if (event.dataTransfer?.types?.includes(CHIP_MIME)) {
                event.preventDefault();
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

// ---------- branch chip placeholder (Tiptap node) ----------

// Empty inline atom that renders as a dashed pill in the editor and serializes
// to the empty string in the chat message. Drag a branch onto it to swap the
// placeholder out for a real branch chip (handled in BranchChipNode's drop
// plugin above). If the user sends without filling it, it just disappears.

function ChipPlaceholderView(props: NodeViewProps) {
  return (
    <NodeViewWrapper
      as="span"
      className="gc-chip-placeholder"
      contentEditable={false}
      draggable={false}
    >
      <span className="gc-chip-placeholder-label">drop branch</span>
      <button
        type="button"
        className="gc-chip-x"
        title="Remove slot"
        aria-label="Remove slot"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.deleteNode();
        }}
      >
        ×
      </button>
    </NodeViewWrapper>
  );
}

const BranchChipPlaceholder = Node.create({
  name: "branchChipPlaceholder",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  parseHTML() {
    return [{ tag: "span[data-chip-placeholder]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(
        { "data-chip-placeholder": "true", class: "gc-chip-placeholder" },
        HTMLAttributes,
      ),
      0,
    ];
  },
  renderText() {
    return "";
  },
  addNodeView() {
    return ReactNodeViewRenderer(ChipPlaceholderView);
  },
});

// ---------- decision card ----------

// Synthetic id for the "your own answer" radio in single-choice mode.
// Lives in the same `picked` set as branch ids so the radio group stays
// mutually exclusive. Stripped before sending — server only sees real
// branch_ids + own_answer string.
const OWN_ANSWER_ID = "__own_answer__";

function DecisionCard({
  node,
  sid,
  onToast,
  forceLocked,
}: {
  node: DecisionNode;
  sid: string;
  onToast: (msg: string) => void;
  forceLocked?: boolean;
}) {
  const multi = !!node.multi_select;
  const removed = useMemo(() => new Set(node.removed_branch_ids ?? []), [node.removed_branch_ids]);
  const live = useMemo(() => node.branches.filter((b) => !removed.has(b.id)), [node.branches, removed]);

  // initial selection: in multi-mode pre-check all is_recommended; single-mode pre-pick the recommended.
  const [picked, setPicked] = useState<Set<string>>(() => {
    const s = new Set<string>();
    if (multi) {
      for (const b of live) if (b.is_recommended) s.add(b.id);
    } else {
      const rec = live.find((b) => b.is_recommended);
      if (rec) s.add(rec.id);
    }
    return s;
  });
  const [ownAnswer, setOwnAnswer] = useState("");
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const ownAnswerRef = useRef<HTMLTextAreaElement | null>(null);

  // Roving-tabindex focus state for the ARIA listbox (ADR-0004). Exactly one
  // branch row carries tabIndex=0 at a time; the rest are -1. `Enter` on the
  // focused row picks+submits in single-mode, `Space` toggles, `Cmd+Enter`
  // submits in multi-mode. Initial focus = first ★ recommended branch so
  // the common "accept the recommendation" path is a single keystroke.
  // Default focus: first ★ recommended branch, else first live branch, else
  // own-answer (the only navigable target when chat removed every branch).
  const initialFocusId = useMemo(() => {
    const rec = live.find((b) => b.is_recommended);
    return rec?.id ?? live[0]?.id ?? OWN_ANSWER_ID;
  }, [live]);
  const [focusedBranchId, setFocusedBranchId] = useState<string | null>(initialFocusId);
  // Reset focus when node identity changes. Also auto-focus the row in the
  // DOM so the page starts with the listbox active (no Tab needed) — but
  // yield if the user is already typing somewhere; don't steal focus from
  // the brief banner / sidebar / any other input.
  useEffect(() => {
    setFocusedBranchId(initialFocusId);
    if (initialFocusId) {
      const t = window.setTimeout(() => {
        const active = document.activeElement;
        const typing =
          active instanceof HTMLElement &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.isContentEditable);
        if (typing) return;
        document.getElementById(`branch-${node.id}-${initialFocusId}`)?.focus();
      }, 0);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);
  // If chat soft-removes the currently-focused branch, hop to first live row
  // (or own-answer when everything got removed). OWN_ANSWER_ID is synthetic
  // — always valid, never in `live`. DOM-focus the fallback row so the
  // visible focus ring follows the state change (matches the focusByIdx
  // pattern in onListKeyDown).
  useEffect(() => {
    if (focusedBranchId === OWN_ANSWER_ID) return;
    if (focusedBranchId && !live.some((b) => b.id === focusedBranchId)) {
      const next = live[0]?.id ?? OWN_ANSWER_ID;
      setFocusedBranchId(next);
      // Yield to React commit so the new tabIndex=0 lands before .focus().
      window.setTimeout(
        () => document.getElementById(`branch-${node.id}-${next}`)?.focus(),
        0,
      );
    }
  }, [focusedBranchId, live, node.id]);
  // Ref-mirror so the composer Esc callback always reads the latest value
  // without re-creating the callback on every re-render.
  const focusedBranchIdRef = useRef<string | null>(focusedBranchId);
  useEffect(() => {
    focusedBranchIdRef.current = focusedBranchId;
  }, [focusedBranchId]);

  // reset selection when node identity changes only.
  // `live` is recomputed (new array ref) on every node_updated SSE — including
  // chat-message broadcasts. Including `live` in deps would wipe the user's
  // in-progress own-answer text mid-typing. node.id changing is the only
  // case that warrants a full reset; the initializer covers the branch list.
  useEffect(() => {
    setPicked(() => {
      const s = new Set<string>();
      if (multi) {
        for (const b of node.branches) if (b.is_recommended && !removed.has(b.id)) s.add(b.id);
      } else {
        const rec = node.branches.find((b) => b.is_recommended && !removed.has(b.id));
        if (rec) s.add(rec.id);
      }
      return s;
    });
    setOwnAnswer("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const togglePick = (id: string) => {
    if (multi) {
      setPicked((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      setPicked(new Set([id]));
      if (id === OWN_ANSWER_ID) {
        // focus textarea so user can immediately type
        setTimeout(() => ownAnswerRef.current?.focus(), 0);
      }
    }
  };

  const ownAnswerSelected = picked.has(OWN_ANSWER_ID);
  const realPicked = useMemo(
    () => Array.from(picked).filter((id) => id !== OWN_ANSWER_ID),
    [picked],
  );
  // single-mode: own-answer radio must be picked + textarea non-empty, OR a branch picked.
  // multi-mode: any branch picked OR non-empty own-answer text (independent of any radio).
  const canSubmit = multi
    ? realPicked.length > 0 || ownAnswer.trim().length > 0
    : ownAnswerSelected
      ? ownAnswer.trim().length > 0
      : realPicked.length > 0;
  // committed = answer landed. forceLocked = fallback render (no live pending).
  // Chat is non-blocking (ADR-0001) so chat_open/messages do NOT lock the card.
  const locked = !!forceLocked || !!node.committed || (node.chosen_branch_ids ?? []).length > 0;

  // Two-phase lock transition. Phase 1 fades chrome (~180ms), phase 2
  // restyles chosen + reorders + dims rejected (~280ms). Fresh mounts that
  // are already locked (history pin, fallback render) skip the animation
  // and land in phase 2 directly.
  const [lockPhase, setLockPhase] = useState<0 | 1 | 2>(locked ? 2 : 0);
  const prevLockedRef = useRef(locked);
  useEffect(() => {
    if (locked && !prevLockedRef.current) {
      setLockPhase(1);
      const t = window.setTimeout(() => setLockPhase(2), 180);
      prevLockedRef.current = true;
      return () => window.clearTimeout(t);
    }
    if (!locked && prevLockedRef.current) {
      setLockPhase(0);
      prevLockedRef.current = false;
    }
  }, [locked]);

  // Display order: in phase 2, chosen branches lift to the top, rejected
  // sink below a divider. Drives both the rendered <li> sequence and
  // the FLIP measurement (chosen ids move up by N row heights).
  const chosenIdSet = useMemo(
    () => new Set(node.chosen_branch_ids ?? []),
    [node.chosen_branch_ids],
  );
  type Row =
    | { kind: "branch"; b: Branch; role: "chosen" | "rejected" | "none" }
    | { kind: "divider" };
  const displayBranches = useMemo<Row[]>(() => {
    if (lockPhase < 2 || chosenIdSet.size === 0) {
      return live.map<Row>((b) => ({ kind: "branch", b, role: "none" }));
    }
    const chosen = live.filter((b) => chosenIdSet.has(b.id));
    const rejected = live.filter((b) => !chosenIdSet.has(b.id));
    const rows: Row[] = chosen.map<Row>((b) => ({ kind: "branch", b, role: "chosen" }));
    if (rejected.length > 0) {
      rows.push({ kind: "divider" });
      for (const b of rejected) rows.push({ kind: "branch", b, role: "rejected" });
    }
    return rows;
  }, [live, lockPhase, chosenIdSet]);

  // FLIP: capture rects BEFORE the reorder commits, then on the phase-2
  // render apply inverse translateY + animate to identity. Single effect
  // so we don't race a "capture every render" effect that would overwrite
  // prev rects with post-reorder layout. Branch keys stay stable across
  // reorder so refs survive.
  const branchRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  useLayoutEffect(() => {
    if (lockPhase < 2) {
      const rects = new Map<string, DOMRect>();
      branchRefs.current.forEach((el, id) => {
        rects.set(id, el.getBoundingClientRect());
      });
      prevRects.current = rects;
      return;
    }
    const prev = prevRects.current;
    if (prev.size === 0) return; // fresh-mount locked: snap, no anim
    const rafs: number[] = [];
    branchRefs.current.forEach((el, id) => {
      const p = prev.get(id);
      if (!p) return;
      const n = el.getBoundingClientRect();
      const dy = p.top - n.top;
      if (Math.abs(dy) < 1) return;
      el.style.transform = `translateY(${dy}px)`;
      el.style.transition = "transform 0s";
      rafs.push(
        requestAnimationFrame(() => {
          el.style.transition = "transform 280ms cubic-bezier(0.2, 0, 0, 1)";
          el.style.transform = "";
        }),
      );
    });
    // clear so subsequent phase-2 re-renders don't re-FLIP off stale rects
    prevRects.current = new Map();
    return () => {
      for (const id of rafs) cancelAnimationFrame(id);
    };
  }, [lockPhase]);

  const useAsDraft = (label: string) => {
    setOwnAnswer(label);
    // single-mode: auto-pick the own-answer radio so the draft wins the
    // mutual-exclusion. multi-mode: textarea is independent — leave picks alone.
    if (!multi) setPicked(new Set([OWN_ANSWER_ID]));
    // tick to ensure render lands before focus
    setTimeout(() => {
      const el = ownAnswerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  };

  // single-mode: typing auto-picks own-answer radio; clearing reverts to
  // recommended branch (or empty). Without the revert, clearing leaves
  // own-answer picked + empty text → Next disabled with no obvious unstick.
  // multi-mode: textarea is already independent of branch checkboxes.
  const handleOwnAnswerChange = (text: string) => {
    setOwnAnswer(text);
    if (multi) return;
    const hasText = text.trim().length > 0;
    if (hasText && !ownAnswerSelected) {
      setPicked(new Set([OWN_ANSWER_ID]));
    } else if (!hasText && ownAnswerSelected) {
      const rec = live.find((b) => b.is_recommended);
      setPicked(rec ? new Set([rec.id]) : new Set());
    }
  };

  const send = async (action: ActionKind) => {
    if (busy) return;
    setBusy(action);
    try {
      // single-mode: send EITHER branch_ids OR own_answer (whichever radio
      // is picked), never both. multi-mode: send both as configured.
      const branchIds = realPicked;
      const ownText = ownAnswer.trim();
      const includeOwn = multi ? ownText.length > 0 : ownAnswerSelected && ownText.length > 0;
      await postAction(sid, node.id, action, {
        branch_ids: branchIds,
        own_answer: includeOwn ? ownText : undefined,
      });
    } catch (e) {
      const rej = e as ActionRejection;
      if (rej && typeof rej.status === "number") {
        if (rej.err === "branch_removed") onToast("This option was removed in a recent chat.");
        else if (rej.err === "node locked") onToast("This question is already settled.");
        else onToast(`Action rejected: ${rej.err ?? rej.status}`);
      } else {
        onToast("Network error");
      }
    } finally {
      setBusy(null);
    }
  };

  // Helper: focus own-answer textarea (used by Tab/Enter on own-answer row).
  const focusOwnAnswerTextarea = () => {
    const el = ownAnswerRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };

  // ARIA-listbox key handler (ADR-0004). ↑/↓ cycles focus across live
  // branches AND the own-answer row, Space toggles, Enter (single-mode)
  // picks+submits, Cmd/Ctrl+Enter (multi-mode) submits, Tab on own-answer
  // jumps into the textarea. Digit 1-9 is a type-ahead jump to a branch.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (locked) return;
    // Own-answer textarea lives inside the listbox; ignore bubbled keys from
    // form fields so typing (space, digits, arrows) isn't hijacked.
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    // Nav cycle: live branches then own-answer at the end.
    const navIds = [...live.map((b) => b.id), OWN_ANSWER_ID];
    const idx = focusedBranchId ? navIds.indexOf(focusedBranchId) : -1;
    const focusByIdx = (i: number) => {
      const next = navIds[(i + navIds.length) % navIds.length];
      setFocusedBranchId(next);
      document.getElementById(`branch-${node.id}-${next}`)?.focus();
    };
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      focusByIdx(idx + 1);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      focusByIdx(idx - 1);
      return;
    }
    // Tab on own-answer row → jump into textarea. Shift+Tab uses default
    // (steps back out of the listbox).
    if (e.key === "Tab" && !e.shiftKey && focusedBranchId === OWN_ANSWER_ID) {
      e.preventDefault();
      focusOwnAnswerTextarea();
      return;
    }
    if (e.key === " " && focusedBranchId) {
      // Multi-mode own-answer is independent text (no checkbox) — space
      // shouldn't toggle anything; focus textarea so user can type instead.
      if (focusedBranchId === OWN_ANSWER_ID && multi) {
        e.preventDefault();
        focusOwnAnswerTextarea();
        return;
      }
      e.preventDefault();
      togglePick(focusedBranchId);
      return;
    }
    if (e.key === "Enter") {
      if ((e.metaKey || e.ctrlKey) && canSubmit) {
        e.preventDefault();
        void send("next");
        return;
      }
      // Enter on own-answer row → pick its radio (single-mode) + focus
      // textarea so user can immediately type. Submit happens on Cmd+Enter
      // from the textarea (which has its own keydown handler).
      if (focusedBranchId === OWN_ANSWER_ID) {
        e.preventDefault();
        if (!multi && !picked.has(OWN_ANSWER_ID)) setPicked(new Set([OWN_ANSWER_ID]));
        focusOwnAnswerTextarea();
        return;
      }
      if (!multi && focusedBranchId) {
        e.preventDefault();
        if (busy) return;
        const id = focusedBranchId;
        setPicked(new Set([id]));
        setBusy("next");
        // Submit directly with the picked id — avoids the setState/closure
        // race that would otherwise make send() read stale `realPicked`.
        // busy guard above + setBusy here mirror send()'s contract so
        // rapid Enter presses cannot double-submit.
        postAction(sid, node.id, "next", { branch_ids: [id] })
          .catch((err) => {
            const rej = err as ActionRejection;
            if (rej && typeof rej.status === "number") {
              if (rej.err === "branch_removed") onToast("This option was removed in a recent chat.");
              else if (rej.err === "node locked") onToast("This question is already settled.");
              else onToast(`Action rejected: ${rej.err ?? rej.status}`);
            } else {
              onToast("Network error");
            }
          })
          .finally(() => setBusy(null));
        return;
      }
      // multi-mode bare Enter: no-op (Cmd+Enter is the submit key)
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const i = parseInt(e.key, 10) - 1;
      const target = live[i];
      if (target) {
        e.preventDefault();
        setFocusedBranchId(target.id);
        document.getElementById(`branch-${node.id}-${target.id}`)?.focus();
      }
    }
  };

  // Own Answer keymap: Cmd/Ctrl+Enter submits with the typed text,
  // Esc returns focus to the own-answer row so arrow keys are live again.
  //
  // Submits via postAction directly (not send()) so we don't read
  // `ownAnswerSelected` from a stale closure: arrow→Enter→type→Cmd+Enter
  // hits the textarea before the radio-pick re-render flushes, and send()
  // would otherwise see ownAnswerSelected=false and drop the text. Since
  // the user is typing IN the own-answer field, the textarea contents are
  // the authoritative source — always include them.
  const onOwnAnswerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      if (locked || busy) return;
      const text = ownAnswer.trim();
      if (!text) return;
      e.preventDefault();
      setBusy("next");
      postAction(sid, node.id, "next", {
        branch_ids: multi ? realPicked : [],
        own_answer: text,
      })
        .catch((err) => {
          const rej = err as ActionRejection;
          if (rej && typeof rej.status === "number") {
            if (rej.err === "branch_removed") onToast("This option was removed in a recent chat.");
            else if (rej.err === "node locked") onToast("This question is already settled.");
            else onToast(`Action rejected: ${rej.err ?? rej.status}`);
          } else {
            onToast("Network error");
          }
        })
        .finally(() => setBusy(null));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setFocusedBranchId(OWN_ANSWER_ID);
      document.getElementById(`branch-${node.id}-${OWN_ANSWER_ID}`)?.focus();
    }
  };

  // Composer layered-Esc callback: blur composer + return focus to the
  // currently focused branch row. Ref-mirrored focusedBranchId so the
  // callback identity stays stable.
  const returnFocusToBranches = useCallback(() => {
    const id = focusedBranchIdRef.current;
    if (id) document.getElementById(`branch-${node.id}-${id}`)?.focus();
  }, [node.id]);

  return (
    <>
      <article
        className={`gc-bigcard${lockPhase >= 1 ? " lock-phase-1" : ""}${lockPhase >= 2 ? " lock-phase-2" : ""}`}
      >
        <header className="gc-bigcard-head">
          {node.multi_select && <span className="gc-chip">multi-select</span>}
          <span className="gc-dim">depth {node.depth}</span>
        </header>
        <h2 className="gc-bigcard-q">{node.question}</h2>
        {node.reasoning && <p className="gc-bigcard-reasoning">{node.reasoning}</p>}

        <ul
          className="gc-bigcard-branches"
          role="listbox"
          aria-multiselectable={multi}
          aria-label="Branches"
          onKeyDown={onListKeyDown}
        >
          {displayBranches.map((row) => {
            if (row.kind === "divider") {
              return (
                <li
                  key="__divider__"
                  className="gc-branches-divider"
                  role="presentation"
                  aria-hidden="true"
                >
                  not chosen
                </li>
              );
            }
            const b = row.b;
            // 1-based index of this branch within live[] — used for the
            // digit-shortcut hint chip + listbox keyboard nav target.
            const i = live.findIndex((x) => x.id === b.id);
            const checked = picked.has(b.id);
            const isFocused = focusedBranchId === b.id;
            const rowId = `branch-${node.id}-${b.id}`;
            const roleCls =
              row.role === "chosen" ? " chosen-locked" : row.role === "rejected" ? " rejected-locked" : "";
            return (
              <li
                key={b.id}
                id={rowId}
                ref={(el) => {
                  if (el) branchRefs.current.set(b.id, el);
                  else branchRefs.current.delete(b.id);
                }}
                role="option"
                aria-selected={checked}
                tabIndex={isFocused && !locked ? 0 : -1}
                className={`gc-branch${checked ? " checked" : ""}${b.is_recommended ? " recommended" : ""}${isFocused ? " focused" : ""}${roleCls}`}
                draggable={!locked}
                onFocus={() => setFocusedBranchId(b.id)}
                onClick={() => {
                  // Sync focus on click so subsequent key events feel coherent.
                  if (!locked) setFocusedBranchId(b.id);
                }}
                onDragStart={(e) => {
                  if (locked) return;
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData(
                    CHIP_MIME,
                    JSON.stringify({ branch_id: b.id, label: b.label }),
                  );
                }}
              >
                <span className="gc-branch-hintkey" aria-hidden="true">{i + 1}</span>
                <label onClick={(e) => e.stopPropagation()}>
                  <input
                    type={multi ? "checkbox" : "radio"}
                    name={`branch-${node.id}`}
                    checked={checked}
                    disabled={locked}
                    tabIndex={-1}
                    onChange={() => togglePick(b.id)}
                  />
                  <span className="gc-branch-text">
                    <span className="gc-branch-label">
                      <span className="gc-branch-check" aria-hidden="true">✓</span>
                      {b.is_recommended && <span className="gc-star" title="recommended">★</span>} {b.label}
                    </span>
                    {b.rationale && <span className="gc-branch-rationale">{b.rationale}</span>}
                  </span>
                </label>
                <button
                  type="button"
                  className="gc-branch-use-as-draft"
                  title="Use as draft for Own Answer"
                  disabled={locked}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    useAsDraft(b.label);
                  }}
                >
                  use as draft
                </button>
              </li>
            );
          })}
          {/* Own-answer row — single mode renders an exclusive radio in the same
              group so picking it deselects branches above. multi mode skips the
              radio (own answer is independent of branch checkboxes).

              The radio + textarea are NOT wrapped in a single <label>: a label
              with two labelable descendants implicitly binds to the first
              (the radio), which makes a click on the textarea fire the radio's
              click handler and (in some browsers) skip placing the caret.
              Each control owns its own label via htmlFor. */}
          <li
            id={`branch-${node.id}-${OWN_ANSWER_ID}`}
            role="option"
            aria-selected={ownAnswerSelected}
            tabIndex={focusedBranchId === OWN_ANSWER_ID && !locked ? 0 : -1}
            onFocus={() => {
              if (!locked) setFocusedBranchId(OWN_ANSWER_ID);
            }}
            onClick={() => {
              if (!locked) setFocusedBranchId(OWN_ANSWER_ID);
            }}
            className={`gc-branch gc-branch-own${ownAnswerSelected ? " checked" : ""}${focusedBranchId === OWN_ANSWER_ID ? " focused" : ""}`}
          >
            <span className="gc-branch-hintkey" aria-hidden="true">↵</span>
            {!multi && (
              <input
                id={`own-radio-${node.id}`}
                type="radio"
                name={`branch-${node.id}`}
                checked={ownAnswerSelected}
                disabled={locked}
                tabIndex={-1}
                onChange={() => togglePick(OWN_ANSWER_ID)}
              />
            )}
            <div className="gc-branch-text">
              <label
                htmlFor={multi ? `own-answer-${node.id}` : `own-radio-${node.id}`}
                className="gc-branch-label"
              >
                Type your own answer {multi && <span className="gc-dim">(optional, in addition to picks)</span>}
              </label>
              <textarea
                id={`own-answer-${node.id}`}
                ref={ownAnswerRef}
                className="gc-own-answer-textarea"
                rows={2}
                placeholder="type your answer, or drag a branch's “use as draft” into here… (Cmd/Ctrl+Enter submits, Esc returns to list)"
                value={ownAnswer}
                onChange={(e) => handleOwnAnswerChange(e.target.value)}
                onKeyDown={onOwnAnswerKeyDown}
                disabled={locked}
              />
            </div>
          </li>
        </ul>

        <div className="gc-bigcard-actions">
          <button
            type="button"
            className="gc-btn gc-btn-primary"
            disabled={locked || !canSubmit || !!busy}
            onClick={() => send("next")}
          >
            {busy === "next" ? "sending…" : "Next"}
          </button>
        </div>

        {lockPhase >= 1 && (
          <div className="gc-bigcard-waiting">waiting for the next question…</div>
        )}
      </article>
      <ComposerPanel
        node={node}
        sid={sid}
        onToast={onToast}
        locked={locked}
        onEscape={returnFocusToBranches}
        branches={live}
      />
    </>
  );
}

// ---------- composer (always-visible) ----------

interface MentionState {
  open: boolean;
  query: string;
  range: { from: number; to: number };
  coords: { left: number; top: number };
  selected: number;
}

function ComposerPanel({
  node,
  sid,
  onToast,
  locked,
  onEscape,
  branches,
}: {
  node: DecisionNode;
  sid: string;
  onToast: (msg: string) => void;
  locked?: boolean;
  onEscape?: () => void;
  branches: Branch[];
}) {
  const messages = node.chat_messages ?? [];
  const proposals = node.pending_proposals ?? [];
  const stagedChatId = proposals[0]?.chat_id ?? null;

  // chat_id: stable for this thread. Persist via a staged proposal if one
  // already exists (so Accept maps to the same chat_id Claude staged).
  // Otherwise generate once and keep in a ref for the panel lifetime.
  const chatIdRef = useRef<string | null>(null);
  if (chatIdRef.current === null) {
    chatIdRef.current = stagedChatId ?? uuid();
  }
  useEffect(() => {
    if (stagedChatId && stagedChatId !== chatIdRef.current) {
      chatIdRef.current = stagedChatId;
    }
  }, [stagedChatId]);

  // reset chat_id when node identity changes (drilled to a new card)
  useEffect(() => {
    chatIdRef.current = stagedChatId ?? uuid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const [busy, setBusy] = useState<"send" | "accept" | "close" | null>(null);
  const [pickedProposalId, setPickedProposalId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerWrapRef = useRef<HTMLDivElement | null>(null);
  // Tiptap v3's useEditor does NOT re-render on every transaction. Reading
  // `editor.isEmpty` directly during render is stale — the Send button
  // would only flip to enabled after some unrelated React state change
  // (typing in the Own Answer textarea, etc.) forced a re-render. Mirror
  // emptiness into React state via onCreate/onUpdate.
  const [editorEmpty, setEditorEmpty] = useState(true);
  // @-mention popup (ADR-0004). null when closed.
  const [mention, setMention] = useState<MentionState | null>(null);

  // Branches eligible for @-mention insertion — drop user-authored synth
  // branches (typed-text echoes), keep Claude-proposed ones in display order.
  const mentionBranches = useMemo(
    () => branches.filter((b) => !b.user_authored),
    [branches],
  );
  const mentionResults = useMemo(() => {
    if (!mention) return [] as Branch[];
    const q = mention.query.trim().toLowerCase();
    if (!q) return mentionBranches;
    return mentionBranches.filter((b) => b.label.toLowerCase().includes(q));
  }, [mention, mentionBranches]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }),
      BranchChipNode,
      BranchChipPlaceholder,
    ],
    content: "",
    editorProps: {
      attributes: {
        class: "gc-composer-editor",
        "aria-label": "Chat composer (drag branches to insert chips, or type @ to pick)",
      },
    },
    onCreate: ({ editor }) => setEditorEmpty(editor.isEmpty),
    onUpdate: ({ editor }) => setEditorEmpty(editor.isEmpty),
  });

  // Lock the editor when the parent decision is settled — chat is non-blocking
  // but once the branch commits, the thread is read-only.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!locked);
  }, [editor, locked]);

  // Reset pick when a fresh proposal batch lands (whole list replaced).
  const batchKey = proposals.map((p) => p.proposal_id).join(",");
  useEffect(() => {
    if (proposals.length === 1) {
      setPickedProposalId(proposals[0].proposal_id);
    } else if (proposals.length > 1) {
      setPickedProposalId((cur) =>
        cur && proposals.some((p) => p.proposal_id === cur) ? cur : proposals[0].proposal_id,
      );
    } else {
      setPickedProposalId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchKey]);

  // autoscroll on new message
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, batchKey]);

  const sendCurrent = async () => {
    if (busy || !editor || locked) return;
    // .getText() walks the doc and uses renderText() on each Node — branch
    // chips serialize via BranchChipNode.renderText as `[Branch id: label]`
    // inline in the message string. No structured content on the wire.
    const text = serializeEditorText(editor);
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy("send");
    try {
      await postAction(sid, node.id, "chat_user_msg", {
        chat_id: chatIdRef.current ?? uuid(),
        msg_id: uuid(),
        text: trimmed,
      });
      editor.commands.clearContent();
    } catch (e) {
      const rej = e as ActionRejection;
      onToast(`Send failed: ${rej?.err ?? rej?.status ?? "network"}`);
    } finally {
      setBusy(null);
    }
  };

  // Ref-mirror sendCurrent so the keydown listener always sees the latest.
  const sendRef = useRef<() => Promise<void>>(async () => {});
  sendRef.current = sendCurrent;

  // Insert a branch chip at the current @-mention range, then close the popup.
  const insertMentionChip = (b: Branch) => {
    if (!editor || !mention) return;
    const { from, to } = mention.range;
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, [
        { type: "branchChip", attrs: { branchId: b.id, label: b.label } },
        { type: "text", text: " " },
      ])
      .run();
    setMention(null);
  };
  // Mirror mention + results so the keydown listener's stale closure can read
  // current state without re-attaching on every change.
  const mentionRef = useRef<MentionState | null>(null);
  mentionRef.current = mention;
  const mentionResultsRef = useRef<Branch[]>(mentionResults);
  mentionResultsRef.current = mentionResults;
  const insertChipRef = useRef(insertMentionChip);
  insertChipRef.current = insertMentionChip;

  // Detect `@<query>` typed at the caret and open the mention popup. Closes
  // on caret move out of range / whitespace / blur.
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const sel = editor.state.selection;
      if (!sel.empty) {
        setMention(null);
        return;
      }
      const $from = sel.$from;
      const parentOffset = $from.parentOffset;
      const start = Math.max(0, parentOffset - 40);
      const before = $from.parent.textBetween(start, parentOffset, "\n", "\0");
      const m = /(^|\s)@(\w*)$/.exec(before);
      if (!m) {
        setMention(null);
        return;
      }
      const query = m[2];
      const triggerLen = query.length + 1; // "@" + query chars
      const to = $from.pos;
      const from = to - triggerLen;
      // Viewport coords — popup is portaled to document.body and positioned
      // with `position: fixed` so the composer's `overflow: hidden` cannot
      // clip it.
      let coords = { left: 0, top: 0 };
      try {
        const c = editor.view.coordsAtPos(to);
        coords = { left: c.left, top: c.bottom };
      } catch {
        // coordsAtPos can throw mid-transaction; popup stays at last coords.
      }
      setMention((cur) => ({
        open: true,
        query,
        range: { from, to },
        coords,
        selected: cur && cur.open ? Math.min(cur.selected, 99) : 0,
      }));
    };
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    editor.on("blur", () => setMention(null));
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("update", update);
    };
  }, [editor]);

  // Clamp mention.selected when the filtered result set shrinks.
  useEffect(() => {
    if (!mention) return;
    if (mention.selected >= mentionResults.length && mentionResults.length > 0) {
      setMention((m) => (m ? { ...m, selected: mentionResults.length - 1 } : m));
    }
  }, [mention, mentionResults.length]);

  // Composer keydown handler — handles, in priority order:
  //   1. Mention popup nav (Esc / ↑↓ / Enter / digit) when popup is open.
  //   2. Cmd/Ctrl+Enter → send.
  //   3. Esc (popup closed) → blur editor + return focus to focused branch.
  // Registered with capture phase so we beat ProseMirror's built-in handlers.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onKeyDown = (e: KeyboardEvent) => {
      const m = mentionRef.current;
      if (m && m.open) {
        const results = mentionResultsRef.current;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setMention(null);
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          setMention((s) =>
            s ? { ...s, selected: Math.min(s.selected + 1, Math.max(0, results.length - 1)) } : s,
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          setMention((s) => (s ? { ...s, selected: Math.max(s.selected - 1, 0) } : s));
          return;
        }
        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          const pick = results[m.selected];
          if (pick) insertChipRef.current(pick);
          return;
        }
        if (
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          /^[1-9]$/.test(e.key)
        ) {
          const i = parseInt(e.key, 10) - 1;
          const pick = results[i];
          if (pick) {
            e.preventDefault();
            e.stopPropagation();
            insertChipRef.current(pick);
            return;
          }
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void sendRef.current();
        return;
      }
      if (e.key === "Escape" && !(m && m.open)) {
        e.preventDefault();
        e.stopPropagation();
        editor.commands.blur();
        onEscape?.();
      }
    };
    dom.addEventListener("keydown", onKeyDown, true);
    return () => dom.removeEventListener("keydown", onKeyDown, true);
  }, [editor, onEscape]);

  // Window event: Cmd/Ctrl+K from anywhere on the page → focus this composer.
  useEffect(() => {
    if (!editor) return;
    const onFocus = () => {
      if (locked) return;
      editor.commands.focus("end");
    };
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocus);
  }, [editor, locked]);

  const accept = async () => {
    if (busy || proposals.length === 0 || !pickedProposalId) return;
    setBusy("accept");
    try {
      await postAction(sid, node.id, "chat_accept", {
        chat_id: chatIdRef.current ?? stagedChatId ?? uuid(),
        proposal_id: pickedProposalId,
      });
    } catch (e) {
      const rej = e as ActionRejection;
      onToast(`Accept failed: ${rej?.err ?? rej?.status ?? "network"}`);
    } finally {
      setBusy(null);
    }
  };

  const clearThread = async () => {
    if (busy) return;
    if (messages.length === 0 && proposals.length === 0) return;
    setBusy("close");
    try {
      await postAction(sid, node.id, "chat_close", {
        chat_id: chatIdRef.current ?? uuid(),
      });
      // mint a fresh chat_id for the next thread
      chatIdRef.current = uuid();
      editor?.commands.clearContent();
    } catch (e) {
      const rej = e as ActionRejection;
      onToast(`Clear failed: ${rej?.err ?? rej?.status ?? "network"}`);
    } finally {
      setBusy(null);
    }
  };

  // Plain-text shortcut.
  const applyShortcut = (template: string, name: string) => {
    if (!editor) return;
    editor.chain().focus().clearContent().insertContent(template).run();
    logShortcutPrefill(sid, node.id, name);
  };

  // Shortcut with empty branch-chip slots — drag a branch onto a slot to fill
  // it. Unfilled slots serialize to "" in the sent message.
  const applyShortcutWithSlots = (
    parts: Array<string | { slot: true }>,
    name: string,
  ) => {
    if (!editor) return;
    const content = parts.map((p) =>
      typeof p === "string" ? { type: "text", text: p } : { type: "branchChipPlaceholder" },
    );
    editor.chain().focus().clearContent().insertContent(content).run();
    logShortcutPrefill(sid, node.id, name);
  };

  return (
    <section className={`gc-composer${locked ? " gc-composer-locked" : ""}`}>
      <header className="gc-composer-head">
        <span className="gc-composer-title">chat</span>
        {!locked && (messages.length > 0 || proposals.length > 0) && (
          <button
            type="button"
            className="gc-btn gc-btn-toolbar gc-composer-clear"
            disabled={!!busy}
            onClick={clearThread}
            title="clear chat thread"
          >
            clear
          </button>
        )}
      </header>
      {proposals.length > 0 && (
        <ProposalPicker
          proposals={proposals}
          node={node}
          pickedId={pickedProposalId}
          onPick={setPickedProposalId}
          onAccept={accept}
          busy={busy === "accept" || !!locked}
        />
      )}
      <div ref={listRef} className="gc-composer-list">
        {messages.length === 0 ? (
          <p className="gc-dim gc-composer-empty">
            Type a message — or click a shortcut below to prefill. Drag branches into the composer to insert chips.
          </p>
        ) : (
          messages.map((m: ChatMessage) => (
            <div key={m.msg_id} className={`gc-chat-msg gc-chat-msg-${m.role}`}>
              <div className="gc-chat-bubble">{m.text}</div>
            </div>
          ))
        )}
        {messages.length > 0 && messages[messages.length - 1].role === "user" && (
          <div className="gc-chat-msg gc-chat-msg-assistant" aria-label="assistant typing">
            <div className="gc-chat-bubble gc-chat-typing">
              <span /><span /><span />
            </div>
          </div>
        )}
      </div>
      <div className="gc-composer-shortcuts">
        <button
          type="button"
          className="gc-btn gc-btn-shortcut"
          onClick={() => applyShortcut("Explain this question", "explain")}
          disabled={!!busy || !editor || !!locked}
          title="Prefill: Explain this question"
        >
          Explain
        </button>
        <button
          type="button"
          className="gc-btn gc-btn-shortcut"
          onClick={() =>
            applyShortcut("Check the current implementation related to this question", "check_impl")
          }
          disabled={!!busy || !editor || !!locked}
          title="Prefill: Check the current implementation"
        >
          Check impl
        </button>
        <button
          type="button"
          className="gc-btn gc-btn-shortcut"
          onClick={() =>
            applyShortcutWithSlots(
              ["Compare ", { slot: true }, " and ", { slot: true }],
              "compare",
            )
          }
          disabled={!!busy || !editor || !!locked}
          title="Prefill: Compare [slot] and [slot] (drag branches in)"
        >
          Compare
        </button>
        <button
          type="button"
          className="gc-btn gc-btn-shortcut"
          onClick={() =>
            applyShortcutWithSlots(
              ["Can we combine ", { slot: true }, " and ", { slot: true }],
              "combine",
            )
          }
          disabled={!!busy || !editor || !!locked}
          title="Prefill: Combine [slot] and [slot] (drag branches in)"
        >
          Combine
        </button>
      </div>
      <div className="gc-composer-input" ref={composerWrapRef}>
        {/* EditorContent wraps the ProseMirror root in its OWN div — that
            wrapper is the actual flex child here, so it must carry flex: 1
            and min-width: 0. Otherwise it collapses to ProseMirror's
            intrinsic content width and the editor looks 30px wide. */}
        <EditorContent editor={editor} className="gc-composer-editor-wrap" />
        <button
          type="button"
          className="gc-btn gc-btn-primary gc-composer-send"
          disabled={!!busy || !editor || editorEmpty || !!locked}
          onClick={() => void sendCurrent()}
        >
          {busy === "send" ? "sending…" : "Send"}
        </button>
        {mention &&
          mention.open &&
          mentionResults.length > 0 &&
          createPortal(
            <ul
              className="gc-mention-popup"
              role="listbox"
              aria-label="Branch mention picker"
              style={{ left: mention.coords.left, top: mention.coords.top + 4 }}
            >
              {mentionResults.slice(0, 9).map((b, i) => (
                <li
                  key={b.id}
                  role="option"
                  aria-selected={i === mention.selected}
                  className={`gc-mention-item${i === mention.selected ? " selected" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMentionChip(b);
                  }}
                  onMouseEnter={() =>
                    setMention((s) => (s ? { ...s, selected: i } : s))
                  }
                >
                  <span className="gc-mention-hintkey" aria-hidden="true">{i + 1}</span>
                  <span className="gc-mention-label">{b.label}</span>
                </li>
              ))}
            </ul>,
            document.body,
          )}
      </div>
    </section>
  );
}

// Tiptap walks the doc and uses renderText() on each Node, joining at block
// boundaries with newlines. Chips serialize via BranchChipNode.renderText.
function serializeEditorText(editor: CoreEditor): string {
  return editor.getText({
    blockSeparator: "\n",
  });
}

function ProposalPicker({
  proposals,
  node,
  pickedId,
  onPick,
  onAccept,
  busy,
}: {
  proposals: PendingProposal[];
  node: DecisionNode;
  pickedId: string | null;
  onPick: (id: string) => void;
  onAccept: () => void;
  busy: boolean;
}) {
  const labelById = useMemo(
    () => new Map(node.branches.map((b) => [b.id, b.label] as const)),
    [node.branches],
  );
  const multi = proposals.length > 1;
  const groupName = `gc-proposal-${node.id}`;
  return (
    <div className="gc-chat-proposal">
      <header className="gc-chat-proposal-head">
        <span className="gc-chip gc-chip-proposal">
          {multi ? `proposed: pick one of ${proposals.length}` : `proposed outcome: ${proposals[0].outcome}`}
        </span>
      </header>
      <ul className="gc-chat-proposal-list" role={multi ? "radiogroup" : undefined}>
        {proposals.map((p) => {
          const checked = pickedId === p.proposal_id;
          const adds = p.ops?.adds ?? [];
          const removes = p.ops?.removes ?? [];
          return (
            <li key={p.proposal_id} className={`gc-chat-proposal-item${checked ? " is-picked" : ""}`}>
              <label className="gc-chat-proposal-row">
                <input
                  type="radio"
                  name={groupName}
                  value={p.proposal_id}
                  checked={checked}
                  disabled={busy}
                  onChange={() => onPick(p.proposal_id)}
                />
                <span className="gc-chat-proposal-body">
                  {multi && (
                    <span className="gc-chip gc-chip-proposal-mini">{p.outcome}</span>
                  )}
                  <span className="gc-chat-proposal-summary">{p.summary}</span>
                  {p.outcome === "refine" && (adds.length > 0 || removes.length > 0) && (
                    <ul className="gc-chat-proposal-ops">
                      {adds.map((b, i) => (
                        <li key={`add-${i}`} className="gc-chat-op-add">
                          + {b.label}
                          {b.rationale ? <span className="gc-dim"> — {b.rationale}</span> : null}
                        </li>
                      ))}
                      {removes.map((rid, i) => (
                        <li key={`rm-${i}`} className="gc-chat-op-remove">
                          − {labelById.get(rid) ?? rid}
                        </li>
                      ))}
                    </ul>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="gc-chat-proposal-actions">
        <button
          type="button"
          className="gc-btn gc-btn-primary"
          disabled={busy || !pickedId}
          onClick={onAccept}
        >
          {busy ? "accepting…" : "Accept"}
        </button>
      </div>
    </div>
  );
}

// ---------- summary card ----------

function SummaryCard({
  node,
  sid,
  onToast,
  forceLocked,
}: {
  node: DecisionNode;
  sid: string;
  onToast: (msg: string) => void;
  forceLocked?: boolean;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [showMap, setShowMap] = useState(false);
  const docsBlocked = !!node.generate_docs;
  const locked = !!forceLocked || !!node.committed || (node.chosen_branch_ids ?? []).length > 0;

  // Esc closes the map overlay — keep close affordance available even when
  // pan/zoom has focus.
  useEffect(() => {
    if (!showMap) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMap(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showMap]);

  const send = async (action: ActionKind) => {
    if (busy) return;
    setBusy(action);
    try {
      await postAction(sid, node.id, action, {
        own_answer: action === "continue_grill" && note.trim() ? note.trim() : undefined,
      });
    } catch (e) {
      const rej = e as ActionRejection;
      if (rej && typeof rej.status === "number") {
        onToast(`Action rejected: ${rej.err ?? rej.status}`);
      } else {
        onToast("Network error");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    <article className={`gc-bigcard gc-summary${locked ? " gc-summary-locked" : ""}`}>
      <header className="gc-bigcard-head">
        <span className="gc-chip gc-chip-summary">summary</span>
        {docsBlocked && <span className="gc-chip gc-chip-docs">docs required</span>}
        <button
          type="button"
          className="gc-btn gc-btn-toolbar gc-summary-map-toggle"
          onClick={() => setShowMap(true)}
          title="Open the decision map for this session"
        >
          Show map
        </button>
      </header>
      <div className="gc-summary-body">
        <ReactMarkdown>{node.summary_body ?? ""}</ReactMarkdown>
      </div>
      {docsBlocked && node.docs_reason && !locked && (
        <p className="gc-summary-docs-reason gc-dim">{node.docs_reason}</p>
      )}
      {!locked && (
        <div className="gc-summary-continue">
          <textarea
            rows={2}
            placeholder="optional — direction for continued grilling"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}
      {!locked && (
        <div className="gc-summary-verdicts">
          <button
            type="button"
            className="gc-btn gc-btn-primary"
            disabled={!!busy}
            onClick={() => send("create_plan")}
          >
            Create plan
          </button>
          {!docsBlocked && (
            <button
              type="button"
              className="gc-btn"
              disabled={!!busy}
              onClick={() => send("implement_now")}
            >
              Implement now
            </button>
          )}
          <button
            type="button"
            className="gc-btn"
            disabled={!!busy}
            onClick={() => send("stop_here")}
          >
            Stop here
          </button>
          <button
            type="button"
            className="gc-btn gc-btn-secondary"
            disabled={!!busy}
            onClick={() => send("continue_grill")}
          >
            Continue grilling
          </button>
        </div>
      )}
      {locked && (
        <div className="gc-bigcard-waiting">session ended</div>
      )}
    </article>
    {showMap && (
      <div
        className="gc-decision-map-overlay"
        role="dialog"
        aria-label="Session decision map"
        onClick={(e) => {
          // backdrop click closes; clicks on the inner panel don't bubble here
          if (e.target === e.currentTarget) setShowMap(false);
        }}
      >
        <div className="gc-decision-map-panel">
          <header className="gc-decision-map-head">
            <span className="gc-decision-map-title">Decision map</span>
            <button
              type="button"
              className="gc-btn gc-btn-toolbar"
              onClick={() => setShowMap(false)}
              aria-label="Close map"
              title="Close (Esc)"
            >
              Close
            </button>
          </header>
          <div className="gc-decision-map-body">
            <Suspense
              fallback={<div className="gc-dim gc-decision-map-loading">Loading map…</div>}
            >
              <DecisionMap />
            </Suspense>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
