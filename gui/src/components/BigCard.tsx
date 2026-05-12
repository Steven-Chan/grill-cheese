import { useEffect, useMemo, useRef, useState } from "react";
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
import type { ChatMessage, DecisionNode, PendingProposal } from "../types";
import { HistoryEntry } from "./HistoryEntry";

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
              view.dispatch(view.state.tr.insert($pos.pos, node));
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

  const useAsDraft = (label: string, rationale: string) => {
    const text = rationale ? `${label} — ${rationale}` : label;
    setOwnAnswer(text);
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

  return (
    <>
      <article className={`gc-bigcard${locked ? " locked" : ""}`}>
        <header className="gc-bigcard-head">
          {node.multi_select && <span className="gc-chip">multi-select</span>}
          <span className="gc-dim">depth {node.depth}</span>
        </header>
        <h2 className="gc-bigcard-q">{node.question}</h2>
        {node.reasoning && <p className="gc-bigcard-reasoning">{node.reasoning}</p>}

        <ul className="gc-bigcard-branches">
          {live.map((b) => {
            const checked = picked.has(b.id);
            return (
              <li
                key={b.id}
                className={`gc-branch${checked ? " checked" : ""}${b.is_recommended ? " recommended" : ""}`}
                draggable={!locked}
                onDragStart={(e) => {
                  if (locked) return;
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData(
                    CHIP_MIME,
                    JSON.stringify({ branch_id: b.id, label: b.label }),
                  );
                }}
              >
                <label>
                  <input
                    type={multi ? "checkbox" : "radio"}
                    name={`branch-${node.id}`}
                    checked={checked}
                    disabled={locked}
                    onChange={() => togglePick(b.id)}
                  />
                  <span className="gc-branch-text">
                    <span className="gc-branch-label">
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
                  onClick={() => useAsDraft(b.label, b.rationale)}
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
            className={`gc-branch gc-branch-own${ownAnswerSelected ? " checked" : ""}`}
          >
            {!multi && (
              <input
                id={`own-radio-${node.id}`}
                type="radio"
                name={`branch-${node.id}`}
                checked={ownAnswerSelected}
                disabled={locked}
                onChange={() => togglePick(OWN_ANSWER_ID)}
              />
            )}
            <div className="gc-branch-text">
              <label
                htmlFor={multi ? `own-answer-${node.id}` : `own-radio-${node.id}`}
                className="gc-branch-label"
              >
                Your own answer {multi && <span className="gc-dim">(optional, in addition to picks)</span>}
              </label>
              <textarea
                id={`own-answer-${node.id}`}
                ref={ownAnswerRef}
                className="gc-own-answer-textarea"
                rows={2}
                placeholder="type your answer, or drag a branch's “use as draft” into here…"
                value={ownAnswer}
                onChange={(e) => handleOwnAnswerChange(e.target.value)}
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

        {!!node.committed && (
          <div className="gc-bigcard-locked-banner gc-dim">
            <span>settled — waiting for the next question…</span>
          </div>
        )}
      </article>
      <ComposerPanel node={node} sid={sid} onToast={onToast} locked={locked} />
    </>
  );
}

// ---------- composer (always-visible) ----------

function ComposerPanel({
  node,
  sid,
  onToast,
  locked,
}: {
  node: DecisionNode;
  sid: string;
  onToast: (msg: string) => void;
  locked?: boolean;
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

  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false }), BranchChipNode],
    content: "",
    editorProps: {
      attributes: {
        class: "gc-composer-editor",
        "aria-label": "Chat composer (drag branches to insert chips)",
      },
    },
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
    if (busy || !editor) return;
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

  const applyShortcut = (template: string, name: string) => {
    if (!editor) return;
    editor.chain().focus().clearContent().insertContent(template).run();
    logShortcutPrefill(sid, node.id, name);
  };

  return (
    <section className={`gc-composer${locked ? " gc-composer-locked" : ""}`}>
      <header className="gc-composer-head">
        <span className="gc-composer-title">chat</span>
        {locked && <span className="gc-dim">settled — chat closed</span>}
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
          onClick={() => applyShortcut("Explain this question.", "explain")}
          disabled={!!busy || !editor || !!locked}
          title="Prefill: Explain this question"
        >
          Explain
        </button>
        <button
          type="button"
          className="gc-btn gc-btn-shortcut"
          onClick={() =>
            applyShortcut("Check the current implementation related to this question.", "check_impl")
          }
          disabled={!!busy || !editor || !!locked}
          title="Prefill: Check the current implementation"
        >
          Check impl
        </button>
        <button
          type="button"
          className="gc-btn gc-btn-shortcut"
          onClick={() => applyShortcut("Compare ▮ and ▮ (drag branches into the slots).", "compare")}
          disabled={!!busy || !editor || !!locked}
          title="Prefill: Compare ▮ and ▮ (drag branches in)"
        >
          Compare
        </button>
        <button
          type="button"
          className="gc-btn gc-btn-shortcut"
          onClick={() =>
            applyShortcut("Can we combine ▮ and ▮ (drag branches into the slots)?", "combine")
          }
          disabled={!!busy || !editor || !!locked}
          title="Prefill: Combine ▮ and ▮ (drag branches in)"
        >
          Combine
        </button>
      </div>
      <div className="gc-composer-input">
        {/* EditorContent wraps the ProseMirror root in its OWN div — that
            wrapper is the actual flex child here, so it must carry flex: 1
            and min-width: 0. Otherwise it collapses to ProseMirror's
            intrinsic content width and the editor looks 30px wide. */}
        <EditorContent editor={editor} className="gc-composer-editor-wrap" />
        <button
          type="button"
          className="gc-btn gc-btn-primary gc-composer-send"
          disabled={!!busy || !editor || isEditorEmpty(editor) || !!locked}
          onClick={() => void sendCurrent()}
        >
          {busy === "send" ? "sending…" : "Send"}
        </button>
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

function isEditorEmpty(editor: CoreEditor | null): boolean {
  if (!editor) return true;
  return editor.isEmpty;
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
  const docsBlocked = !!node.generate_docs;
  const locked = !!forceLocked || !!node.committed || (node.chosen_branch_ids ?? []).length > 0;

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
    <article className={`gc-bigcard gc-summary${locked ? " locked" : ""}`}>
      <header className="gc-bigcard-head">
        <span className="gc-chip gc-chip-summary">summary</span>
        {docsBlocked && <span className="gc-chip gc-chip-docs">docs required</span>}
      </header>
      <div className="gc-summary-body">
        <ReactMarkdown>{node.summary_body ?? ""}</ReactMarkdown>
      </div>
      {docsBlocked && node.docs_reason && (
        <p className="gc-summary-docs-reason gc-dim">{node.docs_reason}</p>
      )}
      <div className="gc-summary-continue">
        <textarea
          rows={2}
          placeholder="optional — direction for continued grilling"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={locked}
        />
      </div>
      <div className="gc-summary-verdicts">
        <button
          type="button"
          className="gc-btn gc-btn-primary"
          disabled={locked || !!busy}
          onClick={() => send("create_plan")}
        >
          Create plan
        </button>
        {!docsBlocked && (
          <button
            type="button"
            className="gc-btn"
            disabled={locked || !!busy}
            onClick={() => send("implement_now")}
          >
            Implement now
          </button>
        )}
        <button
          type="button"
          className="gc-btn"
          disabled={locked || !!busy}
          onClick={() => send("stop_here")}
        >
          Stop here
        </button>
        <button
          type="button"
          className="gc-btn gc-btn-secondary"
          disabled={locked || !!busy}
          onClick={() => send("continue_grill")}
        >
          Continue grilling
        </button>
      </div>
      {locked && (
        <div className="gc-bigcard-locked-banner gc-dim">
          <span>settled.</span>
        </div>
      )}
    </article>
  );
}
