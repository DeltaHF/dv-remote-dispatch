'use strict';

// DV RemoteDispatch - tests/dispatch.test.js
// 共享任务分配索引与“第一单”顺序的纯函数测试。运行：node --test tests/dispatch.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert');

const DispatchLib = require('../dispatch.js');

describe('分配索引', () => {
  it('按 order 排序，同一玩家多单按分配先后排列', () => {
    const index = DispatchLib.indexAssignments([
      { jobId: 'j2', player: 'alice', playerName: 'Alice', order: 2 },
      { jobId: 'j1', player: 'alice', playerName: 'Alice', order: 1 },
      { jobId: 'j3', player: 'bob', playerName: 'Bob', order: 3 },
    ]);
    assert.deepStrictEqual(index.byPlayer.get('alice').jobs.map(a => a.jobId), ['j1', 'j2']);
    assert.deepStrictEqual(index.byPlayer.get('bob').jobs.map(a => a.jobId), ['j3']);
    assert.strictEqual(index.byJob.get('j2').player, 'alice');
  });

  it('同一任务在多玩家列表中只保留最后一处，一单一人的服务端约束不被前端放大', () => {
    const index = DispatchLib.indexAssignments([
      { jobId: 'j1', player: 'alice', order: 1 },
      { jobId: 'j1', player: 'bob', order: 2 },
    ]);
    assert.strictEqual(index.byJob.size, 1);
    assert.strictEqual(index.byJob.get('j1').player, 'bob');
    assert.deepStrictEqual(index.byPlayer.get('alice').jobs, []);
  });

  it('忽略缺少 jobId 或 player 的非法项', () => {
    const index = DispatchLib.indexAssignments([
      null,
      { jobId: '', player: 'alice' },
      { jobId: 'j1', player: '' },
      { jobId: 'j2', player: 'alice', order: 1 },
    ]);
    assert.deepStrictEqual(Array.from(index.byJob.keys()), ['j2']);
  });
});

describe('玩家任务顺序与第一单', () => {
  const index = DispatchLib.indexAssignments([
    { jobId: 'missing', player: 'alice', order: 1 },
    { jobId: 'j2', player: 'alice', order: 2 },
    { jobId: 'j3', player: 'alice', order: 3 },
  ]);

  it('过滤已不存在的任务，保留分配顺序', () => {
    const live = new Set(['j2', 'j3']);
    assert.deepStrictEqual(
      DispatchLib.assignedJobIds(index, 'alice', id => live.has(id)),
      ['j2', 'j3']
    );
  });

  it('第一单是可用的最早一张，不静默跳到后面的任务', () => {
    const live = new Set(['j2', 'j3']);
    const ids = DispatchLib.assignedJobIds(index, 'alice', id => live.has(id));
    assert.strictEqual(ids[0], 'j2');
  });

  it('第一单失效时返回下一张，但不会改用第二张替代第一单的语义', () => {
    const live = new Set(['j3']);
    assert.deepStrictEqual(
      DispatchLib.assignedJobIds(index, 'alice', id => live.has(id)),
      ['j3']
    );
  });

  it('未绑定玩家返回空数组', () => {
    assert.deepStrictEqual(DispatchLib.assignedJobIds(index, 'nobody', () => true), []);
    assert.deepStrictEqual(DispatchLib.assignedJobIds(null, 'alice', () => true), []);
  });
});
