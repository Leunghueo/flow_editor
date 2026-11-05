export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

export function downloadJson(filename, obj) {
  const blob = new Blob([stableStringify(obj)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// --- Cross-page node fragment (system clipboard) -------------------------
// A fragment is the unit copied/pasted between editor pages, tabs and even
// separate editor instances on the same machine. It carries the full node
// objects (with their original ids and next lists) plus their canvas
// positions; id remapping and edge filtering happen at insert time.
export const FRAGMENT_KIND = "flow-editor-fragment";
export const FRAGMENT_VERSION = 1;

export function buildFragmentPayload(nodes, positions, ids, sourceWorkflowId) {
  const picked = (ids || []).filter(
    (id) => id !== "head" && id !== "end" && nodes && nodes[id] && typeof nodes[id] === "object"
  );
  if (!picked.length) return null;
  const fragNodes = {};
  const fragPositions = {};
  for (const id of picked) {
    fragNodes[id] = structuredClone(nodes[id]);
    const pos = positions && positions[id];
    fragPositions[id] = {
      x: Number.isFinite(pos?.x) ? pos.x : 120,
      y: Number.isFinite(pos?.y) ? pos.y : 120
    };
  }
  return {
    kind: FRAGMENT_KIND,
    version: FRAGMENT_VERSION,
    sourceWorkflowId: typeof sourceWorkflowId === "string" ? sourceWorkflowId : "",
    nodes: fragNodes,
    positions: fragPositions
  };
}

export function parseFragmentPayload(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const parsed = safeJsonParse(text);
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (!value || typeof value !== "object" || value.kind !== FRAGMENT_KIND) return null;
  if (!value.nodes || typeof value.nodes !== "object" || Array.isArray(value.nodes)) return null;
  const nodes = {};
  for (const [id, node] of Object.entries(value.nodes)) {
    if (id === "head" || id === "end") continue;
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    nodes[id] = node;
  }
  if (!Object.keys(nodes).length) return null;
  const positions = {};
  for (const id of Object.keys(nodes)) {
    const pos = value.positions && typeof value.positions === "object" ? value.positions[id] : null;
    positions[id] = {
      x: Number.isFinite(pos?.x) ? pos.x : 120,
      y: Number.isFinite(pos?.y) ? pos.y : 120
    };
  }
  return {
    kind: FRAGMENT_KIND,
    version: Number.isFinite(value.version) ? value.version : FRAGMENT_VERSION,
    sourceWorkflowId: typeof value.sourceWorkflowId === "string" ? value.sourceWorkflowId : "",
    nodes,
    positions
  };
}

