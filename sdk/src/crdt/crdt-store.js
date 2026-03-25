/**
 * CRDTStore — Registry managing CRDT instances with gossip integration.
 *
 * Manages named CRDT documents. Local operations are applied and broadcast
 * to peers via the MessageRouter. Incoming remote operations are merged
 * automatically.
 *
 * Supported CRDT types: 'lww-register', 'g-counter', 'or-set'
 *
 * Events emitted:
 *   'update'   (docId, newState, operation)
 *   'conflict' (docId, localState, remoteState)  — currently unused; reserved
 */

import { EventBus } from '../event-bus.js';
import { LWWRegister } from './lww-register.js';
import { GCounter } from './g-counter.js';
import { ORSet } from './or-set.js';

const CRDT_OP   = 'CRDT_OP';
const CRDT_SYNC = 'CRDT_SYNC';

export class CRDTStore extends EventBus {
  /**
   * @param {object} opts
   * @param {import('../sync/message-router.js').MessageRouter} opts.router
   * @param {string} opts.peerId
   */
  constructor({ router, peerId }) {
    super();
    this._router = router;
    this._peerId = peerId;

    /** @type {Map<string, { type: string, crdt: LWWRegister|GCounter|ORSet }>} */
    this._docs = new Map();

    // Register message handlers
    router.handle(CRDT_OP,   (from, msg) => this._handleOp(from, msg));
    router.handle(CRDT_SYNC, (from, msg) => this._handleSync(from, msg));
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Register a CRDT document. If a document with the same ID already exists,
   * the call is a no-op.
   * @param {string} docId
   * @param {'lww-register'|'g-counter'|'or-set'} crdtType
   * @param {*} [initialState] — Serialized initial state (from toJSON / storage)
   */
  register(docId, crdtType, initialState) {
    if (this._docs.has(docId)) return;
    const crdt = this._createCRDT(crdtType, initialState);
    this._docs.set(docId, { type: crdtType, crdt });
  }

  /**
   * Apply a local operation to a registered document and broadcast it.
   * @param {string} docId
   * @param {*} operation — For lww-register: value; for g-counter: number; for or-set: { op: 'add'|'remove', element }
   * @returns {*} new state from toJSON()
   */
  apply(docId, operation) {
    const doc = this._docs.get(docId);
    if (!doc) throw new Error(`CRDTStore: document "${docId}" not registered`);

    this._applyLocal(doc, operation);
    const newState = doc.crdt.toJSON();

    // Broadcast the full state (simple state-based CRDT replication)
    this._router.broadcast(CRDT_OP, { docId, type: doc.type, state: newState });
    this.emit('update', docId, newState, operation);
    return newState;
  }

  /**
   * Get current serialized state of a document.
   * @param {string} docId
   * @returns {*}
   */
  get(docId) {
    const doc = this._docs.get(docId);
    if (!doc) return null;
    return doc.crdt.toJSON();
  }

  /**
   * Request a full state sync from a peer for all registered documents.
   * @param {string} peerId
   */
  syncWith(peerId) {
    const snapshot = {};
    for (const [docId, { type, crdt }] of this._docs) {
      snapshot[docId] = { type, state: crdt.toJSON() };
    }
    this._router.send(peerId, CRDT_SYNC, { snapshot });
  }

  // ─────────────────────────── Internal ───────────────────────────

  _createCRDT(type, initialState) {
    switch (type) {
      case 'lww-register': return LWWRegister.fromJSON(this._peerId, initialState);
      case 'g-counter':    return GCounter.fromJSON(this._peerId, initialState);
      case 'or-set':       return ORSet.fromJSON(this._peerId, initialState);
      default:
        throw new Error(`CRDTStore: unknown CRDT type "${type}"`);
    }
  }

  _applyLocal(doc, operation) {
    switch (doc.type) {
      case 'lww-register':
        doc.crdt.set(operation);
        break;
      case 'g-counter':
        doc.crdt.increment(typeof operation === 'number' ? operation : 1);
        break;
      case 'or-set': {
        const { op, element } = operation || {};
        if (op === 'add') doc.crdt.add(element);
        else if (op === 'remove') doc.crdt.remove(element);
        break;
      }
    }
  }

  _handleOp(fromPeerId, msg) {
    const { docId, type, state } = msg;
    if (!docId || !type || !state) return;

    let doc = this._docs.get(docId);
    if (!doc) {
      // Auto-register on first remote update
      this.register(docId, type);
      doc = this._docs.get(docId);
    }

    const localStateBefore = doc.crdt.toJSON();
    doc.crdt.merge(state);
    const newState = doc.crdt.toJSON();

    this.emit('update', docId, newState, { remote: fromPeerId, state });
  }

  _handleSync(fromPeerId, msg) {
    const { snapshot } = msg;
    if (!snapshot) return;
    for (const [docId, { type, state }] of Object.entries(snapshot)) {
      this._handleOp(fromPeerId, { docId, type, state });
    }
  }
}
