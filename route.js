// DV RemoteDispatch - route.js
// 纯函数库：轨道图构建、Dijkstra 寻路、hop 解析（道岔重分类）、途径道岔计算、
// 裁切式路线坐标拼接、真实端口拓扑寻路、取景 padding 与列表工具。
// 无任何浏览器/DOM 依赖。整体包入 IIFE：经典 <script> 加载时不向共享的全局词法
// 环境泄漏任何顶层 const/let/function（main.js 亦有顶层 const metersToDegrees 等，
// 同名声明会令 main.js 抛 SyntaxError 整体加载失败），只暴露全局 RouteLib 一个绑定；
// Node 环境下经 module.exports 可被 require 用于单元测试（tests/route.test.js）。
(function (global) {
'use strict';

const metersToDegrees = 360 / 40e6;              // 1 米 ≈ 9e-6 度（地球平均周长近似）
const DEFAULT_EPSILON_DEG = 3 * metersToDegrees; // 默认吸附半径：3 米 ≈ 2.7e-5 度

function resolveEpsilonDeg(epsilonDeg) {
  return (typeof epsilonDeg === 'number' && epsilonDeg > 0)
    ? epsilonDeg
    : DEFAULT_EPSILON_DEG;
}

// 两点（[lat,lon]）欧氏距离，单位：度
function pointDistanceDeg(a, b) {
  const dLat = a[0] - b[0];
  const dLon = a[1] - b[1];
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// 折线端点列表（首、尾；单点轨只有首）
function trackEndpointList(coords) {
  if (!coords || coords.length === 0) return [];
  if (coords.length === 1) return [coords[0]];
  return [coords[0], coords[coords.length - 1]];
}

// 折线长度：逐段欧氏距离累加，单位：度
function polylineLengthDeg(coords) {
  if (!coords || coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += pointDistanceDeg(coords[i - 1], coords[i]);
  }
  return total;
}

/**
 * 构建轨道邻接图。
 * @param {Object} tracks     {trackId: [[lat,lon],...]}
 * @param {Array}  junctions  [{position:[lat,lon], branches:[trackId,trackId]}]，数组索引即道岔 id
 * @param {number} [epsilonDeg] 吸附半径（度），可覆盖默认 3 米
 * @returns {Map<trackId, Array<{to, viaJunction, length}>>}
 *   连接规则：
 *   ① 任两条 track 的端点（首/尾）间距 < ε → 相连，viaJunction = null（端点吸附）；
 *   ② 每个道岔：branches 内 track + 任一端点落在 position ε 邻域内的 track（引入轨）
 *      构成团（两两相连），viaJunction = 道岔索引。
 *   同一对 track 若同时存在规则①边与规则②边，保留规则②边；
 *   去重：同一对 track、同一 viaJunction 仅保留一条。
 *   length = 进入目标 track 的折线长度（度），供 findRoute 作边权。
 */
function buildTrackGraph(tracks, junctions, epsilonDeg) {
  const eps = resolveEpsilonDeg(epsilonDeg);
  const junctionList = junctions || [];
  const graph = new Map();    // trackId -> 边数组
  const lengths = new Map();  // trackId -> 折线长度（度）
  const endpoints = new Map();// trackId -> [首端点, 尾端点]
  const trackIds = Object.keys(tracks || {});

  for (const id of trackIds) {
    graph.set(id, []);
    const coords = tracks[id] || [];
    lengths.set(id, polylineLengthDeg(coords));
    endpoints.set(id, trackEndpointList(coords));
  }

  const edgeSeen = new Set();            // 去重：同一对 + 同一 viaJunction 只一条
  const junctionLinkedPairs = new Set(); // 已有规则②边的 track 对（抑制规则①空边）

  function pairKey(a, b) {
    return a < b ? a + '\u0001' + b : b + '\u0001' + a;
  }

  function addEdge(a, b, viaJunction) {
    const pk = pairKey(a, b);
    const key = pk + '\u0002' + (viaJunction === null ? -1 : viaJunction);
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    if (viaJunction !== null) junctionLinkedPairs.add(pk);
    graph.get(a).push({ to: b, viaJunction: viaJunction, length: lengths.get(b) });
    graph.get(b).push({ to: a, viaJunction: viaJunction, length: lengths.get(a) });
  }

  // 规则②：道岔团（先处理，保证规则②边优先于规则①空边）
  for (let jid = 0; jid < junctionList.length; jid++) {
    const junction = junctionList[jid];
    if (!junction || !junction.position || !junction.branches) continue;
    const members = [];
    const memberSeen = new Set();
    for (const tid of junction.branches) {
      if (graph.has(tid) && !memberSeen.has(tid)) {
        memberSeen.add(tid);
        members.push(tid);
      }
    }
    for (const tid of trackIds) {
      if (memberSeen.has(tid)) continue;
      const epsOfTrack = endpoints.get(tid);
      for (let k = 0; k < epsOfTrack.length; k++) {
        if (pointDistanceDeg(epsOfTrack[k], junction.position) < eps) {
          memberSeen.add(tid);
          members.push(tid);
          break;
        }
      }
    }
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        addEdge(members[i], members[j], jid);
      }
    }
  }

  // 规则①：端点吸附（viaJunction = null）
  for (let i = 0; i < trackIds.length; i++) {
    for (let j = i + 1; j < trackIds.length; j++) {
      const a = trackIds[i];
      const b = trackIds[j];
      if (junctionLinkedPairs.has(pairKey(a, b))) continue;
      const ea = endpoints.get(a);
      const eb = endpoints.get(b);
      let snapped = false;
      for (let x = 0; x < ea.length && !snapped; x++) {
        for (let y = 0; y < eb.length; y++) {
          if (pointDistanceDeg(ea[x], eb[y]) < eps) {
            snapped = true;
            break;
          }
        }
      }
      if (snapped) addEdge(a, b, null);
    }
  }

  return graph;
}

/**
 * Dijkstra 最短路。
 * @param {Map}    graph        buildTrackGraph 产物（边含 length = 进入目标 track 的折线长度）
 * @param {string} startTrackId 起点 track
 * @param {string} destTrackId  终点 track
 * @returns {string[]|null} 途经 trackId 顺序数组；start === dest → [start]；
 *                          start/dest 不在图或无连通 → null。
 */
function findRoute(graph, startTrackId, destTrackId) {
  if (!graph || !graph.has(startTrackId) || !graph.has(destTrackId)) return null;
  if (startTrackId === destTrackId) return [startTrackId];

  const dist = new Map();    // trackId -> 已知最短累计长度
  const prev = new Map();    // trackId -> 前驱 trackId
  const settled = new Set(); // 已定稿节点

  // 小顶堆：元素 [累计长度, trackId]
  const heap = [];
  function heapPush(d, id) {
    heap.push([d, id]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  }
  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
        i = m;
      }
    }
    return top;
  }

  dist.set(startTrackId, 0);
  heapPush(0, startTrackId);

  while (heap.length > 0) {
    const popped = heapPop();
    const d = popped[0];
    const id = popped[1];
    if (d > dist.get(id)) continue; // 过期堆条目
    if (settled.has(id)) continue;
    settled.add(id);
    if (id === destTrackId) break;
    const edges = graph.get(id) || [];
    for (const e of edges) {
      if (!graph.has(e.to) || settled.has(e.to)) continue;
      const w = (typeof e.length === 'number' && e.length > 0) ? e.length : 0;
      const nd = d + w;
      if (!dist.has(e.to) || nd < dist.get(e.to)) {
        dist.set(e.to, nd);
        prev.set(e.to, id);
        heapPush(nd, e.to);
      }
    }
  }

  if (!settled.has(destTrackId)) return null;

  const route = [];
  let cur = destTrackId;
  for (;;) {
    route.push(cur);
    if (cur === startTrackId) break;
    cur = prev.get(cur);
    if (cur === undefined) return null; // 理论不可达（防御）
  }
  route.reverse();
  return route;
}

// 点 p 到折线的最近投影：返回 {param, dist}
// param 为线性参数（整数 k = 顶点 k，小数部分 = 沿线段 k→k+1 的比例）；dist 单位：度
function projectParamOnPolyline(coords, p) {
  if (!coords || coords.length === 0) return { param: 0, dist: Infinity };
  if (coords.length === 1) return { param: 0, dist: pointDistanceDeg(coords[0], p) };
  let bestParam = 0;
  let bestDist = Infinity;
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const abLat = b[0] - a[0];
    const abLon = b[1] - a[1];
    const lenSq = abLat * abLat + abLon * abLon;
    let t = 0;
    if (lenSq > 0) {
      t = ((p[0] - a[0]) * abLat + (p[1] - a[1]) * abLon) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const d = pointDistanceDeg([a[0] + abLat * t, a[1] + abLon * t], p);
    if (d < bestDist) {
      bestDist = d;
      bestParam = i + t;
    }
  }
  return { param: bestParam, dist: bestDist };
}

// 折线上 param 处的插值点（克隆返回，不引用原顶点）
function pointAtParam(coords, param) {
  const last = coords.length - 1;
  if (param <= 0) return [coords[0][0], coords[0][1]];
  if (param >= last) return [coords[last][0], coords[last][1]];
  const i = Math.floor(param);
  const t = param - i;
  const a = coords[i];
  const b = coords[i + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// 两条 track 端点列表中距离最近的一对端点 → [[lat,lon],[lat,lon]] 或 null
function closestEndpointPair(fromCoords, toCoords) {
  const ea = trackEndpointList(fromCoords);
  const eb = trackEndpointList(toCoords);
  let best = null;
  let bestDist = Infinity;
  for (let x = 0; x < ea.length; x++) {
    for (let y = 0; y < eb.length; y++) {
      const d = pointDistanceDeg(ea[x], eb[y]);
      if (d < bestDist) {
        bestDist = d;
        best = [ea[x], eb[y]];
      }
    }
  }
  return best;
}

// 查 graph 中 from→to 的边；道岔边优先于吸附边
function findGraphEdge(graph, from, to) {
  const edges = graph ? graph.get(from) : null;
  if (!edges) return null;
  let junctionEdge = null;
  let snapEdge = null;
  for (const e of edges) {
    if (e.to !== to) continue;
    if (e.viaJunction === null || e.viaJunction === undefined) {
      if (!snapEdge) snapEdge = e;
    } else if (!junctionEdge) {
      junctionEdge = e;
    }
  }
  return junctionEdge || snapEdge;
}

// hop 的应选分支：后继 track 属于 branches 取后继，否则取前驱；都不是 → -1
function junctionBranchIndex(junction, from, to) {
  const ti = junction.branches.indexOf(to);
  if (ti !== -1) return ti;
  return junction.branches.indexOf(from);
}

/**
 * 解析路线相邻 track 对的连接（hop）列表。
 * @returns {Array<{from, to, kind, junctionId, branch, point}>}
 *   kind: 'junction'（point = 道岔 position 克隆，branch 为应选分支索引，无法判定为 -1）
 *         'snap'（point = 最近端点对中点；无坐标数据时 point = null）
 *   重分类：graph 边为吸附边、但连接点/两端点之一落在某道岔 position 的 ε 邻域、
 *   且 from/to 之一属于该道岔 branches → 改记 junction hop（junctionsForRoute 不再遗漏
 *   引入轨端点距道岔 position 超过 ε 而未被规则②收编的场景）。
 */
function buildRouteHops(routeTrackIds, tracks, junctions, graph, epsilonDeg) {
  const eps = resolveEpsilonDeg(epsilonDeg);
  const junctionList = junctions || [];
  const hops = [];
  if (!routeTrackIds) return hops;
  for (let i = 0; i + 1 < routeTrackIds.length; i++) {
    const from = routeTrackIds[i];
    const to = routeTrackIds[i + 1];
    const edge = findGraphEdge(graph, from, to);
    if (edge && edge.viaJunction !== null && edge.viaJunction !== undefined) {
      const junction = junctionList[edge.viaJunction];
      if (junction && junction.position && junction.branches) {
        hops.push({
          from: from, to: to, kind: 'junction', junctionId: edge.viaJunction,
          branch: junctionBranchIndex(junction, from, to),
          point: [junction.position[0], junction.position[1]],
        });
        continue;
      }
    }
    let point = null;
    let endA = null;
    let endB = null;
    if (tracks) {
      const pair = closestEndpointPair(tracks[from], tracks[to]);
      if (pair) {
        endA = pair[0];
        endB = pair[1];
        point = [(endA[0] + endB[0]) / 2, (endA[1] + endB[1]) / 2];
      }
    }
    if (point) {
      let reclassified = false;
      for (let jid = 0; jid < junctionList.length; jid++) {
        const junction = junctionList[jid];
        if (!junction || !junction.position || !junction.branches) continue;
        if (junction.branches.indexOf(from) === -1 && junction.branches.indexOf(to) === -1) continue;
        const d = Math.min(
          pointDistanceDeg(point, junction.position),
          pointDistanceDeg(endA, junction.position),
          pointDistanceDeg(endB, junction.position)
        );
        if (d < eps) {
          hops.push({
            from: from, to: to, kind: 'junction', junctionId: jid,
            branch: junctionBranchIndex(junction, from, to),
            point: [junction.position[0], junction.position[1]],
          });
          reclassified = true;
          break;
        }
      }
      if (reclassified) continue;
    }
    hops.push({ from: from, to: to, kind: 'snap', junctionId: -1, branch: -1, point: point });
  }
  return hops;
}

/**
 * 计算路线途经的道岔及应选分支。
 * @param {string[]} routeTrackIds 路线 track 顺序（findRoute 产物）
 * @param {Array}    junctions     道岔数组（索引即 id）
 * @param {Map}      graph         buildTrackGraph 产物
 * @param {Object}   [tracks]      {trackId: [[lat,lon],...]}；提供时启用 hop 重分类 +
 *                                 几何扫描兜底（遗漏修复），省略时退化为纯图边判定（旧行为）
 * @param {number}   [epsilonDeg]  吸附半径（度）
 * @returns {Array<{junctionId, branch}>} 按出现顺序输出，按 junctionId 去重（保留首次；
 *   同一道岔两次经过取不同分支属物理无解场景，保留首次）。
 *   相邻 track 对的边 viaJunction != null 且该对中存在属于此道岔 branches 的 track 时：
 *   branch = branches.indexOf(该 branch track)；两个都是 branch 时取后继 track 的索引。
 *   几何扫描兜底：道岔未被 hop 记录、但其某条 branch 在路线中、路线几何经过其 position
 *   ε 邻域、且该 branch 有端点距 position < 4ε → 补录该 branch。
 */
function junctionsForRoute(routeTrackIds, junctions, graph, tracks, epsilonDeg) {
  const result = [];
  if (!routeTrackIds || routeTrackIds.length < 2) return result;
  const junctionList = junctions || [];
  const seen = new Set();

  if (!tracks) {
    for (let i = 0; i + 1 < routeTrackIds.length; i++) {
      const from = routeTrackIds[i];
      const to = routeTrackIds[i + 1];
      const edges = graph ? graph.get(from) : null;
      if (!edges) continue;
      for (const e of edges) {
        if (e.to !== to) continue;
        const jid = e.viaJunction;
        if (jid === null || jid === undefined) continue;
        const junction = junctionList[jid];
        if (!junction || !junction.branches) continue;
        let branchTrack = null;
        if (junction.branches.indexOf(to) !== -1) branchTrack = to;
        else if (junction.branches.indexOf(from) !== -1) branchTrack = from;
        else continue;
        if (seen.has(jid)) continue;
        seen.add(jid);
        result.push({ junctionId: jid, branch: junction.branches.indexOf(branchTrack) });
      }
    }
    return result;
  }

  const eps = resolveEpsilonDeg(epsilonDeg);
  const hops = buildRouteHops(routeTrackIds, tracks, junctionList, graph, eps);
  for (const hop of hops) {
    if (hop.kind !== 'junction') continue;
    if (hop.junctionId < 0 || hop.branch < 0) continue;
    if (seen.has(hop.junctionId)) continue;
    seen.add(hop.junctionId);
    result.push({ junctionId: hop.junctionId, branch: hop.branch });
  }

  // 几何扫描兜底：hop 解析遗漏的道岔（如端点距 position 均超 ε 的数据缺口）
  const routeSet = new Set(routeTrackIds);
  for (let jid = 0; jid < junctionList.length; jid++) {
    if (seen.has(jid)) continue;
    const junction = junctionList[jid];
    if (!junction || !junction.position || !junction.branches) continue;
    const inRoute = junction.branches.filter(function (b) { return routeSet.has(b) && tracks[b]; });
    if (inRoute.length === 0) continue;
    let near = false;
    for (const tid of routeTrackIds) {
      const coords = tracks[tid];
      if (!coords || coords.length === 0) continue;
      if (projectParamOnPolyline(coords, junction.position).dist < eps) { near = true; break; }
    }
    if (!near) continue;
    let bestBranch = null;
    let bestDist = Infinity;
    for (const b of inRoute) {
      const eps2 = trackEndpointList(tracks[b]);
      for (let k = 0; k < eps2.length; k++) {
        const d = pointDistanceDeg(eps2[k], junction.position);
        if (d < bestDist) {
          bestDist = d;
          bestBranch = b;
        }
      }
    }
    if (bestBranch === null || bestDist >= eps * 4) continue;
    seen.add(jid);
    result.push({ junctionId: jid, branch: junction.branches.indexOf(bestBranch) });
  }
  return result;
}

/**
 * 按路线行进方向拼接各段坐标。
 * 本段起点靠近上一段终点则正向拼入，否则反转后拼入；首段正向。
 * 拼接处重复的连接点保留；返回新数组，不修改传入坐标。
 * @param {string[]} routeTrackIds 路线 track 顺序
 * @param {Object}   tracks        {trackId: [[lat,lon],...]}
 * @returns {Array<[lat,lon]>}
 */
function orientRouteCoords(routeTrackIds, tracks) {
  const result = [];
  let prevEnd = null;
  if (!routeTrackIds) return result;
  for (const id of routeTrackIds) {
    const coords = tracks ? tracks[id] : null;
    if (!coords || coords.length === 0) continue;
    let reversed = false;
    if (prevEnd !== null) {
      const dStart = pointDistanceDeg(prevEnd, coords[0]);
      const dEnd = pointDistanceDeg(prevEnd, coords[coords.length - 1]);
      reversed = dEnd < dStart;
    }
    if (reversed) {
      for (let i = coords.length - 1; i >= 0; i--) {
        result.push([coords[i][0], coords[i][1]]);
      }
      prevEnd = coords[0];
    } else {
      for (let i = 0; i < coords.length; i++) {
        result.push([coords[i][0], coords[i][1]]);
      }
      prevEnd = coords[coords.length - 1];
    }
  }
  return result;
}

/**
 * 裁切单条 track 折线：仅保留 entryPoint → exitPoint 之间的部分。
 * 连接点向折线线段投影取最近点切分（非仅顶点）；端帽替换为精确的连接点坐标，
 * 使相邻段共享同一顶点。entry/exit 为 null 时表示自由端（取离另一连接点更远的端点）。
 * 方向由入/出投影参数顺序决定。返回新数组，不修改传入坐标。
 * @param {Array<[lat,lon]>} coords
 * @param {?[lat,lon]} entryPoint
 * @param {?[lat,lon]} exitPoint
 * @returns {Array<[lat,lon]>}
 */
function sliceTrackPolyline(coords, entryPoint, exitPoint) {
  if (!coords || coords.length === 0) return [];
  if (coords.length === 1) return [[coords[0][0], coords[0][1]]];
  const lastParam = coords.length - 1;

  let a;
  let capStart;
  if (entryPoint) {
    a = projectParamOnPolyline(coords, entryPoint).param;
    capStart = [entryPoint[0], entryPoint[1]];
  } else if (exitPoint) {
    a = pointDistanceDeg(coords[0], exitPoint) > pointDistanceDeg(coords[lastParam], exitPoint)
      ? 0 : lastParam;
    capStart = pointAtParam(coords, a);
  } else {
    a = 0;
    capStart = pointAtParam(coords, 0);
  }

  let b;
  let capEnd;
  if (exitPoint) {
    b = projectParamOnPolyline(coords, exitPoint).param;
    capEnd = [exitPoint[0], exitPoint[1]];
  } else if (entryPoint) {
    b = pointDistanceDeg(coords[lastParam], entryPoint) > pointDistanceDeg(coords[0], entryPoint)
      ? lastParam : 0;
    capEnd = pointAtParam(coords, b);
  } else {
    b = lastParam;
    capEnd = pointAtParam(coords, lastParam);
  }

  let reversed = false;
  if (a > b) {
    const tp = a; a = b; b = tp;
    const tc = capStart; capStart = capEnd; capEnd = tc;
    reversed = true;
  }

  const deduped = [];
  function pushPt(p) {
    const q = deduped[deduped.length - 1];
    if (q && q[0] === p[0] && q[1] === p[1]) return;
    deduped.push(p);
  }
  pushPt(capStart);
  for (let k = Math.ceil(a); k <= Math.floor(b); k++) {
    pushPt([coords[k][0], coords[k][1]]);
  }
  pushPt(capEnd);
  if (reversed) deduped.reverse();
  return deduped;
}

/**
 * 裁切式路线坐标拼接（替代 orientRouteCoords 的主流程实现）。
 * 每段 track 仅在「入 hop 连接点 → 出 hop 连接点」之间绘制：道岔区重叠/回退几何被
 * 裁掉，hop 连接点（道岔 position 或吸附中点）作为精确顶点插入，消除折返毛刺。
 * 单 track 路线返回原折线全量拷贝；同一 track 重复出现按位置独立裁切。
 * @param {string[]} routeTrackIds 路线 track 顺序
 * @param {Object}   tracks        {trackId: [[lat,lon],...]}
 * @param {Map}      graph         buildTrackGraph 产物
 * @param {Array}    junctions     道岔数组（索引即 id）
 * @param {number}   [epsilonDeg]  吸附半径（度）
 * @returns {Array<[lat,lon]>}
 */
function assembleRouteCoords(routeTrackIds, tracks, graph, junctions, epsilonDeg) {
  const result = [];
  if (!routeTrackIds || !tracks) return result;
  const n = routeTrackIds.length;
  if (n === 0) return result;
  const hops = buildRouteHops(routeTrackIds, tracks, junctions, graph, epsilonDeg);
  for (let i = 0; i < n; i++) {
    const coords = tracks[routeTrackIds[i]];
    if (!coords || coords.length === 0) continue;
    const entryPoint = i === 0 ? null : (hops[i - 1] ? hops[i - 1].point : null);
    const exitPoint = i === n - 1 ? null : (hops[i] ? hops[i].point : null);
    const piece = sliceTrackPolyline(coords, entryPoint, exitPoint);
    for (const p of piece) {
      const q = result[result.length - 1];
      if (q && q[0] === p[0] && q[1] === p[1]) continue;
      result.push(p);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 真实端口拓扑（/topology）：轨道首尾端口 + 道岔输入/输出端口 + 直连端口。
// 与旧的按距离猜测 buildTrackGraph 并存，供前端优先使用真实数据。

function portKey(trackId, end) {
  return trackId + '\u0001' + end;
}

function portEndpoint(coords, end) {
  if (!coords || coords.length === 0) return null;
  return end === 'in' ? coords[0] : coords[coords.length - 1];
}

/**
 * 构建端口级轨道图。
 * 节点是 (trackId, 'in'|'out')；轨道自身 in↔out 可达，道岔只连接 in 与各 out
 * 分支，普通直连由 topology.links 提供。输出分支之间不再建立虚假直连。
 * @param {{coords:Object, junctions?:Array, links?:Array}} topology
 * @returns {{graph:Map, tracks:Object, junctions:Array}}
 */
function buildPortGraph(topology) {
  const tracks = (topology && topology.coords) || {};
  const junctions = (topology && topology.junctions) || [];
  const links = (topology && topology.links) || [];
  const graph = new Map();

  function ensureNode(key) {
    if (!graph.has(key)) graph.set(key, []);
  }
  function addDirected(a, b, edge) {
    ensureNode(a);
    ensureNode(b);
    graph.get(a).push(Object.assign({ to: b }, edge));
  }
  function addBoth(a, b, edge) {
    addDirected(a, b, edge);
    addDirected(b, a, edge);
  }

  for (const trackId of Object.keys(tracks)) {
    const coords = tracks[trackId] || [];
    const inKey = portKey(trackId, 'in');
    const outKey = portKey(trackId, 'out');
    ensureNode(inKey);
    ensureNode(outKey);
    const length = polylineLengthDeg(coords);
    addDirected(inKey, outKey, { kind: 'track', trackId: trackId, entry: 'in', exit: 'out', length: length });
    addDirected(outKey, inKey, { kind: 'track', trackId: trackId, entry: 'out', exit: 'in', length: length });
  }

  for (const link of links) {
    if (!link || !link.a || !link.b) continue;
    const a = portKey(link.a.track, link.a.end);
    const b = portKey(link.b.track, link.b.end);
    if (!graph.has(a) || !graph.has(b)) continue;
    addBoth(a, b, { kind: 'link' });
  }

  for (const junction of junctions) {
    if (!junction || !junction.in) continue;
    const inKey = portKey(junction.in.track, junction.in.end);
    if (!graph.has(inKey)) continue;
    for (let i = 0; i < (junction.branches || []).length; i++) {
      const branch = junction.branches[i];
      if (!branch) continue;
      const branchKey = portKey(branch.track, branch.end);
      if (!graph.has(branchKey)) continue;
      addBoth(inKey, branchKey, {
        kind: 'junction',
        junctionId: junction.id,
        branch: Number.isInteger(branch.branch) ? branch.branch : i,
      });
    }
  }

  return { graph: graph, tracks: tracks, junctions: junctions };
}

/**
 * 端口图最短路线。起点/终点任务只给出 trackId，因此两个端口都可作为进入/离开端。
 * @returns {{trackIds:string[], traversals:Array, junctions:Array}|null}
 */
function findPortRoute(portGraph, startTrackId, destTrackId) {
  if (!portGraph || !portGraph.tracks || !portGraph.graph)
    return null;
  if (!portGraph.tracks[startTrackId] || !portGraph.tracks[destTrackId])
    return null;
  if (startTrackId === destTrackId) {
    return {
      trackIds: [startTrackId],
      traversals: [{ trackId: startTrackId, entry: 'in', exit: 'out' }],
      junctions: [],
    };
  }

  const graph = portGraph.graph;
  const startPorts = [portKey(startTrackId, 'in'), portKey(startTrackId, 'out')];
  const dist = new Map();
  const prevNode = new Map();
  const prevEdge = new Map();
  const settled = new Set();
  const heap = [];

  function push(node, d) {
    heap.push([d, node]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  }
  function pop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
        i = m;
      }
    }
    return top;
  }

  for (const start of startPorts) {
    if (!graph.has(start)) continue;
    dist.set(start, 0);
    push(start, 0);
  }

  let targetNode = null;
  while (heap.length > 0) {
    const top = pop();
    const node = top[1];
    if (settled.has(node)) continue;
    if (top[0] > (dist.get(node) ?? Infinity)) continue;
    settled.add(node);
    const sep = node.indexOf('\u0001');
    const trackId = node.slice(0, sep);
    if (trackId === destTrackId) {
      targetNode = node;
      break;
    }
    for (const edge of (graph.get(node) || [])) {
      if (settled.has(edge.to)) continue;
      const w = edge.kind === 'track' ? edge.length : 0;
      const nd = top[0] + w;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prevNode.set(edge.to, node);
        prevEdge.set(edge.to, edge);
        push(edge.to, nd);
      }
    }
  }

  if (!targetNode) return null;

  const edges = [];
  let node = targetNode;
  while (prevEdge.has(node)) {
    edges.push(prevEdge.get(node));
    node = prevNode.get(node);
  }
  const startNode = node;
  edges.reverse();

  const traversals = [];
  const junctions = [];
  for (const edge of edges) {
    if (edge.kind === 'track') {
      traversals.push({ trackId: edge.trackId, entry: edge.entry, exit: edge.exit });
    } else if (edge.kind === 'junction') {
      junctions.push({ junctionId: edge.junctionId, branch: edge.branch });
    }
  }

  // The task names whole tracks, not ports. Include the start track from its
  // far end to the port where routing began, and the destination track from
  // the arrival port to its far end, so the drawn route covers both sidings.
  const startSep = startNode.indexOf('\u0001');
  const startTrack = startNode.slice(0, startSep);
  const startPort = startNode.slice(startSep + 1);
  if (traversals.length === 0 || traversals[0].trackId !== startTrack) {
    traversals.unshift({
      trackId: startTrack,
      entry: startPort === 'in' ? 'out' : 'in',
      exit: startPort,
    });
  }
  const targetSep = targetNode.indexOf('\u0001');
  const targetTrack = targetNode.slice(0, targetSep);
  const targetPort = targetNode.slice(targetSep + 1);
  if (traversals.length === 0 || traversals[traversals.length - 1].trackId !== targetTrack) {
    traversals.push({
      trackId: targetTrack,
      entry: targetPort,
      exit: targetPort === 'in' ? 'out' : 'in',
    });
  }

  const trackIds = [];
  for (const traversal of traversals) {
    if (trackIds[trackIds.length - 1] !== traversal.trackId)
      trackIds.push(traversal.trackId);
  }
  return { trackIds: trackIds, traversals: traversals, junctions: junctions };
}

/**
 * 按端口行进方向拼接真实曲线；不插入道岔图标坐标，只在相邻轨道端点存在
 * 间隙时以中点桥接，避免侧向尖刺。
 */
function assemblePortRouteCoords(route, tracks) {
  const result = [];
  if (!route || !tracks) return result;
  const traversals = route.traversals || [];
  if (traversals.length === 0) {
    const coords = route.trackIds && route.trackIds.length === 1 ? tracks[route.trackIds[0]] : null;
    if (!coords) return result;
    return coords.map(function (p) { return [p[0], p[1]]; });
  }

  function pushPoint(p) {
    if (!p) return;
    const q = result[result.length - 1];
    if (q && pointDistanceDeg(q, p) < 0.1 * metersToDegrees) return;
    result.push([p[0], p[1]]);
  }

  for (const traversal of traversals) {
    const coords = tracks[traversal.trackId];
    if (!coords || coords.length === 0) continue;
    const reversed = traversal.entry === 'out' && traversal.exit === 'in';
    const firstPoint = reversed ? coords[coords.length - 1] : coords[0];
    const previous = result[result.length - 1];
    if (previous && firstPoint) {
      const gap = pointDistanceDeg(previous, firstPoint);
      if (gap > 0.5 * metersToDegrees && gap < 5 * metersToDegrees) {
        result.push([
          (previous[0] + firstPoint[0]) / 2,
          (previous[1] + firstPoint[1]) / 2,
        ]);
      }
    }
    if (reversed) {
      for (let i = coords.length - 1; i >= 0; i--)
        pushPoint(coords[i]);
    } else {
      for (let i = 0; i < coords.length; i++)
        pushPoint(coords[i]);
    }
  }
  return result;
}

/**
 * 从端口路线提取道岔对。同一道岔若被要求不同分支，返回 conflicts 供调用者拒绝执行。
 * @returns {{pairs:Array<{junctionId:number,branch:number}>, conflicts:Array}}
 */
function junctionsForPortRoute(route) {
  const pairs = [];
  const conflicts = [];
  const byId = new Map();
  if (!route || !route.junctions) return { pairs: pairs, conflicts: conflicts };
  for (const junction of route.junctions) {
    if (!junction || !Number.isInteger(junction.junctionId) || !Number.isInteger(junction.branch))
      continue;
    if (!byId.has(junction.junctionId)) {
      const pair = { junctionId: junction.junctionId, branch: junction.branch };
      byId.set(junction.junctionId, pair);
      pairs.push(pair);
    } else if (byId.get(junction.junctionId).branch !== junction.branch) {
      conflicts.push({
        junctionId: junction.junctionId,
        expected: byId.get(junction.junctionId).branch,
        actual: junction.branch,
      });
    }
  }
  return { pairs: pairs, conflicts: conflicts };
}


function viewPaddingForSize(width, height, fraction) {
  const f = (typeof fraction === 'number' && fraction > 0 && fraction < 0.5) ? fraction : 0.125;
  return [Math.round(width * f), Math.round(height * f)];
}

/**
 * 主车组启发式：cars 最多的 task 索引（并列取先者）。
 * tasks 为空或全空 cars 时兜底返回 0。
 * @param {Array<{cars?: Array}>} tasks
 * @returns {number}
 */
function pickConsistTask(tasks) {
  if (!tasks || tasks.length === 0) return 0;
  let bestIndex = 0;
  let bestCount = -1;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const cars = task && task.cars ? task.cars : null;
    const count = cars ? cars.length : 0;
    if (count > bestCount) {
      bestCount = count;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * 中间车皮索引：Math.floor((count - 1) / 2)，即 1→0、2→0、3→1、4→1、5→2。
 * @param {number} count 车皮数
 * @returns {number}
 */
function middleCarIndex(count) {
  return Math.floor((count - 1) / 2);
}

/**
 * job 列表排序：置顶 jobId 在列表中则排最前，其余按 jobId localeCompare 升序；
 * 置顶 id 不在列表视同无置顶。返回新数组（元素原样、不变形），不修改原数组。
 * 列表元素形状兼容（main.js 传入 Map.entries() 快照）：
 *   ① [jobId, jobData] 二元组 → 取 e[0]；② {jobId} 对象 → 取 e.jobId。
 * @param {Array<[string, *]|{jobId: string}>} entries
 * @param {string} pinnedJobId
 * @returns {Array} 新数组（元素原样）
 */
// 取列表元素的排序键（jobId）；仅用于比较，元素本身不变形
function jobEntryKey(e) {
  return Array.isArray(e) ? e[0] : e.jobId;
}

function sortJobEntries(entries, pinnedJobId) {
  const list = (entries || []).slice();
  const hasPinned = pinnedJobId !== null && pinnedJobId !== undefined &&
    list.some(function (e) { return e && jobEntryKey(e) === pinnedJobId; });
  list.sort(function (a, b) {
    if (hasPinned) {
      if (jobEntryKey(a) === pinnedJobId) return -1;
      if (jobEntryKey(b) === pinnedJobId) return 1;
    }
    return String(jobEntryKey(a)).localeCompare(String(jobEntryKey(b)));
  });
  return list;
}

/**
 * 道岔对查询串序列化："12:1,34:0"。
 * 过滤非法项（junctionId/branch 非整数、junctionId < 0、branch < 0）；
 * 分支上限交给后端按真实 outBranches.Count 校验。
 * 全非法或空输入返回 ""。
 * @param {Array<{junctionId: number, branch: number}>} pairs
 * @returns {string}
 */
function formatJunctionPairs(pairs) {
  if (!pairs || pairs.length === 0) return '';
  const parts = [];
  for (const p of pairs) {
    if (!p) continue;
    const junctionId = p.junctionId;
    const branch = p.branch;
    if (!Number.isInteger(junctionId) || !Number.isInteger(branch)) continue;
    if (junctionId < 0) continue;
    if (branch < 0) continue;
    parts.push(junctionId + ':' + branch);
  }
  return parts.join(',');
}

const RouteLib = {
  buildTrackGraph: buildTrackGraph,
  findRoute: findRoute,
  junctionsForRoute: junctionsForRoute,
  orientRouteCoords: orientRouteCoords,
  buildRouteHops: buildRouteHops,
  assembleRouteCoords: assembleRouteCoords,
  buildPortGraph: buildPortGraph,
  findPortRoute: findPortRoute,
  assemblePortRouteCoords: assemblePortRouteCoords,
  junctionsForPortRoute: junctionsForPortRoute,
  viewPaddingForSize: viewPaddingForSize,
  pickConsistTask: pickConsistTask,
  middleCarIndex: middleCarIndex,
  sortJobEntries: sortJobEntries,
  formatJunctionPairs: formatJunctionPairs,
};

global.RouteLib = RouteLib;
if (typeof module !== 'undefined' && module.exports) module.exports = RouteLib;
})(typeof window !== 'undefined' ? window : globalThis);
