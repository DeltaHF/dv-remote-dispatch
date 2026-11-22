// DV RemoteDispatch - signs.js
// 地图标牌的纯函数：牌面信息、提示文字与可选的重叠取舍。
// 与 route.js 相同，整体包入 IIFE，经典 <script> 加载时只暴露 SignsLib 一个绑定，
// 不向共享的全局词法环境泄漏顶层声明；Node 下可 require 用于单元测试。
(function (global) {
'use strict';

// 游戏坡道牌文字形如 "+1.2" / "-0.6"，平坡牌不显示数字。
function formatGrade(grade) {
  if (!grade)
    return '';
  if (grade.kind === 'flat')
    return '0%';
  let text = typeof grade.text === 'string' ? grade.text.trim() : '';
  text = text.replace(/\u2212/g, '-'); // 把 Unicode 减号统一为 ASCII
  if (!text) {
    if (!Number.isFinite(grade.percent))
      return '';
    text = (grade.kind === 'down' ? '-' : '+') + grade.percent.toFixed(1);
  }
  return text.charAt(text.length - 1) === '%' ? text : text + '%';
}

function visibleSpeeds(pole, options) {
  return (!options || options.speeds !== false) && pole && Array.isArray(pole.speeds)
    ? pole.speeds.filter(speed => speed && Number.isFinite(speed.kmh)) : [];
}

function visibleGrades(pole, options) {
  if (!pole || (options && options.grades === false))
    return [];
  const grades = Array.isArray(pole.grades) && pole.grades.length ? pole.grades : [pole.grade];
  return grades.filter(Boolean).map(grade => ({ ...grade, text: formatGrade(grade) }))
    .filter(grade => grade.text);
}

function titleForFaces(speeds, grades) {
  const parts = [];
  for (const speed of speeds) {
    const route = speed.main === true ? ' \u00b7 main line' : speed.main === false ? ' \u00b7 branch' : '';
    const turn = speed.arrow === 'left' || speed.arrow === 'right' ? ` (${speed.arrow})` : '';
    const ahead = speed.speedChange === 'up' ? ' \u00b7 next limit increases by at least 20 km/h'
      : speed.speedChange === 'down' ? ' \u00b7 next limit decreases by at least 20 km/h' : '';
    parts.push(speed.kmh + ' km/h' + route + turn + ahead);
  }
  for (const grade of grades)
    parts.push('Grade ' + grade.text);
  return parts.join(' \u00b7 ');
}

function poleTitle(pole, options) {
  return titleForFaces(visibleSpeeds(pole, options), visibleGrades(pole, options));
}

// Grade on a regular pole goes under its single speed. A grade on a junction
// without a specific branch association gets its own column, not a guessed route.
function poleModel(pole, options) {
  const speeds = visibleSpeeds(pole, options);
  const grades = visibleGrades(pole, options);
  if (!speeds.length && !grades.length)
    return null;
  const columns = speeds.map(speed => ({ speed, grades: [] }));
  const standalone = [];
  for (const grade of grades) {
    const matching = grade.arrow === 'left' || grade.arrow === 'right'
      ? columns.filter(column => column.speed.arrow === grade.arrow) : columns;
    if (matching.length === 1)
      matching[0].grades.push(grade);
    else
      standalone.push(grade);
  }
  if (standalone.length)
    columns.push({ speed: null, grades: standalone });
  const heading = [pole.heading, ...speeds.map(speed => speed.heading), ...grades.map(grade => grade.heading)]
    .find(Number.isFinite);
  return { columns, heading: heading === undefined ? 0 : heading, title: titleForFaces(speeds, grades) };
}

function isMapPosition(position) {
  return Array.isArray(position) && Number.isFinite(position[0]) && Number.isFinite(position[1]);
}

// The mod's coordinates use the same linear meters-to-degrees scale on both axes.
function withinPlayerRange(position, players, radius) {
  if (!isMapPosition(position) || !Array.isArray(players) || !Number.isFinite(radius) || radius <= 0)
    return false;
  const radiusSquared = radius * radius;
  return players.some(player => isMapPosition(player) &&
    (position[0] - player[0]) ** 2 + (position[1] - player[1]) ** 2 <= radiusSquared);
}

// Leaflet uses east-positive X and south-positive Y. The right-hand normal of
// an applicable direction (north = 0°) is (cos, sin). Offset the whole card,
// not just its center, to that side of the track.
function placeBesideTrack(heading, width, height, occupied = []) {
  const angle = Number.isFinite(heading) ? heading : 0;
  const radians = angle * Math.PI / 180;
  const nx = Math.cos(radians);
  const ny = Math.sin(radians);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const normalExtent = Math.abs(nx) * halfWidth + Math.abs(ny) * halfHeight;
  let distance = normalExtent + 6;
  while (true) {
    const x = nx * distance;
    const y = ny * distance;
    const bounds = { left: x - halfWidth, top: y - halfHeight, right: x + halfWidth, bottom: y + halfHeight };
    const padded = { left: bounds.left - 2, top: bounds.top - 2, right: bounds.right + 2, bottom: bounds.bottom + 2 };
    const blockers = occupied.filter(other => rectsOverlap(padded, other));
    if (!blockers.length)
      return { x, y, angle, distance, bounds };
    // Keep same-side coincident cards just beyond what is already placed.
    const farthest = Math.max(...blockers.map(box =>
      nx * (nx >= 0 ? box.right : box.left) + ny * (ny >= 0 ? box.bottom : box.top)));
    distance = farthest + normalExtent + 2 * (Math.abs(nx) + Math.abs(ny)) + .01;
  }
}

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// 依输入顺序放置标牌：与已放置标牌或站名/道岔等既有元素重叠的标牌暂时省略。
function resolveCollisions(items, occupied) {
  const blocked = Array.isArray(occupied) ? occupied.slice() : [];
  const kept = [];
  for (const item of items || []) {
    if (!item || !item.rect)
      continue;
    if (blocked.some(other => other && rectsOverlap(item.rect, other)))
      continue;
    blocked.push(item.rect);
    kept.push(item);
  }
  return kept;
}

// Only direct, unambiguous ports form an ordered chain. Junctions, cycles and
// rails without a trustworthy association are not joined by nearest distance.
function buildRailSignTrackIndex(topology) {
  const tracks = new Map();
  for (const [id, points] of Object.entries(topology?.coords || {})) {
    if (!Array.isArray(points) || points.length < 2 || !points.every(isMapPosition))
      continue;
    const segments = [];
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      const [lat, lng] = points[i - 1];
      const dx = points[i][1] - lng, dy = lat - points[i][0];
      const span = Math.hypot(dx, dy);
      if (!span)
        continue;
      segments.push({ x: lng, y: -lat, dx, dy, span, start: length });
      length += span;
    }
    if (length)
      tracks.set(id, { segments, length });
  }

  const portKey = port => port && tracks.has(port.track) && (port.end === 'in' || port.end === 'out')
    ? port.track + '\u0000' + port.end : null;
  const junctionPorts = new Set();
  for (const junction of topology?.junctions || []) {
    for (const port of [junction.in, ...(junction.branches || [])])
      junctionPorts.add(portKey(port));
  }
  const links = new Map();
  const connect = (key, other) => {
    if (!links.has(key)) links.set(key, new Set());
    links.get(key).add(other);
  };
  for (const { a, b } of topology?.links || []) {
    const from = portKey(a), to = portKey(b);
    if (!from || !to || a.track === b.track || junctionPorts.has(from) || junctionPorts.has(to))
      continue;
    connect(from, to);
    connect(to, from);
  }
  const neighbor = key => {
    const ports = links.get(key);
    if (ports?.size !== 1) return null;
    const other = ports.values().next().value;
    return links.get(other)?.size === 1 ? other : null;
  };
  for (const id of [...tracks.keys()].sort()) {
    for (const end of ['in', 'out']) {
      const root = portKey({ track: id, end });
      if (tracks.get(id).chain || neighbor(root)) continue;
      let port = root, offset = 0;
      while (port) {
        const [trackId, entry] = port.split('\u0000');
        const track = tracks.get(trackId);
        if (track.chain) break;
        const forward = entry === 'in';
        Object.assign(track, { chain: root, forward, offset });
        offset += track.length;
        port = neighbor(portKey({ track: trackId, end: forward ? 'out' : 'in' }));
      }
    }
  }
  for (const [id, track] of tracks) {
    if (!track.chain) // a loop has no unambiguous start for a shared row
      Object.assign(track, { chain: portKey({ track: id, end: 'in' }), forward: true, offset: 0 });
  }
  return tracks;
}

function railSignTrackPosition(tracks, pole, heading, metersToDegrees) {
  const track = tracks?.get(pole.track);
  if (!track || !isMapPosition(pole.p) || !Number.isFinite(heading) || !(metersToDegrees > 0))
    return null;
  const angle = heading * Math.PI / 180;
  const tx = Math.sin(angle), ty = -Math.cos(angle);
  const [lat, lng] = pole.p;
  const candidates = [];
  for (const segment of track.segments) {
    const aligned = (tx * segment.dx + ty * segment.dy) / segment.span;
    if (Math.abs(aligned) < .82) continue;
    const x = lng - segment.x, y = -lat - segment.y;
    const t = Math.max(0, Math.min(1, (x * segment.dx + y * segment.dy) / segment.span ** 2));
    const error = Math.hypot(x - t * segment.dx, y - t * segment.dy);
    if (error <= 15 * metersToDegrees)
      candidates.push({ error, along: segment.start + t * segment.span, aligned });
  }
  candidates.sort((a, b) => a.error - b.error);
  const best = candidates[0];
  if (!best || candidates.some(candidate => candidate.error <= best.error + metersToDegrees &&
      Math.abs(candidate.along - best.along) > 12 * metersToDegrees))
    return null;
  const direction = (best.aligned > 0) === track.forward ? 1 : -1;
  const along = track.forward ? best.along : track.length - best.along;
  // Projection is solely for sequencing. Neither the marker nor its leader
  // is ever attached to the projected centreline position.
  return { lane: `${track.chain}\u0000${direction}`, order: (track.offset + along) * direction };
}

const GAP = 7;
const MIN_GAP = 5;
const MAX_LEADER_REACH = 42; // screen pixels from the pole to the nearest card edge
const EPS = .001;
const dot = (a, b) => a.x * b.x + a.y * b.y;
const right = axis => ({ x: -axis.y, y: axis.x });
const halfExtent = (node, axis) => (node.item.width * Math.abs(axis.x) + node.item.height * Math.abs(axis.y)) / 2;
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const shifted = (p, axis, d) => ({ x: p.x + axis.x * d, y: p.y + axis.y * d });
const sameLane = (a, b) => !!a.item.rail && a.item.rail.lane === b.item.rail?.lane;

function signSlot(node, point, mode) {
  const { x, y } = point;
  const w = node.item.width / 2, h = node.item.height / 2;
  return { x, y, mode, rect: { left: x - w, right: x + w, top: y - h, bottom: y + h } };
}

function boxesCollide(a, b, gap = 0) {
  return a.left < b.right + gap - EPS && b.left < a.right + gap - EPS &&
    a.top < b.bottom + gap - EPS && b.top < a.bottom + gap - EPS;
}

function overlapArea(a, b) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

// Bounds on a scalar displacement along a line inside a rectangle. Used for
// both viewport confinement and exact screen-space obstacle intervals.
function lineInterval(point, axis, rect) {
  let min = -Infinity, max = Infinity;
  for (const [value, rate, low, high] of [[point.x, axis.x, rect.left, rect.right], [point.y, axis.y, rect.top, rect.bottom]]) {
    if (high < low) return null;
    if (Math.abs(rate) < 1e-8) {
      if (value < low - EPS || value > high + EPS) return null;
      continue;
    }
    const a = (low - value) / rate, b = (high - value) / rate;
    min = Math.max(min, Math.min(a, b));
    max = Math.min(max, Math.max(a, b));
  }
  return min <= max ? [min, max] : null;
}

function distanceToCard(node, point) {
  const { anchor, width, height } = node.item;
  return Math.hypot(Math.max(0, Math.abs(point.x - anchor.x) - width / 2),
    Math.max(0, Math.abs(point.y - anchor.y) - height / 2));
}

function localTravelWindow(node, axis, view) {
  const w = node.item.width / 2, h = node.item.height / 2;
  const span = lineInterval(node.home, axis, { left: view.left + w, right: view.right - w,
    top: view.top + h, bottom: view.bottom - h });
  if (!span) return null;
  const reach = Math.max(MAX_LEADER_REACH, distanceToCard(node, node.home));
  // The allowed centres form a rectangle expanded by a disk around the pole.
  // Along any ray starting at home, there is only one boundary to find.
  const cap = distance => {
    if (distanceToCard(node, shifted(node.home, axis, distance)) <= reach) return distance;
    let low = 0, high = 1;
    for (let i = 0; i < 22; i++) {
      const mid = (low + high) / 2;
      if (distanceToCard(node, shifted(node.home, axis, distance * mid)) <= reach) low = mid;
      else high = mid;
    }
    return distance * low;
  };
  const min = span[0] < 0 ? cap(span[0]) : span[0];
  const max = span[1] > 0 ? cap(span[1]) : span[1];
  return min <= max ? [min, max] : null;
}

function blockingInterval(node, axis, rect, gap) {
  const w = node.item.width / 2 + gap, h = node.item.height / 2 + gap;
  return lineInterval(node.home, axis, { left: rect.left - w, right: rect.right + w,
    top: rect.top - h, bottom: rect.bottom + h });
}

function packingOffsets(row, gap) {
  let offset = 0;
  return row.map((item, i) => {
    if (i) offset += Math.max(EPS, item.extent + row[i - 1].extent + gap);
    return offset;
  });
}

// Bounded isotonic regression: find the closest ordered centres for a common
// separation, without making the first card a fixed obstacle to its neighbours.
function packRow(row, offsets) {
  const blocks = [];
  for (const [i, item] of row.entries()) {
    const lo = item.min - offsets[i], hi = item.max - offsets[i];
    if (lo > hi) return null;
    const target = item.target - offsets[i];
    blocks.push({ start: i, lo, hi, sum: target, count: 1, value: clamp(target, lo, hi) });
    while (blocks.length > 1) {
      const a = blocks[blocks.length - 2], b = blocks[blocks.length - 1];
      if (a.value <= b.value + EPS) break;
      a.lo = Math.max(a.lo, b.lo);
      a.hi = Math.min(a.hi, b.hi);
      if (a.lo > a.hi) return null;
      a.count += b.count;
      a.sum += b.sum;
      a.value = clamp(a.sum / a.count, a.lo, a.hi);
      blocks.pop();
    }
  }
  const result = [];
  for (const { start, count, value } of blocks) {
    for (let i = start; i < start + count; i++) result[i] = value + offsets[i];
  }
  return result;
}

function unblockedIntervals(item, obstacles, gap) {
  const { node, scale, target, min, max } = item;
  const banned = [];
  for (const rect of obstacles) {
    const interval = blockingInterval(node, node.axis, rect, gap);
    if (interval) {
      const a = target + interval[0] * scale, b = target + interval[1] * scale;
      if (b > min && a < max) banned.push([a, b]);
    }
  }
  banned.sort((a, b) => a[0] - b[0]);
  const free = [];
  let at = min;
  for (const [a, b] of banned) {
    if (a > at) free.push([at, a]);
    at = Math.max(at, b);
    if (at > max) break;
  }
  if (at <= max) free.push([at, max]);
  return free;
}

function packAroundObstacles(row, offsets, obstacles, gap, preferred) {
  const windows = row.map(item => unblockedIntervals(item, obstacles, gap));
  // A reverse pass reserves enough ordered space for the cards that follow.
  const latest = [];
  for (let i = row.length - 1; i >= 0; i--) {
    const limit = i + 1 < row.length ? latest[i + 1] - (offsets[i + 1] - offsets[i]) : row[i].max;
    const free = windows[i];
    let last = free.length - 1;
    while (last >= 0 && free[last][0] > limit + EPS) last--;
    if (last < 0) return null;
    latest[i] = Math.min(free[last][1], limit);
  }
  const result = [];
  for (const [i, item] of row.entries()) {
    const limit = i ? result[i - 1] + (offsets[i] - offsets[i - 1]) : item.min;
    const target = preferred?.[i] ?? item.target;
    let best = null;
    for (const [a, b] of windows[i]) {
      const low = Math.max(a, limit), high = Math.min(b, latest[i]);
      if (low > high + EPS) continue;
      const value = clamp(target, low, high);
      if (best === null || Math.abs(value - target) < Math.abs(best - target)) best = value;
    }
    if (best === null) return null;
    result.push(best);
  }
  return result;
}

function alongRow(group, axis, packingAxis, limits, view) {
  const row = group.map((node, i) => {
    const scale = dot(node.axis, packingAxis), along = dot(node.axis, axis);
    const span = localTravelWindow(node, node.axis, view);
    if (!span || scale < .18) return null;
    const target = dot(node.home, packingAxis), original = dot(node.home, axis);
    const min = Math.max(span[0], (limits[i][0] - original) / along);
    const max = Math.min(span[1], (limits[i][1] - original) / along);
    if (min > max + EPS) return null;
    return { node, scale, target, extent: halfExtent(node, packingAxis), min: target + min * scale, max: target + max * scale };
  });
  return row.some(item => !item) ? null : row;
}

function rowSlots(row, axis, positions, mode) {
  if (!positions) return null;
  const slots = positions.map((value, i) => {
    const { node, scale, target } = row[i];
    return signSlot(node, shifted(node.home, node.axis, (value - target) / scale), mode);
  });
  return slots.every((slot, i) => !i || dot(slot, axis) >= dot(slots[i - 1], axis) - EPS) ? slots : null;
}

function alongSlots(row, axis, obstacles, gap) {
  const offsets = packingOffsets(row, gap);
  const preferred = packRow(row, offsets);
  if (!preferred) return null;
  const slots = rowSlots(row, axis, preferred, 'along');
  if (slots && slotsClear(slots, obstacles, gap)) return slots;
  const around = rowSlots(row, axis, packAroundObstacles(row, offsets, obstacles, gap, preferred), 'along');
  return around && slotsClear(around, obstacles, gap) ? around : slots;
}

function compressedSlots(row, axis) {
  // Tight viewports and dense junctions may only fit a slightly overlapping row.
  let low = -2 * Math.max(...row.map(item => item.extent)), high = GAP;
  let slots = rowSlots(row, axis, packRow(row, packingOffsets(row, low)), 'compact');
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;
    const next = rowSlots(row, axis, packRow(row, packingOffsets(row, mid)), mid < -EPS ? 'compact' : 'along');
    if (next) { low = mid; slots = next; }
    else high = mid;
  }
  return slots;
}

function slotsClear(slots, obstacles, gap) {
  return slots.every((slot, i) => !obstacles.some(rect => boxesCollide(slot.rect, rect, gap)) &&
    !slots.slice(0, i).some(other => boxesCollide(slot.rect, other.rect, gap)));
}

function outwardSlots(group, axis, limits, obstacles, view, gap) {
  const normal = right(axis);
  const slots = [];
  let ordered = -Infinity;
  for (const [i, node] of group.entries()) {
    const coordinate = dot(node.home, axis);
    if (coordinate < Math.max(ordered, limits[i][0]) - EPS || coordinate > limits[i][1] + EPS)
      return null;
    ordered = coordinate;
    const span = localTravelWindow(node, normal, view);
    const start = Math.max(0, span?.[0] ?? 0);
    const max = span && span[1] >= start ? span[1] : 0;
    const blocked = obstacles.concat(slots.map(slot => slot.rect));
    let chosen = node.home, bestOverflow = Infinity, bestOverlap = Infinity;
    let distance = Math.min(start, max);
    for (let layer = 0; layer < 3; layer++) {
      const slot = signSlot(node, shifted(node.home, normal, distance), distance ? 'outward' : 'home');
      const hits = blocked.filter(rect => boxesCollide(slot.rect, rect, gap));
      const overflow = node.item.width * node.item.height - overlapArea(slot.rect, view);
      const overlap = hits.reduce((sum, rect) => sum + overlapArea(slot.rect, rect), 0);
      if (overflow < bestOverflow - EPS || (overflow <= bestOverflow + EPS && overlap < bestOverlap - EPS)) {
        chosen = slot;
        bestOverflow = overflow;
        bestOverlap = overlap;
      }
      if (!hits.length) {
        if (overflow < EPS) chosen = slot;
        break;
      }
      // Move only far enough to clear the actual blocking edges along this ray.
      // A distant or wide card elsewhere in the group does not set a layer step.
      let next = distance;
      for (const rect of hits) {
        const interval = blockingInterval(node, normal, rect, gap);
        if (interval) next = Math.max(next, interval[1] + EPS);
      }
      next = Math.min(max, next);
      if (next <= distance + EPS) break;
      distance = next;
    }
    slots.push(chosen);
  }
  return slots;
}

function layoutScore(group, slots, obstacles, view) {
  let overflow = 0, overlap = 0, longest = 0, motion = 0;
  const blocked = obstacles.slice();
  for (const [i, slot] of slots.entries()) {
    overflow += group[i].item.width * group[i].item.height - overlapArea(slot.rect, view);
    overlap += blocked.reduce((sum, rect) => sum + overlapArea(slot.rect, rect), 0);
    longest = Math.max(longest, distanceToCard(group[i], slot));
    motion += (slot.x - group[i].home.x) ** 2 + (slot.y - group[i].home.y) ** 2;
    blocked.push(slot.rect);
  }
  return [overflow, overlap, longest, motion];
}

function betterLayout(a, b) {
  if (!b) return true;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > EPS) return a[i] < b[i];
  }
  return false;
}

function nearbySlots(group, axis, limits, blocked, view) {
  const rows = [];
  if (group[0].item.rail) {
    // Pack against actual screen widths/heights in each useful direction. A
    // diagonal projection of the full rectangle stacks too much empty space.
    for (const direction of [{ x: Math.sign(axis.x), y: 0 }, { x: 0, y: Math.sign(axis.y) }]) {
      const row = alongRow(group, axis, direction, limits, view);
      if (row) rows.push(row);
    }
  }
  let fallback = null, fallbackScore = null;
  for (const gap of [GAP, MIN_GAP, 0]) {
    let best = null, bestScore = null;
    const candidates = [outwardSlots(group, axis, limits, blocked, view, gap), ...rows.map(row => alongSlots(row, axis, blocked, gap))];
    for (const slots of candidates) {
      if (!slots) continue;
      const score = layoutScore(group, slots, blocked, view);
      if (betterLayout(score, fallbackScore)) { fallback = slots; fallbackScore = score; }
      if (score[0] < EPS && slotsClear(slots, blocked, gap) && betterLayout(score, bestScore)) {
        best = slots;
        bestScore = score;
      }
    }
    if (best) return best;
  }
  for (const row of rows) {
    const slots = compressedSlots(row, axis);
    if (!slots) continue;
    const score = layoutScore(group, slots, blocked, view);
    if (betterLayout(score, fallbackScore)) { fallback = slots; fallbackScore = score; }
  }
  return fallback;
}

function layoutRailSignCards(items, size, obstacles = []) {
  const nodes = items.map((item, i) => {
    const r = item.heading * Math.PI / 180;
    const node = { item, i, axis: { x: Math.sin(r), y: -Math.cos(r) }, active: false };
    const normal = right(node.axis);
    node.home = signSlot(node, shifted(item.anchor, normal, halfExtent(node, normal) + 6), 'home');
    node.slot = node.home;
    return node;
  });
  const parent = nodes.map((_, i) => i);
  const root = i => {
    while (i !== parent[i]) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const sweep = nodes.slice().sort((a, b) => a.home.rect.left - b.home.rect.left);
  for (let i = 0; i < sweep.length; i++) {
    const a = sweep[i];
    for (let j = i + 1; j < sweep.length && sweep[j].home.rect.left < a.home.rect.right; j++) {
      const b = sweep[j];
      if (!boxesCollide(a.home.rect, b.home.rect)) continue;
      a.active = b.active = true;
      if (sameLane(a, b) && dot(a.axis, b.axis) >= .82)
        parent[root(b.i)] = root(a.i);
    }
  }
  const spatial = (a, b) => a.item.anchor.x - b.item.anchor.x || a.item.anchor.y - b.item.anchor.y || a.i - b.i;
  const groups = new Map();
  for (const node of nodes.filter(node => node.active).sort(spatial)) {
    const key = root(node.i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const view = { left: 0, top: 0, right: size.x, bottom: size.y };
  for (const group of groups.values()) {
    group.sort((a, b) => (a.item.rail?.order - b.item.rail?.order || 0) || spatial(a, b));
    const sum = group.reduce((v, node) => ({ x: v.x + node.axis.x, y: v.y + node.axis.y }), { x: 0, y: 0 });
    const norm = Math.hypot(sum.x, sum.y);
    const axis = norm ? { x: sum.x / norm, y: sum.y / norm } : group[0].axis;
    // A sharp turn or folded projection has no single safe slide axis.
    if (group.some((node, i) => dot(node.axis, axis) < .82 || (i > 0 &&
        dot(node.item.anchor, axis) < dot(group[i - 1].item.anchor, axis) - EPS))) continue;
    const members = new Set(group);
    const others = nodes.filter(node => !members.has(node));
    const limits = group.map(node => {
      let lo = -Infinity, hi = Infinity;
      for (const other of others) {
        if (!sameLane(node, other) || dot(other.axis, axis) < .82) continue;
        const d = other.item.rail.order - node.item.rail.order;
        const projected = dot(other.item.anchor, axis) - dot(node.item.anchor, axis);
        if (d > 0 && projected >= -EPS) hi = Math.min(hi, dot(other.slot, axis));
        if (d < 0 && projected <= EPS) lo = Math.max(lo, dot(other.slot, axis));
      }
      return [lo, hi];
    });
    const blocked = obstacles.concat(others.map(other => other.slot.rect));
    const slots = nearbySlots(group, axis, limits, blocked, view);
    if (slots) group.forEach((node, i) => { node.slot = slots[i]; });
  }
  return nodes.map(node => node.slot);
}

// Range selection for the map overlay. 'world' removes the player filter;
// 'local' keeps only the player running this game, and falls back to every
// online player when that position is unknown (dedicated server). The caller
// still culls to the viewport, so 'world' does not load every pole in the world.
function rangePlayers(players, localPosition, scope) {
  const list = Array.isArray(players) ? players : [];
  if (scope === 'world')
    return null;
  if (scope !== 'players' && isMapPosition(localPosition))
    return [localPosition];
  return list;
}

const api = {
  formatGrade: formatGrade,
  poleTitle: poleTitle,
  poleModel: poleModel,
  isMapPosition: isMapPosition,
  withinPlayerRange: withinPlayerRange,
  rangePlayers: rangePlayers,
  placeBesideTrack: placeBesideTrack,
  rectsOverlap: rectsOverlap,
  resolveCollisions: resolveCollisions,
  buildRailSignTrackIndex: buildRailSignTrackIndex,
  railSignTrackPosition: railSignTrackPosition,
  layoutRailSignCards: layoutRailSignCards,
};

global.SignsLib = api;
if (typeof module !== 'undefined' && module.exports)
  module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
