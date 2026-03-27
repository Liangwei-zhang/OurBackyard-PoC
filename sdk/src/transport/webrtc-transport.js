/**
 * WebRTCTransport — Manage RTCPeerConnection lifecycle + DataChannel open/close/send.
 *
 * Extracted and cleaned up from p2p-mesh.js lines 190-396.
 * Single responsibility: raw WebRTC connections only. No message routing, no encryption.
 *
 * Events emitted:
 *   'peer:connected'    (peerId)
 *   'peer:disconnected' (peerId)
 *   'data'              (peerId, data)       — raw string or ArrayBuffer
 *   'signal:send'       (targetPeerId, signal) — ICE/SDP to relay via signaling
 */

import { EventBus } from '../event-bus.js';

export class WebRTCTransport extends EventBus {
  /**
   * @param {object} opts
   * @param {string}   opts.peerId      — Local peer identifier
   * @param {object[]} opts.iceServers  — RTCIceServer array
   * @param {number}   [opts.maxPeers=12]
   * @param {number}   [opts.chunkSize=65536]
   * @param {number}   [opts.maxBuffer=4194304]
   * @param {number}   [opts.reconnectMs=3000]
   */
  constructor({ peerId, iceServers, maxPeers = 12, chunkSize = 65536, maxBuffer = 4194304, reconnectMs = 3000 }) {
    super();
    this.peerId      = peerId;
    this.iceServers  = iceServers ?? [];
    this.maxPeers    = maxPeers;
    this.chunkSize   = chunkSize;
    this.maxBuffer   = maxBuffer;
    this.reconnectMs = reconnectMs;

    /** @type {Map<string, RTCPeerConnection>} */
    this._peerConns    = new Map();
    /** @type {Map<string, RTCDataChannel>} */
    this._dataChannels = new Map();
    /** @type {Map<string, object>} — peerMeta for reconnect tracking */
    this._peerMeta     = new Map();
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Initiate a connection to a remote peer (offerer role).
   * Called when lexicographic order dictates we send the first offer.
   * @param {string} targetPeerId
   */
  async createOffer(targetPeerId) {
    if (this._peerConns.has(targetPeerId)) return;
    if (this._peerConns.size >= this.maxPeers) return;

    const pc = this._newPC(targetPeerId);

    const dc = pc.createDataChannel('mesh', { ordered: true });
    this._setupDataChannel(targetPeerId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.emit('signal:send', targetPeerId, {
      type:  'offer',
      sdp:   { type: offer.type, sdp: offer.sdp },
    });
  }

  /**
   * Backward-compatible transport interface.
   * Tracks the peer and creates an offer when this side is the offerer.
   * @param {string} peerId
   * @param {boolean|object} [shouldOfferOrMeta=true]
   * @param {object} [meta]
   */
  async connect(peerId, shouldOfferOrMeta = true, meta = {}) {
    let shouldOffer = shouldOfferOrMeta;
    let peerMeta = meta;

    if (typeof shouldOfferOrMeta === 'object' && shouldOfferOrMeta !== null) {
      shouldOffer = true;
      peerMeta = shouldOfferOrMeta;
    }

    this.trackPeer(peerId, peerMeta);

    if (!shouldOffer || this._peerConns.has(peerId) || this._peerConns.size >= this.maxPeers) {
      return;
    }

    await this.createOffer(peerId);
  }

  /**
   * Handle an incoming signal (offer / answer / ice-candidate).
   * @param {string} fromPeerId
   * @param {object} signal
   */
  async handleSignal(fromPeerId, signal) {
    switch (signal.type) {
      case 'offer':   return this._handleOffer(fromPeerId, signal);
      case 'answer':  return this._handleAnswer(fromPeerId, signal);
      case 'ice-candidate': return this._handleIceCandidate(fromPeerId, signal);
    }
  }

  /**
   * Send data to a single peer (string or ArrayBuffer).
   * @param {string} peerId
   * @param {string|ArrayBuffer} data
   * @returns {boolean} — true if sent
   */
  send(peerId, data) {
    const dc = this._dataChannels.get(peerId);
    if (dc?.readyState === 'open') {
      if (dc.bufferedAmount >= this.maxBuffer) return false;
      try { dc.send(data); return true; } catch {}
    }
    return false;
  }

  /**
   * Broadcast data to all connected peers.
   * @param {string|ArrayBuffer} data
   * @param {string} [excludePeerId]
   */
  broadcast(data, excludePeerId) {
    for (const [peerId, dc] of this._dataChannels) {
      if (peerId !== excludePeerId && dc.readyState === 'open') {
        if (dc.bufferedAmount >= this.maxBuffer) continue;
        try { dc.send(data); } catch {}
      }
    }
  }

  /**
   * Mark a peer as known (for reconnect tracking on announce).
   * @param {string} peerId
   * @param {object} meta
   */
  trackPeer(peerId, meta = {}) {
    this._peerMeta.set(peerId, { ...meta, lastSeen: Date.now() });
  }

  /**
   * Disconnect from a peer and clean up.
   * @param {string} peerId
   */
  disconnect(peerId) {
    this._cleanPeer(peerId);
  }

  /**
   * Destroy all connections and clean up.
   */
  destroy() {
    for (const pc of this._peerConns.values()) try { pc.close(); } catch {}
    this._peerConns.clear();
    this._dataChannels.clear();
    this._peerMeta.clear();
    this.removeAllListeners();
  }

  destroyAll() { this.destroy(); }

  close() {
    this.destroy();
  }

  // ─────────────────────────── Properties ───────────────────────────

  /** @returns {string[]} */
  get connectedPeers() { return [...this._dataChannels.keys()]; }

  /** @returns {number} */
  get peerCount() { return this._dataChannels.size; }

  /**
   * Check whether an active RTCPeerConnection exists for the given peer.
   * @param {string} peerId
   * @returns {boolean}
   */
  hasPeerConnection(peerId) { return this._peerConns.has(peerId); }

  /**
   * Retrieve the open DataChannel for a peer, or null if not connected.
   * @param {string} peerId
   * @returns {RTCDataChannel|null}
   */
  getDataChannel(peerId) {
    const dc = this._dataChannels.get(peerId);
    return (dc?.readyState === 'open') ? dc : null;
  }

  /** @returns {string[]} */
  peers() { return this.connectedPeers; }

  // ─────────────────────────── Internal — signal handlers ───────────────────────────

  async _handleOffer(peerId, signal) {
    let pc = this._peerConns.get(peerId);

    if (pc) {
      const state = pc.signalingState;
      if (state === 'stable') return; // already connected — ignore re-offer

      if (state === 'have-local-offer') {
        // Glare resolution: lower peerId wins (becomes answerer)
        if (this.peerId > peerId) {
          // We lose — roll back our offer and answer theirs
          try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
        } else {
          return; // We win — wait for their answer
        }
      }

      if (pc.signalingState !== 'stable') {
        // Unexpected state — start fresh
        pc.close();
        this._peerConns.delete(peerId);
        pc = null;
      }
    }

    if (!pc) pc = this._newPC(peerId);
    pc.ondatachannel = (e) => this._setupDataChannel(peerId, e.channel);

    try {
      await pc.setRemoteDescription(signal.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.emit('signal:send', peerId, {
        type: 'answer',
        sdp:  { type: answer.type, sdp: answer.sdp },
      });
    } catch (e) {
      console.warn('[WebRTCTransport] offer handling error:', e.message);
    }
  }

  async _handleAnswer(peerId, signal) {
    const pc = this._peerConns.get(peerId);
    if (!pc) return;
    if (pc.signalingState !== 'have-local-offer') {
      // Duplicate answer from multiple signaling relays — silently ignore
      return;
    }
    try {
      await pc.setRemoteDescription(signal.sdp);
    } catch (e) {
      console.warn('[WebRTCTransport] answer handling error:', e.message);
    }
  }

  async _handleIceCandidate(peerId, signal) {
    const pc = this._peerConns.get(peerId);
    if (pc && signal.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch {}
    }
  }

  // ─────────────────────────── Internal — RTCPeerConnection ───────────────────────────

  _newPC(peerId) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const candidate = e.candidate.toJSON
          ? e.candidate.toJSON()
          : {
              candidate:         e.candidate.candidate,
              sdpMid:            e.candidate.sdpMid,
              sdpMLineIndex:     e.candidate.sdpMLineIndex,
              usernameFragment:  e.candidate.usernameFragment,
            };
        this.emit('signal:send', peerId, { type: 'ice-candidate', candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[WebRTC] ${peerId.slice(0,12)} connectionState → ${state}`);
      if (state === 'failed' || state === 'disconnected') {
        this._cleanPeer(peerId);
        // Auto-reconnect with backoff if the peer is still known
        setTimeout(() => {
          if (this._peerMeta.has(peerId) && !this._peerConns.has(peerId)) {
            if (this.peerId < peerId) this.createOffer(peerId).catch(() => {});
          }
        }, this.reconnectMs);
      }
    };

    // ICE restart on failure: send an explicit new offer with iceRestart:true.
    // NOTE: onnegotiationneeded is intentionally NOT used — it races with the
    // explicit createOffer() call in createOffer() when createDataChannel() fires
    // negotiationneeded, causing 'Failed to set local offer: m-line order mismatch'.
    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ${peerId.slice(0,12)} iceState → ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed' && this.peerId < peerId) {
        console.log('[WebRTCTransport] ICE failed, restarting for peer:', peerId);
        pc.createOffer({ iceRestart: true })
          .then(offer => pc.setLocalDescription(offer).then(() => offer))
          .then(offer => this.emit('signal:send', peerId, {
            type: 'offer',
            sdp:  { type: offer.type, sdp: offer.sdp },
          }))
          .catch(e => console.warn('[WebRTCTransport] ICE restart error:', e.message));
      }
    };

    this._peerConns.set(peerId, pc);
    return pc;
  }

  _setupDataChannel(peerId, dc) {
    dc.binaryType = 'arraybuffer';

    // Backpressure threshold
    dc.bufferedAmountLowThreshold = this.chunkSize;

    dc.onopen = () => {
      this._dataChannels.set(peerId, dc);
      this.emit('peer:connected', peerId);
    };

    dc.onclose = () => {
      this._dataChannels.delete(peerId);
      this.emit('peer:disconnected', peerId);
    };

    dc.onmessage = (e) => {
      this.emit('data', peerId, e.data);
    };

    // Pre-register even before open so we can detect early close
    this._dataChannels.set(peerId, dc);
  }

  _cleanPeer(peerId) {
    try { this._peerConns.get(peerId)?.close(); } catch {}
    this._peerConns.delete(peerId);
    this._dataChannels.delete(peerId);
  }
}
