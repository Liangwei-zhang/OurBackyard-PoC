import { ISignaling, RTCSignal } from './signaling-interface.js';

/**
 * NostrSignaling — Decentralised WebRTC signaling over public Nostr relays (NIP-01).
 * Uses H3 L7 cells as geographic subscription channels.
 */
export declare class NostrSignaling extends ISignaling {
  constructor(opts: {
    peerId: string;
    h3Cell: string;
    relays?: string[];
    /** Injected secp256k1 module ({ getPublicKey, schnorrSign }) */
    secp256k1?: { getPublicKey: (privKey: Uint8Array) => Uint8Array; schnorrSign: (msg: Uint8Array, privKey: Uint8Array) => Uint8Array };
    bootTimeoutMs?: number;
    relayTimeoutMs?: number;
    reconnectMs?: number;
  });

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendSignal(targetPeerId: string, signal: RTCSignal): Promise<void>;
  announce(meta?: object): Promise<void>;
  readonly isOnline: boolean;
}
