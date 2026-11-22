// Ordered rail-sign layout regressions; all fixture anchors are immutable.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRailSignTrackIndex, railSignTrackPosition, layoutRailSignCards, rectsOverlap } = require('../signs.js');

const degrees = 360 / 40e6;
const pos = (x, z = 0) => [z * degrees, x * degrees];
const port = (track, end) => ({ track, end });
const link = (a, ae, b, be) => ({ a: port(a, ae), b: port(b, be) });
const topology = {
  coords: { a: [pos(-205), pos(102)], b: [pos(313), pos(102)], c: [pos(313), pos(530)],
    d: [pos(530), pos(830)], parallel: [pos(-205, 8), pos(830, 8)] },
  links: [link('a', 'out', 'b', 'out'), link('b', 'in', 'c', 'in'), link('c', 'out', 'd', 'in')],
  junctions: [],
};
const index = buildRailSignTrackIndex(topology);
const poles = [ ['a', 0, -5], ['b', 210, -4], ['c', 416, -6], ['d', 635, -3] ]
  .map(([track, x, z]) => Object.freeze({ track, p: Object.freeze(pos(x, z)) }));
const located = (pole, heading = 90, tracks = index) => railSignTrackPosition(tracks, pole, heading, degrees);
const geometry = (anchor, opts = {}) => Object.freeze({ anchor: Object.freeze(anchor), width: 59.4, height: 27, heading: 90, ...opts });
const view = { x: 600, y: 275 };
const camera = (scale = .133, y = 230, x = 104) => poles.map(pole => geometry(
  { x: x + pole.p[1] / degrees * scale, y: y - pole.p[0] / degrees * scale }, { rail: located(pole) }));
const eps = .002;
function intersection(a, b) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > eps &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > eps;
}
function clear(slots) {
  assert.ok(slots.every((slot, i) => slots.slice(i + 1).every(other => !intersection(slot.rect, other.rect))));
}
function ordered(slots, projection = slot => slot.x) {
  assert.ok(slots.every((slot, i) => !i || projection(slot) > projection(slots[i - 1])));
}
function contained(slots, size) {
  assert.ok(slots.every(({ rect: r }) => r.left >= -eps && r.top >= -eps && r.right <= size.x + eps && r.bottom <= size.y + eps));
}
function eastSide(items, slots) {
  assert.ok(slots.every((slot, i) => slot.rect.top >= items[i].anchor.y + 6 - eps));
}
function localLeaders(items, slots) {
  for (const [i, { rect }] of slots.entries()) {
    const { x, y } = items[i].anchor;
    const distance = Math.hypot(Math.max(0, rect.left - x, x - rect.right), Math.max(0, rect.top - y, y - rect.bottom));
    assert.ok(distance <= 42 + eps, `leader from pole ${i} reaches ${distance} px`);
  }
}
function compactGap(gap) {
  assert.ok(gap >= 5 - eps && gap <= 10 + eps, `gap is ${gap} px`);
}

describe('标牌关联与沿轨顺序', () => {
  it('在四个真实拓扑区段上连续排序，正确处理反向存储的第二段', () => {
    const order = poles.map(pole => located(pole));
    assert.equal(new Set(order.map(item => item.lane)).size, 1);
    assert.deepEqual(order.map(item => Math.round(item.order / degrees)), [205, 415, 621, 840]);
    assert.deepEqual(poles.map(pole => pole.p), [pos(0, -5), pos(210, -4), pos(416, -6), pos(635, -3)]);
  });

  it('同一轨道反向标牌归另一侧，顺序也随行车方向反转', () => {
    const reverse = poles.slice().reverse().map(pole => located(pole, 270));
    assert.equal(new Set(reverse.map(item => item.lane)).size, 1);
    assert.notEqual(reverse[0].lane, located(poles[0]).lane);
    assert.ok(reverse.every((item, i) => !i || item.order > reverse[i - 1].order));
  });

  it('并行轨保持独立，缺归属、错到远离本轨或朝向不符时不猜最近轨', () => {
    const parallel = located({ track: 'parallel', p: pos(0, 9) });
    assert.notEqual(parallel.lane, located(poles[0]).lane);
    assert.equal(located({ p: pos(0, 2) }), null);
    assert.equal(located({ track: 'a', p: pos(0, 40) }), null);
    assert.equal(located(poles[0], 0), null);
  });

  it('不穿越道岔端口，也不在有多个接续选项的端口猜测方向', () => {
    const junction = buildRailSignTrackIndex({ ...topology,
      junctions: [{ in: port('a', 'out'), branches: [port('b', 'out'), port('parallel', 'in')] }],
    });
    const ambiguous = buildRailSignTrackIndex({ ...topology,
      links: [...topology.links, link('a', 'out', 'parallel', 'in')],
    });
    for (const tracks of [junction, ambiguous])
      assert.notEqual(located(poles[0], 90, tracks).lane, located(poles[1], 90, tracks).lane);
  });

  it('遇到自交且无法确定沿线里程时，不合成同一排序', () => {
    const folded = buildRailSignTrackIndex({ coords: { r: [pos(-90), pos(90), pos(90, 50), pos(-90, 50), pos(-90, 2), pos(90, 2)] } });
    assert.equal(located({ track: 'r', p: pos(0, 1) }, 90, folded), null);
  });
});

describe('碰撞后的保序避让', () => {
  it('没有实际重叠时，间距不足 7 px 也不挪原位牌面', () => {
    const items = [geometry({ x: 82, y: 115 }), geometry({ x: 142, y: 115 })];
    const out = layoutRailSignCards(items, view);
    assert.deepEqual(out.map(o => [o.mode, o.x]), [['home', 82], ['home', 142]]);
    clear(out);
  });

  it('轻微碰撞时优先就近错开，不为一两像素的重叠平移一整层', () => {
    const items = [geometry({ x: 230, y: 115 }, { rail: { lane: 'straight', order: 0 } }),
      geometry({ x: 288, y: 115 }, { rail: { lane: 'straight', order: 1 } })];
    const out = layoutRailSignCards(items, view);
    assert.ok(out.every((slot, i) => slot.mode === 'along' && Math.abs(slot.x - items[i].anchor.x) < 5));
    compactGap(out[1].rect.left - out[0].rect.right);
    clear(out);
    eastSide(items, out);
  });

  it('不同宽度斜向牌只挪到相邻牌的真实边缘，不按整组的宽度跨一层', () => {
    const items = [geometry({ x: 200, y: 150 }, { heading: 45 }),
      geometry({ x: 212, y: 115 }, { heading: 45, width: 95 })];
    const out = layoutRailSignCards(items, view);
    assert.deepEqual(out.map(slot => slot.mode), ['outward', 'home']);
    compactGap(out[0].rect.top - out[1].rect.bottom);
    assert.ok(Math.hypot(out[0].x - 225.84264, out[0].y - 175.84264) < 12);
    clear(out);
    localLeaders(items, out);
  });

  it('贴边时四张牌共同沿轨腾位，保序且相邻边缘只留 5 至 10 px', () => {
    const items = camera();
    const out = layoutRailSignCards(items, view);
    assert.ok(out.every(slot => slot.mode === 'along'));
    assert.ok(out[0].x < items[0].anchor.x && out[3].x > items[3].anchor.x);
    out.slice(1).forEach((slot, i) => compactGap(slot.rect.left - out[i].rect.right));
    ordered(out);
    clear(out);
    contained(out, view);
    eastSide(items, out);
    localLeaders(items, out);
    const backwards = layoutRailSignCards(items.slice().reverse(), view).reverse();
    assert.deepEqual(backwards, out);
  });

  it('斜向贴边时以真正的横竖边距避让，不用对角投影拉宽间隔', () => {
    const items = [geometry({ x: 120, y: 165 }, { heading: 45, rail: { lane: 'diagonal', order: 0 } }),
      geometry({ x: 143, y: 142 }, { heading: 45, rail: { lane: 'diagonal', order: 1 } })];
    const size = { x: 480, y: 200 };
    const out = layoutRailSignCards(items, size);
    assert.ok(out.every(slot => slot.mode === 'along'));
    compactGap(out[0].rect.top - out[1].rect.bottom);
    contained(out, size);
    ordered(out, slot => slot.x - slot.y);
    localLeaders(items, out);
  });

  it('局部极密时保序压叠，不把两端甩远来强求留白', () => {
    const items = camera(.02, 100, 260);
    const out = layoutRailSignCards(items, view);
    assert.equal(out.length, items.length);
    assert.ok(out.slice(1).every((slot, i) => out[i].rect.right - slot.rect.left < 9));
    ordered(out);
    eastSide(items, out);
    localLeaders(items, out);
  });

  it('不足以留出 7 px 时，优先降为 5 px 而不是让牌越界', () => {
    const items = [geometry({ x: 45, y: 230 }, { rail: { lane: 'tight', order: 0 } }),
      geometry({ x: 79, y: 230 }, { rail: { lane: 'tight', order: 1 } })];
    const size = { x: 124.3, y: 275 };
    const out = layoutRailSignCards(items, size);
    const gap = out[1].rect.left - out[0].rect.right;
    assert.ok(Math.abs(gap - 5) <= eps);
    contained(out, size);
    eastSide(items, out);
  });

  it('横向实在容纳不了时压叠但不裁切、不掉牌，顺序不变', () => {
    const items = camera(.133, 230, 41), size = { x: 224, y: 275 };
    const out = layoutRailSignCards(items, size);
    assert.equal(out.length, 4);
    assert.ok(out.every(slot => slot.mode === 'compact'));
    assert.ok(out.slice(1).every((slot, i) => slot.rect.left < out[i].rect.right));
    assert.ok(out.slice(1).every((slot, i) => out[i].rect.right - slot.rect.left < 4.6));
    ordered(out);
    contained(out, size);
    eastSide(items, out);
  });

  it('附近有空位就避开站名，不挪原本未碰撞的标牌', () => {
    const lane = { lane: located(poles[0]).lane };
    const items = [geometry({ x: 160, y: 230 }, { rail: { ...lane, order: 0 } }),
      geometry({ x: 195, y: 230 }, { rail: { ...lane, order: 1 } }),
      geometry({ x: 550, y: 231 }, { rail: { ...lane, order: 2 } })];
    const obstacle = { left: 104, right: 146, top: 230, bottom: 275 };
    const out = layoutRailSignCards(items, view, [obstacle]);
    assert.ok(out.every(slot => !rectsOverlap(slot.rect, obstacle)));
    assert.equal(out.at(-1).mode, 'home');
    assert.equal(out.at(-1).x, 550);
    compactGap(out[1].rect.left - out[0].rect.right);
    clear(out);
    ordered(out);
    contained(out, view);
    localLeaders(items, out);
  });

  it('跨过大片站名才能排开时，保留触点附近的布局，不把整组拖到远处', () => {
    const items = camera();
    const obstacle = { left: 90, right: 213, top: 230, bottom: 275 };
    const out = layoutRailSignCards(items, view, [obstacle]);
    assert.ok(out.some(slot => rectsOverlap(slot.rect, obstacle)));
    clear(out);
    ordered(out);
    contained(out, view);
    localLeaders(items, out);
  });

  it('识别不到轨道时保留各自的牌与触点，不串成沿轨队列', () => {
    const items = [geometry({ x: 250, y: 130 }), geometry({ x: 275, y: 130 })];
    const out = layoutRailSignCards(items, view);
    assert.equal(out.length, 2);
    assert.ok(out.every((slot, i) => Math.abs(slot.x - items[i].anchor.x) < eps));
    clear(out);
  });

  it('斜向右侧仍贴在原轨侧，移动后整个牌面不压过触点所在切线', () => {
    const items = [0, 19, 38, 57].map((d, order) => geometry({ x: 434 + d, y: 209 - d },
      { heading: 45, rail: { lane: 'curve-local', order } }));
    const size = { x: 560, y: 275 };
    const out = layoutRailSignCards(items, size);
    ordered(out, slot => slot.x - slot.y);
    clear(out);
    contained(out, size);
    for (const [i, slot] of out.entries())
      assert.ok(((slot.rect.left - items[i].anchor.x) + (slot.rect.top - items[i].anchor.y)) / Math.sqrt(2) >= 6 - eps);
  });
});
