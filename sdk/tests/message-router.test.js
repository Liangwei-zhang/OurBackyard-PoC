import { MessageRouter } from '../src/sync/message-router.js';
import config from '../src/config.js';

describe('MessageRouter', () => {
  let router;
  beforeEach(() => {
    router = new MessageRouter();
    config.reset();
  });

  test('routes message to registered handler', () => {
    const calls = [];
    router.on('chat', msg => calls.push(msg));
    router.route({ id: '1', type: 'chat', text: 'hi' });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('hi');
  });

  test('deduplicates by id — same id not routed twice', () => {
    const calls = [];
    router.on('chat', msg => calls.push(msg));
    router.route({ id: 'abc', type: 'chat' });
    router.route({ id: 'abc', type: 'chat' });
    expect(calls).toHaveLength(1);
  });

  test('messages without id are not deduped (stateless)', () => {
    const calls = [];
    router.on('ping', msg => calls.push(msg));
    router.route({ type: 'ping' });
    router.route({ type: 'ping' });
    expect(calls).toHaveLength(2);
  });

  test('wildcard handler receives all message types', () => {
    const types = [];
    router.on('*', msg => types.push(msg.type));
    router.route({ id: '1', type: 'a' });
    router.route({ id: '2', type: 'b' });
    expect(types).toEqual(['a', 'b']);
  });

  test('drops non-object messages', () => {
    expect(router.route('not-an-object')).toBe(false);
    expect(router.route(null)).toBe(false);
  });

  test('drops messages without type', () => {
    const calls = [];
    router.on('*', msg => calls.push(msg));
    expect(router.route({ id: '1' })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('drops oversized messages', () => {
    config.set('router.maxMessageBytes', 10);
    const calls = [];
    router.on('big', msg => calls.push(msg));
    expect(router.route({ id: '1', type: 'big', data: 'x'.repeat(100) })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('LRU eviction at capacity — oldest entry evicted', () => {
    config.set('router.dedupCapacity', 3);
    router = new MessageRouter(); // fresh router picks up new config
    const calls = [];
    router.on('t', msg => calls.push(msg.id));

    router.route({ id: '1', type: 't' });
    router.route({ id: '2', type: 't' });
    router.route({ id: '3', type: 't' });
    // Now at capacity — '1' should be evicted
    router.route({ id: '4', type: 't' }); // evicts '1'
    // '1' should be re-accepted now
    router.route({ id: '1', type: 't' });
    expect(calls).toEqual(['1', '2', '3', '4', '1']);
  });

  test('handler errors are isolated', () => {
    const calls = [];
    router.on('safe', msg => calls.push(msg.id));
    router.on('safe', () => { throw new Error('boom'); });
    // Both handlers registered; error in second should not stop first
    router.route({ id: 'x1', type: 'safe' });
    expect(calls).toEqual(['x1']);
  });

  test('off() removes handler', () => {
    const calls = [];
    const fn = msg => calls.push(msg);
    router.on('evt', fn);
    router.off('evt', fn);
    router.route({ id: 'y1', type: 'evt' });
    expect(calls).toHaveLength(0);
  });

  test('hasSeen() returns true after routing', () => {
    router.route({ id: 'seen-me', type: 't' });
    expect(router.hasSeen('seen-me')).toBe(true);
  });

  test('clearSeen() resets dedup state', () => {
    const calls = [];
    router.on('clr', msg => calls.push(msg));
    router.route({ id: 'dup', type: 'clr' });
    router.clearSeen();
    router.route({ id: 'dup', type: 'clr' });
    expect(calls).toHaveLength(2);
  });
});
