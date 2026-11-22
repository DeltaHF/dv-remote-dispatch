// DV RemoteDispatch - signs.js 单元测试
// 运行：node --test tests/*.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SignsLib = require('../signs.js');

describe('坡道牌文字', () => {
  it('平坡固定显示 0%', () => {
    assert.equal(SignsLib.formatGrade({ kind: 'flat', text: '+0.4', percent: 0.4 }), '0%');
  });
  it('上坡与下坡保留游戏牌面数值', () => {
    assert.equal(SignsLib.formatGrade({ kind: 'up', text: '+1.2', percent: 1.2 }), '+1.2%');
    assert.equal(SignsLib.formatGrade({ kind: 'down', text: '-0.6', percent: 0.6 }), '-0.6%');
  });
  it('统一 Unicode 减号', () => {
    assert.equal(SignsLib.formatGrade({ kind: 'down', text: '\u22120.6', percent: 0.6 }), '-0.6%');
  });
  it('牌面文字缺失时按百分比回退', () => {
    assert.equal(SignsLib.formatGrade({ kind: 'up', text: '', percent: 1.25 }), '+1.3%');
    assert.equal(SignsLib.formatGrade({ kind: 'down', percent: 0.6 }), '-0.6%');
  });
  it('没有可用数值时返回空串', () => {
    assert.equal(SignsLib.formatGrade({ kind: 'up', text: '' }), '');
    assert.equal(SignsLib.formatGrade(null), '');
  });
});

describe('标牌提示文字', () => {
  const pole = {
    speeds: [
      { kmh: 50, heading: 90, main: true },
      { kmh: 20, heading: 180, main: false },
    ],
    grade: { kind: 'up', text: '+1.2', percent: 1.2 },
  };
  it('同杆限速与坡道合并，主线与支线分别标注', () => {
    assert.equal(SignsLib.poleTitle(pole),
      '50 km/h \u00b7 main line \u00b7 20 km/h \u00b7 branch \u00b7 Grade +1.2%');
  });
  it('没有线路分类时保持简洁', () => {
    const plain = { speeds: [{ kmh: 70, heading: 0 }], grade: null };
    assert.equal(SignsLib.poleTitle(plain), '70 km/h');
  });
  it('只显示已开启的图层', () => {
    assert.equal(SignsLib.poleTitle(pole, { speeds: true, grades: false }),
      '50 km/h \u00b7 main line \u00b7 20 km/h \u00b7 branch');
    assert.equal(SignsLib.poleTitle(pole, { speeds: false, grades: true }), 'Grade +1.2%');
    assert.equal(SignsLib.poleTitle({}, { speeds: true, grades: true }), '');
  });
});

describe('标牌信息列', () => {
  it('保留游戏提供的突变类型，且不把相邻支线的速度差当成突变', () => {
    const pole = { heading: 67, speeds: [
      { kmh: 100, arrow: 'left', heading: 30, speedChange: 'down' },
      { kmh: 50, arrow: 'right', heading: 100 },
    ] };
    const model = SignsLib.poleModel(pole);
    assert.equal(model.heading, 67);
    assert.deepEqual(model.columns.map(column => column.speed.speedChange), ['down', undefined]);
    assert.match(model.title, /next limit decreases by at least 20 km\/h/);
    assert.doesNotMatch(model.title, /increases/);
  });

  it('普通标牌的限速和坡度上下同列', () => {
    const model = SignsLib.poleModel({ speeds: [{ kmh: 70, heading: 90 }], grade: { kind: 'up', text: '+1.4' } });
    assert.equal(model.heading, 90);
    assert.equal(model.columns.length, 1);
    assert.equal(model.columns[0].grades[0].text, '+1.4%');
  });

  it('道岔按明确的左右股分配坡度，未提供方向时单独显示', () => {
    const speeds = [{ kmh: 100, arrow: 'left' }, { kmh: 50, arrow: 'right' }];
    const grade = { kind: 'down', text: '-0.9' };
    const directed = SignsLib.poleModel({ speeds, grade: { ...grade, arrow: 'right' } });
    assert.deepEqual(directed.columns.map(column => column.grades.length), [0, 1]);
    const shared = SignsLib.poleModel({ speeds, grade });
    assert.deepEqual(shared.columns.map(column => column.grades.length), [0, 0, 1]);
    assert.equal(shared.columns[2].speed, null);
  });

  it('同杆多个坡道不丢失，也不会重复读旧版兼容的单坡度字段', () => {
    const grades = [{ kind: 'up', text: '+2', heading: 180 }, { kind: 'flat' }];
    const model = SignsLib.poleModel({ grades, grade: grades[0] }, { speeds: false });
    assert.equal(model.heading, 180);
    assert.deepEqual(model.columns[0].grades.map(grade => grade.text), ['+2%', '0%']);
  });

  it('关闭图层时去掉该层的信息，不创建空标牌', () => {
    const pole = { speeds: [{ kmh: 30, speedChange: 'up' }], grade: { kind: 'flat' } };
    const gradeOnly = SignsLib.poleModel(pole, { speeds: false, grades: true });
    assert.equal(gradeOnly.columns[0].speed, null);
    assert.equal(gradeOnly.title, 'Grade 0%');
    assert.equal(SignsLib.poleModel(pole, { speeds: false, grades: false }), null);
  });
});

describe('沿轨道侧面摆放标牌', () => {
  it('东西向的两个方向贴在轨道的南北两侧', () => {
    const east = SignsLib.placeBesideTrack(90, 54, 17);
    const west = SignsLib.placeBesideTrack(270, 54, 17, [east.bounds]);
    assert.ok(east.bounds.top >= 6 - 1e-8);
    assert.ok(west.bounds.bottom <= -6 + 1e-8);
    assert.ok(Math.abs(east.x) < 1e-8 && Math.abs(west.x) < 1e-8);
    assert.ok(Math.abs(east.distance - west.distance) < 1e-8);
    assert.equal(SignsLib.rectsOverlap(east.bounds, west.bounds), false);
  });

  it('斜向轨段也让牌面四角都落在行车方向右侧', () => {
    const position = SignsLib.placeBesideTrack(45, 86.5, 32);
    const { left, right, top, bottom } = position.bounds;
    for (const x of [left, right]) {
      for (const y of [top, bottom])
        assert.ok((x + y) / Math.sqrt(2) >= 6 - 1e-8);
    }
  });

  it('同一点上同向的牌继续朝外排列，不盖住前一块', () => {
    const first = SignsLib.placeBesideTrack(0, 54, 17);
    const second = SignsLib.placeBesideTrack(0, 86.5, 32, [first.bounds]);
    assert.ok(second.bounds.left >= first.bounds.right + 2);
    assert.equal(SignsLib.rectsOverlap(first.bounds, second.bounds), false);
  });
});

describe('玩家附近的标牌范围', () => {
  it('默认只看本机玩家，其他在线玩家的标牌不进入渲染', () => {
    const local = [0.1, 0.1];
    const players = [local, [0.3, 0.3]];
    assert.deepEqual(SignsLib.rangePlayers(players, local, 'local'), [local]);
    assert.equal(SignsLib.withinPlayerRange([0.3, 0.3], SignsLib.rangePlayers(players, local, 'local'), 0.018), false);
  });

  it('所有在线玩家模式按全部玩家取并集', () => {
    const local = [0.1, 0.1];
    const players = [local, [0.3, 0.3]];
    assert.deepEqual(SignsLib.rangePlayers(players, local, 'players'), players);
    assert.equal(SignsLib.withinPlayerRange([0.3, 0.3], SignsLib.rangePlayers(players, local, 'players'), 0.018), true);
  });

  it('全图模式不按玩家过滤，返回 null 表示跳过距离判断', () => {
    assert.equal(SignsLib.rangePlayers([[0.1, 0.1]], [0.1, 0.1], 'world'), null);
    assert.equal(SignsLib.rangePlayers([], null, 'world'), null);
  });

  it('本机位置未知时退回全部玩家，不因此清空地图', () => {
    const players = [[0.1, 0.1], [0.3, 0.3]];
    assert.deepEqual(SignsLib.rangePlayers(players, null, 'local'), players);
    assert.deepEqual(SignsLib.rangePlayers(players, [NaN, 0.2], 'local'), players);
  });

  it('没有玩家数据时返回空列表，不抛异常', () => {
    assert.deepEqual(SignsLib.rangePlayers(null, null, 'local'), []);
    assert.deepEqual(SignsLib.rangePlayers(undefined, [0.1, 0.1], 'players'), []);
    assert.deepEqual(SignsLib.rangePlayers(undefined, null, 'world'), null);
  });

  it('未知模式按本机玩家处理，不意外放开到全图', () => {
    const local = [0.1, 0.1];
    const players = [local, [0.3, 0.3]];
    assert.deepEqual(SignsLib.rangePlayers(players, local, 'watch-everything'), [local]);
  });

  it('任一在线玩家进入半径即可显示，离开全部玩家的范围后不显示', () => {
    const sign = [0.1, 0.1];
    assert.equal(SignsLib.withinPlayerRange(sign, [[0.01, 0.01], [0.101, 0.1]], 0.018), true);
    assert.equal(SignsLib.withinPlayerRange(sign, [[0.01, 0.01], [0.141, 0.1]], 0.018), false);
  });

  it('使用圆形范围并包含恰好在半径上的标牌', () => {
    assert.equal(SignsLib.withinPlayerRange([0, 0.018], [[0, 0]], 0.018), true);
    assert.equal(SignsLib.withinPlayerRange([0.015, 0.015], [[0, 0]], 0.018), false);
  });

  it('没有有效玩家或牌杆坐标时不显示', () => {
    assert.equal(SignsLib.withinPlayerRange([0.1, 0.1], [], 0.018), false);
    assert.equal(SignsLib.withinPlayerRange([0.1, 0.1], [null, [NaN, 0.1]], 0.018), false);
    assert.equal(SignsLib.withinPlayerRange([null, 0.1], [[0, 0.1]], 0.018), false);
  });
});

describe('重叠取舍', () => {
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

  it('互不重叠的标牌全部保留', () => {
    const items = [
      { id: 1, rect: rect(0, 0, 10, 10) },
      { id: 2, rect: rect(20, 0, 30, 10) },
    ];
    assert.deepEqual(SignsLib.resolveCollisions(items, []).map(i => i.id), [1, 2]);
  });
  it('重叠时保留先放置的，后到的省略', () => {
    const items = [
      { id: 'speed', rect: rect(0, 0, 20, 10) },
      { id: 'grade', rect: rect(0, 5, 20, 15) },
      { id: 'free', rect: rect(40, 0, 50, 10) },
    ];
    assert.deepEqual(SignsLib.resolveCollisions(items, []).map(i => i.id), ['speed', 'free']);
  });
  it('站名和道岔占用区不可覆盖', () => {
    const items = [
      { id: 'onStation', rect: rect(0, 0, 20, 10) },
      { id: 'clear', rect: rect(30, 0, 40, 10) },
    ];
    const kept = SignsLib.resolveCollisions(items, [rect(-2, -2, 22, 12)]);
    assert.deepEqual(kept.map(i => i.id), ['clear']);
  });
  it('缺少尺寸数据的项被跳过', () => {
    const items = [{ id: 1 }, { id: 2, rect: rect(0, 0, 5, 5) }];
    assert.deepEqual(SignsLib.resolveCollisions(items, []).map(i => i.id), [2]);
  });
});

describe('经典 script 全局词法环境', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'signs.js'), 'utf8');

  it('只暴露 SignsLib，不与 main.js 顶层声明冲突', () => {
    const ctx = vm.createContext({});
    vm.runInContext(source, ctx, { filename: 'res/signs.js' });
    assert.equal(typeof ctx.SignsLib.formatGrade, 'function');
    // 若 signs.js 泄漏了顶层 const formatGrade，这里会抛 SyntaxError
    vm.runInContext("const formatGrade = 1; const poleTitle = 2; const placeBesideTrack = 3;", ctx);
  });
});
