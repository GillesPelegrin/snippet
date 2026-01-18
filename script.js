/**
 * ==========================================
 * DEEL 1: DATABASE CONFIGURATIE & INFRA
 * ==========================================
 */
const DB_CONFIG = {
    NAME: 'SnippetManagerDB_v2',
    VERSION: 1,
    STORES: {
        SNIPPETS: 'snippets',
        TAGS: 'tags',
        TAG_STATS: 'tag_stats',
        DOMAIN_STATS: 'domain_stats'
    }
};

class Database {
    static async get() {
        if (this.dbInstance) return this.dbInstance;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_CONFIG.NAME, DB_CONFIG.VERSION);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                const { SNIPPETS, TAGS, TAG_STATS, DOMAIN_STATS } = DB_CONFIG.STORES;

                // 1. Snippets Store
                if (!db.objectStoreNames.contains(SNIPPETS)) {
                    db.createObjectStore(SNIPPETS, { keyPath: 'id', autoIncrement: true });
                }
                // 2. Tags Ontology
                if (!db.objectStoreNames.contains(TAGS)) {
                    db.createObjectStore(TAGS, { keyPath: 'name' });
                }
                // 3. Co-occurrence Stats
                if (!db.objectStoreNames.contains(TAG_STATS)) {
                    db.createObjectStore(TAG_STATS, { keyPath: 'pair' });
                }
                // 4. Domain Stats
                if (!db.objectStoreNames.contains(DOMAIN_STATS)) {
                    db.createObjectStore(DOMAIN_STATS, { keyPath: 'domain' });
                }
            };

            request.onsuccess = (e) => {
                this.dbInstance = e.target.result;
                resolve(this.dbInstance);
            };
            request.onerror = () => reject('DB Error');
        });
    }
}

/**
 * ==========================================
 * DEEL 2: KNOWLEDGE GRAPH SERVICE (HET BREIN)
 * ==========================================
 * Deze class bevat GEEN UI-logica. Alleen data-analyse.
 */
class KnowledgeGraphService {
    constructor() {
        this.stores = DB_CONFIG.STORES;
    }

    // Hulpmethode: maak unieke key voor 2 tags
    _getPairKey(tagA, tagB) {
        return [tagA, tagB].sort().join('_');
    }

    // Leert van nieuwe input (update de graph)
    async learn(tags, domain) {
        if (!tags || tags.length === 0) return;
        const db = await Database.get();

        const tx = db.transaction(
            [this.stores.TAGS, this.stores.TAG_STATS, this.stores.DOMAIN_STATS],
            'readwrite'
        );

        // 1. Tags opslaan (Ontology)
        const tagStore = tx.objectStore(this.stores.TAGS);
        tags.forEach(tagName => {
            const req = tagStore.get(tagName);
            req.onsuccess = () => {
                if (!req.result) {
                    tagStore.put({ name: tagName, created: Date.now(), parent: null, color: null });
                }
            };
        });

        // 2. Co-occurrence opslaan (Associaties)
        const statStore = tx.objectStore(this.stores.TAG_STATS);
        for (let i = 0; i < tags.length; i++) {
            for (let j = i + 1; j < tags.length; j++) {
                const pairKey = this._getPairKey(tags[i], tags[j]);
                this._incrementStat(statStore, pairKey);
            }
        }

        // 3. Domein kennis opslaan
        if (domain) {
            const domainStore = tx.objectStore(this.stores.DOMAIN_STATS);
            const req = domainStore.get(domain);
            req.onsuccess = () => {
                const data = req.result || { domain: domain, tagCounts: {} };
                tags.forEach(t => {
                    data.tagCounts[t] = (data.tagCounts[t] || 0) + 1;
                });
                domainStore.put(data);
            };
        }
    }

    // Helper voor teller verhogen
    _incrementStat(store, key) {
        const req = store.get(key);
        req.onsuccess = () => {
            const item = req.result || { pair: key, count: 0, lastSeen: 0 };
            item.count++;
            item.lastSeen = Date.now();
            store.put(item);
        };
    }

    // Voorspel tags op basis van input
    async predict(currentTags, domain) {
        const db = await Database.get();
        const scores = new Map();

        // A. Domein Suggesties
        if (domain) {
            await new Promise(resolve => {
                const tx = db.transaction(this.stores.DOMAIN_STATS, 'readonly');
                const req = tx.objectStore(this.stores.DOMAIN_STATS).get(domain);
                req.onsuccess = () => {
                    if (req.result?.tagCounts) {
                        Object.entries(req.result.tagCounts)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 3)
                            .forEach(([tag]) => scores.set(tag, (scores.get(tag) || 0) + 5));
                    }
                    resolve();
                };
            });
        }

        // B. Associatie Suggesties (als er al tags getypt zijn)
        if (currentTags.length > 0) {
            const tx = db.transaction(this.stores.TAG_STATS, 'readonly');
            const req = tx.objectStore(this.stores.TAG_STATS).getAll();

            await new Promise(resolve => {
                req.onsuccess = () => {
                    const allStats = req.result;
                    allStats.forEach(stat => {
                        const [tagA, tagB] = stat.pair.split('_');
                        const hasA = currentTags.includes(tagA);
                        const hasB = currentTags.includes(tagB);

                        // Als A er is maar B niet -> stel B voor
                        if (hasA && !hasB) scores.set(tagB, (scores.get(tagB) || 0) + stat.count);
                        // Als B er is maar A niet -> stel A voor
                        else if (!hasA && hasB) scores.set(tagA, (scores.get(tagA) || 0) + stat.count);
                    });
                    resolve();
                };
            });
        }

        // Verwijder tags die we al hebben
        currentTags.forEach(t => scores.delete(t));

        // Return top 5
        return Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(entry => entry[0])
            .slice(0, 5);
    }
}

/**
 * ==========================================
 * DEEL 3: SNIPPET REPOSITORY (DATA STORE)
 * ==========================================
 * Regelt CRUD operaties voor snippets en roept de Brain aan bij save.
 */
class SnippetRepository {
    constructor(knowledgeGraph) {
        this.storeName = DB_CONFIG.STORES.SNIPPETS;
        this.brain = knowledgeGraph; // Dependency Injection
    }

    async getAll() {
        const db = await Database.get();
        return new Promise(resolve => {
            const tx = db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).getAll();
            req.onsuccess = () => resolve(req.result);
        });
    }

    async save(item) {
        const db = await Database.get();

        // 1. Opslaan in DB
        const savedItem = await new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const req = tx.objectStore(this.storeName).put(item);
            req.onsuccess = () => resolve({ ...item, id: req.result });
            req.onerror = () => reject(req.error);
        });

        // 2. Trigger het brein om te leren (Async, fire & forget)
        // We extraheren hier het domein voor de graph
        let domain = null;
        const urlMatch = item.text.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
            try { domain = new URL(urlMatch[0]).hostname; } catch (e) { }
        }

        // Het brein leert nu van de tags die bij deze save horen
        this.brain.learn(item.tags, domain).catch(console.error);

        return savedItem;
    }

    async delete(id) {
        const db = await Database.get();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const req = tx.objectStore(this.storeName).delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
}

/**
 * ==========================================
 * DEEL 4: UI CONTROLLER (APP LOGIC)
 * ==========================================
 * Verbinding tussen HTML en de Services.
 */

// Initialiseer Services
const graphService = new KnowledgeGraphService();
const snippetRepo = new SnippetRepository(graphService);

// UI Element Refs
const elements = {
    fabAdd: document.getElementById('fabAdd'),
    modalOverlay: document.getElementById('snippetModalOverlay'),
    modalTitle: document.getElementById('modalTitle'),
    btnCloseSnippet: document.getElementById('btnCloseSnippet'),
    btnSave: document.getElementById('btnSave'),
    btnDelete: document.getElementById('btnDelete'),
    btnText: document.querySelector('.btn-text'),
    input: document.getElementById('snippetInput'),
    editorBackdrop: document.getElementById('editorBackdrop'),
    suggestionArea: document.getElementById('suggestionArea'),
    col1: document.getElementById('col-1'),
    col2: document.getElementById('col-2'),
    emptyState: document.getElementById('emptyState'),
    searchInput: document.getElementById('searchInput'),
    filterBtn: document.getElementById('btnOpenFilter'),
    filterOverlay: document.getElementById('filterModalOverlay'),
    filterClose: document.getElementById('btnCloseFilter'),
    filterApply: document.getElementById('btnApplyFilter'),
    filterTagsSection: document.getElementById('dynamicTagsSection')
};

// Regex
const RE = {
    URL: /(https?:\/\/[^\s]+)/g,
    TAG: /(?:^|\s)(#[\w-]+)/g
};

// App State
let state = {
    snippets: [],
    editingId: null,
    filter: 'all',
    search: '',
    availableTags: new Set(),
    debounceTimer: null
};

// --- Helper Functions ---
const parseTags = (text) => {
    const matches = [];
    let match;
    const regex = new RegExp(RE.TAG); // Fresh instance
    while ((match = regex.exec(text)) !== null) {
        matches.push(match[1].substring(1));
    }
    return matches;
};

const escapeHtml = (text) => {
    if (!text) return "";
    return text.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
};

// --- Core UI Logic ---

async function loadSnippets() {
    state.snippets = await snippetRepo.getAll();
    state.snippets.sort((a, b) => b.timestamp - a.timestamp);

    // Update tags set voor filter
    state.availableTags.clear();
    state.snippets.forEach(s => s.tags?.forEach(t => state.availableTags.add(t)));

    renderGrid();
}

function renderGrid() {
    elements.col1.innerHTML = '';
    elements.col2.innerHTML = '';

    const filtered = state.snippets.filter(filterLogic);

    if (filtered.length === 0) {
        elements.emptyState.style.display = 'block';
        updateEmptyStateText();
    } else {
        elements.emptyState.style.display = 'none';
        filtered.forEach((snip, i) => {
            const card = createCard(snip);
            (i % 2 === 0 ? elements.col1 : elements.col2).appendChild(card);
        });
    }
}

function filterLogic(snippet) {
    const textMatch = snippet.text.toLowerCase().includes(state.search.toLowerCase());
    if (!textMatch) return false;

    const hasLink = RE.URL.test(snippet.text);

    if (state.filter === 'links' && !hasLink) return false;
    if (state.filter === 'text' && hasLink) return false;
    if (state.filter.startsWith('tag:')) {
        const tag = state.filter.substring(4);
        if (!snippet.tags?.includes(tag)) return false;
    }
    return true;
}

function createCard(snippet) {
    const div = document.createElement('div');
    div.className = 'snippet-card';
    
    // --- PREPARE CONTENT ---
    const urlMatch = snippet.text.match(RE.URL);
    const url = urlMatch ? urlMatch[0] : null;
    let content = snippet.text;
    if (url) content = content.replace(url, '');
    content = content.replace(RE.TAG, ' ').replace(/\s+/g, ' ').trim();

    if (!content && !!url) div.classList.add('is-link-only');

    // Build HTML
    let html = '';
    if (content) {
        html += `<div class="snippet-content">${escapeHtml(content)}</div>`;
    } else if (snippet.tags?.length && !url) {
        html += `<div class="snippet-content" style="color:#888">${snippet.tags.map(t=>'#'+t).join(' ')}</div>`;
    }

    if (url) {
        // ... (Your existing Link Preview & Fallback logic goes here) ...
        // For brevity, assuming you kept the fallback logic from previous steps
        let domain = 'External Link'; 
        let image = null; 
        let title = 'Link';
        if (snippet.meta) {
             domain = snippet.meta.domain; image = snippet.meta.image; title = snippet.meta.title;
        } else { try { domain = new URL(url).hostname; } catch(e){} }
        
        const bgStyle = getGradientForDomain(domain);
        const imgTag = image 
            ? `<img src="${image}" class="link-image" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
            : '';
        const fallbackDisplay = image ? 'none' : 'flex';

        html += `
            <div class="link-preview">
                ${imgTag}
                <div class="fallback-preview" style="display:${fallbackDisplay}; background:${bgStyle}">
                    <span>${domain.charAt(0).toUpperCase()}</span>
                    <span class="fallback-domain">${domain}</span>
                </div>
                <div class="link-meta">
                    <div class="link-title">${escapeHtml(title)}</div>
                    <div class="link-domain">${escapeHtml(domain)}</div>
                </div>
            </div>`;
    }
    div.innerHTML = html;

    // --- UNIFIED TOUCH/CLICK LOGIC ---
    let timer;
    let isLongPress = false;
    let startX, startY;

    const startPress = (e) => {
        isLongPress = false;
        if (e.touches) {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }
        timer = setTimeout(() => {
            isLongPress = true;
            if (navigator.vibrate) navigator.vibrate(50);
            openModal(snippet); // LONG PRESS -> ALWAYS EDIT
        }, 500);
    };

    const cancelPress = () => clearTimeout(timer);

    const handleMove = (e) => {
        if (!startX) return;
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        if (Math.abs(x - startX) > 10 || Math.abs(y - startY) > 10) {
            clearTimeout(timer); // Cancel if scrolling
        }
    };

    const endPress = (e) => {
        clearTimeout(timer);
        if (isLongPress) {
            // Event already handled by timer, just stop propagation
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // --- SHORT TAP LOGIC ---
        // If we tapped the Link Preview area -> Open URL
        if (url && e.target.closest('.link-preview')) {
            e.stopPropagation();
            window.open(url, '_blank');
        } 
        // If we tapped Text (or anything else) -> Edit
        else {
            openModal(snippet);
        }
    };

    // Attach listeners to the WHOLE card
    div.addEventListener('touchstart', startPress, { passive: true });
    div.addEventListener('touchmove', handleMove, { passive: true });
    div.addEventListener('touchend', endPress);
    div.addEventListener('mousedown', startPress);
    div.addEventListener('mouseleave', cancelPress);
    div.addEventListener('mouseup', endPress);

    // Prevent Context Menu on Long Press
    div.addEventListener('contextmenu', (e) => {
        if (isLongPress) {
            e.preventDefault();
            return false;
        }
    });

    return div;
}

// --- Editor & Suggestions (Interaction with Brain) ---

function handleEditorInput() {
    updateHighlight();
    syncScroll();

    // Debounce de call naar het brein
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(async () => {
        const text = elements.input.value;
        const currentTags = parseTags(text);

        let domain = null;
        const urlMatch = text.match(RE.URL);
        if (urlMatch) {
            try { domain = new URL(urlMatch[0]).hostname; } catch (e) { }
        }

        // Vraag het brein om advies
        const suggestions = await graphService.predict(currentTags, domain);
        renderSuggestions(suggestions);
    }, 300);
}

function renderSuggestions(tags) {
    elements.suggestionArea.innerHTML = '';
    tags.forEach(tag => {
        const chip = document.createElement('div');
        chip.className = 'suggestion-chip';
        chip.textContent = `#${tag}`;
        chip.onclick = () => acceptSuggestion(tag);
        elements.suggestionArea.appendChild(chip);
    });
}

function acceptSuggestion(tag) {
    const val = elements.input.value;
    const needsSpace = val.length > 0 && !val.endsWith(' ');
    elements.input.value = val + (needsSpace ? ' ' : '') + `#${tag} `;
    elements.input.focus();
    handleEditorInput(); // Update direct
}

function updateHighlight() {
    let html = escapeHtml(elements.input.value);

    html = html.replace(/(^|\s)(#[\w-]+)/g, '$1<span class="tag-highlight">$2</span>');

    if (html.endsWith('\n')) html += ' ';
    elements.editorBackdrop.innerHTML = html;
}

function syncScroll() {
    elements.editorBackdrop.scrollTop = elements.input.scrollTop;
}

// --- CRUD Actions ---

async function handleSave() {
    const text = elements.input.value.trim();
    if (!text) return;

    const tags = parseTags(text);
    const item = {
        text,
        timestamp: Date.now(),
        tags,
        meta: null, // Kan later worden opgehaald
    };

    if (state.editingId) {
        item.id = state.editingId;
    }

    // Opslaan (repo regelt de DB en triggert het brein)
    const saved = await snippetRepo.save(item);

    // Metadata ophalen (optioneel, achtergrond)
    const urlMatch = text.match(RE.URL);
    if (urlMatch) fetchMetadataAndUpdate(saved, urlMatch[0]);

    closeModal();
    loadSnippets();
}

async function handleDelete() {
    if (state.editingId && confirm('Delete snippet?')) {
        await snippetRepo.delete(state.editingId);
        closeModal();
        loadSnippets();
    }
}

async function fetchMetadataAndUpdate(snippet, url) {
    try {
        const res = await fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}`);
        const json = await res.json();

        if (json.status === 'success') {
            snippet.meta = {
                url,
                title: json.data.title,
                description: json.data.description,
                image: json.data.image?.url,
                domain: json.data.publisher || new URL(url).hostname
            };
        } else {
            throw new Error('No metadata');
        }
    } catch (e) {
        // Fallback logica (net als in het origineel):
        // Als fetch faalt, sla basis info op zodat de skeleton verdwijnt
        console.warn('Meta fetch fail, using fallback', e);
        snippet.meta = {
            url: url,
            title: new URL(url).hostname,
            image: null,
            domain: 'External Link'
        };
    }

    // Altijd opslaan (success of fallback)
    await snippetRepo.save(snippet);

    // UI verversen
    loadSnippets();
}

function getGradientForDomain(domain) {
    if (!domain) return 'linear-gradient(135deg, #eee, #ddd)';
    
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
        hash = domain.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    // Create HSL color from hash
    const h = Math.abs(hash % 360);
    const s = 65; // Saturation 65%
    const l = 55; // Lightness 55%
    
    return `linear-gradient(135deg, hsl(${h}, ${s}%, ${l}%), hsl(${h+40}, ${s}%, ${l-20}%))`;
}

// --- Modal Handling ---

function openModal(snippet = null) {
    elements.modalOverlay.classList.add('active');
    if (snippet) {
        state.editingId = snippet.id;
        elements.input.value = snippet.text;
        elements.modalTitle.textContent = "Edit Snippet";
        elements.btnDelete.style.display = 'block';
        elements.btnText.textContent = 'Update';
    } else {
        state.editingId = null;
        elements.input.value = '';
        elements.modalTitle.textContent = "New Snippet";
        elements.btnDelete.style.display = 'none';
        elements.btnText.textContent = 'Save';
    }
    updateHighlight();
    renderSuggestions([]); // Reset suggesties
    elements.input.focus();
}

function closeModal() {
    elements.modalOverlay.classList.remove('active');
    state.editingId = null;
}

// --- Filter UI ---
function openFilter() {
    elements.filterOverlay.classList.add('active');
    elements.filterTagsSection.innerHTML = '<div class="filter-section-title">Labels</div>';

    const sortedTags = Array.from(state.availableTags).sort();
    if (sortedTags.length === 0) elements.filterTagsSection.innerHTML += '<div style="padding:10px;color:#999">No tags yet</div>';

    sortedTags.forEach(tag => {
        const el = document.createElement('label');
        el.className = `filter-option ${state.filter === 'tag:' + tag ? 'selected' : ''}`;
        el.innerHTML = `<input type="radio" name="filter" value="tag:${tag}"> <span>#${tag}</span>`;
        el.onclick = () => {
            el.querySelector('input').checked = true;
            document.querySelectorAll('.filter-option').forEach(o => o.classList.remove('selected'));
            el.classList.add('selected');
        };
        elements.filterTagsSection.appendChild(el);
    });
}

function applyFilter() {
    const checked = document.querySelector('input[name="filter"]:checked');
    if (checked) {
        state.filter = checked.value;
        elements.filterBtn.classList.toggle('active', state.filter !== 'all');
        renderGrid();
    }
    elements.filterOverlay.classList.remove('active');
}

function updateEmptyStateText() {
    if (state.search) elements.emptyState.textContent = `No results for "${state.search}"`;
    else if (state.filter.startsWith('tag:')) elements.emptyState.textContent = `No snippets with #${state.filter.substring(4)}`;
    else elements.emptyState.textContent = 'No snippets found.';
}

// --- Event Listeners ---
elements.searchInput.addEventListener('input', (e) => { state.search = e.target.value; renderGrid(); });
elements.input.addEventListener('input', handleEditorInput);
elements.input.addEventListener('scroll', syncScroll);

elements.fabAdd.addEventListener('click', () => openModal());
elements.btnCloseSnippet.addEventListener('click', closeModal);
elements.modalOverlay.addEventListener('click', (e) => { if (e.target === elements.modalOverlay) closeModal(); });

elements.btnSave.addEventListener('click', handleSave);
elements.btnDelete.addEventListener('click', handleDelete);

elements.filterBtn.addEventListener('click', openFilter);
elements.filterClose.addEventListener('click', () => elements.filterOverlay.classList.remove('active'));
elements.filterApply.addEventListener('click', applyFilter);
elements.filterOverlay.addEventListener('click', (e) => { if (e.target === elements.filterOverlay) elements.filterOverlay.classList.remove('active'); });

// Static Filter Options Click
document.querySelectorAll('.static-filter-option').forEach(opt => {
    opt.addEventListener('click', () => {
        const input = opt.querySelector('input');
        input.checked = true;
        document.querySelectorAll('.filter-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
    });
});

// Init
loadSnippets();

// Exporteer voor debug/testen
if (typeof module !== 'undefined') module.exports = { KnowledgeGraphService, SnippetRepository, Database };