// DV RemoteDispatch - dispatch.js
// Variable-height virtual list used by the dispatch sidebar. Only cards that
// intersect the scroll viewport (plus a small overscan) are mounted in the DOM.
(function (global) {
'use strict';

class VirtualList {
  constructor(container, options) {
    this.container = container;
    this.options = options || {};
    this.gap = this.options.gap ?? 6;
    this.overscan = this.options.overscan ?? 300;
    this.estimateHeight = this.options.estimateHeight ?? 40;
    this.items = [];
    this.heights = new Map();
    this.mounted = new Map();
    this.frame = null;

    this.inner = document.createElement('div');
    this.inner.className = 'vlist-inner';
    this.container.appendChild(this.inner);

    this.onScroll = () => this.schedule();
    this.container.addEventListener('scroll', this.onScroll, { passive: true });

    this.resizeObserver = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const key = entry.target.dataset.vlistKey;
        if (!key || !this.mounted.has(key)) continue;
        const height = entry.target.offsetHeight;
        if (height > 0 && this.heights.get(key) !== height) {
          this.heights.set(key, height);
          changed = true;
        }
      }
      if (changed) this.schedule();
    });
  }

  setItems(items, options) {
    const opts = options || {};
    const nextKeys = new Set((items || []).map(item => item.key));
    for (const [key, entry] of Array.from(this.mounted.entries())) {
      if (!nextKeys.has(key)) {
        this.resizeObserver.unobserve(entry.el);
        entry.el.remove();
        this.mounted.delete(key);
      }
    }
    for (const key of Array.from(this.heights.keys())) {
      if (!nextKeys.has(key)) this.heights.delete(key);
    }

    this.items = (items || []).slice();
    for (const item of this.items) {
      const entry = this.mounted.get(item.key);
      if (!entry) continue;
      entry.item = item;
      if (opts.forceRender) {
        const el = this.options.render(item, this);
        el.dataset.vlistKey = item.key;
        el.style.position = 'absolute';
        el.style.left = '0';
        el.style.right = '0';
        el.style.top = entry.el.style.top || '0px';
        this.resizeObserver.unobserve(entry.el);
        entry.el.replaceWith(el);
        entry.el = el;
        this.resizeObserver.observe(el);
        const height = el.offsetHeight;
        if (height > 0)
          this.heights.set(item.key, height);
      } else if (this.options.update) {
        this.options.update(entry.el, item, this);
      }
    }
    this.layout();
  }

  positions() {
    const positions = [];
    let top = 0;
    for (const item of this.items) {
      const height = this.heights.get(item.key) ?? this.estimateHeight;
      positions.push({ item: item, top: top, height: height });
      top += height + this.gap;
    }
    return { positions: positions, total: Math.max(0, top - this.gap) };
  }

  layout() {
    this.frame = null;
    const layout = this.positions();
    this.inner.style.height = layout.total + 'px';

    const viewTop = this.container.scrollTop - this.overscan;
    const viewBottom = this.container.scrollTop + this.container.clientHeight + this.overscan;
    const visible = new Set();
    let remeasured = false;

    for (const position of layout.positions) {
      const intersects = position.top + position.height >= viewTop && position.top <= viewBottom;
      if (!intersects) continue;
      visible.add(position.item.key);
      let entry = this.mounted.get(position.item.key);
      if (!entry) {
        const el = this.options.render(position.item, this);
        el.dataset.vlistKey = position.item.key;
        el.style.position = 'absolute';
        el.style.left = '0';
        el.style.right = '0';
        entry = { el: el, item: position.item };
        this.mounted.set(position.item.key, entry);
        this.inner.appendChild(el);
        this.resizeObserver.observe(el);
        const height = el.offsetHeight;
        if (height > 0) {
          if (Math.abs(height - position.height) > 0.5)
            remeasured = true;
          this.heights.set(position.item.key, height);
        }
      }
      entry.el.style.top = position.top + 'px';
    }

    for (const [key, entry] of Array.from(this.mounted.entries())) {
      if (visible.has(key)) continue;
      this.resizeObserver.unobserve(entry.el);
      entry.el.remove();
      this.mounted.delete(key);
    }
    if (remeasured)
      this.schedule();
  }

  schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => this.layout());
  }

  refreshItem(key) {
    const entry = this.mounted.get(key);
    if (!entry) {
      this.schedule();
      return;
    }
    const height = entry.el.offsetHeight;
    if (height > 0 && this.heights.get(key) !== height) {
      this.heights.set(key, height);
      this.schedule();
    }
  }

  scrollToKey(key) {
    const layout = this.positions();
    const found = layout.positions.find(p => p.item.key === key);
    if (!found) return;
    const top = found.top;
    if (top < this.container.scrollTop || top + found.height > this.container.scrollTop + this.container.clientHeight)
      this.container.scrollTop = Math.max(0, top - 12);
    this.schedule();
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.container.removeEventListener('scroll', this.onScroll);
    this.resizeObserver.disconnect();
    this.inner.remove();
    this.mounted.clear();
  }
}

global.DispatchLib = {
  VirtualList: VirtualList,
  indexAssignments: indexAssignments,
  assignedJobIds: assignedJobIds,
};
if (typeof module !== 'undefined' && module.exports)
  module.exports = global.DispatchLib;

/**
 * Build authoritative indexes from a flat assignment list.
 * A job can belong to only one player; assignments are ordered by `order`.
 */
function indexAssignments(assignments) {
  const all = (assignments || []).filter(Boolean).slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const byJob = new Map();
  const byPlayer = new Map();
  for (const assignment of all) {
    if (!assignment || !assignment.jobId || !assignment.player)
      continue;
    const previous = byJob.get(assignment.jobId);
    if (previous) {
      const previousPlayer = byPlayer.get(previous.player);
      if (previousPlayer) {
        const index = previousPlayer.jobs.findIndex(job => job.jobId === assignment.jobId);
        if (index !== -1)
          previousPlayer.jobs.splice(index, 1);
      }
    }
    byJob.set(assignment.jobId, assignment);
    let player = byPlayer.get(assignment.player);
    if (!player) {
      player = { player: assignment.player, playerName: assignment.playerName || assignment.player, jobs: [] };
      byPlayer.set(assignment.player, player);
    }
    player.playerName = assignment.playerName || player.playerName;
    player.jobs.push(assignment);
  }
  for (const player of byPlayer.values())
    player.jobs.sort((a, b) => (a.order || 0) - (b.order || 0));
  return { byJob: byJob, byPlayer: byPlayer };
}

/** Ordered, de-duplicated live job ids for one player. */
function assignedJobIds(index, playerId, isLive) {
  if (!index || !index.byPlayer)
    return [];
  const player = index.byPlayer.get(playerId);
  if (!player)
    return [];
  const seen = new Set();
  const result = [];
  for (const assignment of player.jobs) {
    if (seen.has(assignment.jobId)) continue;
    if (isLive && !isLive(assignment.jobId)) continue;
    seen.add(assignment.jobId);
    result.push(assignment.jobId);
  }
  return result;
}
})(typeof window !== 'undefined' ? window : globalThis);
