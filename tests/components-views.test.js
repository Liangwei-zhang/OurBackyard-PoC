import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("components and views", () => {
    beforeAll(async () => {
        await __loadScript("src/components/ItemCard.js");
        await __loadScript("src/components/ImageLazyLoader.js");
        await __loadScript("src/views/BrowseView.js");
        await __loadScript("src/views/AddItemView.js");
        await __loadScript("src/views/ChatView.js");
        await __loadScript("src/views/MyItemsView.js");
    });

    beforeEach(() => {
        __resetDom();
        window.peerId = "peer-self";
        window.displayName = "Tester";
        window.Utils = {
            formatPrice: (v) => `$${v}`,
            validateImage: () => ({ valid: true }),
            showToast: vi.fn(),
        };
        globalThis.WebSocket = { OPEN: 1 };
    });

    it("item card render escapes unsafe html", () => {
        const html = window.ItemCard.render(
            {
                id: "1",
                sellerId: "peer-other",
                title: `<img src=x onerror=1>`,
                status: "available",
                price: 9,
                imageHash: "hash-1",
            },
            "peer-self",
            new Set(["peer-other"]),
        );

        expect(html).toContain("&lt;img src=x onerror=1&gt;");
        expect(html).not.toContain("<img src=x onerror=1>");
        expect(window.ItemCard.getStatusClass("pending")).toBe("status-pending");
    });

    it("item detail renders into modal safely", () => {
        document.body.innerHTML = `<div id="item-modal"></div><div id="modal-content"></div>`;
        window.ItemCard.renderDetail({
            title: "Chair",
            price: 20,
            description: "<script>alert(1)</script>",
            sellerName: "Alice",
        });

        const content = document.getElementById("modal-content");
        expect(content.textContent).toContain("<script>alert(1)</script>");
        expect(content.innerHTML).not.toContain("<script>alert(1)</script>");
    });

    it("image lazy loader loads local blob and can request from peers", async () => {
        const img = document.createElement("img");
        img.dataset.hash = "hash-1";
        img.dataset.itemId = "item-1";
        document.body.appendChild(img);

        window.db = {
            blobs: {
                where: vi.fn().mockReturnValue({
                    equals: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({ blob: new Blob(["x"]) }),
                    }),
                }),
            },
        };

        await window.ImageLazyLoader.loadImage(img);
        expect(img.dataset.loaded).toBe("true");
        expect(img.src.startsWith("blob:")).toBe(true);

        const send = vi.fn();
        window.ws = { readyState: WebSocket.OPEN, send };
        window.ImageLazyLoader.requestImageFromPeers("hash-x", "item-x");
        expect(send).toHaveBeenCalledWith(expect.stringContaining(`"type":"REQ_IMAGE"`));
    });

    it("browse view filters/sorts and triggers reload on category change", () => {
        window.loadItems = vi.fn();
        document.body.innerHTML = `
          <button class="filter-category" data-category="All"></button>
          <button class="filter-category" data-category="Tools"></button>
          <button class="sort-btn" data-sort="price-low"></button>
        `;

        window.BrowseView.init();
        window.BrowseView.setCategory("Tools");
        expect(window.BrowseView.currentFilter).toBe("Tools");
        expect(window.loadItems).toHaveBeenCalled();

        const items = [
            { category: "Tools", price: 20, timestamp: 2 },
            { category: "Food", price: 5, timestamp: 3 },
            { category: "Tools", price: 10, timestamp: 1 },
        ];

        expect(window.BrowseView.filterByCategory(items).length).toBe(2);
        window.BrowseView.setSort("price-low");
        const sorted = window.BrowseView.sortItems(window.BrowseView.filterByCategory(items));
        expect(sorted.map((i) => i.price)).toEqual([10, 20]);
    });

    it("add item view validates form and publishes data", async () => {
        document.body.innerHTML = `
          <input id="item-title" value="Desk" />
          <select id="item-category"><option value="Furniture" selected>Furniture</option></select>
          <input id="item-price" value="120" />
          <input id="item-condition" value="used" />
          <textarea id="item-desc">Wooden desk</textarea>
          <input id="photo-input" />
          <button id="btn-add-photo"></button>
          <button id="btn-publish">發布</button>
          <div id="photo-preview-container"></div>
        `;

        const add = vi.fn().mockResolvedValue(42);
        const broadcast = vi.fn();
        window.db = { items: { add } };
        window.WSService = { broadcast };
        window.ImageUtils = {
            compressImage: vi.fn(),
            computeImageHash: vi.fn(),
            saveBlobWithQuotaCheck: vi.fn(),
        };
        window.loadItems = vi.fn();
        window.currentH3Index = "h3-1";

        window.AddItemView.selectedPhotos = [];
        await window.AddItemView.publishItem();

        expect(add).toHaveBeenCalled();
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "NEW_ITEM", title: "Desk" }));
        expect(window.Utils.showToast).toHaveBeenCalledWith("發布成功！", "success");
    });

    it("chat view sends outgoing message via p2p and websocket", () => {
        document.body.innerHTML = `
          <div id="chat-messages"></div>
          <input id="chat-input" />
          <button id="btn-send-chat"></button>
        `;
        window.P2PStreamer = { broadcast: vi.fn() };
        const wsSend = vi.fn();
        window.ws = { readyState: WebSocket.OPEN, send: wsSend };

        window.ChatView.clear();
        window.ChatView.setPeer("peer-b", "Bob");
        document.getElementById("chat-input").value = "<hello>";
        window.ChatView.sendMessage();

        expect(window.ChatView.messages.length).toBe(1);
        expect(window.P2PStreamer.broadcast).toHaveBeenCalled();
        expect(wsSend).toHaveBeenCalled();
        expect(document.getElementById("chat-messages").innerHTML).toContain("&lt;hello&gt;");
    });

    it("my items view can load, delete and update status", async () => {
        const deleteSpy = vi.fn().mockResolvedValue(undefined);
        const updateSpy = vi.fn().mockResolvedValue(undefined);

        window.db = {
            items: {
                where: vi.fn().mockReturnValue({
                    equals: vi.fn().mockReturnValue({
                        toArray: vi.fn().mockResolvedValue([{ id: 1, sellerId: "peer-self", title: "Item", price: 1, status: "available" }]),
                    }),
                }),
                delete: deleteSpy,
                update: updateSpy,
            },
        };
        window.WSService = { broadcast: vi.fn() };
        document.body.innerHTML = `<div id="my-items-grid"></div>`;

        const items = await window.MyItemsView.loadMyItems();
        expect(items.length).toBe(1);
        window.MyItemsView.render(items);
        expect(document.getElementById("my-items-grid").innerHTML).toContain("Item");

        await window.MyItemsView.deleteItem(1);
        expect(deleteSpy).toHaveBeenCalledWith(1);

        const refreshSpy = vi.spyOn(window.MyItemsView, "refresh").mockResolvedValue(undefined);
        await window.MyItemsView.updateStatus(1, "pending");
        expect(updateSpy).toHaveBeenCalled();
        expect(window.WSService.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "ITEM_UPDATE" }));
        expect(refreshSpy).toHaveBeenCalled();
    });
});

