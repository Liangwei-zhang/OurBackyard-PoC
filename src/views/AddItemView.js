/**
 * Add Item View
 * OurBackyard P2P Marketplace
 * Handles creating new marketplace items
 */

const AddItemView = {
    selectedPhotos: [],
    
    /**
     * Initialize the add item view
     */
    init() {
        this.bindEvents();
        console.log("[AddItemView] Initialized");
    },
    
    /**
     * Bind UI events
     */
    bindEvents() {
        // Photo upload
        const photoInput = document.getElementById('photo-input');
        if (photoInput) {
            photoInput.addEventListener('change', (e) => this.handlePhotoSelect(e));
        }
        
        // Add photo button
        const addPhotoBtn = document.getElementById('btn-add-photo');
        if (addPhotoBtn) {
            addPhotoBtn.addEventListener('click', () => {
                photoInput?.click();
            });
        }
        
        // Publish button
        const publishBtn = document.getElementById('btn-publish');
        if (publishBtn) {
            publishBtn.addEventListener('click', () => this.publishItem());
        }
    },
    
    /**
     * Handle photo selection
     * @param {Event} event
     */
    handlePhotoSelect(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        
        for (const file of files) {
            // Validate image
            const validation = window.Utils?.validateImage(file);
            if (!validation?.valid) {
                window.Utils?.showToast?.(validation.error, "error");
                continue;
            }
            
            // Add to selected photos
            this.selectedPhotos.push(file);
            
            // Show preview
            this.showPhotoPreview(file);
        }
        
        // Clear input for next selection
        event.target.value = '';
    },
    
    /**
     * Show photo preview
     * @param {File} file
     */
    showPhotoPreview(file) {
        const container = document.getElementById('photo-preview-container');
        if (!container) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const div = document.createElement('div');
            div.className = 'photo-preview';
            div.innerHTML = `
                <img src="${e.target.result}" alt="Preview">
                <button class="btn-remove" onclick="AddItemView.removePhoto(${this.selectedPhotos.length - 1})">×</button>
            `;
            container.appendChild(div);
        };
        reader.readAsDataURL(file);
    },
    
    /**
     * Remove photo from selection
     * @param {number} index
     */
    removePhoto(index) {
        this.selectedPhotos.splice(index, 1);
        
        // Re-render previews
        this.renderPreviews();
    },
    
    /**
     * Render all photo previews
     */
    renderPreviews() {
        const container = document.getElementById('photo-preview-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        this.selectedPhotos.forEach((file, index) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const div = document.createElement('div');
                div.className = 'photo-preview';
                div.innerHTML = `
                    <img src="${e.target.result}" alt="Preview">
                    <button class="btn-remove" onclick="AddItemView.removePhoto(${index})">×</button>
                `;
                container.appendChild(div);
            };
            reader.readAsDataURL(file);
        });
    },
    
    /**
     * Validate form data
     * @returns {Object} { valid: boolean, errors: string[] }
     */
    validate() {
        const errors = [];
        
        const title = document.getElementById('item-title')?.value?.trim();
        const category = document.getElementById('item-category')?.value;
        
        if (!title) {
            errors.push("請輸入標題");
        }
        
        if (!category) {
            errors.push("請選擇分類");
        }
        
        return {
            valid: errors.length === 0,
            errors,
        };
    },
    
    /**
     * Publish new item
     */
    async publishItem() {
        // Validate
        const validation = this.validate();
        if (!validation.valid) {
            window.Utils?.showToast?.(validation.errors[0], "error");
            return;
        }
        
        const btn = document.getElementById('btn-publish');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '發布中...';
        }
        
        try {
            const title = document.getElementById('item-title').value.trim();
            const category = document.getElementById('item-category').value;
            const price = document.getElementById('item-price').value;
            const condition = document.getElementById('item-condition').value;
            const description = document.getElementById('item-desc').value.trim();
            
            // Process images if selected
            let imageHash = null;
            let thumbnail = null;
            
            if (this.selectedPhotos.length > 0) {
                const file = this.selectedPhotos[0];
                
                // Compress image
                const compressed = await window.ImageUtils?.compressImage?.(file, 800, 0.7);
                if (compressed) {
                    imageHash = await window.ImageUtils?.computeImageHash?.(compressed);
                    thumbnail = URL.createObjectURL(compressed);
                }
            }
            
            // Create item object
            const itemData = {
                type: "marketplace",
                status: "available",
                title,
                category,
                price: price || 0,
                condition: condition || "used",
                description,
                sellerId: window.peerId,
                sellerName: window.displayName,
                h3Index: window.currentH3Index,
                timestamp: Date.now(),
                imageHash,
                thumbnail,
            };
            
            // Save to local DB
            const db = window.db;
            if (db) {
                const itemId = await db.items.add(itemData);
                itemData.id = itemId;
                
                // Save image blob if present
                if (imageHash && this.selectedPhotos.length > 0) {
                    const file = this.selectedPhotos[0];
                    const compressed = await window.ImageUtils?.compressImage?.(file, 800, 0.7);
                    if (compressed) {
                        await window.ImageUtils?.saveBlobWithQuotaCheck?.(imageHash, compressed);
                    }
                }
            }
            
            // Broadcast to peers
            if (window.WSService?.broadcast) {
                window.WSService.broadcast({
                    ...itemData,
                    type: "NEW_ITEM",
                });
            }
            
            // Show success
            window.Utils?.showToast?.("發布成功！", "success");
            
            // Clear form
            this.clearForm();
            
            // Switch to browse tab
            if (window.loadItems) {
                window.loadItems();
            }
            
        } catch (err) {
            console.error("[AddItemView] Publish error:", err);
            window.Utils?.showToast?.("發布失敗: " + err.message, "error");
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '發布';
            }
        }
    },
    
    /**
     * Clear form
     */
    clearForm() {
        this.selectedPhotos = [];
        
        document.getElementById('item-title').value = '';
        document.getElementById('item-category').value = '';
        document.getElementById('item-price').value = '';
        document.getElementById('item-condition').value = 'used';
        document.getElementById('item-desc').value = '';
        
        const previewContainer = document.getElementById('photo-preview-container');
        if (previewContainer) {
            previewContainer.innerHTML = '';
        }
    },
};

// Export
window.AddItemView = AddItemView;
