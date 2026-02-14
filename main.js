const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, Modal, FuzzySuggestModal, setIcon } = require('obsidian');

// Default user settings
const DEFAULT_SETTINGS = {
    scrollSpeed: 5,             // The base number of pixels moved per scroll tick.
    repeatInterval: 5,          // How often (in milliseconds) the scroll logic repeats while a key is held down.
    smoothScrollStart: 0.7,     // Initial speed multiplier when first pressing a scroll key. Values less than 1 create a "slow start" feel.
    smoothScrollEnd: 2.0,       // Maximum speed multiplier reached after holding the key down.
    smoothScrollDuration: 2000, // How long (in milliseconds) it takes to ramp from 'smoothScrollStart' to 'smoothScrollEnd'.
    smoothScrollCurve: 3        // Controls the 'feel' of the acceleration. 1 is linear (constant increase). 3 (cubic) creates a more natural, weighted acceleration curve.
};

// Defines every UI button clickable with "F to select element"
const CLICKABLE_SELECTORS = [
    "a", "button", "input", "[role='button']", ".clickable", ".clickable-icon",
    ".tree-item-self", ".workspace-tab-header", ".nav-file-title", ".nav-folder-title",
    ".hyperlink", ".tag", ".cm-hashtag", ".cm-url", ".external-link", ".internal-link",
    ".bases-cards-item", ".text-icon-button", ".menu-item", ".view-header-breadcrumb", ".view-header-title", ".callout-fold"
].join(", ");

// Defines every keyboard character usable with "F to select element"
const HINT_CHARS = "abcdefghijklmnopqrstuvwxyz";

// --- GLOBAL HELPERS ---

// Escapes special characters for use in a regular expression
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Identifies the correct scrollable container based on view type (Markdown vs PDF)
function getScrollElement(view) {
    if (!view) return null;
    if (view.getViewType() === "markdown" && view.getMode() === "preview") {
        return view.previewMode.containerEl.querySelector(".markdown-preview-view");
    }
    if (view.getViewType() === "pdf") {
        return view.contentEl.querySelector(".pdf-viewer-container") || 
               view.contentEl.querySelector(".pdf-container") ||
               view.contentEl.querySelector(".pdf-embed");
    }
    return null;
}

// Unified smooth scroll helper to prevent fighting native scroll interruption
function smoothScrollTo(el, targetValue, isPercentage = false, axis = 'y') {
    if (!el) return;
    
    const prop = axis === 'x' ? 'scrollLeft' : 'scrollTop';
    const maxProp = axis === 'x' ? 'scrollWidth' : 'scrollHeight';
    const clientProp = axis === 'x' ? 'clientWidth' : 'clientHeight';
    
    let targetPixel = targetValue;
    if (isPercentage) {
        const maxScroll = el[maxProp] - el[clientProp];
        targetPixel = maxScroll * targetValue;
    }

    // Initial attempt
    el.scrollTo({ [axis === 'x' ? 'left' : 'top']: targetPixel, behavior: 'smooth' });

    // Enforce scroll target (fixes issue where browser stops scroll on minor events)
    let lastPos = -1;
    let safetyCounter = 0;
    
    const interval = setInterval(() => {
        if (!el.isConnected || safetyCounter++ > 50) { clearInterval(interval); return; }

        const currentPos = el[prop];
        
        // Stop if we are close enough (within 5px)
        if (Math.abs(currentPos - targetPixel) < 5) { clearInterval(interval); return; }

        // If we stopped moving but haven't reached target, push again
        if (Math.abs(currentPos - lastPos) < 2) {
             el.scrollTo({ [axis === 'x' ? 'left' : 'top']: targetPixel, behavior: 'smooth' });
        }
        lastPos = currentPos;
    }, 100);
}

// --- MARK SEARCH MODAL ---

// Initialize the modal with reference to plugin
class MarkSearchModal extends FuzzySuggestModal {
    constructor(plugin) {
        super(plugin.app);
        this.plugin = plugin;
        this.setPlaceholder("Search for mark...");
    }

    // format mark data for the fuzzy finder
    getItems() {
        return Object.entries(this.plugin.markManager.marks).map(([key, data]) => ({
            key, ...data
        }));
    }

    // Generate the display text for a specific mark
    getItemText(item) {
        const pct = Math.round(item.percentage * 100);
        const filename = item.path.split('/').pop();
        return `${item.key} at ${pct}% ${filename}`;
    }

    // Custom renderer to include the Delete button in the list
    renderSuggestion(item, el) {
        el.addClass("vimium-mark-modal-item");
        el.createSpan({ text: this.getItemText(item.item) });

        const deleteBtn = el.createEl("button", { cls: "vimium-mark-delete-btn" });
        setIcon(deleteBtn, "x"); 

        // Handle clicking the 'X' button to delete a mark without closing modal
        deleteBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.plugin.markManager.deleteMark(item.item.key);
            
            // Efficiently refresh the list without closing the modal
            this.onInput();
            this.inputEl.focus();
        };
    }

    // Action to perform when a mark is selected (Enter key)
    onChooseItem(item) {
        this.plugin.markManager.jumpToMark(item.key);
    }
}

// --- TAB SEARCH MODAL ---

// Initialize tab search modal
class TabSearchModal extends FuzzySuggestModal {
    constructor(app) {
        super(app);
        this.setPlaceholder("Search open tabs...");
    }

    // Gather all active leaves in the workspace
    getItems() {
        const leaves = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.getRoot() === this.app.workspace.rootSplit && leaf.view) {
                leaves.push(leaf);
            }
        });
        return leaves;
    }

    // Get the title of the tab
    getItemText(leaf) { 
        return leaf.getDisplayText(); 
    }
    
    // Switch to the selected tab
    onChooseItem(leaf) { 
        this.app.workspace.setActiveLeaf(leaf, { focus: true }); 
    }
}

// --- BOOKMARK SEARCH MODAL ---

class BookmarkSearchModal extends FuzzySuggestModal {
    constructor(app, closeOnEscape = false, restoreLeaf = null) {
        super(app);
        this.setPlaceholder("Search bookmarks...");
        this.closeOnEscape = closeOnEscape;
        this.restoreLeaf = restoreLeaf;
        this.didChoose = false;
        this.targetLeaf = app.workspace.activeLeaf;
    }

    // Retrieve hierarchical bookmarks from the internal plugin
    getItems() {
        const plugin = this.app.internalPlugins.getPluginById("bookmarks");
        if (!plugin?.enabled || !plugin?.instance?.items) return [];

        const items = [];
        const traverse = (list) => {
            if (!list) return;
            for (const item of list) {
                if (item.items) traverse(item.items);
                else items.push(item);
            }
        };
        traverse(plugin.instance.items);
        return items;
    }

    // Return title or path of bookmark
    getItemText(item) { 
        return item.title || item.path || item.query || "Untitled Bookmark"; 
    }
    
    // Track if a selection was made to prevent restore logic on close
    selectSuggestion(value, evt) { 
        this.didChoose = true; 
        super.selectSuggestion(value, evt); 
    }

    // Open the selected bookmark (file or query)
    async onChooseItem(item) {
        const plugin = this.app.internalPlugins.getPluginById("bookmarks");
        const leaf = this.targetLeaf;

        if (item.type === 'file') {
            const file = this.app.vault.getAbstractFileByPath(item.path);
            if (file) await leaf.openFile(file);
            return;
        }
        if (plugin?.instance) plugin.instance.openBookmark(item, leaf);
    }

    // Clean up new tabs if the user cancelled the operation
    onClose() {
        if (this.closeOnEscape && !this.didChoose) {
            if (this.targetLeaf) this.targetLeaf.detach();
            if (this.restoreLeaf) this.app.workspace.setActiveLeaf(this.restoreLeaf, { focus: true });
        }
    }
}

// --- HELP MODAL UI ---

class VimiumHelpModal extends Modal {
    constructor(app) { super(app); }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("vimium-help-modal");

        contentEl.createEl("h1", { text: "Vimium-Obsidian Help" });

        const grid = contentEl.createDiv({ cls: "vimium-grid" });
        const col1 = grid.createDiv({ cls: "vimium-col" });

        this.addSection(col1, "Navigating the page", [
            [["k"], "Scroll up"],
            [["j"], "Scroll down"],
            [["h"], "Scroll left"],
            [["l"], "Scroll right"],
            [["gg"], "Scroll to top"],
            [["G"], "Scroll to bottom"],
            [["zH"], "Scroll to far left"],
            [["zL"], "Scroll to far right"],
            [["u"], "Scroll up (faster)"],
            [["d"], "Scroll down (faster)"],
            [["yy"], "Copy file path to clipboard"],
            [["f"], "Open Link Hints"],
            [["F"], "Open Link Hints in a new tab"],
            [["i"], "Enter insert mode"],
            [["esc"], "Leave insert mode"],
            [["[["], "Jump to previous heading"],
            [["]]"], "Jump to next heading"],
        ]);

        this.addSection(col1, "Files & Commands", [
            [["o"], "Open quick switcher"],
            [["O"], "Open quick switcher in new tab"],
            [["e"], "Open command palette"],
            [["b"], "Open a bookmark"],
            [["B"], "Open a bookmark in a new tab"],
            [["T"], "Search through open tabs"],
        ]);

        this.addSection(col1, "Using Marks", [
            [["m*"], "Create a new mark"],
            [["`*"], "Jump to a mark"],
            [["md"], "Clear marks on current tab"],
            [["ml"], "List/Search all marks"],
        ]);

        const col2 = grid.createDiv({ cls: "vimium-col" });

        this.addSection(col2, "Navigating history", [
            [["H"], "Go back in history"],
            [["L"], "Go forward in history"],
        ]);

        this.addSection(col2, "Using Find", [
            [["/"], "Enter find mode"],
            [["n"], "Cycle forward to the next find match"],
            [["N"], "Cycle backward to the previous find match"],
        ]);

        this.addSection(col2, "Manipulating tabs", [
            [["t"], "Create new tab"],
            [["J", "gT"], "Go one tab left"],
            [["K", "gt"], "Go one tab right"],
            [["^"], "Go to previously-visited tab"],
            [["g0"], "Go to the first tab"],
            [["g$"], "Go to the last tab"],
            [["yt"], "Duplicate current tab"],
            [["p"], "Pin/Unpin current tab"],
            [["x"], "Close current tab"],
            [["X"], "Restore closed tab"],
            [["W"], "Move tab to new window"],
            [["<<"], "Move tab to the left"],
            [[">>"], "Move tab to the right"],
            [["zi"], "Zoom in"],
            [["zo"], "Zoom out"],
            [["z0"], "Reset zoom"],
        ]);

        this.addSection(col2, "Miscellaneous", [
            [["r"], "Reload Obsidian"],
            [["R"], "Open a random new note"],
            [["gs"], "Open file in default app"],
            [["?"], "Show help"],
        ]);
    }

    // Helper to render a section of keys in the help modal
    addSection(parent, title, rows) {
        parent.createEl("h3", { text: title });
        const table = parent.createEl("table", { cls: "vimium-table" });
        rows.forEach(([keys, desc]) => {
            const tr = table.createEl("tr");
            const tdKeys = tr.createEl("td", { cls: "vimium-keys" });
            keys.forEach((k, index) => {
                if (index > 0) tdKeys.createSpan({ text: ",", style: "margin-right: 4px; color: var(--text-muted);" });
                tdKeys.createSpan({ text: k, cls: "vimium-key" });
            });
            tr.createEl("td", { text: desc, cls: "vimium-desc" });
        });
    }
}

// --- LINK HINT MANAGER ---

class LinkHintManager {
    constructor(plugin) {
        this.plugin = plugin;
        this.active = false;
        this.hints = [];
        this.containerEl = null;
        this.currentDoc = null;
        this.boundClickHandler = null;
    }

    // Check if hints are currently displayed
    isActive() { 
        return this.active; 
    }

    // Begin the hint generation process
    start(openInNewTab = false, doc = document) {
        if (this.active) return;
        this.active = true;
        this.openInNewTab = openInNewTab;
        this.currentDoc = doc;
        this.input = "";

        const win = doc.defaultView || window;
        this.boundClickHandler = () => { this.stop(); };
        doc.addEventListener("mousedown", this.boundClickHandler);

        const elements = Array.from(doc.querySelectorAll(CLICKABLE_SELECTORS)).filter(el => {
            if (!el.offsetParent) return false;
            const rect = el.getBoundingClientRect();
            return (rect.width > 0 && rect.height > 0 &&
                    rect.top >= 0 && rect.left >= 0 &&
                    rect.bottom <= (win.innerHeight || doc.documentElement.clientHeight) &&
                    rect.right <= (win.innerWidth || doc.documentElement.clientWidth));
        });

        if (!elements.length) { new Notice("No clickable elements."); this.stop(); return; }

        const codes = this.generateHintCodes(elements.length);
        this.containerEl = doc.createElement("div");
        this.containerEl.id = "vimium-hint-container";
        doc.body.appendChild(this.containerEl);

        this.hints = elements.map((el, i) => {
            const code = codes[i];
            const rect = el.getBoundingClientRect();
            const hintEl = doc.createElement("div");
            hintEl.className = "vimium-hint";
            if (this.openInNewTab) hintEl.style.borderColor = "#58c4dc";
            hintEl.innerText = code.toUpperCase();
            hintEl.style.top = `${rect.top}px`;
            hintEl.style.left = `${rect.left}px`;
            this.containerEl.appendChild(hintEl);
            return { code, el, hintEl };
        });
    }

    // Handle input key when hints are active
    handleKey(key) {
        if (!this.active) return false;
        if (key === "Escape") { this.stop(); return true; }
        if (key === "Backspace") {
            this.input = this.input.slice(0, -1);
            this.updateHints();
            return true;
        }

        if (!/^[a-z]$/i.test(key)) return true;
        this.input += key.toLowerCase();
        
        const possible = this.hints.filter(h => h.code.startsWith(this.input));
        if (!possible.length) return true;

        const exact = this.hints.find(h => h.code === this.input);
        if (exact) {
            this.triggerClick(exact.el);
            this.stop();
        } else {
            this.updateHints();
        }
        return true;
    }

    // Redraw hints based on current input filter
    updateHints() {
        this.hints.forEach(hint => {
            if (hint.code.startsWith(this.input)) {
                hint.hintEl.style.display = "block";
                const matched = hint.code.substring(0, this.input.length).toUpperCase();
                const rest = hint.code.substring(this.input.length).toUpperCase();
                hint.hintEl.innerHTML = `<span class="vimium-match">${matched}</span>${rest}`;
            } else { hint.hintEl.style.display = "none"; }
        });
    }

    // Simulate a click event on the target element
    triggerClick(el) {
        if (this.openInNewTab) {
            el.dispatchEvent(new MouseEvent("click", {
                bubbles: true, cancelable: true, view: this.currentDoc?.defaultView || window,
                ctrlKey: true, metaKey: true
            }));
        } else {
            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.contentEditable === "true") el.focus();
            else el.click();
        }
    }

    // Clean up hint overlay and listeners
    stop() {
        if (!this.active) return;
        this.active = false;
        if (this.boundClickHandler && this.currentDoc) {
            this.currentDoc.removeEventListener("mousedown", this.boundClickHandler);
            this.boundClickHandler = null;
        }
        if (this.containerEl) { this.containerEl.remove(); this.containerEl = null; }
        this.currentDoc = null;
    }

    // Generate unique character codes for hints
    generateHintCodes(count) {
        if (count <= 26) return HINT_CHARS.slice(0, count).split('');
        const codes = [];
        const chars = HINT_CHARS.split('');
        for (const c1 of chars) {
            for (const c2 of chars) {
                codes.push(c1 + c2);
                if (codes.length >= count) return codes;
            }
        }
        return codes;
    }
}

// --- MARK MANAGER ---

class MarkManager {
    constructor(plugin) {
        this.plugin = plugin;
        this.marks = {};
        this.waitingForMarkChar = false;
        this.waitingForJumpChar = false;
        this.promptNotice = null;
    }

    // Check if we are waiting for a mark key
    isActive() { 
        return this.waitingForMarkChar || this.waitingForJumpChar; 
    }

    // Handle keystrokes specifically for mark operations
    handleKey(evt) {
        const key = evt.key;
        if (this.waitingForMarkChar) {
            if (key === "Escape") {
                this.waitingForMarkChar = false;
                this.notify("Cancelled mark creation", this.promptNotice);
            } else {
                const lower = key.toLowerCase();
                this.waitingForMarkChar = false;
                if (lower === 'd') this.clearAllMarks(this.promptNotice);
                else if (lower === 'l') {
                    if (this.promptNotice) this.promptNotice.hide();
                    new MarkSearchModal(this.plugin).open();
                } else this.createMark(key, this.promptNotice);
            }
            this.promptNotice = null;
            return true;
        }

        if (this.waitingForJumpChar) {
            this.waitingForJumpChar = false;
            if (key !== "Escape") this.jumpToMark(key);
            else if (this.promptNotice) this.promptNotice.hide();
            this.promptNotice = null;
            return true;
        }
        return false;
    }

    // Begin 'create mark' state
    startMarkCreation() { 
        this.waitingForMarkChar = true; this.promptNotice = new Notice("Create mark..."); 
    }
    
    // Begin 'jump to mark' state
    startMarkJump() { 
        this.waitingForJumpChar = true; 
    }

    // Helper to update an existing notice or create a new one
    notify(msg, existingNotice = null) {
        if (existingNotice?.noticeEl?.isConnected) existingNotice.noticeEl.setText(msg);
        else new Notice(msg);
    }

    // Record the current scroll position as a mark
    createMark(key, promptNotice = null) {
        const view = this.plugin.app.workspace.activeLeaf?.view;
        const el = getScrollElement(view);
        if (!el) { this.notify("Marks only work in Reading Mode or PDFs", promptNotice); return; }

        const maxScroll = el.scrollHeight - el.clientHeight;
        const percentage = maxScroll > 0 ? el.scrollTop / maxScroll : 0;
        
        if (!view.file) return;

        this.marks[key] = { leafId: view.leaf.id, path: view.file.path, percentage };
        this.notify(`Marked '${key}' at ${Math.round(percentage * 100)}%`, promptNotice);
        this.drawMarks(view);
    }

    // Remove a specific mark
    deleteMark(key) {
        if (this.marks[key]) {
            delete this.marks[key];
            const view = this.plugin.app.workspace.activeLeaf?.view;
            if (view) this.drawMarks(view);
        }
    }

    // Restore a tab and scroll to a saved mark position
    async jumpToMark(key) {
        const mark = this.marks[key];
        if (!mark) { new Notice(`Mark '${key}' not set`); return; }

        const workspace = this.plugin.app.workspace;
        let targetLeaf = workspace.getLeafById(mark.leafId);

        if (targetLeaf) {
            workspace.setActiveLeaf(targetLeaf, { focus: true });
            const el = getScrollElement(targetLeaf.view);
            if (el) smoothScrollTo(el, mark.percentage, true);
            else new Notice("Tab content changed");
        } else {
            const file = this.plugin.app.vault.getAbstractFileByPath(mark.path);
            if (file) {
                new Notice(`Re-opening '${key}'...`);
                targetLeaf = workspace.getLeaf('tab');
                await targetLeaf.openFile(file);
                this.marks[key].leafId = targetLeaf.id;
                setTimeout(() => { 
                    const el = getScrollElement(targetLeaf.view);
                    if (el) smoothScrollTo(el, mark.percentage, true);
                }, 500);
            } else {
                new Notice("File no longer exists");
                delete this.marks[key];
            }
        }
    }

    // Delete all marks for the current file
    clearAllMarks(promptNotice = null) {
        const currentLeafId = this.plugin.app.workspace.activeLeaf?.id;
        if (!currentLeafId) return;

        for (const key in this.marks) {
            if (this.marks[key].leafId === currentLeafId) delete this.marks[key];
        }
        const view = this.plugin.app.workspace.activeLeaf?.view;
        if (view) this.drawMarks(view);
        this.notify("Cleared marks for this tab", promptNotice);
    }

    // Visually render marks (ticks) on the scrollbar
    drawMarks(view) {
        if (!view?.leaf) return;
        const scrollEl = getScrollElement(view);
        if (!scrollEl) return;

        const parent = scrollEl.parentElement;
        if (!parent) return;
        let container = parent.querySelector('.vimium-marks-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'vimium-marks-container';
            parent.appendChild(container);
            if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        }
        container.empty();

        const currentLeafId = view.leaf.id;
        for (const [key, data] of Object.entries(this.marks)) {
            if (data.leafId === currentLeafId) {
                const tick = document.createElement('div');
                tick.className = 'vimium-mark-tick';
                tick.setAttribute('data-label', key);
                tick.style.top = `${data.percentage * 100}%`;
                tick.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    smoothScrollTo(scrollEl, data.percentage, true);
                };
                container.appendChild(tick);
            }
        }
    }
}

// --- CORE LOGIC ---

class VimiumLogic {
    constructor(plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        this.keyBuffer = "";
        this.bufferTimeout = null;
        this.scrollInterval = null;
        this.currentScrollKey = null;
        this.currentZoom = 1.0;
        this.hintManager = new LinkHintManager(plugin);
        this.markManager = plugin.markManager;
    }

    // Locate the line number of a currently highlighted search match
    getLineOfActiveMatch(view) {
        try {
            const activeMatchEl = view.previewMode.containerEl.querySelector(".search-highlight > div.is-active");
            if (!activeMatchEl) return null;
            const renderer = view.previewMode.renderer;
            if (renderer?.sections) {
                for (const section of renderer.sections) {
                    if (section.el.contains(activeMatchEl)) return section.lineStart;
                }
            }
        } catch (e) { console.error("Vimium: Failed to map DOM to Line", e); }
        return null;
    }

    // Mask embeds and links to prevent Regex matching inside URL definitions
    getSearchableContent(rawText) {
        return rawText
            .replace(/!\[\[(.*?)\]\]/g, m => " ".repeat(m.length)) // Embeds
            .replace(/\[\[(.*?)\|(.*?)\]\]/g, (m, p, a) => " ".repeat(2 + p.length + 1) + a + " ".repeat(2)) // Aliases
            .replace(/\[(.*?)\]\((.*?)\)/g, (m, t, u) => " " + t + " ".repeat(2 + u.length + 1)); // Links
    }

    // Create a visual flash effect on the text editor
    triggerFlash(cm, offset, len, doc) {
        if (!cm) return;
        let attempts = 0;
        const flash = setInterval(() => {
            if (++attempts > 50) { clearInterval(flash); return; }
            const startRect = cm.coordsAtPos(offset);
            const endRect = cm.coordsAtPos(offset + len);
            
            if (startRect && endRect && (startRect.top > 0 || startRect.left > 0)) {
                clearInterval(flash);
                const height = startRect.bottom - startRect.top;
                let width = (endRect.top === startRect.top) ? (endRect.left - startRect.left) : 50;
                if (width < 5) width = 10;

                const flashEl = doc.createElement("div");
                flashEl.className = "vimium-flash";
                Object.assign(flashEl.style, {
                    left: `${startRect.left}px`, top: `${startRect.top + (height / 2)}px`,
                    width: `${width}px`, height: `${height}px`
                });
                doc.body.appendChild(flashEl);
                setTimeout(() => flashEl.remove(), 10000);
            }
        }, 20);
    }

    // Main handler for keydown events
    async handleKeyDown(event) {
        const doc = event.target.ownerDocument || document; 
        const helpContent = doc.querySelector(".vimium-help-modal");
        const activeModal = doc.querySelector(".modal");
        
        let scrollTarget = null;
        let isHelpMode = false;

        if (helpContent && activeModal?.contains(helpContent)) {
            scrollTarget = helpContent.closest(".modal");
            isHelpMode = true;
        } else if (!activeModal) {
            scrollTarget = getScrollElement(this.app.workspace.activeLeaf?.view);
        }

        if (activeModal && !isHelpMode) return;
        if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
        
        if (this.hintManager.isActive()) {
            this.hintManager.handleKey(event.key);
            event.preventDefault(); event.stopPropagation(); return;
        }

        if (this.markManager.isActive()) {
            if (this.markManager.handleKey(event)) { event.preventDefault(); event.stopPropagation(); }
            return;
        }

        let key = event.key;
        if (event.shiftKey) {
            if (key === ",") key = "<";
            if (key === ".") key = ">";
        }

        const lowerKey = key.toLowerCase();
        const { ctrlKey: isCtrl, shiftKey: isShift, altKey: isAlt, metaKey: isMeta } = event;

        if (key === "Escape") {
            if (isHelpMode) return; 
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view?.getMode() === "source") {
                this.app.commands.executeCommandById("markdown:toggle-preview");
                event.preventDefault(); 
            }
            return;
        }
        
        // 'f' -> Link Hints
        if (lowerKey === "f" && !isCtrl && !isAlt && !isMeta && !isHelpMode && this.shouldHandleKeys(doc)) {
            this.hintManager.start(isShift, doc); 
            event.preventDefault(); return;
        }

        if (!isHelpMode && !this.shouldHandleKeys(doc)) return;

        // --- BUFFER SEQUENCES ---

        if (this.keyBuffer.length > 0 && !isCtrl && !isAlt && !isMeta) {
            const sequence = this.keyBuffer + key;
            let matched = true;

            switch (sequence) {
                case "gg": if (scrollTarget) smoothScrollTo(scrollTarget, 0, false, 'y'); break;
                case "zH": if (scrollTarget) smoothScrollTo(scrollTarget, 0, false, 'x'); break;
                case "zL": if (scrollTarget) smoothScrollTo(scrollTarget, 1.0, true, 'x'); break;
                case "gt": this.app.commands.executeCommandById("workspace:next-tab"); break;
                case "gT": this.app.commands.executeCommandById("workspace:previous-tab"); break;
                case "zi": if (scrollTarget) this.adjustContentZoom(scrollTarget, 0.1); break;
                case "zo": if (scrollTarget) this.adjustContentZoom(scrollTarget, -0.1); break;
                case "z0": if (scrollTarget) this.resetContentZoom(scrollTarget); break;
                case "[[": if (!isHelpMode) this.navigateToHeading(-1); break;
                case "]]": if (!isHelpMode) this.navigateToHeading(1); break;
                case "<<": if (!isHelpMode) this.moveTab(-1); break;
                case ">>": if (!isHelpMode) this.moveTab(1); break;
                case "gs": 
                    const f = this.app.workspace.getActiveFile();
                    if (f) { this.app.openWithDefaultApp(f.path); new Notice(`Opening ${f.name}...`); }
                    break;
                case "g0": case "g$":
                    const l = this.app.workspace.activeLeaf;
                    if (l?.parent?.children) {
                        const siblings = l.parent.children.filter(c => c.view);
                        const target = sequence === "g0" ? siblings[0] : siblings[siblings.length - 1];
                        if (target && target !== l) this.app.workspace.setActiveLeaf(target, { focus: true });
                    }
                    break;
                case "yt": 
                case "yy":
                     const file = this.app.workspace.getActiveFile();
                     if (file) {
                         if (sequence === "yt") this.app.workspace.getLeaf('tab').openFile(file);
                         else { navigator.clipboard.writeText(file.path); new Notice(`Yanked ${file.path}`); }
                     }
                     break;
                default: matched = false;
            }

            this.clearKeyBuffer();
            if (matched) { event.preventDefault(); return; }
        }

        if (this.keyBuffer === "" && !isCtrl && !isAlt && !isMeta &&
           "gyz[]<>".includes(key)) {
            this.addToBuffer(key);
            event.preventDefault(); return;
        }

        if (key === "?" && !isCtrl && !isAlt && !isMeta) {
            new VimiumHelpModal(this.app).open();
            event.preventDefault(); return;
        }

        // --- SCROLLING ---

        if (scrollTarget && !isShift && !isCtrl && !isAlt && !isMeta && "jkduhl".includes(lowerKey)) {
            if (event.repeat) { event.preventDefault(); return; }
            
            if (this.scrollInterval === null) {
                this.currentScrollKey = lowerKey;
                this.scrollStartTime = Date.now();
                this.performScroll(scrollTarget, lowerKey, false, 1.0);
                
                this.scrollInterval = setInterval(() => {
                    const target = isHelpMode ? doc.querySelector(".vimium-help-modal")?.closest(".modal") 
                                              : getScrollElement(this.app.workspace.activeLeaf?.view);
                    if (target && this.currentScrollKey) {
                        const { smoothScrollDuration: dur, smoothScrollStart: start, smoothScrollEnd: max, smoothScrollCurve: curveP } = this.plugin.settings;
                        const t = Math.min(1, (Date.now() - this.scrollStartTime) / dur);
                        const velocity = start + (max - start) * Math.pow(t, curveP); 
                        this.performScroll(target, this.currentScrollKey, true, velocity);
                    } else this.stopScroll();
                }, this.plugin.settings.repeatInterval);
            }
            event.preventDefault(); return;
        }

        if (!isCtrl && !isAlt && !isMeta && !isHelpMode) {
            // Marks
            if (lowerKey === 'm') { this.markManager.startMarkCreation(); event.preventDefault(); return; }
            if (key === '`') { this.markManager.startMarkJump(); event.preventDefault(); return; }
            
            // Bookmarks
            if (lowerKey === "b") {
                const modal = new BookmarkSearchModal(this.plugin.app, isShift, isShift ? this.app.workspace.activeLeaf : null);
                if (isShift) this.app.commands.executeCommandById("workspace:new-tab");
                modal.open();
                event.preventDefault(); return;
            }

            // Quick Switcher logic
            if (lowerKey === "o") {
                if (isShift) {
                     const origin = this.app.workspace.activeLeaf;
                     this.app.commands.executeCommandById("workspace:new-tab");
                     const target = this.app.workspace.activeLeaf;
                     this.app.commands.executeCommandById("switcher:open");
                     setTimeout(() => {
                        const modal = target?.view?.contentEl?.ownerDocument.querySelector('.modal-container .prompt');
                        if (modal) {
                            const timer = setInterval(() => {
                                if (!modal.closest('.modal-container').isConnected) {
                                    clearInterval(timer);
                                    if (target.view.getViewType() === "empty") {
                                        target.detach();
                                        if (origin) this.app.workspace.setActiveLeaf(origin, { focus: true });
                                    }
                                }
                            }, 100);
                        }
                     }, 250);
                } else this.app.commands.executeCommandById("switcher:open");
                event.preventDefault(); return;
            }

            // Standard Commands
            if (lowerKey === 't') {
                 if (isShift) new TabSearchModal(this.plugin.app).open();
                 else this.app.commands.executeCommandById("workspace:new-tab");
                 event.preventDefault(); return;
            }
            if (lowerKey === 'w' && isShift) {
                 this.app.commands.executeCommandById("workspace:move-to-new-window");
                 event.preventDefault(); return;
            }
            if (lowerKey === 'e' && !isShift) {
                 this.app.commands.executeCommandById("command-palette:open");
                 event.preventDefault(); return;
            }
            if (lowerKey === 'p' && !isShift) {
                 this.app.commands.executeCommandById("workspace:toggle-pin");
                 event.preventDefault(); return;
            }
            if (lowerKey === 'r' && !isShift) {
                 this.app.commands.executeCommandById("app:reload");
                 event.preventDefault(); return;
            }

            // Tabs / History
            if (lowerKey === "x") {
                if (isShift) {
                     if (this.app.workspace.recentLeaves?.length === 0) new Notice("No closed tabs to restore.");
                     else this.app.commands.executeCommandById("workspace:undo-close-pane");
                } else this.app.commands.executeCommandById("workspace:close");
                event.preventDefault(); return;
            }

            if (key === "^") {
                const prev = this.plugin.previousLeaf;
                if (prev?.parent) this.app.workspace.setActiveLeaf(prev, { focus: true });
                else new Notice("No previous tab found.");
                event.preventDefault(); return;
            }

            if (isShift && (lowerKey === "j" || lowerKey === "k")) {
                this.app.commands.executeCommandById(lowerKey === "j" ? "workspace:previous-tab" : "workspace:next-tab");
                event.preventDefault(); return;
            }

            if (isShift && (lowerKey === "h" || lowerKey === "l")) {
                this.goHistory(lowerKey === "h" ? -1 : 1);
                event.preventDefault(); return;
            }

            if (lowerKey === "r" && isShift) {
                const files = this.app.vault.getMarkdownFiles();
                if (files.length) this.app.workspace.getLeaf(true).openFile(files[Math.floor(Math.random() * files.length)]);
                event.preventDefault(); return;
            }

            if (isShift && lowerKey === "g") {
                if (scrollTarget) smoothScrollTo(scrollTarget, 1.0, true, 'y');
                event.preventDefault(); return;
            }
        }

        // --- 'i' -> SMART INSERT ---

        if (lowerKey === "i" && !isCtrl && !isAlt && !isMeta && !isShift && !isHelpMode) {
            let view = this.app.workspace.getActiveViewOfType(MarkdownView);
            // Fallback for sticky
            if (!view) this.app.workspace.iterateRootLeaves(l => { if (!view && l.view instanceof MarkdownView) view = l.view; });
            
            if (view?.getMode() === "preview") {
                event.preventDefault(); event.stopPropagation();

                // Check if Search HUD is NOT active
                if (!this.plugin.findLogic || !this.plugin.findLogic.searchHud) {
                    this.app.commands.executeCommandById("markdown:toggle-preview");

                    // Wait for the editor to render and force focus
                    let attempts = 0;
                    const focusInterval = setInterval(() => {
                        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                        // Stop checking if we found the editor in source mode
                        if (activeView && activeView.getMode() === 'source' && activeView.editor) {
                             activeView.editor.focus();
                             clearInterval(focusInterval);
                        }
                        // Give up after ~400ms to prevent infinite loops
                        if (++attempts > 20) clearInterval(focusInterval);
                    }, 20);
                    return;
                }
                // ------------------------------------------------

                // 1.0 GATHER SEARCH DATA (Safely)
                let searchQuery = "";
                let targetIndex = 0;
                let nativeLine = null;

                try {
                    nativeLine = this.getLineOfActiveMatch(view);
                    const find = this.plugin.findLogic;

                    if (find) {
                        // 1.1 Try to get query from active HUD first
                        if (find.inputEl && find.inputEl.value) searchQuery = find.inputEl.value;
                        
                        // 1.2 Fallback to cache for this file
                        else if (view.file?.path) searchQuery = find.searchCache[view.file.path] || "";

                        // 1.3 Try to get the index (1/5) from HUD
                        if (find.countEl) {
                            const parts = find.countEl.innerText?.split('/');
                            if (parts?.length) targetIndex = parseInt(parts[0].trim(), 10) - 1;
                        }
                        
                        find.closeSearchHud();
                    }
                } catch (e) {
                    console.log("Vimium: Error gathering search data, proceeding to toggle.", e);
                }

                // 2.0 EXECUTE TOGGLE
                this.app.commands.executeCommandById("markdown:toggle-preview");

                // 3.0 ATTEMPT JUMP (Only if we have data)
                if (!searchQuery && nativeLine === null) return;

                let attempts = 0;
                const waitForEditor = setInterval(() => {
                    view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (++attempts > 125) { clearInterval(waitForEditor); return; }

                    if (view?.editor) {
                        clearInterval(waitForEditor);
                        const editor = view.editor;
                        editor.focus();
                        
                        if (targetIndex < 0) targetIndex = 0;
                        let found = false;

                        // Regex Strategy
                        if (searchQuery) {
                            const regex = new RegExp(escapeRegExp(searchQuery), "gi");
                            const content = this.getSearchableContent(editor.getValue());
                            let match, count = 0;
                            while ((match = regex.exec(content)) !== null) {
                                if (count === targetIndex) {
                                    const pos = editor.offsetToPos(match.index);
                                    editor.setCursor(pos);
                                    editor.scrollIntoView({ from: pos, to: pos }, true);
                                    this.triggerFlash(editor.cm, match.index, searchQuery.length, view.contentEl.ownerDocument);
                                    found = true;
                                    break;
                                }
                                count++;
                            }
                        }

                        // Native Line Strategy (Fallback)
                        if (!found && nativeLine !== null) {
                            const lineText = editor.getLine(nativeLine);
                            let ch = 0;
                            if (searchQuery) {
                                const m = (new RegExp(escapeRegExp(searchQuery), "i")).exec(lineText);
                                if (m) ch = m.index;
                            }
                            const pos = { line: nativeLine, ch };
                            editor.setCursor(pos);
                            editor.scrollIntoView({ from: pos, to: pos }, true);
                            this.triggerFlash(editor.cm, editor.posToOffset(pos), searchQuery.length || 5, view.contentEl.ownerDocument);
                        }
                    }
                }, 20);
                return;
            }
        }
    }

    // Handle key release events. Primarily used to stop scrolling
    handleKeyUp(event) {
        if ("jkduhl".includes(event.key.toLowerCase()) && event.key.toLowerCase() === this.currentScrollKey) {
            this.stopScroll();
        }
    }

    // Shift current tab left or right (Placeholder)
    moveTab(direction) {
        new Notice("Tab moving is not yet implemented.");
        console.log(`Vimium: moveTab requested direction ${direction}`);
    }

    // Jump to next or previous heading in markdown file
    navigateToHeading(direction) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return;
        const cache = this.app.metadataCache.getFileCache(view.file);
        if (!cache?.headings?.length) { new Notice("No headings found."); return; }

        const scrollTop = view.previewMode.containerEl.querySelector(".markdown-preview-view").scrollTop;
        const renderer = view.previewMode.renderer;
        let currentLine = 0;
        
        if (renderer?.sections) {
            for (const section of renderer.sections) {
                if (section.el.offsetTop >= scrollTop) { currentLine = section.lineStart; break; }
                currentLine = section.lineStart;
            }
        }

        const headings = cache.headings;
        let target = null;
        if (direction > 0) {
            target = headings.find(h => h.position.start.line > currentLine) || headings[headings.length - 1];
        } else {
            for (let i = headings.length - 1; i >= 0; i--) {
                if (headings[i].position.start.line < currentLine) { target = headings[i]; break; }
            }
            target = target || headings[0];
        }
        if (target) {
            view.setEphemeralState({ line: target.position.start.line });
            new Notice(`Jumped to: ${target.heading}`);
        }
    }

    // Modify the zoom level of the content
    adjustContentZoom(el, delta) {
        this.currentZoom = Math.min(5.0, Math.max(0.3, parseFloat((this.currentZoom + delta).toFixed(1))));
        el.style.zoom = this.currentZoom;
        new Notice(`Zoom ${Math.round(this.currentZoom * 100)}%`);
    }

    // Reset zoom to default 1.0
    resetContentZoom(el) { 
        this.currentZoom = 1.0; el.style.zoom = 1.0; new Notice("Zoom Reset"); 
    }

    // Execute a single scroll step (called by loop or keydown)
    performScroll(el, key, isRepeat, multiplier) {
        const speed = this.plugin.settings.scrollSpeed * (['d', 'u'].includes(key) ? 2 : 1) * multiplier;
        const dir = (key === 'j' || key === 'd' || key === 'l') ? 1 : -1;
        const axis = ['h', 'l'].includes(key) ? 'left' : 'top';
        
        if (isRepeat) el[axis === 'left' ? 'scrollLeft' : 'scrollTop'] += (speed * dir);
        else el.scrollBy({ [axis]: (speed * dir * 25), behavior: "smooth" });
    }

    // Cancel the automated smooth scrolling loop
    stopScroll() { 
        if (this.scrollInterval) { clearInterval(this.scrollInterval); this.scrollInterval = null; this.currentScrollKey = null; } 
    }

    // Navigate back or forward in navigation history
    goHistory(dir) {
        const h = this.app.workspace.activeLeaf?.history;
        if (!h) return;
        if (dir === -1) { if (h.backHistory.length) h.back(); else new Notice("No back history."); }
        else { if (h.forwardHistory.length) h.forward(); else new Notice("No forward history."); }
    }

    // Add keystroke to the command buffer (reset after 1s)
    addToBuffer(k) { 
        this.keyBuffer += k; clearTimeout(this.bufferTimeout); this.bufferTimeout = setTimeout(() => this.keyBuffer = "", 1000); 
    }
    
    // Clear the keystroke buffer immediately
    clearKeyBuffer() { 
        this.keyBuffer = ""; clearTimeout(this.bufferTimeout); 
    }

    // Determine if Vimium should intercept keys in current context
    shouldHandleKeys(doc = document) {
        const active = doc.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return false;
        if (getScrollElement(this.app.workspace.activeLeaf?.view)) return true;
        return ["empty", "bases", "canvas", "graph", "localgraph", "image", "pdf", "kanban"]
               .includes(this.app.workspace.activeLeaf?.view?.getViewType());
    }
}

// --- PLUGIN ENTRY POINT ---

// Plugin load point: Initialize settings, managers, and event listeners
module.exports = class VimiumRead extends Plugin {
  async onload() {
    console.log("Loading Vimium Read...");
    await this.loadSettings();

    this.markManager = new MarkManager(this);
    this.logic = new VimiumLogic(this);
    this.findLogic = new FindLogic(this);

    this.currentLeaf = this.app.workspace.activeLeaf;

    // Close HUD on tab switch
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (this.findLogic) this.findLogic.closeSearchHud();

      if (leaf && leaf !== this.currentLeaf) {
        this.previousLeaf = this.currentLeaf;
        this.currentLeaf = leaf;
      }
      if (leaf?.view && getScrollElement(leaf.view)) {
        setTimeout(() => this.markManager.drawMarks(leaf.view), 150);
      }
    }));

    // Maintain a registry of documents that have listeners attached
    this._docsWithListeners = new WeakSet();

    const registerWindowEvents = (win) => {
      const doc = win.document;
      if (this._docsWithListeners.has(doc)) return;
      this._docsWithListeners.add(doc);
      this.registerDomEvent(doc, "keydown", (e) => this.logic.handleKeyDown(e), { capture: true });
      this.registerDomEvent(doc, "keyup",   (e) => this.logic.handleKeyUp(e));
      this.registerDomEvent(doc, "keydown", (e) => this.findLogic.handleKeyDown(e), { capture: true });
    };

    registerWindowEvents(window);
    this.registerEvent(this.app.workspace.on("window-open", (l) => registerWindowEvents(l.win ?? l)));

    this.addSettingTab(new VimiumReadSettingTab(this.app, this));
  }

  // Load settings from disk
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  // Save settings to disk
  async saveSettings() {
    await this.saveData(this.settings);
  }
  // Cleanup resources when plugin is disabled
  onunload() {
    this.logic?.hintManager?.stop(); this.findLogic?.closeSearchHud();
    // Allow clean reattachment after reload
    this._docsWithListeners = new WeakSet();
  }
};

// Render the settings UI
class VimiumReadSettingTab extends PluginSettingTab {
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h3', { text: 'Base Scroll Settings' });

        const addTextSetting = (name, desc, key, isFloat = false) => {
            new Setting(containerEl).setName(name).setDesc(desc)
                .addText(text => text.setValue(this.plugin.settings[key].toString())
                .onChange(async (val) => {
                    this.plugin.settings[key] = isFloat ? parseFloat(val) : parseInt(val);
                    await this.plugin.saveSettings();
                }));
        };

        addTextSetting("Base Scroll Speed", "The fundamental pixel step size when scrolling", "scrollSpeed");
        addTextSetting("Repeat Interval (ms)", "Lower = smoother (higher CPU)", "repeatInterval");

        containerEl.createEl('h3', { text: 'Scroll Acceleration' });
        addTextSetting("Start Speed Multiplier", "Speed at start of scroll", "smoothScrollStart", true);
        addTextSetting("Max Speed Multiplier", "Top scrolling speed", "smoothScrollEnd", true);
        addTextSetting("Ramp Duration (ms)", "Time to max scrolling speed", "smoothScrollDuration");
        addTextSetting("Acceleration Curve", "1=Linear, 3=Cubic", "smoothScrollCurve", true);
    }
}

// --- FIND LOGIC ---

// Initialize find logic state
class FindLogic {
    constructor(plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        this.searchCache = {}; // Simple cache: "Folder/Note.md": "search query"
        this.searchHud = null;
        this.inputEl = null;
        this.countEl = null;
        this.currentDoc = null;
        this.nativeUI = {};
        this.handleGlobalClick = this.handleGlobalClick.bind(this);
    }

    // Generic helper for any view that supports Obsidian's native search bar (PDF + Md Preview)
    getSearchableView() { 
        const view = this.app.workspace.activeLeaf?.view;
        if (!view) return null;
        const type = view.getViewType();
        if (type === "pdf") return view;
        if (type === "markdown" && view.getMode() === "preview") return view;
        return null;
    }

    // Intercept keys for search functionality
    handleKeyDown(event) {
        const doc = event.target.ownerDocument || document;
        if (doc.querySelector(".modal") || !this.getSearchableView()) return;

        if (this.searchHud && doc.activeElement === this.inputEl) {
            if (event.key === "Escape") { 
                event.preventDefault(); event.stopPropagation(); 
                this.closeSearchHud(); 
            }
            return;
        }

        const active = doc.activeElement;
        if (active && active !== this.inputEl && active !== this.nativeUI.input &&
           (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.contentEditable === "true")) return;

        const key = event.key;
        if (key === "/" && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault(); event.stopPropagation();
            this.openSearchHud();
            return;
        }

        if (this.searchHud) {
            const isShift = event.shiftKey;
            if (key === "n" || key === "Enter" || key === "ArrowDown" || key === "N" || key === "ArrowUp") {
                event.preventDefault(); event.stopPropagation();
                this.findNextSearchResult((key === "N" || (key === "n" && isShift) || (key === "Enter" && isShift) || key === "ArrowUp"));
                return;
            }
            if (key === "/" || key === "Backspace") { event.preventDefault(); this.inputEl.focus(); return; }
            if (key === "Escape") { 
                event.preventDefault(); event.stopPropagation(); 
                this.closeSearchHud(); 
            }
        }
    }

    // Initialize and display the custom search HUD
    openSearchHud() {
        const view = this.getSearchableView();
        if (!view) return;
        
        this.currentDoc = view.containerEl.ownerDocument;
        
        // Immediately apply CSS to hide the native box before it appears
        this.currentDoc.body.classList.add('vimium-search-active');

        // Retrieve last query for this specific file
        const currentPath = view.file?.path || "global";
        const savedQuery = this.searchCache[currentPath] || "";

        this.app.commands.executeCommandById('editor:open-search');

        let attempts = 0;
        const waitForSearchUI = setInterval(() => {
            this.connectToNativeSearchUI();
            if (this.nativeUI.input) {
                clearInterval(waitForSearchUI);
                this.createSearchHud(savedQuery);
            } else if (attempts++ > 50) {
                clearInterval(waitForSearchUI);
                this.currentDoc.body.classList.remove('vimium-search-active');
            }
        }, 50);
    }

    // Link custom Search HUD to native Obsidian search buttons
    connectToNativeSearchUI() {
        const view = this.getSearchableView();
        if (!view) return;
        const root = view.containerEl || view.contentEl;
        
        let container = root.querySelector('.document-search-container');
        if (container) {
            this.nativeUI = {
                input: container.querySelector('input[type="text"]'),
                next: container.querySelector('[aria-label="Next match"], .document-search-button:nth-of-type(2)'),
                prev: container.querySelector('[aria-label="Previous match"], .document-search-button:nth-of-type(1)'),
                count: container.querySelector('.document-search-count'),
                closeBtn: container.querySelector('.document-search-close-button')
            };
            return;
        }

        container = root.querySelector('.pdf-findbar');
        if (container) {
            const buttons = container.querySelectorAll('.pdf-toolbar-button');
            this.nativeUI = {
                input: container.querySelector('input'),
                prev: buttons[0], next: buttons[1],
                count: container.querySelector('.pdf-findbar-message'),
                closeBtn: container.querySelector('[aria-label="Close"]')
            };
        }
    }

    // Build the custom search UI elements
    createSearchHud(initialQuery) {
        if (this.searchHud) { this.inputEl.focus(); this.inputEl.select(); return; }
        const doc = this.currentDoc;
        if (!doc) return;

        this.startSearchObserver();
        this.searchHud = doc.createElement('div');
        this.searchHud.id = 'vimium-search-hud';
        this.searchHud.classList.add('vimium-search-hud');

        this.countEl = doc.createElement('span');
        this.countEl.classList.add('vimium-count');
        this.countEl.innerText = "0/0";

        this.inputEl = doc.createElement('input');
        Object.assign(this.inputEl, { type: "text", placeholder: "Search...", className: "vimium-search-input" });
        
        if (initialQuery) {
            this.inputEl.value = initialQuery;
            this.syncToNativeSearch(initialQuery);
        }

        const div = doc.createElement('span'); div.className = 'vimium-search-divider'; div.innerText = " / ";
        this.searchHud.append(this.countEl, div, this.inputEl);
        doc.body.appendChild(this.searchHud);

        this.inputEl.focus();
        if (initialQuery) this.inputEl.select();

        setTimeout(() => doc.addEventListener('click', this.handleGlobalClick), 100);
        
        this.inputEl.addEventListener('input', () => {
            const val = this.inputEl.value;
            
            // Save search query to cache
            const view = this.getSearchableView();
            if (view?.file?.path) {
                this.searchCache[view.file.path] = val;
            }

            this.syncToNativeSearch(val);
        });
        
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); e.stopPropagation();
                if (this.inputEl.value) this.findNextSearchResult(e.shiftKey);
                this.inputEl.blur();
                doc.defaultView?.focus();
            }
        });
    }

    // Watch for changes in the native search result count
    startSearchObserver() {
        const el = this.getSearchableView()?.contentEl;
        if (el) {
            if (this.observer) this.observer.disconnect();
            this.observer = new MutationObserver(() => this.updateSearchCountFromNative());
            this.observer.observe(el, { childList: true, subtree: true });
        }
    }

    // Push input from custom HUD to native search box
    syncToNativeSearch(query) {
        if (!this.nativeUI.input) this.connectToNativeSearchUI();
        if (!this.nativeUI.input) return;
        this.nativeUI.input.value = query;
        this.nativeUI.input.dispatchEvent(new Event('input', { bubbles: true }));
        // Ensure highlights trigger
        this.nativeUI.input.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => this.updateSearchCountFromNative(), 50);
    }

    // Trigger native next/prev buttons
    findNextSearchResult(reverse) {
        if (!this.nativeUI.input) this.connectToNativeSearchUI();
        (reverse ? this.nativeUI.prev : this.nativeUI.next)?.click();
    }

    // Mirror native search count to custom HUD
    updateSearchCountFromNative() {
        if (!this.nativeUI.count) this.connectToNativeSearchUI();
        let txt = this.nativeUI.count?.innerText;
        if (txt) {
            txt = txt.replace(" of ", " / ").replace("matches", "");
            if (this.countEl && txt !== this.countEl.innerText) this.countEl.innerText = txt;
        }
    }

    // Close search if clicking outside HUD
    handleGlobalClick(e) {
        if (this.searchHud?.contains(e.target)) return;
        if (this.currentDoc?.querySelector('.document-search-container')?.contains(e.target)) return;
        if (this.currentDoc?.querySelector('.pdf-findbar')?.contains(e.target)) return; 
        
        this.closeSearchHud(); 
    }

    // Destroy search HUD and cleanup events
    closeSearchHud() {
        const doc = this.currentDoc || document;
        
        if (doc && doc.body) doc.body.classList.remove('vimium-search-active');

        if (this.searchHud) {
            doc.removeEventListener('click', this.handleGlobalClick);
            this.searchHud.remove();
            this.searchHud = null;
            this.observer?.disconnect();
            
            // Just close the native button to ensure it resets properly
            this.nativeUI.closeBtn?.click();

            this.nativeUI = {};
            this.getSearchableView()?.contentEl?.focus();
        }
        this.currentDoc = null;
    }
}