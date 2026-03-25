/**
 * @file webrtc-transport.js
 * @description WebRTC DataChannel transport with glare resolution, ICE restart,
 * auto-reconnect with exponential backoff, and backpressure control.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { ITransport } from './transport-interface.js';
import config from '../config.js';
import { Logger } from '../logger.js';

const log = new Logger('WebRTCTransport');

/** @typedef {{ pc: RTCPeerConnection, dc: RTCDataChannel|null, state: string, reconnectAttempts: number, reconnectTimer: number|null }} PeerEntry */

export class WebRTCTransport extends EventBus {
  /**
   * @param {object} [opts]
   * @param {RTCConfiguration} [opts.rtcConfig] — ICE servers configuration
   */
  constructor(opts = {}) {
    super();
    this._rtcConfig = opts.rtcConfig ?? { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    /** @type {Map<string, PeerEntry>} */
    this._peers = new Map();
    /** @type {string|null} local peer ID (set by the caller) */
    this.localId = null;
  }

  // ─── ITransport contract ────────────────────────────────────────────────────

  /**
   * Initiate or accept a WebRTC connection with peerId.
   * @param {string} peerId
   * @param {object} signalingChannel — must have sendToPeer(peerId, msg)
   * @param {boolean} [polite=true]   — polite peer yields on glare
   */
  async connect(peerId, signalingChannel, polite = true) {
    if (!peerId) throw new TypeError('peerId is required');
    if (this._peers.has(peerId)) return; // already connecting / connected
    const pc = this._createPC(peerId, signalingChannel, polite);
    const entry = { pc, dc: null, state: 'connecting', reconnectAttempts: 0, reconnectTimer: null };
    this._peers.set(peerId, entry);

    if (!polite) {
      // Impolite peer creates the offer
      const dc = pc.createDataChannel('p2p', { ordered: false, maxRetransmits: 0 });
      entry.dc = dc;
      this._setupDataChannel(peerId, dc);
    }
  }

  /**
   * Send data to a specific peer. Returns false if backpressure limit reached.
   * @param {string} peerId
   * @param {string|ArrayBuffer} data
   * @returns {boolean}
   */
  send(peerId, data) {
    const entry = this._peers.get(peerId);
    if (!entry?.dc || entry.dc.readyState !== 'open') return false;
    const maxBuffer = config.get('transport.maxBufferBytes');
    if (entry.dc.bufferedAmount >= maxBuffer) {
      log.warn(`Backpressure on ${peerId} — bufferedAmount=${entry.dc.bufferedAmount}`);
      return false;
    }
    try {
      entry.dc.send(data);
      return true;
    } catch (e) {
      log.error(`send() error for ${peerId}`, e);
      return false;
    }
  }

  /**
   * Broadcast data to all connected peers, skipping backpressured ones.
   * @param {string|ArrayBuffer} data
   */
  broadcast(data) {
    for (const peerId of this._peers.keys()) {
      this.send(peerId, data);
    }
  }

  /**
   * Disconnect from a peer and clean up resources.
   * @param {string} peerId
   */
  disconnect(peerId) {
    const entry = this._peers.get(peerId);
    if (!entry) return;
    if (entry.reconnectTimer !== null) clearTimeout(entry.reconnectTimer);
    try { entry.dc?.close(); } catch { /* ignore */ }
    try { entry.pc.close(); } catch { /* ignore */ }
    this._peers.delete(peerId);
    this.emit('close', { peerId, reason: 'local disconnect' });
  }

  /**
   * Close all connections and release all resources.
   */
  close() {
    for (const peerId of [...this._peers.keys()]) {
      this.disconnect(peerId);
    }
  }

  /**
   * Return all currently tracked peer IDs.
   * @returns {string[]}
   */
  peers() {
    return [...this._peers.keys()];
  }

  // ─── Signaling message ingress ───────────────────────────────────────────────

  /**
   * Handle a signaling message from a remote peer.
   * Must be called by the signaling layer when a message is received.
   * @param {string} peerId
   * @param {{ type: string, sdp?: string, candidate?: RTCIceCandidateInit }} msg
   * @param {object} signalingChannel
   */
  async handleSignal(peerId, msg, signalingChannel) {
    let entry = this._peers.get(peerId);
    if (!entry) {
      // We are the polite peer — create PC reactively
      const pc = this._createPC(peerId, signalingChannel, true);
      entry = { pc, dc: null, state: 'connecting', reconnectAttempts: 0, reconnectTimer: null };
      this._peers.set(peerId, entry);
    }
    const { pc } = entry;

    try {
      if (msg.type === 'offer') {
        const offerCollision = pc.signalingState !== 'stable';
        const polite = entry._polite ?? true;
        if (offerCollision && !polite) {
          log.debug(`Glare: ignoring offer from ${peerId} (impolite)`);
          return;
        }
        if (offerCollision) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(msg),
          ]);
        } else {
          await pc.setRemoteDescription(msg);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signalingChannel.sendToPeer(peerId, { type: 'answer', sdp: pc.localDescription.sdp });

      } else if (msg.type === 'answer') {
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(msg);

      } else if (msg.type === 'candidate') {
        if (msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch { /* ignore stale candidates */ }
        }
      } else if (msg.type === 'ice-restart') {
        await this._restartICE(peerId, signalingChannel);
      }
    } catch (e) {
      log.error(`handleSignal error for ${peerId}`, e);
      this.emit('error', { peerId, error: e });
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  /**
   * @private
   */
  _createPC(peerId, signalingChannel, polite) {
    const pc = new RTCPeerConnection(this._rtcConfig);
    // Attach polite flag
    pc._politeFlag = polite;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) signalingChannel.sendToPeer(peerId, { type: 'candidate', candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription(offer);
        signalingChannel.sendToPeer(peerId, { type: 'offer', sdp: pc.localDescription.sdp });
      } catch (e) {
        log.error('onnegotiationneeded error', e);
      }
    };

    pc.oniceconnectionstatechange = () => {
      log.debug(`ICE ${peerId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        this._scheduleReconnect(peerId, signalingChannel);
      }
    };

    pc.onconnectionstatechange = () => {
      log.debug(`Connection ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._scheduleReconnect(peerId, signalingChannel);
      }
    };

    pc.ondatachannel = ({ channel }) => {
      const entry = this._peers.get(peerId);
      if (entry) { entry.dc = channel; }
      this._setupDataChannel(peerId, channel);
    };

    return pc;
  }

  /** @private */
  _setupDataChannel(peerId, dc) {
    const maxBuffer = config.get('transport.maxBufferBytes');
    dc.bufferedAmountLowThreshold = Math.floor(maxBuffer * 0.5);

    dc.onopen = () => {
      const entry = this._peers.get(peerId);
      if (entry) {
        entry.state = 'connected';
        entry.reconnectAttempts = 0;
      }
      log.info(`DataChannel open with ${peerId}`);
      this.emit('open', { peerId });
    };

    dc.onmessage = ({ data }) => {
      this.emit('message', { peerId, data });
    };

    dc.onerror = (e) => {
      log.error(`DataChannel error with ${peerId}`, e);
      this.emit('error', { peerId, error: e });
    };

    dc.onclose = () => {
      const entry = this._peers.get(peerId);
      if (entry) entry.state = 'disconnected';
      log.info(`DataChannel closed with ${peerId}`);
      this.emit('close', { peerId, reason: 'datachannel closed' });
    };
  }

  /** @private */
  async _restartICE(peerId, signalingChannel) {
    const entry = this._peers.get(peerId);
    if (!entry) return;
    try {
      const offer = await entry.pc.createOffer({ iceRestart: true });
      await entry.pc.setLocalDescription(offer);
      signalingChannel.sendToPeer(peerId, { type: 'offer', sdp: entry.pc.localDescription.sdp });
    } catch (e) {
      log.error(`ICE restart failed for ${peerId}`, e);
    }
  }

  /** @private */
  _scheduleReconnect(peerId, signalingChannel) {
    const entry = this._peers.get(peerId);
    if (!entry || entry.reconnectTimer !== null) return;

    const maxAttempts = config.get('transport.reconnectMaxAttempts');
    if (entry.reconnectAttempts >= maxAttempts) {
      log.warn(`Max reconnect attempts reached for ${peerId}`);
      this.emit('close', { peerId, reason: 'max reconnect attempts' });
      this._peers.delete(peerId);
      return;
    }

    const base = config.get('transport.reconnectBaseDelay');
    const max = config.get('transport.reconnectMaxDelay');
    const delay = Math.min(base * Math.pow(2, entry.reconnectAttempts), max);
    entry.reconnectAttempts++;

    log.info(`Reconnecting to ${peerId} in ${delay}ms (attempt ${entry.reconnectAttempts})`);
    entry.reconnectTimer = setTimeout(async () => {
      entry.reconnectTimer = null;
      await this._restartICE(peerId, signalingChannel);
    }, delay);
  }
}

// Mix in ITransport marker
Object.setPrototypeOf(WebRTCTransport.prototype, Object.create(ITransport.prototype, {
  constructor: { value: WebRTCTransport },
}));

export default WebRTCTransport;
