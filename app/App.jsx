import React, { useEffect, useMemo, useRef, useState } from "react";
import { isCondType, newWorkflow, normalizeWorkflow, truncateNext, validateWorkflow } from "./schema.js";
import { clamp, safeJsonParse, stableStringify } from "./utils.js";

const NODE_WIDTH = 190;
const NODE_HEIGHT = 96;
const GRID_SIZE = 28;
const TURN_RADIUS = 14;
const SIDE_ROUTE_MIN_GAP = TURN_RADIUS * 2;
const SCENE_WIDTH = 3600;
const SCENE_HEIGHT = 2400;
const CLONE_OFFSET = 48;

function typeBadge(type) {
  return String(type || "").replace(/_/g, " ");
}

function nodeColor(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.startsWith("plc")) return "var(--node-plc)";
  if (normalized.startsWith("sys")) return "var(--node-sys)";
  if (normalized.startsWith("select")) return "var(--node-select)";
  if (normalized.startsWith("loop")) return "var(--node-loop)";
  return "var(--node-sys)";
}

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}${dd}`;
}

function makeNodeId(nodes) {
  let id = "";
  do {
    id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  } while (nodes[id]);
  return id;
}

function makeDefaultNodeName(type, nodes) {
  const base = typeBadge(type);
  const used = new Set(Object.values(nodes).map((node) => node.node_name));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function buildNodePresets(raw) {
  return Object.entries(raw || {}).map(([key, value]) => ({
    key,
    label: value?.node_name || key,
    type: value?.type || key,
    template: structuredClone(value || {})
  }));
}

function supportsMultipleOutputs(type) {
  const normalized = String(type || "").toLowerCase();
  return normalized === "select" || normalized === "switch" || normalized === "cond";
}

// Display label for one outgoing edge. For cond the order of next is the
// branch semantics: next[0] is the true branch, next[1] the false branch.
function edgeBranchLabel(fromNode, index) {
  if (!fromNode) return "";
  if (isCondType(fromNode.type)) return index === 0 ? "真 true" : index === 1 ? "假 false" : "";
  return "";
}

function isConfirmEnabled(node) {
  return Boolean(node?.args?.confirm);
}

function nodeGnode(node) {
  const value = node?.gnode;
  return typeof value === "string" ? value.trim() : "";
}

function nodeCenter(pos) {
  return { x: pos.x + NODE_WIDTH / 2, y: pos.y + NODE_HEIGHT / 2 };
}

function nodeSidePoint(pos, side) {
  const center = nodeCenter(pos);
  if (side === "left") return { x: pos.x, y: center.y };
  if (side === "right") return { x: pos.x + NODE_WIDTH, y: center.y };
  if (side === "top") return { x: center.x, y: pos.y };
  return { x: center.x, y: pos.y + NODE_HEIGHT };
}

function dedupePath(points) {
  const result = [];
  for (const point of points) {
    const prev = result[result.length - 1];
    if (!prev || prev.x !== point.x || prev.y !== point.y) result.push(point);
  }
  return result;
}

function roundedPath(points, radius = TURN_RADIUS) {
  const clean = dedupePath(points);
  if (clean.length < 2) return "";
  let path = `M ${clean[0].x} ${clean[0].y}`;

  for (let i = 1; i < clean.length - 1; i += 1) {
    const prev = clean[i - 1];
    const curr = clean[i];
    const next = clean[i + 1];
    const prevDx = curr.x - prev.x;
    const prevDy = curr.y - prev.y;
    const nextDx = next.x - curr.x;
    const nextDy = next.y - curr.y;
    const prevLen = Math.abs(prevDx) + Math.abs(prevDy);
    const nextLen = Math.abs(nextDx) + Math.abs(nextDy);
    const cut = Math.min(radius, prevLen / 2, nextLen / 2);
    const entry = {
      x: curr.x - Math.sign(prevDx) * cut,
      y: curr.y - Math.sign(prevDy) * cut
    };
    const exit = {
      x: curr.x + Math.sign(nextDx) * cut,
      y: curr.y + Math.sign(nextDy) * cut
    };
    path += ` L ${entry.x} ${entry.y} Q ${curr.x} ${curr.y} ${exit.x} ${exit.y}`;
  }

  const last = clean[clean.length - 1];
  path += ` L ${last.x} ${last.y}`;
  return path;
}

function routeEdge(fromId, toId, positions) {
  const fromPos = positions[fromId];
  const toPos = positions[toId];
  if (!fromPos || !toPos) return null;
  const toRightGap = toPos.x - (fromPos.x + NODE_WIDTH);
  const toLeftGap = fromPos.x - (toPos.x + NODE_WIDTH);

  let points;
  if (toRightGap >= SIDE_ROUTE_MIN_GAP || toLeftGap >= SIDE_ROUTE_MIN_GAP) {
    const toRight = toRightGap >= toLeftGap;
    const start = nodeSidePoint(fromPos, toRight ? "right" : "left");
    const end = nodeSidePoint(toPos, toRight ? "left" : "right");
    const midX = Math.round((start.x + end.x) / 2);
    points = [
      start,
      { x: midX, y: start.y },
      { x: midX, y: end.y },
      end
    ];
  } else {
    const fromCenter = nodeCenter(fromPos);
    const toCenter = nodeCenter(toPos);
    const toBelow = toCenter.y >= fromCenter.y;
    const start = nodeSidePoint(fromPos, toBelow ? "bottom" : "top");
    const end = nodeSidePoint(toPos, toBelow ? "top" : "bottom");
    const midY = Math.round((start.y + end.y) / 2);
    points = [
      start,
      { x: start.x, y: midY },
      { x: end.x, y: midY },
      end
    ];
  }
  const labelPoint = points.length >= 3
    ? {
      x: Math.round((points[1].x + points[2].x) / 2),
      y: Math.round((points[1].y + points[2].y) / 2)
    }
    : null;
  return { path: roundedPath(points), labelPoint };
}

function buildEdges(workflow) {
  const positions = workflow.ui?.nodes || {};
  const edges = [];
  for (const [fromId, node] of Object.entries(workflow.nodes)) {
    (node.next || []).forEach((toId, index) => {
      if (!positions[fromId] || !positions[toId]) return;
      const routed = routeEdge(fromId, toId, positions);
      if (!routed) return;
      edges.push({
        id: `${fromId}->${toId}`,
        fromId,
        toId,
        path: routed.path,
        label: edgeBranchLabel(node, index),
        labelX: routed.labelPoint?.x ?? null,
        labelY: routed.labelPoint?.y ?? null
      });
    });
  }
  return edges;
}

function isCanvasBackgroundTarget(target) {
  return target instanceof Element && !target.closest(".node") && !target.closest(".wire") && !target.closest(".context-menu");
}

function cloneNodePayload(node, nextId) {
  return {
    ...structuredClone(node),
    node_id: nextId,
    node_name: `${node.node_name || nextId} Copy`,
    gnode: "",
    next: []
  };
}

async function pickOpenFile() {
  if (typeof window.showOpenFilePicker !== "function") return null;
  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    excludeAcceptAllOption: false,
    types: [
      {
        description: "Workflow JSON",
        accept: { "application/json": [".json"] }
      }
    ]
  });
  return handle || null;
}

async function ensureWritableHandle(currentHandle, suggestedName) {
  if (currentHandle) return currentHandle;
  if (typeof window.showSaveFilePicker !== "function") return null;
  return window.showSaveFilePicker({
    suggestedName,
    types: [
      {
        description: "Workflow JSON",
        accept: { "application/json": [".json"] }
      }
    ]
  });
}

export default function App() {
  const [nodePresetConfig, setNodePresetConfig] = useState({});
  const nodePresets = useMemo(() => buildNodePresets(nodePresetConfig), [nodePresetConfig]);
  const [workflow, setWorkflow] = useState(() => newWorkflow());
  const [selectedIds, setSelectedIds] = useState(["head"]);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [connectSourceId, setConnectSourceId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [fileHandle, setFileHandle] = useState(null);
  const [presetLoadError, setPresetLoadError] = useState("");
  const [nodeJsonDraft, setNodeJsonDraft] = useState("");
  const [nodeJsonDraftKey, setNodeJsonDraftKey] = useState("");
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const fileInputRef = useRef(null);

  const errors = useMemo(() => validateWorkflow(workflow), [workflow]);
  const selectedNode = selectedIds.length === 1 ? workflow.nodes[selectedIds[0]] || null : null;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  useEffect(() => {
    if (!selectedNode) {
      setNodeJsonDraft("");
      setNodeJsonDraftKey("");
      return;
    }
    const normalized = JSON.stringify(selectedNode, null, 2);
    setNodeJsonDraft((current) => (current === normalized ? current : normalized));
    setNodeJsonDraftKey(normalized);
  }, [selectedIds, selectedNode]);

  useEffect(() => {
    let active = true;

    async function loadNodePresets() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}nodes.json`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Failed to load nodes.json: ${response.status} ${response.statusText}`);
        const data = await response.json();
        if (!active) return;
        setNodePresetConfig(data && typeof data === "object" ? data : {});
        setPresetLoadError("");
      } catch (error) {
        if (!active) return;
        setNodePresetConfig({});
        setPresetLoadError(String(error));
      }
    }

    loadNodePresets();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    function closeContextMenu() {
      setContextMenu(null);
    }

    window.addEventListener("click", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
    };
  }, []);

  function updateNode(nodeId, patch) {
    setWorkflow((prev) => {
      const next = structuredClone(prev);
      const current = next.nodes[nodeId];
      if (!current) return prev;
      next.nodes[nodeId] = { ...current, ...patch };
      next.nodes[nodeId].next = truncateNext(next.nodes[nodeId].next, next.nodes[nodeId].type);
      return next;
    });
  }

  function updateViewport(patchOrUpdater) {
    setWorkflow((prev) => {
      const next = structuredClone(prev);
      const current = next.ui.viewport;
      next.ui.viewport = typeof patchOrUpdater === "function" ? patchOrUpdater(current) : { ...current, ...patchOrUpdater };
      return next;
    });
  }

  function setNodeConfirm(nodeId, enabled) {
    setWorkflow((prev) => {
      const next = structuredClone(prev);
      const current = next.nodes[nodeId];
      if (!current) return prev;
      current.args = current.args && typeof current.args === "object" ? current.args : {};
      current.args.confirm = enabled;
      return next;
    });
  }

  function buildNormalizedNodePatch(rawValue, nodeId, fallbackNode) {
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw new Error("Node JSON must be an object");
    }
    return {
      ...rawValue,
      node_id: nodeId,
      node_name: typeof rawValue.node_name === "string" && rawValue.node_name.trim() ? rawValue.node_name : nodeId,
      type: typeof rawValue.type === "string" && rawValue.type.trim() ? rawValue.type : fallbackNode.type,
      desc: typeof rawValue.desc === "string" ? rawValue.desc : "",
      meta: rawValue.meta && typeof rawValue.meta === "object" && !Array.isArray(rawValue.meta) ? rawValue.meta : {},
      args: rawValue.args && typeof rawValue.args === "object" && !Array.isArray(rawValue.args) ? rawValue.args : {},
      next: Array.isArray(rawValue.next) ? rawValue.next.map(String) : []
    };
  }

  function applyNodeJsonDraft(options = {}) {
    if (!selectedNode) return { ok: true, workflow };
    const parsed = safeJsonParse(nodeJsonDraft);
    if (!parsed.ok) {
      if (!options.silent) alert(String(parsed.error));
      return { ok: false, error: parsed.error };
    }

    let patch;
    try {
      patch = buildNormalizedNodePatch(parsed.value, selectedIds[0], selectedNode);
    } catch (error) {
      if (!options.silent) alert(String(error));
      return { ok: false, error };
    }

    const nextWorkflow = structuredClone(workflow);
    const current = nextWorkflow.nodes[selectedIds[0]];
    if (!current) return { ok: false, error: new Error(`Node ${selectedIds[0]} not found`) };
    nextWorkflow.nodes[selectedIds[0]] = { ...current, ...patch };
    nextWorkflow.nodes[selectedIds[0]].next = truncateNext(nextWorkflow.nodes[selectedIds[0]].next, nextWorkflow.nodes[selectedIds[0]].type);

    const normalizedText = JSON.stringify(nextWorkflow.nodes[selectedIds[0]], null, 2);
    setWorkflow(nextWorkflow);
    setNodeJsonDraft(normalizedText);
    setNodeJsonDraftKey(normalizedText);
    return { ok: true, workflow: nextWorkflow };
  }

  function addNode(presetKey, x, y) {
    const id = makeNodeId(workflow.nodes);
    const preset = nodePresets.find((item) => item.key === presetKey);
    setWorkflow((prev) => {
      const next = structuredClone(prev);
      const base = structuredClone(preset?.template || {});
      const knownKeys = new Set(["node_id", "node_name", "type", "desc", "meta", "args", "next"]);
      const customFields = Object.fromEntries(
        Object.entries(base).filter(([k]) => !knownKeys.has(k))
      );
      next.nodes[id] = {
        node_id: id,
        node_name: base.node_name || makeDefaultNodeName(base.type || presetKey, next.nodes),
        type: base.type || presetKey,
        desc: typeof base.desc === "string" ? base.desc : "",
        meta: base.meta && typeof base.meta === "object" ? base.meta : {},
        args: base.args && typeof base.args === "object" ? base.args : {},
        next: Array.isArray(base.next) ? base.next.map(String) : [],
        ...customFields
      };
      next.ui.nodes[id] = {
        x: Math.round(x / GRID_SIZE) * GRID_SIZE,
        y: Math.round(y / GRID_SIZE) * GRID_SIZE
      };
      return next;
    });
    setSelectedIds([id]);
    setSelectedEdge(null);
    setConnectSourceId(null);
    setContextMenu(null);
  }

  function deleteNodes(nodeIds) {
    const removable = nodeIds.filter((id) => id !== "head" && id !== "end");
    if (!removable.length) return;
    setWorkflow((prev) => {
      const next = structuredClone(prev);
      for (const nodeId of removable) {
        delete next.nodes[nodeId];
        delete next.ui.nodes[nodeId];
      }
      for (const node of Object.values(next.nodes)) {
        node.next = (node.next || []).filter((id) => !removable.includes(id));
      }
      return next;
    });
    setSelectedIds(["head"]);
    setSelectedEdge(null);
    setConnectSourceId((current) => (current && removable.includes(current) ? null : current));
    setContextMenu(null);
  }

  function cloneNodes(nodeIds) {
    const sourceIds = nodeIds.filter((id) => workflow.nodes[id] && id !== "head" && id !== "end");
    if (!sourceIds.length) return;
    const mapping = {};
    setWorkflow((prev) => {
      const next = structuredClone(prev);
      for (const sourceId of sourceIds) {
        const cloneId = makeNodeId(next.nodes);
        mapping[sourceId] = cloneId;
        next.nodes[cloneId] = cloneNodePayload(next.nodes[sourceId], cloneId);
        const pos = next.ui.nodes[sourceId] || { x: 120, y: 120 };
        next.ui.nodes[cloneId] = {
          x: pos.x + CLONE_OFFSET,
          y: pos.y + CLONE_OFFSET
        };
      }
      for (const sourceId of sourceIds) {
        const cloneId = mapping[sourceId];
        next.nodes[cloneId].next = (next.nodes[sourceId].next || [])
          .filter((toId) => mapping[toId])
          .map((toId) => mapping[toId]);
      }
      return next;
    });
    setSelectedIds(Object.values(mapping));
    setSelectedEdge(null);
    setConnectSourceId(null);
    setContextMenu(null);
  }

  function reorderNodeNext(nodeId, index, delta) {
    setWorkflow((prev) => {
      const next = structuredClone(prev);
      const node = next.nodes[nodeId];
      if (!node || !Array.isArray(node.next)) return prev;
      const target = index + delta;
      if (target < 0 || target >= node.next.length) return prev;
      const arr = [...node.next];
      [arr[index], arr[target]] = [arr[target], arr[index]];
      node.next = arr;
      return next;
    });
  }

  function deleteEdge(fromId, toId) {
    setWorkflow((prev) => {
      const next = structuredClone(prev);
      const node = next.nodes[fromId];
      if (!node) return prev;
      node.next = (node.next || []).filter((id) => id !== toId);
      return next;
    });
    setSelectedEdge(null);
    setContextMenu(null);
  }

  function alignNodesToGrid() {
    setWorkflow((prev) => {
      const next = structuredClone(prev);
      for (const [id, pos] of Object.entries(next.ui.nodes || {})) {
        if (!next.nodes[id]) continue;
        pos.x = Math.round(pos.x / GRID_SIZE) * GRID_SIZE;
        pos.y = Math.round(pos.y / GRID_SIZE) * GRID_SIZE;
      }
      return next;
    });
  }

  async function loadFromHandle(handle) {
    const file = await handle.getFile();
    const text = await file.text();
    const parsed = safeJsonParse(text);
    if (!parsed.ok) {
      alert(String(parsed.error));
      return;
    }
    const wf = normalizeWorkflow(parsed.value);
    setWorkflow(wf);
    setSelectedIds(["head"]);
    setSelectedEdge(null);
    setConnectSourceId(null);
    setContextMenu(null);
    setFileHandle(handle);
  }

  async function handleLoadClicked() {
    if (typeof window.showOpenFilePicker === "function") {
      try {
        const handle = await pickOpenFile();
        if (!handle) return;
        await loadFromHandle(handle);
      } catch (error) {
        if (error?.name !== "AbortError") alert(String(error));
      }
      return;
    }
    fileInputRef.current?.click();
  }

  async function handleFilePicked(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    const parsed = safeJsonParse(text);
    if (!parsed.ok) {
      alert(String(parsed.error));
      return;
    }
    try {
      const wf = normalizeWorkflow(parsed.value);
      setWorkflow(wf);
      setSelectedIds(["head"]);
      setSelectedEdge(null);
      setConnectSourceId(null);
      setContextMenu(null);
      setFileHandle(null);
    } catch (error) {
      alert(String(error));
    }
  }

  async function handleSaveClicked() {
    try {
      let workflowToSave = workflow;
      if (selectedNode && nodeJsonDraft !== nodeJsonDraftKey) {
        const applied = applyNodeJsonDraft({ silent: false });
        if (!applied.ok) return;
        workflowToSave = applied.workflow;
      }
      const handle = await ensureWritableHandle(fileHandle, `${nowStamp()}-${workflow.id}.json`);
      if (!handle) {
        alert("Current browser does not support direct file save. Please use a Chromium-based browser.");
        return;
      }
      const writable = await handle.createWritable();
      await writable.write(stableStringify(workflowToSave));
      await writable.close();
      setFileHandle(handle);
    } catch (error) {
      if (error?.name !== "AbortError") alert(String(error));
    }
  }

  function handleNewClicked() {
    if (!confirm("Reset workflow to a new empty one?")) return;
    const wf = newWorkflow();
    setWorkflow(wf);
    setSelectedIds(["head"]);
    setSelectedEdge(null);
    setConnectSourceId(null);
    setContextMenu(null);
    setFileHandle(null);
  }

  function handleZoom(delta) {
    updateViewport((current) => ({
      ...current,
      zoom: clamp(Number((current.zoom + delta).toFixed(2)), 0.4, 2.2)
    }));
  }

  function handleResetView() {
    updateViewport({ x: 0, y: 0, zoom: 1 });
  }

  function beginInspectorResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    function onMove(moveEvent) {
      setInspectorWidth(clamp(startWidth + (startX - moveEvent.clientX), 280, 720));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleConnect(nodeId) {
    if (!connectSourceId) return false;
    if (connectSourceId === nodeId) {
      setConnectSourceId(null);
      return true;
    }
    if (connectSourceId === "end" || nodeId === "head") {
      setConnectSourceId(null);
      return true;
    }

    const sourceNode = workflow.nodes[connectSourceId];
    if (sourceNode && isCondType(sourceNode.type)) {
      const currentNext = sourceNode.next || [];
      if (!currentNext.includes(nodeId) && currentNext.length >= 2) {
        alert("cond 节点最多 2 条出线（next[0]=真分支、next[1]=假分支），已经连满。请先删除一条连线再重连，或在右侧面板调整 next 顺序。");
        setConnectSourceId(null);
        return true;
      }
    }

    setWorkflow((prev) => {
      const next = structuredClone(prev);
      const fromNode = next.nodes[connectSourceId];
      if (!fromNode) return prev;
      fromNode.next = Array.isArray(fromNode.next) ? fromNode.next : [];
      if (!supportsMultipleOutputs(fromNode.type)) {
        fromNode.next = [nodeId];
      } else if (isCondType(fromNode.type)) {
        if (!fromNode.next.includes(nodeId) && fromNode.next.length < 2) {
          fromNode.next.push(nodeId);
        }
      } else if (!fromNode.next.includes(nodeId)) {
        fromNode.next.push(nodeId);
      }
      return next;
    });
    setSelectedIds([connectSourceId, nodeId]);
    setSelectedEdge(null);
    setConnectSourceId(null);
    setContextMenu(null);
    return true;
  }

  function handleNodeClick(nodeId, event) {
    setContextMenu(null);
    if (handleConnect(nodeId)) return;

    setSelectedEdge(null);
    if (event?.ctrlKey || event?.metaKey) {
      setSelectedIds((prev) => (prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]));
      return;
    }
    setSelectedIds([nodeId]);
  }

  function handleNodeDoubleClick(nodeId) {
    setContextMenu(null);
    setSelectedEdge(null);
    setSelectedIds([nodeId]);
    setConnectSourceId((current) => (current === nodeId ? null : nodeId));
  }

  function handleNodeContextMenu(nodeId, event) {
    event.preventDefault();
    event.stopPropagation();
    const targetIds = selectedSet.has(nodeId) ? selectedIds : [nodeId];
    setSelectedIds(targetIds);
    setSelectedEdge(null);
    setConnectSourceId(null);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId,
      targetIds
    });
  }

  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target;
      const isTyping = target instanceof HTMLElement
        && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (isTyping) return;

      if (event.key === "Escape") {
        setConnectSourceId(null);
        setSelectedEdge(null);
        setContextMenu(null);
        return;
      }

      if (event.key.toLowerCase() === "d" && (event.ctrlKey || event.metaKey) && selectedIds.length) {
        event.preventDefault();
        cloneNodes(selectedIds);
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") return;
      event.preventDefault();
      if (selectedEdge) {
        deleteEdge(selectedEdge.fromId, selectedEdge.toId);
        return;
      }
      if (selectedIds.length) deleteNodes(selectedIds);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedEdge, selectedIds, workflow]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">WF</div>
          <div className="title">
            <div className="name">工作流编辑平台</div>
            <div className="sub">工作流ID: {workflow.id}</div>
          </div>
        </div>
        <div className="top-actions">
          <button className="btn" onClick={handleNewClicked}>New</button>
          <button className="btn" onClick={handleLoadClicked}>Load JSON</button>
          <button className="btn primary" onClick={handleSaveClicked}>Save</button>
          <button className="btn" onClick={alignNodesToGrid}>Align Grid</button>
          <button className="btn" onClick={() => handleZoom(-0.1)}>-</button>
          <button className="btn" onClick={handleResetView}>100%</button>
          <button className="btn" onClick={() => handleZoom(0.1)}>+</button>
          <div className="pill">{selectedIds.length} selected</div>
        </div>
        <input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={handleFilePicked} />
      </header>

      <div
        className="layout"
        style={{ gridTemplateColumns: `${paletteCollapsed ? 52 : 270}px minmax(0, 1fr) ${inspectorWidth}px` }}
      >
        <aside className={`palette ${paletteCollapsed ? "collapsed" : ""}`}>
          <div className="panel-title palette-head">
            {paletteCollapsed ? null : <span>可用节点</span>}
            <button
              className="icon-btn"
              title={paletteCollapsed ? "展开工具栏" : "收起工具栏"}
              onClick={() => setPaletteCollapsed((current) => !current)}
            >
              {paletteCollapsed ? "»" : "«"}
            </button>
          </div>
          {paletteCollapsed ? (
            <div className="palette-collapsed-label">节点库</div>
          ) : (
          <>
          <div className="palette-list">
            {nodePresets.map((preset) => (
              <PaletteItem key={preset.key} preset={preset} />
            ))}
            {!nodePresets.length ? <div className="empty">{presetLoadError || "Loading nodes.json..."}</div> : null}
          </div>
          <div className="panel-title" style={{ marginTop: 16 }}>Validation</div>
          <div className={"validation " + (errors.length ? "bad" : "good")}>
            {errors.length ? errors.map((error) => <div key={error} className="validation-item">{error}</div>) : <div className="validation-item">流程验证通过</div>}
          </div>
          <div className="panel-title" style={{ marginTop: 16 }}>Tips</div>
          <div className="tips">
            <div className="tip">拖拽上述节点到编辑区.</div>
            <div className="tip">单击节点进行编辑, +Ctrl可多选节点进行批量可克隆删除操作.</div>
            <div className="tip">Alt+拖拽空白区域可框选多个节点.</div>
            <div className="tip">双击节点可指定下级节点并自动连线</div>
            <div className="tip">cond 条件分支: 双击后依次点两个目标, 第1条是真分支、第2条是假分支, 顺序可在右侧面板用 ↑↓ 调整</div>
            <div className="tip">Del可删除节点/连线</div>
            <div className="tip">右键可弹出菜单</div>
          </div>
          </>
          )}
        </aside>

        <Canvas
          workflow={workflow}
          selectedIds={selectedIds}
          selectedSet={selectedSet}
          selectedEdge={selectedEdge}
          connectSourceId={connectSourceId}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeContextMenu={handleNodeContextMenu}
          onEdgeClick={(edge) => {
            setSelectedEdge(edge);
            setSelectedIds([]);
            setConnectSourceId(null);
            setContextMenu(null);
          }}
          onCanvasClick={() => {
            setSelectedIds([]);
            setSelectedEdge(null);
            setConnectSourceId(null);
            setContextMenu(null);
          }}
          onAddNode={addNode}
          onMoveNodes={(patches) => {
            setWorkflow((prev) => {
              const next = structuredClone(prev);
              for (const [id, pos] of Object.entries(patches)) {
                if (next.ui.nodes[id]) next.ui.nodes[id] = pos;
              }
              return next;
            });
          }}
          onSelectNodes={(ids) => {
            setSelectedIds(ids);
            setSelectedEdge(null);
            setConnectSourceId(null);
            setContextMenu(null);
          }}
          onToggleNodeConfirm={setNodeConfirm}
          onViewportChange={updateViewport}
        />

        <aside className="inspector">
          <div className="inspector-resize" title="拖动调整编辑区宽度" onMouseDown={beginInspectorResize} />
          <div className="panel-title">Properties ({selectedIds.length})</div>
          {selectedNode ? (
            <NodeInspector
              nodeId={selectedIds[0]}
              node={selectedNode}
              workflow={workflow}
              jsonText={nodeJsonDraft}
              onJsonTextChange={setNodeJsonDraft}
              onApplyJson={() => applyNodeJsonDraft({ silent: false })}
              onReorderNext={reorderNodeNext}
              connectSourceId={connectSourceId}
            />
          ) : selectedIds.length > 1 ? (
            <SelectionInspector selectedIds={selectedIds} />
          ) : selectedEdge ? (
            <EdgeInspector edge={selectedEdge} workflow={workflow} onDelete={() => deleteEdge(selectedEdge.fromId, selectedEdge.toId)} />
          ) : (
            <div className="empty">Select a node or connection</div>
          )}
        </aside>
      </div>

      {contextMenu ? (
        <NodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          targetIds={contextMenu.targetIds}
          onClone={() => cloneNodes(contextMenu.targetIds)}
          onDelete={() => deleteNodes(contextMenu.targetIds)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

function PaletteItem({ preset }) {
  return (
    <div
      className="palette-item"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-node-type", preset.key);
        event.dataTransfer.effectAllowed = "copy";
      }}
      style={{ borderLeftColor: nodeColor(preset.type) }}
    >
      <div className="palette-type">{preset.label}</div>
      <div className="palette-sub">{preset.type}</div>
    </div>
  );
}

function Canvas({
  workflow,
  selectedIds,
  selectedSet,
  selectedEdge,
  connectSourceId,
  onNodeClick,
  onNodeDoubleClick,
  onNodeContextMenu,
  onEdgeClick,
  onCanvasClick,
  onAddNode,
  onMoveNodes,
  onSelectNodes,
  onToggleNodeConfirm,
  onViewportChange
}) {
  const canvasRef = useRef(null);
  const panMovedRef = useRef(false);
  const [dragState, setDragState] = useState(null);
  const [panState, setPanState] = useState(null);
  const [selectionState, setSelectionState] = useState(null);

  const positions = workflow.ui?.nodes || {};
  const viewport = workflow.ui?.viewport || { x: 0, y: 0, zoom: 1 };
  const edges = useMemo(() => buildEdges(workflow), [workflow]);

  function getScenePoint(clientX, clientY) {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left - viewport.x) / viewport.zoom,
      y: (clientY - rect.top - viewport.y) / viewport.zoom
    };
  }

  function handleDrop(event) {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/x-node-type");
    if (!type) return;
    const point = getScenePoint(event.clientX, event.clientY);
    onAddNode(type, point.x - NODE_WIDTH / 2, point.y - NODE_HEIGHT / 2);
  }

  function handleWheel(event) {
    event.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const before = {
      x: (cursorX - viewport.x) / viewport.zoom,
      y: (cursorY - viewport.y) / viewport.zoom
    };
    const zoom = clamp(Number((viewport.zoom + (event.deltaY < 0 ? 0.08 : -0.08)).toFixed(2)), 0.4, 2.2);
    onViewportChange({
      zoom,
      x: cursorX - before.x * zoom,
      y: cursorY - before.y * zoom
    });
  }

  function beginPan(event) {
    if (event.button !== 0 || !isCanvasBackgroundTarget(event.target)) return false;
    panMovedRef.current = false;
    setPanState({
      clientX: event.clientX,
      clientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y
    });
    return true;
  }

  function beginSelection(event) {
    if (event.button !== 0 || !event.altKey || !isCanvasBackgroundTarget(event.target)) return false;
    event.preventDefault();
    panMovedRef.current = true;
    const point = getScenePoint(event.clientX, event.clientY);
    setSelectionState({ start: point, current: point });
    setPanState(null);
    return true;
  }

  function getSelectionRect(selection) {
    const left = Math.min(selection.start.x, selection.current.x);
    const top = Math.min(selection.start.y, selection.current.y);
    const right = Math.max(selection.start.x, selection.current.x);
    const bottom = Math.max(selection.start.y, selection.current.y);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
  }

  function isNodeInSelection(pos, rect) {
    const nodeRect = {
      left: pos.x,
      top: pos.y,
      right: pos.x + NODE_WIDTH,
      bottom: pos.y + NODE_HEIGHT
    };
    return nodeRect.left <= rect.right
      && nodeRect.right >= rect.left
      && nodeRect.top <= rect.bottom
      && nodeRect.bottom >= rect.top;
  }

  function finishSelection() {
    if (!selectionState) return;
    const rect = getSelectionRect(selectionState);
    const ids = Object.keys(workflow.nodes).filter((id) => {
      const pos = positions[id];
      return pos && isNodeInSelection(pos, rect);
    });
    onSelectNodes(ids);
    setSelectionState(null);
  }

  return (
    <main
      ref={canvasRef}
      className="canvas"
      onWheel={handleWheel}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
      onMouseMove={(event) => {
        if (selectionState) {
          setSelectionState((current) => current ? { ...current, current: getScenePoint(event.clientX, event.clientY) } : current);
          return;
        }
        if (dragState) {
          const point = getScenePoint(event.clientX, event.clientY);
          const patches = {};
          for (const [id, origin] of Object.entries(dragState.origins)) {
            patches[id] = {
              x: Math.max(0, origin.x + (point.x - dragState.pointerStart.x)),
              y: Math.max(0, origin.y + (point.y - dragState.pointerStart.y))
            };
          }
          onMoveNodes(patches);
          return;
        }
        if (panState) {
          if (!panMovedRef.current && (event.clientX !== panState.clientX || event.clientY !== panState.clientY)) {
            panMovedRef.current = true;
          }
          onViewportChange({
            x: panState.startX + (event.clientX - panState.clientX),
            y: panState.startY + (event.clientY - panState.clientY)
          });
        }
      }}
      onMouseUp={() => {
        finishSelection();
        setDragState(null);
        setPanState(null);
      }}
      onMouseLeave={() => {
        setDragState(null);
        setPanState(null);
        setSelectionState(null);
      }}
      onMouseDown={(event) => {
        if (beginSelection(event)) return;
        beginPan(event);
      }}
      onClick={(event) => {
        if (!isCanvasBackgroundTarget(event.target)) return;
        if (panMovedRef.current) {
          panMovedRef.current = false;
          return;
        }
        onCanvasClick();
      }}
    >
      <div className="canvas-status">
        <span>{Math.round(viewport.zoom * 100)}%</span>
        <span>{connectSourceId ? `connecting from: ${connectSourceId}` : `${selectedIds.length} selected | left-drag blank area to pan | Alt-drag to select`}</span>
      </div>

      <div
        className="scene"
        style={{
          width: SCENE_WIDTH,
          height: SCENE_HEIGHT,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`
        }}
      >
        <svg className="wires" aria-hidden="true" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}>
          {edges.map((edge) => (
            <g key={edge.id}>
              <path
                d={edge.path}
                className={`wire ${selectedEdge?.id === edge.id ? "wire-selected" : ""} ${connectSourceId === edge.fromId ? "wire-active" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onEdgeClick(edge);
                }}
              />
              {edge.label && edge.labelX !== null ? (
                <text className="wire-label" x={edge.labelX} y={edge.labelY}>{edge.label}</text>
              ) : null}
            </g>
          ))}
        </svg>

        {selectionState ? (
          <div
            className="selection-box"
            style={{
              left: getSelectionRect(selectionState).left,
              top: getSelectionRect(selectionState).top,
              width: getSelectionRect(selectionState).width,
              height: getSelectionRect(selectionState).height
            }}
          />
        ) : null}

        {Object.entries(workflow.nodes).map(([id, node]) => {
          const pos = positions[id] || { x: 100, y: 100 };
          const selected = selectedSet.has(id);
          const isConnectSource = connectSourceId === id;
          const gnode = nodeGnode(node);
          return (
            <div
              key={id}
              className={`node ${selected ? "selected " : ""}${isConnectSource ? "connect-from " : ""}`}
              style={{ left: pos.x, top: pos.y, borderTopColor: nodeColor(node.type) }}
              onMouseDown={(event) => {
                event.stopPropagation();
                const point = getScenePoint(event.clientX, event.clientY);
                const dragIds = selectedSet.has(id) ? selectedIds : [id];
                const origins = Object.fromEntries(dragIds.map((dragId) => [dragId, positions[dragId] || { x: 0, y: 0 }]));
                setDragState({
                  pointerStart: point,
                  origins
                });
              }}
              onClick={(event) => {
                event.stopPropagation();
                onNodeClick(id, event);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onNodeDoubleClick(id);
              }}
              onContextMenu={(event) => onNodeContextMenu(id, event)}
            >
              <div className="node-head">
                <div className="node-title">{node.node_name || id}</div>
                <div className="node-pill">{typeBadge(node.type)}</div>
              </div>
              <div className="node-body">
                {gnode ? <div className="node-gnode">{gnode}</div> : null}
                {isCondType(node.type) ? (
                  <div className="node-expr" title={Array.isArray(node.args?.expr) ? node.args.expr.join(" AND ") : String(node.args?.expr || "")}>
                    {Array.isArray(node.args?.expr) ? node.args.expr.join(" AND ") : String(node.args?.expr || "expr 未设置")}
                    {` · 出线 ${(node.next || []).length}/2`}
                  </div>
                ) : null}
                <div className="node-meta">
                  <label
                    className={`node-confirm ${isConfirmEnabled(node) ? "on" : ""}`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={isConfirmEnabled(node)}
                      onChange={(event) => onToggleNodeConfirm(id, event.target.checked)}
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                    />
                    <span className="node-confirm-track" aria-hidden="true">
                      <span className="node-confirm-thumb" />
                    </span>
                    <span className="node-confirm-label">confirm</span>
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}

function NodeInspector({ nodeId, node, workflow, jsonText, onJsonTextChange, onApplyJson, onReorderNext, connectSourceId }) {
  const cond = node ? isCondType(node.type) : false;
  const nextList = node?.next || [];
  return (
    <div className="inspector-body">
      {cond ? (
        <div className="branch-hint">
          cond 条件分支：必须恰好 2 条出线，next[0] = 真分支、next[1] = 假分支（按连线添加的先后顺序）。expr 为单个比较式或列表（多条为 AND），文法同 plc_batch 的 done_list。出线连满后需先删一条再重连。
        </div>
      ) : null}
      {nextList.length ? (
        <div className="field">
          <label>next 顺序{cond ? "（顺序即分支语义）" : ""}</label>
          <div className="next-order-list">
            {nextList.map((toId, index) => (
              <div className="next-order-row" key={`${toId}-${index}`}>
                <span className="next-order-tag">
                  {cond ? (index === 0 ? "真 true" : "假 false") : `#${index + 1}`}
                </span>
                <span className="next-order-name">{workflow?.nodes?.[toId]?.node_name || toId}</span>
                <button className="icon-btn" title="上移" disabled={index === 0} onClick={() => onReorderNext(nodeId, index, -1)}>↑</button>
                <button className="icon-btn" title="下移" disabled={index === nextList.length - 1} onClick={() => onReorderNext(nodeId, index, 1)}>↓</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="field">
        <label>node JSON</label>
        <textarea value={jsonText} onChange={(event) => onJsonTextChange(event.target.value)} rows={24} />
      </div>
      <div className="row">
        <button className="btn" onClick={onApplyJson}>Apply JSON</button>
        <div className="pill">{connectSourceId ? `connecting from: ${connectSourceId}` : `editing: ${nodeId}`}</div>
      </div>
    </div>
  );
}

function SelectionInspector({ selectedIds }) {
  return (
    <div className="inspector-body">
      <div className="field">
        <label>selection</label>
        <input value={`${selectedIds.length} nodes`} readOnly />
      </div>
      <div className="field">
        <label>members</label>
        <textarea value={selectedIds.join("\n")} readOnly rows={8} />
      </div>
      <div className="hint">Use the node context menu to clone/delete the current selection.</div>
    </div>
  );
}

function NodeContextMenu({ x, y, targetIds, onClone, onDelete, onClose }) {
  const removable = targetIds.some((id) => id !== "head" && id !== "end");

  return (
    <div
      className="context-menu"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="context-menu-title">{targetIds.length > 1 ? `${targetIds.length} nodes selected` : targetIds[0]}</div>
      <button
        className="context-menu-item"
        disabled={!removable}
        onClick={() => {
          onClone();
          onClose();
        }}
      >
        Clone
      </button>
      <button
        className="context-menu-item danger"
        disabled={!removable}
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        Delete
      </button>
    </div>
  );
}

function EdgeInspector({ edge, workflow, onDelete }) {
  const fromNode = workflow.nodes[edge.fromId];
  const toNode = workflow.nodes[edge.toId];
  return (
    <div className="inspector-body">
      <div className="field">
        <label>from</label>
        <input value={fromNode?.node_name || edge.fromId} readOnly />
      </div>
      <div className="field">
        <label>to</label>
        <input value={toNode?.node_name || edge.toId} readOnly />
      </div>
      {edge.label ? (
        <div className="field">
          <label>branch</label>
          <input value={edge.label} readOnly />
        </div>
      ) : null}
      <div className="field">
        <label>connection</label>
        <div className="hint">Delete removes this edge only.</div>
      </div>
      <button className="btn danger" onClick={onDelete}>Delete connection</button>
    </div>
  );
}
