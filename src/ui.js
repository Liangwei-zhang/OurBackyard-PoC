// ============ UI Module ============

/**
 * Show item detail modal
 */
async function showItemDetail(id) {
    const item = await window.db?.items.get(id);
    if (!item) return;
    
    const escapedTitle = escapeHtml(item.title || '');
    const escapedDesc = escapeHtml(item.description || '');
    const priceText = item.price === 0 ? '🎁 Free' : `$${item.price}`;
    
    // Build images
    let imagesHtml = buildImageGallery(item);
    
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <span class="close" onclick="closeModal()">&times;</span>
            ${imagesHtml}
            <h2>${escapedTitle}</h2>
            <p class="price">${priceText}</p>
            <p class="description">${escapedDesc}</p>
            <p class="seller">賣家: ${escapeHtml(item.sellerId || 'Unknown')}</p>
        </div>
    `;
    
    document.body.appendChild(modal);
    modal.style.display = 'block';
}

/**
 * Build image gallery HTML
 */
function buildImageGallery(item) {
    const defaultImg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#333" width="100" height="100"/><text fill="#666" x="50" y="55" text-anchor="middle">📷</text></svg>';
    
    const imageHashes = item.imageHashes || (item.imageHash ? [item.imageHash] : []);
    
    if (imageHashes.length === 0) {
        return `<img src="${defaultImg}" alt="No image" class="detail-image">`;
    }
    
    // Load images from blobs
    const images = imageHashes.map(hash => {
        return `<img src="${defaultImg}" data-hash="${hash}" class="detail-image" loading="lazy">`;
    });
    
    return `<div class="gallery">${images.join('')}</div>`;
}

/**
 * Close modal
 */
function closeModal() {
    const modal = document.querySelector('.modal');
    if (modal) {
        modal.remove();
    }
}

/**
 * Show notification toast
 */
function notify(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * Toggle theme (day/night)
 */
function toggleTheme() {
    const isDay = document.body.classList.toggle('day-mode');
    localStorage.setItem('theme', isDay ? 'day' : 'night');
}

/**
 * Show setup modal
 */
function showSetup() {
    document.getElementById('setup')?.classList.remove('hidden');
    document.getElementById('app')?.classList.add('hidden');
}

/**
 * Hide setup, show app
 */
function hideSetup() {
    document.getElementById('setup')?.classList.add('hidden');
    document.getElementById('app')?.classList.remove('hidden');
}

// Export
window.UI = {
    showItemDetail,
    closeModal,
    notify,
    toggleTheme,
    showSetup,
    hideSetup,
    buildImageGallery
};
