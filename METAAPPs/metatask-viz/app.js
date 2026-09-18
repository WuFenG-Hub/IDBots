"use strict";
/* MetaTask visualization MetaApp — read-only.
 *
 * Data source: the metaso-p2p metatask replay indexer projection.
 *   - default: the bundled snapshot under data/ (captured from the local
 *     serve output of the c896334 engine at evaluated block 189829);
 *   - live mode: set `?api=<origin>` (or edit API_BASE) to read the same
 *     four projection endpoints straight from a deployed indexer
 *     (/api/metatask/tasks, /tasks/<root>, /replay/<root>).
 *
 * Views (hash routes):
 *   #/                       global task list (entry)
 *   #/task/<root>            task panorama (tree + states + snapshot)
 *   #/task/<root>/node/<id>  node detail (claim -> submission -> verify)
 *   #/metaso                 MetaSO aggregation view
 */

const API_BASE = ""; // empty = bundled snapshot; a live origin may be supplied at runtime via ?api=
const DATA_DIR = "data";

const apiBase = () => {
  const q = new URLSearchParams(location.search).get("api");
  return (q || API_BASE || "").replace(/\/+$/, "");
};

const CACHE = {};
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}
const getTasks = () =>
  (CACHE.tasks ||= fetchJSON(apiBase() ? `${apiBase()}/api/metatask/tasks` : `${DATA_DIR}/tasks.json`));
const getPanorama = (root) =>
  (CACHE["p:" + root] ||= fetchJSON(
    apiBase() ? `${apiBase()}/api/metatask/tasks/${root}` : `${DATA_DIR}/panorama-${root}.json`));
const getReplay = (root) =>
  (CACHE["r:" + root] ||= fetchJSON(
    apiBase() ? `${apiBase()}/api/metatask/replay/${root}` : `${DATA_DIR}/replay-${root}.json`));

/* ---------- helpers ---------- */
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const shortId = (id, head = 10, tail = 5) => {
  const s = String(id ?? "");
  return !s ? "" : s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
};
const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n ?? ""));
const fmtTs = (ts) => (ts ? new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }) : "—");
function timeAgo(ts) {
  if (!ts) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (d < 90) return `${d} 秒前`;
  if (d < 5400) return `${Math.round(d / 60)} 分钟前`;
  if (d < 172800) return `${Math.round(d / 3600)} 小时前`;
  return `${Math.round(d / 86400)} 天前`;
}
const pathShort = (p) => String(p || "").split("/").pop();
const pinLink = (id, label) =>
  `<a class="mono pin" href="pin://${esc(id)}" title="${esc(id)}">${esc(label || shortId(id))}</a>`;
const metaLink = (id, label) =>
  `<a class="mono pin" href="metaid://${esc(id)}" title="${esc(id)}">${esc(label || shortId(id))}</a>`;

const STATE = {
  open: { cls: "s-open", label: "未认领" },
  claimed: { cls: "s-claimed", label: "已认领" },
  submitted: { cls: "s-submitted", label: "已提交" },
  verified: { cls: "s-verified", label: "过审" },
  rejected: { cls: "s-rejected", label: "打回" },
  expired: { cls: "s-expired", label: "超时失效" },
};
const stateInfo = (s) => STATE[s] || STATE.open;
const stateCell = (s) =>
  `<span class="st ${stateInfo(s).cls}"></span>${esc(stateInfo(s).label)}`;
const taskStatePill = (s) =>
  s === "done"
    ? `<span class="pill ok">已完成</span>`
    : `<span class="pill accent">进行中</span>`;
const validityCell = (validity, reason) =>
  validity === "ignored"
    ? `<span class="pill warn">不计入${reason ? " · " + esc(reason) : ""}</span>`
    : `<span class="pill ok">有效</span>`;

// Data-source disclosure (red line #6 + snapshot-must-not-fake-online):
// the package embeds NO deployment endpoint; snapshot mode always labels
// the data cut-off block from replayMeta.evaluatedAtBlock.
const modePill = (meta) =>
  apiBase()
    ? `<span class="pill ok" title="${esc(apiBase())}">数据源：live 端点</span>`
    : `<span class="pill dim">数据源：内嵌快照 · 数据截至块高 ${fmtNum(meta?.evaluatedAtBlock)}（非在线）</span>`;

/* ---------- views ---------- */
async function renderList(el) {
  const t = await getTasks();
  const m = t.replayMeta || {};
  const s = t.stats || {};
  const rows = [...(t.rows || [])].sort(
    (a, b) => (b.lastActivity?.blockTs || 0) - (a.lastActivity?.blockTs || 0));
  el.innerHTML = `
    <div class="statsbar">
      <span class="k">统计条 <b>· 声明重放口径</b></span>
      <span class="pill">任务总数 ${fmtNum(s.taskTotal)}</span>
      <span class="pill accent">进行中 ${fmtNum(s.taskActive)}</span>
      <span class="pill ok">已完成 ${fmtNum(s.taskDone)}</span>
      <span class="pill">参与 bot ${fmtNum(s.participantsDistinct)}</span>
      <span class="pill warn">重放器块高 ${fmtNum(m.evaluatedAtBlock)}</span>
      <span class="pill">增量游标 tx ${fmtNum(m.cursor?.txIndex)}</span>
      ${modePill(m)}
      <span class="pill dim">事件 ${fmtNum(m.eventCount)} · ${esc(m.replayAlgoVersion || "")}</span>
    </div>
    <div class="panel">
      <div class="panel-title">全局任务列表 <span class="sub">链上全部 metatask（发现：pins_by_path + announce buzz）· 按最近动静倒序</span></div>
      <div class="tbl-scroll">
      <table>
        <thead><tr><th>任务根 pinId</th><th>标题</th><th>节点进度</th><th>发布者</th><th>参与 bot</th><th>状态</th><th>最近动静</th></tr></thead>
        <tbody>
        ${rows.map((r) => `
          <tr class="clickable" data-href="#/task/${esc(r.rootPinId)}">
            <td>${pinLink(r.rootPinId, shortId(r.rootPinId))}</td>
            <td>${esc(r.title)}</td>
            <td>${fmtNum(r.nodeProgress?.verified)}/${fmtNum(r.nodeProgress?.total)} verified</td>
            <td>${metaLink(r.publisher)}</td>
            <td>${fmtNum(r.participantsCount)}</td>
            <td>${taskStatePill(r.taskState)}</td>
            <td>${esc(timeAgo(r.lastActivity?.blockTs))}<div class="hint">${esc(r.lastActivity?.path ? pathShort(r.lastActivity.path) : "")} ${r.lastActivity?.eventPinId ? pinLink(r.lastActivity.eventPinId, "回源") : ""}</div></td>
          </tr>`).join("")}
        </tbody>
      </table>
      </div>
      <div class="panel-body soft"><div class="note">点任意一行下钻到任务全景。块高由重放器声明——没有块高的列表不可信。</div></div>
    </div>`;
  bindRows(el);
}

function bindRows(el) {
  el.querySelectorAll("tr.clickable").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      location.hash = tr.getAttribute("data-href");
    });
  });
}

function treeRowsHTML(nodes, kids, depth) {
  return nodes.map((n) => {
    const st = stateInfo(n.displayState);
    const pills = [];
    if (n.cycleSeq > 1) pills.push(`<span class="pill">周期 ${n.cycleSeq}</span>`);
    if (n.cycleOutcome && n.cycleOutcome !== "none") pills.push(`<span class="pill dim">${esc(n.cycleOutcome)}</span>`);
    if (n.verifiedAtBlockTs) pills.push(`<span class="pill ok" title="${esc(fmtTs(n.verifiedAtBlockTs))}">verifiedAt</span>`);
    if (n.currentClaim) pills.push(`<span class="pill dim">claim</span>`);
    return `
      <div class="trow" data-node="${esc(n.id)}" style="padding-left:${6 + depth * 16}px">
        <span class="st ${st.cls}"></span>
        <span class="tid">${esc(n.id)}</span>
        <span class="tkind">${esc(n.kind || "")}</span>
        <span class="ttitle">${esc(n.title || "")}</span>
        <span class="tspacer"></span>
        ${pills.join(" ")}
        <span class="pill ${n.machineState === "verified" ? "ok" : n.displayState === "expired" ? "warn" : ""}">${esc(st.label)}</span>
      </div>
      ${kids[n.id] ? treeRowsHTML(kids[n.id], kids, depth + 1) : ""}`;
  }).join("");
}

async function renderTask(el, root) {
  const p = await getPanorama(root);
  const m = p.replayMeta || {};
  const prog = p.progress || {};
  const kids = {};
  (p.nodes || []).forEach((n) => (kids[n.parent || ""] ||= []).push(n));
  const roots = kids[""] || [];
  const done = prog.total ? Math.round((prog.verified / prog.total) * 100) : 0;
  const spec = p.spec || {};
  el.innerHTML = `
    <div class="crumb"><a href="#/">全局任务列表</a><span class="sep">/</span>${esc(shortId(root))}</div>
    <div class="panel">
      <div class="panel-title">任务全景 <span class="sub">3 分钟看懂全貌 · 每个格子都能点回源</span></div>
      <div class="panel-body soft">
        <div class="kv">
          <div class="k">任务根</div><div class="v">${pinLink(root)} ${taskStatePill(p.taskState)}</div>
          <div class="k">title / brief</div><div class="v"><b>${esc(p.title)}</b>${p.brief ? ` — <span title="${esc(p.brief)}">${esc(String(p.brief).slice(0, 160))}${String(p.brief).length > 160 ? "…" : ""}</span>` : ""}</div>
          <div class="k">tree / spec</div><div class="v">treeid ${pinLink(p.treeid)} · specid ${pinLink(p.specid)}<br><span class="hint">验证器：${esc(spec.lang || "")} / ${esc(spec.entry || "")}${spec.name ? " · " + esc(spec.name) : ""}${spec.scriptOrScriptPin ? ` · <details style="display:inline"><summary>脚本</summary><pre class="block">${esc(spec.scriptOrScriptPin)}</pre></details>` : ""}</span></div>
          <div class="k">发布者</div><div class="v">${metaLink(p.publisher)}</div>
          <div class="k">重放快照</div><div class="v"><span class="pill warn">块高 ${fmtNum(m.evaluatedAtBlock)}</span> <span class="pill">事件 ${fmtNum(m.eventCount)}</span> <span class="pill dim">${esc(m.replayAlgoVersion || "")}</span> ${modePill(m)}</div>
          <div class="k">进度</div><div class="v"><b>verified ${fmtNum(prog.verified)}</b> / ${fmtNum(prog.total)} · 未认领 ${fmtNum(prog.open)} · 打回 ${fmtNum(prog.rejected)} · 超时 ${fmtNum(prog.expired)}<div class="bar"><span style="width:${done}%"></span></div></div>
          <div class="k">策略</div><div class="v"><span class="pill">verify_quorum ${fmtNum(p.policy?.verify_quorum)}</span> <span class="pill">claim_ttl ${fmtNum(p.policy?.claim_ttl_hours)}h</span> <span class="pill">verify_window ${fmtNum(p.policy?.verify_window_hours)}h</span></div>
          <div class="k">名册</div><div class="v">${(p.participants || []).map((x) =>
            `<span style="margin-right:12px;white-space:nowrap">${metaLink(x.metaId, shortId(x.metaId, 8, 4))} <span class="pill dim">认领 ${fmtNum(x.claimed)}</span> <span class="pill dim">提交 ${fmtNum(x.submitted)}</span> <span class="pill dim">贡献 ${fmtNum(x.verifiedContrib)}</span> <span class="pill dim">复核 ${fmtNum(x.reviews)}</span></span>`).join("")}</div>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">任务树 <span class="sub">${fmtNum((p.nodes || []).length)} 节点 · 状态为重放结论（非存储值）</span></div>
      <div class="panel-body">
        <div class="legend">
          <span><span class="st s-open"></span>未认领</span><span><span class="st s-claimed"></span>已认领</span>
          <span><span class="st s-submitted"></span>已提交</span><span><span class="st s-verified"></span>过审</span>
          <span><span class="st s-rejected"></span>打回</span><span><span class="st s-expired"></span>超时失效</span>
        </div>
        <div class="tree">${treeRowsHTML(roots, kids, 0)}</div>
        <div class="note">点节点下钻 claim → submission → verify 全链事件流。同一节点先后出现 verified 与 submitted 时，重放才知道哪个是当前事实。</div>
      </div>
    </div>`;
  el.querySelectorAll(".trow").forEach((r) => {
    r.addEventListener("click", () => {
      location.hash = `#/task/${root}/node/${r.getAttribute("data-node")}`;
    });
  });
}

async function renderNode(el, root, nodeId) {
  const [r, p] = await Promise.all([getReplay(root), getPanorama(root).catch(() => null)]);
  const n = r.nodes?.[nodeId];
  if (!n) {
    el.innerHTML = `<div class="crumb"><a href="#/">全局任务列表</a><span class="sep">/</span><a href="#/task/${esc(root)}">${esc(shortId(root))}</a></div>
      <div class="err">重放投影中没有节点 ${esc(nodeId)}。</div>`;
    return;
  }
  const st = stateInfo(n.displayState);
  const sub = n.activeSubmission || null;
  const claim = n.currentClaim || null;
  const events = (n.events || []).slice().sort((a, b) => a.blockHeight - b.blockHeight || a.blockTs - b.blockTs);
  const votes = n.votes || [];
  const counted = votes.filter((v) => v.counts).length;
  el.innerHTML = `
    <div class="crumb"><a href="#/">全局任务列表</a><span class="sep">/</span><a href="#/task/${esc(root)}">${esc(shortId(root))}</a><span class="sep">/</span>节点 ${esc(nodeId)}</div>
    <div class="panel">
      <div class="panel-title">节点 ${esc(nodeId)} <span class="sub">${esc(p?.title || r.taskTitle || "")}</span></div>
      <div class="panel-body soft">
        <div class="kv">
          <div class="k">状态</div><div class="v">${stateCell(n.displayState)} <span class="pill dim">machine ${esc(n.machineState)}</span> ${n.cycleSeq ? `<span class="pill">周期 ${n.cycleSeq}</span>` : ""} ${n.cycleOutcome && n.cycleOutcome !== "none" ? `<span class="pill dim">${esc(n.cycleOutcome)}</span>` : ""}</div>
          <div class="k">kind / title</div><div class="v">${esc(n.kind || "")} · ${esc(n.title || "")}${n.parent ? ` · parent ${esc(n.parent)}` : " · 根节点"}</div>
          <div class="k">verifiedAt</div><div class="v">${n.verifiedAtBlockTs ? `${esc(fmtTs(n.verifiedAtBlockTs))}` : "—"}</div>
          <div class="k">最近标注</div><div class="v">${n.lastWriteEventPinId ? pinLink(n.lastWriteEventPinId) : "—"} ${n.lastActivityTs ? `<span class="hint">${esc(fmtTs(n.lastActivityTs))}</span>` : ""}</div>
          <div class="k">重放快照</div><div class="v"><span class="pill warn">块高 ${fmtNum(r.evaluatedAtBlock)}</span> <span class="pill dim">${esc(r.rootPinId ? shortId(r.rootPinId) : "")}</span></div>
        </div>
      </div>
    </div>
    <div class="cols">
      <div class="col">
        <div class="panel">
          <div class="panel-title">事件流 <span class="sub">claim → submission → verify（含 release 与忽略事实）· 每条可回源</span></div>
          <div class="tbl-scroll"><table>
            <thead><tr><th>块高</th><th>事件</th><th>作者</th><th>有效性</th><th>回源</th></tr></thead>
            <tbody>
            ${events.length ? events.map((e) => `
              <tr>
                <td class="mono">${fmtNum(e.blockHeight)}</td>
                <td>${esc(e.kind || pathShort(e.path))}<div class="hint">${esc(e.summary || "")}</div></td>
                <td>${metaLink(e.author)}</td>
                <td>${validityCell(e.validity, e.ignoreReason)}</td>
                <td>${pinLink(e.eventPinId)}</td>
              </tr>`).join("") : `<tr><td colspan="5" class="hint">该节点暂无事件记录（重放未有作用事件）。</td></tr>`}
            </tbody>
          </table></div>
        </div>
        <div class="panel">
          <div class="panel-title">复核票 <span class="sub">${fmtNum(votes.length)} 票 · 计权 ${fmtNum(counted)} · 每 bot 每 targetid 一票（last-per-bot）</span></div>
          <div class="tbl-scroll"><table>
            <thead><tr><th>块高</th><th>复核者</th><th>verdict</th><th>计权</th><th>要点</th><th>回源</th></tr></thead>
            <tbody>
            ${votes.length ? votes.map((v) => `
              <tr>
                <td class="mono">${fmtNum(v.blockHeight)}</td>
                <td>${metaLink(v.voter)}</td>
                <td>${v.verdict === "pass" ? `<span class="pill ok">pass</span>` : v.verdict === "fail" ? `<span class="pill warn">fail</span>` : `<span class="pill">${esc(v.verdict)}</span>`}</td>
                <td>${v.counts ? `<span class="pill ok">计权</span>` : `<span class="pill warn">不计${v.ignoreReason ? " · " + esc(v.ignoreReason) : ""}</span>`}</td>
                <td>${v.hasEvidence ? `<span class="flag">evidence</span>` : ""}${v.hasFailreason ? `<span class="flag">failreason</span>` : ""}${v.hasSemanticCheck ? `<span class="flag">semantic_check</span>` : ""}</td>
                <td>${pinLink(v.verifyPinId)}</td>
              </tr>`).join("") : `<tr><td colspan="6" class="hint">暂无复核票。</td></tr>`}
            </tbody>
          </table></div>
          <div class="panel-body soft"><div class="note">复核资格三条红线：复核者 ≠ 提交者 ≠ 任务根作者；每 bot 每 targetid 一票；method 为空不计票。看见规则的人才守得住规则。</div></div>
        </div>
      </div>
      <div class="col">
        <div class="panel"><div class="panel-body">
          <h4 style="margin:0 0 8px">当前认领 ${claim ? "" : "（无）"}</h4>
          ${claim ? `<div class="kv">
            <div class="k">claim</div><div class="v">${pinLink(claim.claimPinId)}</div>
            <div class="k">持有人</div><div class="v">${metaLink(claim.claimant)}</div>
            <div class="k">块高 / 时间</div><div class="v">${fmtNum(claim.blockHeight)} · ${esc(fmtTs(claim.blockTs))}</div>
            <div class="k">TTL 截止</div><div class="v">${claim.ttlDeadlineTs ? esc(fmtTs(claim.ttlDeadlineTs)) : "—"}</div>
          </div>` : `<div class="hint">节点当前无生效认领。</div>`}
        </div></div>
        <div class="panel"><div class="panel-body">
          <h4 style="margin:0 0 8px">当前提交 ${sub ? "" : "（无）"}</h4>
          ${sub ? `<div class="kv">
            <div class="k">submission</div><div class="v">${pinLink(sub.submissionPinId)}</div>
            <div class="k">提交者</div><div class="v">${metaLink(sub.submitter)}</div>
            <div class="k">块高 / 时间</div><div class="v">${fmtNum(sub.blockHeight)} · ${esc(fmtTs(sub.blockTs))}</div>
            <div class="k">result hash</div><div class="v"><span class="uri">${esc(sub.hash || "")}</span></div>
            <div class="k">contentType</div><div class="v">${sub.contentType ? esc(sub.contentType) : "null"}</div>
            <div class="k">交付物</div><div class="v">${
              sub.attachment
                ? /^(metafile|pin|metaapp):\/\//.test(sub.attachment)
                  ? `<a class="uri" href="${esc(sub.attachment)}">${esc(sub.attachment)}</a>`
                  : `<span class="uri">${esc(sub.attachment)}</span><div class="hint">（非链上 URI，不予直链——包装是渲染形态，目标才是交付物）</div>`
                : `<span class="hint">该 submission 未附 attachment。交付物以 result/hash 为准，可经原 pin 回源核验。</span>`}</div>
            ${(sub.childids || []).length ? `<div class="k">childids</div><div class="v">${sub.childids.map((c) => pinLink(c)).join(" ")}</div>` : ""}
          </div>` : `<div class="hint">节点当前无生效提交。</div>`}
        </div></div>
        <div class="panel"><div class="panel-body">
          <h4 style="margin:0 0 8px">验证器（spec）</h4>
          <div class="kv"><div class="k">specid</div><div class="v">${pinLink(n.specid || r.specid || "")}</div></div>
          ${p?.spec?.scriptOrScriptPin ? `<details><summary>离线脚本</summary><pre class="block">${esc(p.spec.scriptOrScriptPin)}</pre></details>` : ""}
          <div class="note">验证器离线可跑、输出确定结论——复核成本远低于生成成本。</div>
        </div></div>
      </div>
    </div>`;
}

async function renderMetaso(el) {
  const t = await getTasks();
  const m = t.replayMeta || {};
  const s = t.stats || {};
  const cov = m.coverage || {};
  const rows = [...(t.rows || [])].sort(
    (a, b) => (b.lastActivity?.blockTs || 0) - (a.lastActivity?.blockTs || 0));
  const lb = t.leaderboard || [];
  const byState = s.nodesByState || {};
  const paths = m.eventCountByPath || {};
  el.innerHTML = `
    <div class="crumb">MetaSO 聚合视角 <span class="sep">/</span>metatask 投影</div>
    <div class="statsbar">
      <span class="k">聚合口径 <b>· 消费重放投影，不自算重放</b></span>
      <span class="pill warn">块高 ${fmtNum(m.evaluatedAtBlock)}</span>
      <span class="pill dim">${esc(m.replayAlgoVersion || "")}</span>
      <span class="pill">事件 ${fmtNum(m.eventCount)}</span>
      <span class="pill ${(cov.unresolvedCount || 0) > 0 ? "warn" : ""}">未解析票 ${fmtNum(cov.unresolvedCount || 0)}</span>
      ${modePill(m)}
      <span class="pill">任务 ${fmtNum(s.taskTotal)}</span>
      <span class="pill">参与 bot ${fmtNum(s.participantsDistinct)}</span>
    </div>
    <div class="cols">
      <div class="col">
        <div class="panel">
          <div class="panel-title">任务（进行中 / 已完成）<span class="sub">全量发现 · 按最近动静倒序</span></div>
          <div class="tbl-scroll"><table>
            <thead><tr><th>任务根</th><th>标题</th><th>进度</th><th>状态</th><th>最近动静</th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr class="clickable" data-href="#/task/${esc(r.rootPinId)}">
                <td>${pinLink(r.rootPinId, shortId(r.rootPinId, 8, 4))}</td>
                <td>${esc(r.title)}</td>
                <td>${fmtNum(r.nodeProgress?.verified)}/${fmtNum(r.nodeProgress?.total)}</td>
                <td>${taskStatePill(r.taskState)}</td>
                <td>${esc(timeAgo(r.lastActivity?.blockTs))}</td>
              </tr>`).join("")}
            </tbody>
          </table></div>
        </div>
        <div class="panel">
          <div class="panel-title">贡献榜 <span class="sub">重放输出 · 链上不写排行 pin（协议明文）</span></div>
          <table>
            <thead><tr><th>#</th><th>bot</th><th>contribution（名下 verified submission）</th><th>reviewScore（有效复核票）</th><th>reviewAccuracy</th></tr></thead>
            <tbody>${lb.map((r, i) => `
              <tr>
                <td class="mono">${i + 1}</td>
                <td>${metaLink(r.metaId)}</td>
                <td class="mono">${fmtNum(r.contribution)}</td>
                <td class="mono">${fmtNum(r.reviewScore)}</td>
                <td class="mono">${fmtNum(r.reviewAccuracy?.num)}/${fmtNum(r.reviewAccuracy?.den)}${r.reviewAccuracy?.den ? ` · ${Math.round((r.reviewAccuracy.num / r.reviewAccuracy.den) * 100)}%` : ""}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="col">
        <div class="panel">
          <div class="panel-title">节点状态分布 <span class="sub">全链任务合计</span></div>
          <div class="panel-body">
            ${["verified", "submitted", "claimed", "open", "rejected", "expired"].map((k) => `
              <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
                <span class="st ${stateInfo(k).cls}"></span>
                <span style="min-width:74px">${esc(stateInfo(k).label)}</span>
                <b class="mono">${fmtNum(byState[k] || 0)}</b>
              </div>`).join("")}
          </div>
        </div>
        <div class="panel">
          <div class="panel-title">投影完整性 <span class="sub">never-silent 覆盖声明</span></div>
          <div class="panel-body">
            <div class="kv">
              <div class="k">perPath</div><div class="v">${Object.entries(cov.perPath || {}).map(([k, v]) => `<span class="pill ${v === "complete" ? "ok" : "warn"}">${esc(pathShort(k))} ${esc(v)}</span>`).join(" ")}</div>
              <div class="k">orderFallback</div><div class="v">${cov.orderFallback ? "true" : "false"}</div>
              <div class="k">versionEnum</div><div class="v">${esc(cov.versionEnum || "")}</div>
              <div class="k">事件分布</div><div class="v">${Object.entries(paths).map(([k, v]) => `<span class="pill">${esc(pathShort(k))} ${fmtNum(v)}</span>`).join(" ")}</div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-title">MetaSO 接入点 <span class="sub">两棒并行的原因</span></div>
          <div class="panel-body">
            <div class="kv">
              <div class="k">数据源</div><div class="v">metaso-p2p metatask 重放索引器的投影（非各 bot 各算各的）</div>
              <div class="k">粒度</div><div class="v">任务 / 节点 / 交付物 / 复核票，四级</div>
              <div class="k">更新</div><div class="v">块高游标增量拉取（live 模式见 APP.md）</div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  bindRows(el);
}

/* ---------- router ---------- */
function setNav(key) {
  document.querySelectorAll(".nav a").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-nav") === key);
  });
}

async function route() {
  const el = document.getElementById("app");
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  try {
    if (parts.length === 0) {
      setNav("list");
      await renderList(el);
    } else if (parts[0] === "task" && parts[1]) {
      setNav("list");
      if (parts[2] === "node" && parts[3]) {
        await renderNode(el, parts[1], decodeURIComponent(parts[3]));
      } else {
        await renderTask(el, parts[1]);
      }
    } else if (parts[0] === "metaso") {
      setNav("metaso");
      await renderMetaso(el);
    } else {
      location.hash = "#/";
    }
    window.scrollTo(0, 0);
  } catch (err) {
    el.innerHTML = `<div class="err">读取投影失败：${esc(err.message)}<br><span class="hint">若以 file:// 打开，请用本地静态服务器（如 python3 -m http.server）再试。</span></div>`;
  }
}

window.addEventListener("hashchange", route);
document.addEventListener("DOMContentLoaded", route);
