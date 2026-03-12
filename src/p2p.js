// ============ P2P Module ============

// Image download queue management
const ImageDownloadQueue = {
    queue: [],
    downloading: 0,
    maxConcurrent: 3,
    timeouts: new Map(),
    
    init() {
        this.queue = [];
        this.downloading = 0;
        console.log('[Queue] Initialized, max concurrent:', this.maxConcurrent);
    },
    
    add(hash, sellerId) {
        // Check if already queued or downloading
        if (this.queue.some(t => t.hash === hash) || this.isDownloading(hash)) {
            console.log('[Queue] Already queued/downloading:', hash);
            return false;
        }
        
        this.queue.push({ hash, sellerId });
        console.log('[Queue] Added:', hash, 'Queue length:', this.queue.length);
        this.process();
        return true;
    },
    
    isDownloading(hash) {
        return this.downloading >= this.maxConcurrent;
    },
    
    async process() {
        while (this.downloading < this.maxConcurrent && this.queue.length > 0) {
            const task = this.queue.shift();
            this.downloading++;
            this.executeRequest(task.hash, task.sellerId);
        }
    },
    
    async executeRequest(hash, sellerId) {
        // Set timeout
        const timeout = setTimeout(() => {
            console.log('[Queue] Timeout for:', hash);
            this.complete(hash);
        }, 15000);
        
        this.timeouts.set(hash, timeout);
        
        // Send request via WebSocket
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'REQ_IMAGE',
                imageHash: hash,
                requesterId: peerId,
                sellerId: sellerId
            }));
            console.log('[Queue] Sent request for:', hash);
        } else {
            // Re-queue if not connected
            console.log('[Queue] Not connected, re-queuing:', hash);
            this.queue.unshift({ hash, sellerId });
            this.complete(hash);
        }
    },
    
    complete(hash) {
        // Clear timeout
        if (this.timeouts.has(hash)) {
            clearTimeout(this.timeouts.get(hash));
            this.timeouts.delete(hash);
        }
        
        // Release slot
        if (this.downloading > 0) {
            this.downloading--;
        }
        
        // Process next
        this.process();
    },
    
    get length() {
        return this.queue.length;
    },
    
    get active() {
        return this.downloading;
    }
};

// P2P Data Channel management
const P2PStreamer = {
    dataChannels: new Map(),
    peers: new Set(),
    
    // Create data channel with peer
    createChannel(peerId) {
        if (this.dataChannels.has(peerId)) {
            return this.dataChannels.get(peerId);
        }
        
        // Note: Actual DataChannel creation requires RTCPeerConnection
        // This is a placeholder for the P2P implementation
        console.log('[P2P] Creating channel with:', peerId);
        return null;
    },
    
    // Broadcast to all connected peers
    broadcast(msg) {
        const data = JSON.stringify(msg);
        
        this.dataChannels.forEach((channel, peerId) => {
            if (channel.readyState === 'open') {
                channel.send(data);
            }
        });
        
        // Also send via WebSocket as fallback
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    },
    
    // Handle incoming data
    handleData(peerId, data) {
        try {
            const msg = JSON.parse(data);
            console.log('[P2P] Received from', peerId, ':', msg.type);
            return msg;
        } catch (err) {
            console.error('[P2P] Parse error:', err);
            return null;
        }
    },
    
    // Close channel with peer
    closeChannel(peerId) {
        const channel = this.dataChannels.get(peerId);
        if (channel) {
            channel.close();
            this.dataChannels.delete(peerId);
        }
        this.peers.delete(peerId);
    },
    
    // Get connected peer count
    getPeerCount() {
        return this.peers.size;
    }
};

// Image lazy loader using IntersectionObserver
const ImageLazyLoader = {
    observer: null,
    activeRequests: new Set(),
    
    init() {
        this.observer = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        const hash = img.dataset.hash;
                        
                        if (hash && img.dataset.loaded !== 'true' && !this.activeRequests.has(hash)) {
                            console.log('[Lazy] Triggered:', hash);
                            this.requestImage(hash);
                        }
                    }
                });
            },
            { rootMargin: '200px' }
        );
    },
    
    observe(el) {
        if (this.observer) {
            this.observer.observe(el);
        }
    },
    
    unobserve(el) {
        if (this.observer) {
            this.observer.unobserve(el);
        }
    },
    
    async requestImage(hash) {
        if (this.activeRequests.has(hash)) return;
        this.activeRequests.add(hash);
        
        // Check local DB first
        const blobs = await db.blobs.where('hash').equals(hash).toArray();
        if (blobs.length > 0) {
            window.updateImageInUI?.(hash);
            this.activeRequests.delete(hash);
            return;
        }
        
        // Request from network
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'REQ_IMAGE',
                imageHash: hash,
                requesterId: peerId
            }));
        }
        
        // Auto-release after 15 seconds
        setTimeout(() => {
            this.activeRequests.delete(hash);
        }, 15000);
    }
};

// Export
window.ImageDownloadQueue = ImageDownloadQueue;
window.P2PStreamer = P2PStreamer;
window.ImageLazyLoader = ImageLazyLoader;
