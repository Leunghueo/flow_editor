# Flow Editor — 工作流编辑平台

可视化工作流（流程）编辑器：拖拽节点到画布、连线成图、编辑节点 JSON，最后导出与后端工作流引擎同构的 workflow JSON 文件。当前节点模板与成都静载上位机的 workflow 体系对应（`plc_batch / sys / select / cond / loop_begin / loop_end`）。

## 运行

```bash
npm install
npm run dev      # http://localhost:5173（strictPort，端口占用会直接报错）
npm run build
npm run preview
```

技术栈：React 18 + Vite 5，无额外 UI / 图库，连线与画布均为手写实现。

## 目录

| 路径 | 作用 |
|---|---|
| `index.html` | 入口页，挂载 `/app/main.jsx` |
| `app/main.jsx` | React 入口，引入 `App` 与 `styles.css` |
| `app/App.jsx` | 编辑器主体（约 1175 行）：顶栏 / 节点库 / 画布 / 属性面板 |
| `app/schema.js` | 工作流数据模型：`newWorkflow()` / `normalizeWorkflow()` / `validateWorkflow()` |
| `app/utils.js` | `safeJsonParse` / `stableStringify` / `downloadJson` / `clamp` |
| `app/styles.css` | 全部样式；节点配色：plc 橙、sys 蓝、select 绿、loop 紫 |
| `public/nodes.json` | **运行时实际加载**的节点模板（前端启动时 `fetch(BASE_URL + "nodes.json")`） |
| `app/nodes.json` | `public/nodes.json` 的同步副本（运行时不加载，仅防误改错文件；改模板以 `public/` 为准并同步此文件） |
| `vite.config.js` | Vite + React 插件，dev 端口 5173 |

## 数据模型（workflow JSON）

```jsonc
{
  "id": "uuid", "name": "新工作流", "ctime": "ISO 时间", "desc": "...", "meta": {},
  "nodes": {                       // 以 node_id 为键的字典，必须含 head / end
    "head": { "node_id": "head", "node_name": "开始", "type": "sys",
              "desc": "", "meta": {}, "args": {}, "next": ["end"] },
    "end":  { "node_id": "end",  "node_name": "结束", "type": "sys",
              "desc": "", "meta": {}, "args": {}, "next": [] }
  },
  "ui": {
    "nodes":    { "head": { "x": 120, "y": 120 } },  // 各节点画布坐标
    "viewport": { "x": 0, "y": 0, "zoom": 1 }        // 画布平移与缩放
  }
}
```

节点通用字段（以 `public/nodes.json` 模板为准）：`node_id / node_name / type / require_node / desc / meta / args / gnode / next`。`args` 常用键：`delay`、`confirm`（执行前确认，画布节点卡片上有开关）、以及各类型私有参数。

当前 6 种节点模板（`public/nodes.json`）：

| type | 名称 | 关键 args |
|---|---|---|
| `plc_batch` | PLC并发执行 | `actlist: [{pt_name, value, reset}]`，可并行写多个 PLC 点 |
| `sys` | 上位机指令 | `algo`（如 `wait`）+ `data`（如 `{seconds: 1}`） |
| `select` | 分支模块 | 人工选择后续分支，允许多个 `next` |
| `cond` | 条件分支 | `expr`：单比较式或列表（AND，文法同 `plc_batch` 的 done_list）；真走 `next[0]`、假走 `next[1]` |
| `loop_begin` | 循环开始 | `count` 循环计数 |
| `loop_end` | 循环结束 | 需与 `loop_begin` 配对 |

校验规则（`schema.js: validateWorkflow`）：必须含 `head/end`；`end.next` 必须为空；`next` 引用的节点必须存在；节点键与 `node_id` 必须一致；普通节点最多 1 个 `next`，`select/switch` 不限，**`cond` 必须恰好 2 个**（`next[0]`=真分支、`next[1]`=假分支，与后端 `_validate_graph` 一致），且 `args.expr` 不得为空（单个比较式或非空字符串列表）。

## 编辑器操作

- **加节点**：左侧节点库拖到画布（吸附 28px 网格，顶栏 Align Grid 可一键对齐已有节点）
- **连线**：双击源节点进入 connect 模式，再单击目标节点。普通节点 `next` 只保留 1 个（替换），`select/switch` 为追加，`cond` 为追加但上限 2 条（连满会弹窗提示）；cond 连线顺序即分支语义，画布上会标注“真 true / 假 false”，顺序连反可在右侧面板的 next 顺序列表用 ↑↓ 调整
- **布局**：左侧节点库可点 « 收缩成窄条（» 展开）；右侧属性编辑区左缘可左右拖动调整宽度（280–720px）
- **选/移**：单击选中，Ctrl/⌘+单击多选，拖动可批量移动；Alt+拖空白框选；拖空白平移画布；滚轮以光标为中心缩放（0.4–2.2）
- **克隆/删除**：右键菜单，或 Ctrl/⌘+D 克隆、Del/Backspace 删除节点或连线；`head/end` 不可删、不可克隆。克隆会清空 `gnode`，仅保留克隆集合内部的连线
- **改节点**：右侧面板直接编辑节点 JSON，点 Apply JSON 生效（保存时会自动先应用未生效的草稿）
- **存/读文件**：优先使用 File System Access API 直接读写本地 JSON 文件（需 Chromium 系浏览器），否则回退到文件选择框；默认文件名 `YYYY-MMDD-<workflow.id>.json`
- **连线渲染**：正交折线 + 14px 圆角，按左右间隙自动选择左右出线或上下出线

## 注意事项（代码现状）

1. **两份 nodes.json**：运行时只用 `public/nodes.json`；`app/nodes.json` 已同步为相同内容（2026-10-31），改模板时两份一起改，避免再次分叉。
2. **`cond` 支持（2026-10-31 已修）**：`schema.js` 新增 `maxOutputsForType/truncateNext`（cond 上限 2、select/switch 不限、其余 1），连线、Apply JSON、属性更新统一按上限截断；校验对 cond 强制恰好 2 个 `next` 且 `expr` 非空。注意新建 cond 在连满 2 条出线前，左侧 Validation 会一直报“currently N”，这是与后端加载校验对齐的预期提示。
3. `loop_end` 模板的 `desc` 已更正为“循环结束模块,需与循环开始模块配对”。
4. 无撤销/重做、无自动保存；工作只存在内存中，靠手动 Save 落盘。
