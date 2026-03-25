/**
 * Tests for MessageRouter
 * Run with: node --test sdk/tests/message-router.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MessageRouter, Priority } from '../src/sync/message-router.js';

describe('MessageRouter', () => {
  it('should route a message to a registered handler', async () => {
    const router = new MessageRouter();
    const received = [];
    router.handle('PING', (from, msg) => received.push({ from, msg }));

    const result = await router.route('peer1', { type: 'PING', id: '1', data: 'hello' });
    assert.ok(result);
    assert.equal(received.length, 1);
    assert.equal(received[0].from, 'peer1');
  });

  it('should deduplicate messages by id', async () => {
    const router = new MessageRouter();
    let count = 0;
    router.handle('MSG', () => count++);

    await router.route('p1', { type: 'MSG', id: 'dup1' });
    await router.route('p1', { type: 'MSG', id: 'dup1' });
    await router.route('p1', { type: 'MSG', id: 'dup1' });

    assert.equal(count, 1);
    assert.equal(router.metrics.duplicates, 2);
  });

  it('should not deduplicate messages without id', async () => {
    const router = new MessageRouter();
    let count = 0;
    router.handle('MSG', () => count++);

    await router.route('p1', { type: 'MSG' });
    await router.route('p1', { type: 'MSG' });

    assert.equal(count, 2);
  });

  it('should emit route:unhandled for unknown type', async () => {
    const router = new MessageRouter();
    const unhandled = [];
    router.on('route:unhandled', (type) => unhandled.push(type));

    await router.route('p1', { type: 'UNKNOWN', id: 'u1' });
    assert.equal(unhandled.length, 1);
    assert.equal(unhandled[0], 'UNKNOWN');
  });

  it('should support wildcard handler (*)', async () => {
    const router = new MessageRouter();
    const all = [];
    router.handle('*', (from, msg) => all.push(msg.type));
    router.handle('PING', () => {});

    await router.route('p1', { type: 'PING', id: 'w1' });
    await router.route('p1', { type: 'PONG', id: 'w2' });

    assert.ok(all.includes('PING'));
    assert.ok(all.includes('PONG'));
  });

  it('should track metrics', async () => {
    const router = new MessageRouter();
    router.handle('A', () => {});
    router.handle('B', () => { throw new Error('handler error'); });

    await router.route('p1', { type: 'A', id: 'm1' });
    await router.route('p1', { type: 'B', id: 'm2' });

    assert.equal(router.metrics.routed, 2);
    assert.equal(router.metrics.invoked, 2);
    assert.equal(router.metrics.errors, 1);
  });

  it('should timeout slow handlers', async () => {
    const router = new MessageRouter({ handlerTimeoutMs: 50 });
    let errored = false;
    router.handle('SLOW', () => new Promise(r => setTimeout(r, 200)));
    router.on('route:error', () => { errored = true; });

    await router.route('p1', { type: 'SLOW', id: 's1' });
    assert.ok(errored);
    assert.equal(router.metrics.errors, 1);
  });

  it('should unhandle a specific handler', async () => {
    const router = new MessageRouter();
    let count = 0;
    const fn = () => count++;
    router.handle('MSG', fn);
    router.unhandle('MSG', fn);

    await router.route('p1', { type: 'MSG', id: 'u1' });
    assert.equal(count, 0);
  });

  it('should call handlers sorted by priority', async () => {
    const router = new MessageRouter();
    const order = [];
    router.handle('MSG', () => order.push('normal'), Priority.NORMAL);
    router.handle('MSG', () => order.push('high'), Priority.HIGH);
    router.handle('MSG', () => order.push('low'), Priority.LOW);

    await router.route('p1', { type: 'MSG', id: 'p1' });
    assert.deepStrictEqual(order, ['high', 'normal', 'low']);
  });

  it('should evict old dedup entries at capacity', async () => {
    const router = new MessageRouter({ dedupCapacity: 3 });
    let count = 0;
    router.handle('MSG', () => count++);

    await router.route('p1', { type: 'MSG', id: 'a' });
    await router.route('p1', { type: 'MSG', id: 'b' });
    await router.route('p1', { type: 'MSG', id: 'c' });
    // Now capacity is full: 'a', 'b', 'c'
    await router.route('p1', { type: 'MSG', id: 'd' }); // evicts 'a'
    // 'a' should no longer be in dedup set
    await router.route('p1', { type: 'MSG', id: 'a' }); // should process again
    assert.equal(count, 5); // a, b, c, d, a (second time)
  });

  it('should reset metrics', () => {
    const router = new MessageRouter();
    router.metrics.routed = 99;
    router.resetMetrics();
    assert.equal(router.metrics.routed, 0);
  });

  it('should throw on invalid handle arguments', () => {
    const router = new MessageRouter();
    assert.throws(() => router.handle('', () => {}), /non-empty string/);
    assert.throws(() => router.handle('MSG', 'notfn'), /function/);
  });

  it('should return false for empty/invalid messages', async () => {
    const router = new MessageRouter();
    assert.equal(await router.route('p1', null), false);
    assert.equal(await router.route('p1', {}), false);
    assert.equal(await router.route('p1', { type: '' }), false);
  });
});
