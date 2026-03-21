/**
 * Item Card Component
 * OurBackyard P2P Marketplace
 */

/**
 * Render an item card HTML string - XSS SAFE
 * User content is sanitized before insertion
 * @param {Object} item - Item data
 * @param {string} peerId - Current user's peer ID
 * @param {Set} onlineNeighbors - Set of online peer IDs
 * @returns {string} HTML string
 */
function renderItemCard(item, peerId, onlineNeighbors = new Set()) {
    const isOwner = item.sellerId === peerId;
    const isOnline = onlineNeighbors.has(item.sellerId);
    const onlineBadge = isOnline ? '<span class="online-dot"></span>' : '';
    
    const statusClass = getStatusClass(item.status);
    const priceText = window.Utils?.formatPrice?.(item.price) || formatPrice(item.price);
    
    // XSS SAFE: Sanitize user content
    const sanitize = (text) => {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };
    
    const safeTitle = sanitize(item.title);
    const safeStatus = sanitize(item.status);
    const safeId = encodeURIComponent(item.id);
    
    const defaultImg = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23333" width="100" height="100"/><text fill="%23666" x="50" y="55" text-anchor="middle">📷</text></svg>'
    );
    
    const microPlaceholder = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect fill="%23444" width="50" height="50"/></svg>'
    );
    
    return `
        <div class="item-card ${item.status}" 
             onclick="window.showItemDetail(${safeId})" 
             data-item-id="${safeId}" 
             data-updated-at="${item.updatedAt || 0}">
            <img class="item-image lazy"
                 data-item-id="${safeId}"
                 data-hash="${encodeURIComponent(item.imageHash || '')}"
                 src="${microPlaceholder}"
                 alt="${safeTitle}"
                 style="filter: blur(3px)"
                 onerror="this.src='${defaultImg}'">
            <div class="item-info">
                <div class="item-title">${onlineBadge}${safeTitle}</div>
                <div class="item-price">${priceText}</div>
                <div class="item-footer">
                    <span class="item-status ${statusClass}">${safeStatus}</span>
                    ${isOwner ? `<button class="btn-edit" data-id="${safeId}" title="編輯">✏️</button>` : ''}
                    <button class="btn-report" onclick="event.stopPropagation(); window.ContentModerator?.reportItem('item-${safeId}', 'inappropriate')" title="舉報">🚩</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Get status CSS class
 * @param {string} status
 * @returns {string}
 */
function getStatusClass(status) {
    switch (status) {
        case "available": return "status-available";
        case "pending": return "status-pending";
        default: return "status-gone";
    }
}

/**
 * Format price (fallback if Utils not loaded)
 * @param {number|string} price
 * @returns {string}
 */
function formatPrice(price) {
    if (price === 0 || price === "0") return "🎁 Free";
    if (price === "swap") return "☕ Swap";
    return `$${price}`;
}

/**
 * Render item detail modal - XSS SAFE VERSION
 * @param {Object} item - Item data
 */
function renderItemDetailModal(item) {
    const priceText = formatPrice(item.price);
    const defaultImg = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23333" width="100" height="100"/><text fill="%23666" x="50" y="55" text-anchor="middle">📷</text></svg>'
    );
    
    const modalContent = document.getElementById("modal-content");
    if (!modalContent) return;
    
    // Clear existing content
    modalContent.innerHTML = '';
    
    // Create image element safely
    const img = document.createElement('img');
    img.src = item.thumbnail || item.imageUrl || defaultImg;
    img.style.cssText = 'width:100%;border-radius:16px;margin-bottom:16px';
    img.onerror = function() { this.src = defaultImg; };
    modalContent.appendChild(img);
    
    // Create title safely
    const title = document.createElement('h2');
    title.style.cssText = 'font-size:22px;margin-bottom:8px';
    title.textContent = item.title || '';
    modalContent.appendChild(title);
    
    // Create price safely
    const price = document.createElement('p');
    price.style.cssText = 'color:var(--accent-green);font-size:24px;font-weight:700;margin-bottom:16px';
    price.textContent = priceText;
    modalContent.appendChild(price);
    
    // Helper to create safe text paragraph
    const createTextP = (text, style) => {
        const p = document.createElement('p');
        p.style.cssText = 'color:var(--text-muted);margin-bottom:8px';
        p.textContent = text || '';
        return p;
    };
    
    // Add details safely
    modalContent.appendChild(createTextP('Condition: ' + (item.condition || 'N/A')));
    modalContent.appendChild(createTextP('Category: ' + (item.category || 'N/A')));
    
    if (item.description) {
        const desc = document.createElement('p');
        desc.style.cssText = 'color:var(--text-muted);margin-bottom:16px';
        desc.textContent = item.description;
        modalContent.appendChild(desc);
    }
    
    if (item.sellerName) {
        const seller = document.createElement('p');
        seller.style.cssText = 'color:var(--text-muted);margin-bottom:16px';
        seller.textContent = '👤 ' + item.sellerName;
        modalContent.appendChild(seller);
    }
    
    // Show modal
    const modal = document.getElementById("item-modal");
    if (modal) modal.style.display = "block";
}

// Export
window.ItemCard = {
    render: renderItemCard,
    renderDetail: renderItemDetailModal,
    formatPrice,
    getStatusClass,
};
