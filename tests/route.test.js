'use strict';

// DV RemoteDispatch - tests/route.test.js
// Node 内置 node:test，零依赖。运行：node --test tests/*.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert');

const RouteLib = require('../route.js');

// ---------------------------------------------------------------------------
// 0. 模块导出（CJS）
// ---------------------------------------------------------------------------
describe('模块导出（CJS）', () => {
  it('require("./route.js") 导出完整 API（含真实端口拓扑）', () => {
    const lib = require('../route.js');
    for (const name of [
      'buildTrackGraph', 'findRoute', 'junctionsForRoute', 'orientRouteCoords',
      'buildRouteHops', 'assembleRouteCoords', 'viewPaddingForSize',
      'pickConsistTask', 'middleCarIndex', 'sortJobEntries', 'formatJunctionPairs',
      'buildPortGraph', 'findPortRoute', 'assemblePortRouteCoords', 'junctionsForPortRoute',
    ]) {
      assert.strictEqual(typeof lib[name], 'function', 'RouteLib.' + name + ' 应为函数');
    }
  });
});

const M = m => m * 360 / 40e6; // 米 → 度（与 route.js 内部换算一致）

const EPS = 3 * 360 / 40e6; // 默认吸附半径（3 米对应的度数），与 route.js 内部一致

function dist(a, b) {
  const dLat = a[0] - b[0];
  const dLon = a[1] - b[1];
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function hasEdge(graph, from, to, viaJunction) {
  const edges = graph.get(from) || [];
  return edges.some(function (e) { return e.to === to && e.viaJunction === viaJunction; });
}

// 手工构造邻接图：adj = { id: [[to, length(进入 to 的折线长度), viaJunction?], ...] }
function makeGraph(adj) {
  const g = new Map();
  for (const id of Object.keys(adj)) {
    g.set(id, adj[id].map(function (e) {
      return { to: e[0], length: e[1], viaJunction: e.length > 2 ? e[2] : null };
    }));
  }
  return g;
}

// ---------------------------------------------------------------------------
// 1. middleCarIndex
// ---------------------------------------------------------------------------
describe('middleCarIndex', () => {
  it('1→0 / 2→0 / 3→1 / 4→1 / 5→2', () => {
    assert.strictEqual(RouteLib.middleCarIndex(1), 0);
    assert.strictEqual(RouteLib.middleCarIndex(2), 0);
    assert.strictEqual(RouteLib.middleCarIndex(3), 1);
    assert.strictEqual(RouteLib.middleCarIndex(4), 1);
    assert.strictEqual(RouteLib.middleCarIndex(5), 2);
  });
});

// ---------------------------------------------------------------------------
// 2. pickConsistTask
// ---------------------------------------------------------------------------
describe('pickConsistTask', () => {
  it('多 task 取 cars 最多者', () => {
    const tasks = [{ cars: ['a'] }, { cars: ['a', 'b', 'c'] }, { cars: ['a', 'b'] }];
    assert.strictEqual(RouteLib.pickConsistTask(tasks), 1);
  });

  it('cars 数并列取先者', () => {
    const tasks = [{ cars: ['a', 'b'] }, { cars: ['x', 'y'] }];
    assert.strictEqual(RouteLib.pickConsistTask(tasks), 0);
  });

  it('单 task → 0', () => {
    assert.strictEqual(RouteLib.pickConsistTask([{ cars: ['a', 'b'] }]), 0);
  });

  it('tasks 空 / 全空 cars 兜底返回 0', () => {
    assert.strictEqual(RouteLib.pickConsistTask([]), 0);
    assert.strictEqual(RouteLib.pickConsistTask([{}, {}]), 0);
    assert.strictEqual(RouteLib.pickConsistTask([{ cars: [] }, { cars: [] }]), 0);
  });
});

// ---------------------------------------------------------------------------
// 3. buildTrackGraph
// ---------------------------------------------------------------------------
describe('buildTrackGraph', () => {
  it('端点 ε 内相连（viaJunction = null），远离不相连', () => {
    const tracks = {
      A: [[0, 0], [0, 0.001]],
      B: [[0, 0.00100001], [0, 0.002]],   // B 首端距 A 尾端 1e-8 < ε
      C: [[0, 0.5], [0, 0.501]],          // 与 A/B 远离
    };
    const graph = RouteLib.buildTrackGraph(tracks, []);
    assert.ok(hasEdge(graph, 'A', 'B', null), 'A→B 应有吸附边');
    assert.ok(hasEdge(graph, 'B', 'A', null), 'B→A 应有吸附边（无向对称）');
    assert.strictEqual((graph.get('A') || []).filter(e => e.to === 'C').length, 0, 'A-C 不应相连');
    assert.strictEqual((graph.get('C') || []).length, 0, 'C 应无任何邻接');
  });

  it('道岔团：branches + 近端点引入轨 两两相连（viaJunction = 道岔索引）', () => {
    const tracks = {
      IN: [[10, 9.999], [10, 10.0000001]],   // 引入轨：尾端落在道岔 position ε 邻域
      B1: [[10, 10.0000002], [10, 10.001]],  // branch 0
      B2: [[10.0000003, 10], [10.001, 10]],  // branch 1
      FAR: [[10, 10.01], [10, 10.02]],       // 远离道岔
    };
    const junctions = [{ position: [10, 10], branches: ['B1', 'B2'] }];
    const graph = RouteLib.buildTrackGraph(tracks, junctions);

    assert.ok(hasEdge(graph, 'IN', 'B1', 0), '引入轨-branch0 团边');
    assert.ok(hasEdge(graph, 'IN', 'B2', 0), '引入轨-branch1 团边');
    assert.ok(hasEdge(graph, 'B1', 'B2', 0), 'branch-branch 团边');
    assert.ok(hasEdge(graph, 'B2', 'B1', 0), '团边无向对称');
    assert.strictEqual((graph.get('FAR') || []).length, 0, '远离轨不进团');
  });

  it('同一对 track 规则②边优先（抑制规则①空边）', () => {
    // B1 首端与 B2 首端彼此相距 ~1e-5 < ε（足以触发端点吸附），
    // 但二者同属道岔团 → 只应有 viaJunction=0 的边，不应有 null 边
    const tracks = {
      B1: [[10, 10.0000002], [10, 10.001]],
      B2: [[10.0000003, 10], [10.001, 10]],
    };
    const junctions = [{ position: [10, 10], branches: ['B1', 'B2'] }];
    const graph = RouteLib.buildTrackGraph(tracks, junctions);
    assert.ok(hasEdge(graph, 'B1', 'B2', 0), '应有道岔团边');
    assert.ok(!hasEdge(graph, 'B1', 'B2', null), '不应再有吸附空边');
    assert.strictEqual((graph.get('B1') || []).length, 1, 'B1 邻接仅一条');
  });

  it('边携带 length = 进入目标 track 的折线长度', () => {
    const tracks = {
      A: [[0, 0], [0, 0.001]],                 // 长 0.001
      B: [[0, 0.00100001], [0, 0.00300001]],   // 长 0.002
    };
    const graph = RouteLib.buildTrackGraph(tracks, []);
    const edgeAtoB = graph.get('A').find(e => e.to === 'B');
    const edgeBtoA = graph.get('B').find(e => e.to === 'A');
    assert.ok(Math.abs(edgeAtoB.length - 0.002) < 1e-9, 'A→B 边权 = B 的折线长度');
    assert.ok(Math.abs(edgeBtoA.length - 0.001) < 1e-9, 'B→A 边权 = A 的折线长度');
  });
});

// ---------------------------------------------------------------------------
// 4. findRoute
// ---------------------------------------------------------------------------
describe('findRoute', () => {
  const linear = makeGraph({
    A: [['B', 1]],
    B: [['A', 1], ['C', 1]],
    C: [['B', 1]],
  });

  it('线形 A-B-C → [A,B,C]', () => {
    assert.deepStrictEqual(RouteLib.findRoute(linear, 'A', 'C'), ['A', 'B', 'C']);
  });

  it('相邻直达 → [A,B]', () => {
    assert.deepStrictEqual(RouteLib.findRoute(linear, 'A', 'B'), ['A', 'B']);
  });

  it('start === dest → [start]', () => {
    assert.deepStrictEqual(RouteLib.findRoute(linear, 'A', 'A'), ['A']);
  });

  it('start/dest 不在 graph → null', () => {
    assert.strictEqual(RouteLib.findRoute(linear, 'X', 'A'), null);
    assert.strictEqual(RouteLib.findRoute(linear, 'A', 'X'), null);
  });

  it('不连通 → null', () => {
    const split = makeGraph({
      A: [['B', 1]],
      B: [['A', 1]],
      C: [['D', 1]],
      D: [['C', 1]],
    });
    assert.strictEqual(RouteLib.findRoute(split, 'A', 'D'), null);
  });

  it('两条路径按累计折线长度取短者（而非最少跳数）', () => {
    // A→Z→B 直达 2 跳但 Z 长（边权 100）；A→X→Y→B 绕行 3 跳但各段短（总权 3）
    const g = makeGraph({
      A: [['Z', 100], ['X', 1]],
      Z: [['A', 1], ['B', 1]],
      B: [['Z', 100], ['Y', 1]],
      X: [['A', 1], ['Y', 1]],
      Y: [['X', 1], ['B', 1]],
    });
    assert.deepStrictEqual(RouteLib.findRoute(g, 'A', 'B'), ['A', 'X', 'Y', 'B']);
  });

  it('端到端：buildTrackGraph 吸附连通后寻路', () => {
    const tracks = {
      A: [[0, 0], [0, 0.001]],
      B: [[0, 0.00100001], [0, 0.002]],
      C: [[0, 0.00200001], [0, 0.003]],
    };
    const graph = RouteLib.buildTrackGraph(tracks, []);
    assert.deepStrictEqual(RouteLib.findRoute(graph, 'A', 'C'), ['A', 'B', 'C']);
  });
});

// ---------------------------------------------------------------------------
// 5. orientRouteCoords
// ---------------------------------------------------------------------------
describe('orientRouteCoords', () => {
  it('反向段被翻转，拼接处连续（相邻段端点距 < ε）', () => {
    const tracks = {
      T1: [[0, 0], [0, 0.001]],
      T2: [[0, 0.002], [0, 0.00100001]],   // 定义方向与行进方向相反
      T3: [[0, 0.00200001], [0, 0.003]],
    };
    const coords = RouteLib.orientRouteCoords(['T1', 'T2', 'T3'], tracks);
    assert.strictEqual(coords.length, 6, '全部坐标保留（含重复连接点）');
    assert.deepStrictEqual(coords[0], [0, 0]);
    assert.deepStrictEqual(coords[1], [0, 0.001]);
    assert.deepStrictEqual(coords[2], [0, 0.00100001], 'T2 应翻转为 [0,0.00100001],[0,0.002]');
    assert.deepStrictEqual(coords[3], [0, 0.002]);
    assert.deepStrictEqual(coords[4], [0, 0.00200001]);
    assert.deepStrictEqual(coords[5], [0, 0.003]);
    // 拼接处（T1 尾→T2 首、T2 尾→T3 首）距离必须 < ε
    assert.ok(dist(coords[1], coords[2]) < EPS, 'T1/T2 拼接处连续');
    assert.ok(dist(coords[3], coords[4]) < EPS, 'T2/T3 拼接处连续');
  });

  it('首段保持正向', () => {
    const tracks = { S: [[1, 1], [1, 2]] };
    assert.deepStrictEqual(RouteLib.orientRouteCoords(['S'], tracks), [[1, 1], [1, 2]]);
  });

  it('不修改传入的原始坐标数组', () => {
    const t2 = [[0, 0.002], [0, 0.00100001]];
    const tracks = { T1: [[0, 0], [0, 0.001]], T2: t2 };
    RouteLib.orientRouteCoords(['T1', 'T2'], tracks);
    assert.deepStrictEqual(t2, [[0, 0.002], [0, 0.00100001]], '原数组保持定义方向');
  });
});

// ---------------------------------------------------------------------------
// 6. junctionsForRoute
// ---------------------------------------------------------------------------
describe('junctionsForRoute', () => {
  // 道岔 0 @ [20,20]（branches RB1/RB2），RA、RA2 为引入轨；
  // 道岔 1 @ [21,21]（branches SB1/SB2），SC 为引入轨，SC 首端吸附 RB1 尾端。
  const tracks = {
    RA: [[20, 19.999], [20, 20.0000001]],       // 引入轨（尾端靠道岔 0）
    RA2: [[20.0000004, 20], [20.001, 20.0005]], // 引入轨 2（首端靠道岔 0）
    RB1: [[20, 20.0000002], [20, 20.001]],      // 道岔 0 branch 0
    RB2: [[20.0000003, 20], [20.001, 20]],      // 道岔 0 branch 1
    SC: [[20, 20.00100001], [21, 21.0000001]],  // 引入轨（首端吸附 RB1 尾端，尾端靠道岔 1）
    SB1: [[21, 21.0000002], [21, 21.001]],      // 道岔 1 branch 0
    SB2: [[21.0000003, 21], [21.001, 21]],      // 道岔 1 branch 1
  };
  const junctions = [
    { position: [20, 20], branches: ['RB1', 'RB2'] },
    { position: [21, 21], branches: ['SB1', 'SB2'] },
  ];
  const graph = RouteLib.buildTrackGraph(tracks, junctions);

  it('经道岔分支 → 正确 {junctionId, branch}（保序）', () => {
    const r = RouteLib.junctionsForRoute(['RA', 'RB1', 'SC', 'SB2'], junctions, graph);
    assert.deepStrictEqual(r, [{ junctionId: 0, branch: 0 }, { junctionId: 1, branch: 1 }]);
  });

  it('端点吸附连接（viaJunction = null）→ 无道岔项', () => {
    const r = RouteLib.junctionsForRoute(['RB1', 'SC'], junctions, graph);
    assert.deepStrictEqual(r, []);
  });

  it('同一道岔出现多次 → 按 junctionId 去重（保留首次）', () => {
    // RA→RB1 经道岔 0（branch 0）；RB1→RA2 是团边（RA2 为引入轨，branch 取 RB1=0）→ 重复道岔 0
    const r = RouteLib.junctionsForRoute(['RA', 'RB1', 'RA2'], junctions, graph);
    assert.deepStrictEqual(r, [{ junctionId: 0, branch: 0 }]);
  });

  it('相邻对两个都是 branch → 取后继 track 的索引', () => {
    const r = RouteLib.junctionsForRoute(['RB1', 'RB2'], junctions, graph);
    assert.deepStrictEqual(r, [{ junctionId: 0, branch: 1 }]);
  });

  it('空/单元素路线 → []', () => {
    assert.deepStrictEqual(RouteLib.junctionsForRoute([], junctions, graph), []);
    assert.deepStrictEqual(RouteLib.junctionsForRoute(['RA'], junctions, graph), []);
  });
});

// ---------------------------------------------------------------------------
// 6b. junctionsForRoute：道岔重分类与几何扫描兜底（道岔遗漏修复回归）
// ---------------------------------------------------------------------------
describe('junctionsForRoute 重分类与几何扫描', () => {
  // 重分类场景：道岔 J @ 1000m；A 尾端 996.5m（距 J 3.5m > ε，规则②不收编），
  // B（branch）首端 998.5m；A↔B 仅靠端点吸附（2m < ε）→ viaJunction = null 旧行为遗漏
  const reTracks = {
    A: [[0, 0], [0, M(996.5)]],
    B: [[0, M(998.5)], [0, M(2000)]],
  };
  const reJunctions = [{ position: [0, M(1000)], branches: ['B'] }];
  const reGraph = RouteLib.buildTrackGraph(reTracks, reJunctions);

  it('吸附边端点/连接点近道岔 → 重分类记录 {junctionId, branch}', () => {
    const r = RouteLib.junctionsForRoute(['A', 'B'], reJunctions, reGraph, reTracks);
    assert.deepStrictEqual(r, [{ junctionId: 0, branch: 0 }]);
  });

  it('省略 tracks 参数 → 退化为旧行为（兼容 3 参调用，不记录）', () => {
    const r = RouteLib.junctionsForRoute(['A', 'B'], reJunctions, reGraph);
    assert.deepStrictEqual(r, []);
  });

  // 几何扫描兜底：A 尾端 1003.4m、B 首端 1005.4m（吸附 2m），连接中点距 J 4.4m > ε
  // → 重分类失败；但路线几何经过 J（A 折线覆盖 1000m）且 B 端点距 J 5.4m < 4ε → 补录
  const sweepTracks = {
    A: [[0, 0], [0, M(1003.4)]],
    B: [[0, M(1005.4)], [0, M(2000)]],
  };
  const sweepGraph = RouteLib.buildTrackGraph(sweepTracks, reJunctions);

  it('重分类仍遗漏时几何扫描兜底补录', () => {
    const r = RouteLib.junctionsForRoute(['A', 'B'], reJunctions, sweepGraph, sweepTracks);
    assert.deepStrictEqual(r, [{ junctionId: 0, branch: 0 }]);
  });

  it('路线几何不经过道岔邻域 → 扫描不误录', () => {
    // 道岔 position 横向偏移 10m（> ε）：branch C 在路线中，但路线几何不贴近 position
    const tracks = {
      X: [[0, M(4000)], [0, M(5000.5)]],
      C: [[0, M(5001)], [0, M(6000)]],
    };
    const farJunctions = [{ position: [M(10), M(5000)], branches: ['C'] }];
    const g = RouteLib.buildTrackGraph(tracks, farJunctions);
    const r = RouteLib.junctionsForRoute(['X', 'C'], farJunctions, g, tracks);
    assert.deepStrictEqual(r, []);
  });

  it('hop 已记录的道岔扫描不重复补录', () => {
    // A 尾端 1002m 距 J 2m < ε → 规则②团边直接记录；扫描应跳过（去重）
    const tracks = {
      A: [[0, 0], [0, M(1002)]],
      B: [[0, M(998)], [0, M(2000)]],
    };
    const g = RouteLib.buildTrackGraph(tracks, reJunctions);
    const r = RouteLib.junctionsForRoute(['A', 'B'], reJunctions, g, tracks);
    assert.deepStrictEqual(r, [{ junctionId: 0, branch: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// 6c. assembleRouteCoords：裁切式拼接（道岔折线毛刺修复回归）
// ---------------------------------------------------------------------------
describe('assembleRouteCoords', () => {
  // 道岔 J @ 1000m；A（引入轨）尾端越过 J 2m，B（branch）首端在 J 前 2m → 重叠区 998..1002m
  // 旧 orientRouteCoords 整段拼接会 1002 → 998 折返形成毛刺
  const junctions = [{ position: [0, M(1000)], branches: ['B'] }];

  it('道岔区重叠几何被裁切：无折返、道岔 position 为精确顶点', () => {
    const tracks = {
      A: [[0, 0], [0, M(1002)]],
      B: [[0, M(998)], [0, M(2000)]],
    };
    const graph = RouteLib.buildTrackGraph(tracks, junctions);
    const coords = RouteLib.assembleRouteCoords(['A', 'B'], tracks, graph, junctions);
    assert.deepStrictEqual(coords, [[0, 0], [0, M(1000)], [0, M(2000)]]);
  });

  it('分支折线定义方向相反 → 仍按行进方向裁切拼接', () => {
    const tracks = {
      A: [[0, 0], [0, M(1002)]],
      B: [[0, M(2000)], [0, M(998)]],   // 定义方向与行进方向相反
    };
    const graph = RouteLib.buildTrackGraph(tracks, junctions);
    const coords = RouteLib.assembleRouteCoords(['A', 'B'], tracks, graph, junctions);
    assert.deepStrictEqual(coords, [[0, 0], [0, M(1000)], [0, M(2000)]]);
  });

  it('单 track 路线 → 原折线全量拷贝', () => {
    const tracks = { S: [[1, 1], [1, 2], [1, 3]] };
    const coords = RouteLib.assembleRouteCoords(['S'], tracks, null, []);
    assert.deepStrictEqual(coords, [[1, 1], [1, 2], [1, 3]]);
  });

  it('无道岔吸附连接 → 以端点中点为顶点裁切，无折返', () => {
    const tracks = {
      A: [[0, 0], [0, M(500)]],
      B: [[0, M(500.5)], [0, M(1000)]],   // 首端距 A 尾端 0.5m
    };
    const graph = RouteLib.buildTrackGraph(tracks, []);
    const coords = RouteLib.assembleRouteCoords(['A', 'B'], tracks, graph, []);
    const mid = (M(500) + M(500.5)) / 2;
    assert.deepStrictEqual(coords, [[0, 0], [0, M(500)], [0, mid], [0, M(500.5)], [0, M(1000)]]);
  });

  it('同一 track 重复出现按位置独立裁切（不抛异常、首末为自由端）', () => {
    const tracks = {
      A: [[0, 0], [0, M(1002)]],
      B: [[0, M(998)], [0, M(2000)]],
    };
    const graph = RouteLib.buildTrackGraph(tracks, junctions);
    const coords = RouteLib.assembleRouteCoords(['A', 'B', 'A'], tracks, graph, junctions);
    assert.ok(coords.length > 0);
    assert.deepStrictEqual(coords[0], [0, 0]);
    assert.deepStrictEqual(coords[coords.length - 1], [0, 0], '折返路线末段回到 A 自由端');
  });

  it('不修改传入的原始坐标数组', () => {
    const a = [[0, 0], [0, M(1002)]];
    const b = [[0, M(998)], [0, M(2000)]];
    const tracks = { A: a, B: b };
    const graph = RouteLib.buildTrackGraph(tracks, junctions);
    RouteLib.assembleRouteCoords(['A', 'B'], tracks, graph, junctions);
    assert.deepStrictEqual(a, [[0, 0], [0, M(1002)]]);
    assert.deepStrictEqual(b, [[0, M(998)], [0, M(2000)]]);
  });

  it('空路线 / 缺失坐标 → 安全返回', () => {
    assert.deepStrictEqual(RouteLib.assembleRouteCoords([], {}, null, []), []);
    assert.deepStrictEqual(RouteLib.assembleRouteCoords(['X'], {}, null, []), []);
  });
});

// ---------------------------------------------------------------------------
// 6d. viewPaddingForSize（镜头 75% 占屏）
// ---------------------------------------------------------------------------
describe('viewPaddingForSize', () => {
  it('1920×1080 默认 12.5% → [240, 135]', () => {
    assert.deepStrictEqual(RouteLib.viewPaddingForSize(1920, 1080), [240, 135]);
  });

  it('自定义 fraction 生效', () => {
    assert.deepStrictEqual(RouteLib.viewPaddingForSize(1000, 500, 0.1), [100, 50]);
  });

  it('非法 fraction 回退默认 0.125', () => {
    assert.deepStrictEqual(RouteLib.viewPaddingForSize(1000, 500, 99), [125, 63]);
    assert.deepStrictEqual(RouteLib.viewPaddingForSize(1000, 500, 'x'), [125, 63]);
  });
});

// ---------------------------------------------------------------------------
// 7. sortJobEntries
// ---------------------------------------------------------------------------
describe('sortJobEntries', () => {
  const entries = [{ jobId: 'c-job' }, { jobId: 'a-job' }, { jobId: 'b-job' }];

  it('置顶最先，其余按 jobId 字典序', () => {
    const sorted = RouteLib.sortJobEntries(entries, 'b-job');
    assert.deepStrictEqual(sorted.map(e => e.jobId), ['b-job', 'a-job', 'c-job']);
  });

  it('置顶缺席 → 退化为纯字典序', () => {
    const sorted = RouteLib.sortJobEntries(entries, 'zzz-absent');
    assert.deepStrictEqual(sorted.map(e => e.jobId), ['a-job', 'b-job', 'c-job']);
  });

  it('返回新数组，不修改原数组', () => {
    const before = JSON.stringify(entries);
    RouteLib.sortJobEntries(entries, 'a-job');
    assert.strictEqual(JSON.stringify(entries), before, '原数组顺序不变');
  });

  // ---- 元组形状 [jobId, jobData]（main.js 传入 Map.entries() 快照，P1-2 回归防护）----

  it('元组形状 [jobId, jobData]：置顶最先，其余字典序', () => {
    const tuples = [['c-job', { n: 3 }], ['a-job', { n: 1 }], ['b-job', { n: 2 }]];
    const sorted = RouteLib.sortJobEntries(tuples, 'b-job');
    assert.deepStrictEqual(sorted.map(e => e[0]), ['b-job', 'a-job', 'c-job']);
  });

  it('元组形状：置顶缺席 → 退化为纯字典序（评审复现场景）', () => {
    const tuples = [['c-job', {}], ['a-job', {}], ['b-job', {}]];
    const sorted = RouteLib.sortJobEntries(tuples, 'zzz-absent');
    assert.deepStrictEqual(sorted.map(e => e[0]), ['a-job', 'b-job', 'c-job']);
  });

  it('元组形状：元素原样返回（引用不变、不变形）', () => {
    const tA = ['a-job', { x: 1 }];
    const tB = ['b-job', { x: 2 }];
    const sorted = RouteLib.sortJobEntries([tB, tA], 'a-job');
    assert.strictEqual(sorted[0], tA, '置顶元组为同一引用');
    assert.strictEqual(sorted[1], tB, '其余元组为同一引用');
    assert.deepStrictEqual(sorted[0], ['a-job', { x: 1 }], '元素不被改写');
  });
});

// ---------------------------------------------------------------------------
// 8. formatJunctionPairs
// ---------------------------------------------------------------------------
describe('formatJunctionPairs', () => {
  it('正常序列化 → "12:1,34:0"', () => {
    assert.strictEqual(
      RouteLib.formatJunctionPairs([{ junctionId: 12, branch: 1 }, { junctionId: 34, branch: 0 }]),
      '12:1,34:0'
    );
  });

  it('非法项被过滤（负 id、非整数、非数；分支号允许大于 1）', () => {
    const pairs = [
      { junctionId: -1, branch: 0 },   // 负 id
      { junctionId: 1.5, branch: 0 },  // 非整数 id
      { junctionId: '6', branch: 0 },  // 非数 id
      { junctionId: NaN, branch: 0 },  // NaN id
      { junctionId: 5, branch: 2 },    // 合法：真实道岔可能多于两个分支
      { junctionId: 5, branch: -1 },   // branch 负数
      { junctionId: 7, branch: '1' },  // 非数 branch
      { junctionId: 8, branch: 0 },    // 合法
      null,                            // 非法项
    ];
    assert.strictEqual(RouteLib.formatJunctionPairs(pairs), '5:2,8:0');
  });

  it('全非法 / 空输入 → ""', () => {
    assert.strictEqual(RouteLib.formatJunctionPairs([{ junctionId: -2, branch: 0 }]), '');
    assert.strictEqual(RouteLib.formatJunctionPairs([]), '');
    assert.strictEqual(RouteLib.formatJunctionPairs(null), '');
  });
});

// ---------------------------------------------------------------------------
// 10. 端口级真实拓扑（buildPortGraph / findPortRoute）
// ---------------------------------------------------------------------------
describe('端口级真实拓扑', () => {
  const topology = {
    coords: {
      A: [[0, 0], [0, M(100)]],
      B: [[0, M(100)], [0, M(200)]],
      C: [[0, M(100)], [M(10), M(200)]],
      D: [[0, M(200)], [0, M(300)]], // 定义方向与行进方向相反
    },
    junctions: [
      {
        id: 3,
        position: [M(5), M(100)], // 道岔图标故意横向偏离轨道连接点
        in: { track: 'A', end: 'out' },
        branches: [
          { track: 'B', end: 'in', branch: 0 },
          { track: 'C', end: 'in', branch: 1 },
        ],
      },
    ],
    links: [{ a: { track: 'B', end: 'out' }, b: { track: 'D', end: 'out' } }],
  };

  it('道岔只连接输入与各输出，分支之间没有虚假直连', () => {
    const built = RouteLib.buildPortGraph(topology);
    const bIn = 'B\u0001in';
    const cIn = 'C\u0001in';
    const edges = built.graph.get(bIn) || [];
    assert.strictEqual(edges.some(e => e.to === cIn), false);
    const junctionEdges = edges.filter(e => e.kind === 'junction');
    assert.strictEqual(junctionEdges.length, 1);
    assert.strictEqual(junctionEdges[0].to, 'A\u0001out');
    assert.strictEqual(junctionEdges[0].branch, 0);
  });

  it('A→B：包含起终整条轨道、途经道岔分支 0', () => {
    const built = RouteLib.buildPortGraph(topology);
    const route = RouteLib.findPortRoute(built, 'A', 'B');
    assert.deepStrictEqual(route.trackIds, ['A', 'B']);
    assert.deepStrictEqual(route.junctions, [{ junctionId: 3, branch: 0 }]);
    const coords = RouteLib.assemblePortRouteCoords(route, topology.coords);
    assert.deepStrictEqual(coords[0], [0, 0]);
    assert.ok(dist(coords[coords.length - 1], [0, M(200)]) < 1e-9);
  });

  it('A→C：途经道岔分支 1', () => {
    const built = RouteLib.buildPortGraph(topology);
    const route = RouteLib.findPortRoute(built, 'A', 'C');
    assert.deepStrictEqual(route.trackIds, ['A', 'C']);
    assert.deepStrictEqual(RouteLib.junctionsForPortRoute(route).pairs, [{ junctionId: 3, branch: 1 }]);
  });

  it('不把偏离轨道的道岔图标坐标插入路线（无侧向尖刺）', () => {
    const built = RouteLib.buildPortGraph(topology);
    const route = RouteLib.findPortRoute(built, 'A', 'B');
    const coords = RouteLib.assemblePortRouteCoords(route, topology.coords);
    assert.strictEqual(coords.some(p => Math.abs(p[0] - M(5)) < 1e-10 && Math.abs(p[1] - M(100)) < 1e-10), false);
    assert.ok(coords.every(p => p[0] === 0), '路线应始终位于轨道中心线上');
  });

  it('普通直连端口可寻路，反向定义的轨道按行进方向拼接', () => {
    topology.coords.D = [[0, M(300)], [0, M(200)]];
    const built = RouteLib.buildPortGraph(topology);
    const route = RouteLib.findPortRoute(built, 'A', 'D');
    assert.deepStrictEqual(route.trackIds, ['A', 'B', 'D']);
    const coords = RouteLib.assemblePortRouteCoords(route, topology.coords);
    assert.ok(dist(coords[coords.length - 1], [0, M(300)]) < 1e-9, 'D 应反向拼接到 300m');
  });

  it('同一道岔不同分支 → junctionsForPortRoute 报告冲突', () => {
    const info = RouteLib.junctionsForPortRoute({
      junctions: [
        { junctionId: 1, branch: 0 },
        { junctionId: 1, branch: 1 },
      ],
    });
    assert.deepStrictEqual(info.pairs, [{ junctionId: 1, branch: 0 }]);
    assert.strictEqual(info.conflicts.length, 1);
  });

  it('未知轨道 → null（不抛异常）', () => {
    const built = RouteLib.buildPortGraph(topology);
    assert.strictEqual(RouteLib.findPortRoute(built, 'A', 'nope'), null);
  });
});

// ---------------------------------------------------------------------------
// 9. 经典 script 共享全局词法环境（P1-1 回归防护）
//    vm.createContext 模拟 index.html 先后加载 res/route.js 与 res/main.js：
//    两个经典脚本的顶层 const 进入同一全局词法环境。route.js 若在 IIFE 外
//    泄漏任何顶层 const/let（如 metersToDegrees），下方第二段脚本实例化即抛
//    SyntaxError（与 main.js:3 顶层 const metersToDegrees 同名冲突）。
// ---------------------------------------------------------------------------
describe('经典 script 全局词法环境', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');

  it('先 route.js 后 main.js 顶层声明 → 无 SyntaxError 且 global.RouteLib 就绪', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'route.js'), 'utf8');
    const ctx = vm.createContext({});
    vm.runInContext(source, ctx, { filename: 'res/route.js' });

    // main.js 头部真实顶层声明片段（main.js:1-24 摘要；metersToDegrees 为此前冲突标识符）
    vm.runInContext([
      "'use strict';",
      'const initialZoom = 20;',
      'const earthCircumference = 40e6;',
      'const metersToDegrees = 360 / earthCircumference;',
      'const defaultSettings = {};',
      'const settings = { ...defaultSettings };',
      'let selectedJobId = null;',
    ].join('\n'), ctx, { filename: 'res/main.js-head.js' });

    assert.strictEqual(typeof ctx.RouteLib, 'object', 'global.RouteLib 应存在');
    assert.strictEqual(typeof ctx.RouteLib.findRoute, 'function', 'RouteLib API 应可用');
    assert.strictEqual(ctx.RouteLib, vm.runInContext('RouteLib', ctx), 'RouteLib 可按标识符直接访问');
  });

  it('route.js 加载后不向全局词法环境泄漏顶层 const/let', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'route.js'), 'utf8');
    const ctx = vm.createContext({});
    vm.runInContext(source, ctx, { filename: 'res/route.js' });
    // 与 route.js 内部全部顶层标识符同名声明应可自由实例化（即证明未被泄漏占用）
    vm.runInContext([
      'const metersToDegrees = 1;',
      'const DEFAULT_EPSILON_DEG = 2;',
      'const RouteLib = {}; // 注意：作为 const 声明与 window.RouteLib 属性不冲突',
      'let buildTrackGraph, findRoute, junctionsForRoute, orientRouteCoords;',
      'let buildRouteHops, assembleRouteCoords, viewPaddingForSize;',
      'let projectParamOnPolyline, pointAtParam, sliceTrackPolyline;',
      'let closestEndpointPair, findGraphEdge, junctionBranchIndex;',
      'let pickConsistTask, middleCarIndex, sortJobEntries, formatJunctionPairs;',
    ].join('\n'), ctx, { filename: 'leak-probe.js' });
    assert.ok(true, '同名 const 声明未冲突 = 无顶层泄漏');
  });
});
