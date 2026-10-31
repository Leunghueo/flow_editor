export function isCondType(type) {
  return String(type || "").toLowerCase() === "cond";
}

// Maximum number of outgoing edges (next) a node type may have:
// cond = exactly 2 (true/false branches), select/switch = unlimited, others = 1.
export function maxOutputsForType(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "cond") return 2;
  if (normalized === "select" || normalized === "switch") return Infinity;
  return 1;
}

export function supportsMultipleOutputs(type) {
  return maxOutputsForType(type) > 1;
}

export function truncateNext(next, type) {
  const arr = Array.isArray(next) ? next.map(String) : [];
  const limit = maxOutputsForType(type);
  return limit === Infinity ? arr : arr.slice(0, limit);
}

export function newWorkflow() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: "新工作流",
    ctime: now,
    desc: "by工作流编辑平台",
    meta: {},
    nodes: {
      head: {
        node_id: "head",
        node_name: "开始",
        type: "sys",
        desc: "工作流开始",
        meta: {},
        args: {},
        next: ["end"]
      },
      end: {
        node_id: "end",
        node_name: "结束",
        type: "sys",
        desc: "工作流结束",
        meta: {},
        args: {},
        next: []
      }
    },
    ui: {
      nodes: {
        head: { x: 120, y: 120 },
        end: { x: 520, y: 120 }
      },
      viewport: { x: 0, y: 0, zoom: 1 }
    }
  };
}

export function normalizeWorkflow(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid JSON root");
  const wf = { ...raw };
  if (!wf.nodes || typeof wf.nodes !== "object") throw new Error("Missing nodes");
  if (!wf.nodes.head || !wf.nodes.end) throw new Error("Workflow must contain head/end");
  wf.id = typeof wf.id === "string" && wf.id ? wf.id : crypto.randomUUID();
  wf.meta = wf.meta && typeof wf.meta === "object" ? wf.meta : {};
  wf.desc = typeof wf.desc === "string" ? wf.desc : "";
  wf.ctime = typeof wf.ctime === "string" && wf.ctime ? wf.ctime : new Date().toISOString();
  wf.name = typeof wf.name === "string" && wf.name ? wf.name : "workflow";

  wf.ui = wf.ui && typeof wf.ui === "object" ? wf.ui : {};
  wf.ui.nodes = wf.ui.nodes && typeof wf.ui.nodes === "object" ? wf.ui.nodes : {};
  wf.ui.viewport = wf.ui.viewport && typeof wf.ui.viewport === "object" ? wf.ui.viewport : {};
  wf.ui.viewport.x = Number.isFinite(wf.ui.viewport.x) ? wf.ui.viewport.x : 0;
  wf.ui.viewport.y = Number.isFinite(wf.ui.viewport.y) ? wf.ui.viewport.y : 0;
  wf.ui.viewport.zoom = Number.isFinite(wf.ui.viewport.zoom) ? wf.ui.viewport.zoom : 1;

  for (const [id, node] of Object.entries(wf.nodes)) {
    if (!node || typeof node !== "object") throw new Error(`Node ${id} is not an object`);
    if (typeof node.type !== "string" || !node.type.trim()) throw new Error(`Node ${id} missing type`);
    node.node_id = id;
    node.node_name = typeof node.node_name === "string" && node.node_name.trim() ? node.node_name : id;
    node.args = node.args && typeof node.args === "object" ? node.args : {};
    node.meta = node.meta && typeof node.meta === "object" ? node.meta : {};
    node.desc = typeof node.desc === "string" ? node.desc : "";
    node.next = Array.isArray(node.next) ? node.next.map(String) : [];
    if (!wf.ui.nodes[id]) wf.ui.nodes[id] = { x: 120 + Math.random() * 500, y: 140 + Math.random() * 300 };
  }
  return wf;
}

export function validateWorkflow(wf) {
  const errors = [];
  if (!wf.nodes?.head) errors.push("missing node: head");
  if (!wf.nodes?.end) errors.push("missing node: end");

  for (const [id, node] of Object.entries(wf.nodes || {})) {
    if (node.node_id !== id) errors.push(`${id}.node_id must match its key`);
    if (id === "end" && node.next && node.next.length) errors.push("end.next must be empty");
    const next = node.next || [];
    for (const n of next) {
      if (n === "end") continue;
      if (!wf.nodes[n]) errors.push(`${id}.next references missing node: ${n}`);
    }
    if (isCondType(node.type)) {
      if (next.length !== 2) {
        errors.push(`${id} is cond and must have exactly 2 next nodes (next[0]=true branch, next[1]=false branch), currently ${next.length}`);
      }
      const expr = node.args?.expr;
      const exprOk = (typeof expr === "string" && Boolean(expr.trim()))
        || (Array.isArray(expr) && expr.length > 0 && expr.every((e) => typeof e === "string" && Boolean(e.trim())));
      if (!exprOk) errors.push(`${id}.args.expr is missing or empty (cond requires an expression)`);
    } else if (!supportsMultipleOutputs(node.type) && next.length > 1) {
      errors.push(`${id} has ${next.length} next nodes (only select/switch/cond support multiple)`);
    }
  }
  return errors;
}
