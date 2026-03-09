// ============================================
// LLM Gateway Chat - Main Controller
// ============================================

// Gateway URL (WebAdmin runs on :3401, Gateway on :3400)
const GATEWAY_URL = window.location.origin.replace(':3401', ':3400');

// State
let models = [];
let currentModel = '';
let isStreaming = false;

// DOM Elements
const elements = {
    modelSelect: document.getElementById('model-select'),
    temperature: document.getElementById('temperature'),
    tempValue: document.getElementById('temp-value'),
    maxTokens: document.getElementById('max-tokens'),
    systemPrompt: document.getElementById('system-prompt'),
    messages: document.getElementById('messages'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    attachBtn: document.getElementById('attach-btn'),
    fileInput: document.getElementById('file-input'),
    attachmentPreview: document.getElementById('attachment-preview'),
    newChatBtn: document.getElementById('new-chat-btn'),
    themeToggle: document.getElementById('theme-toggle'),
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebar-toggle'),
    sidebarToggleMobile: document.getElementById('sidebar-toggle-mobile'),
    gatewayStatus: document.querySelector('.status-dot'),
    lightbox: document.getElementById('lightbox'),
    lightboxImage: document.getElementById('lightbox-image'),
    lightboxClose: document.getElementById('lightbox-close')
};

// ============================================
// Initialization
// ============================================

async function init() {
    console.log('[Chat] Initializing...');
    
    // Load models
    await loadModels();
    
    // Setup event listeners
    setupEventListeners();
    
    // Check gateway status
    checkGatewayStatus();
    
    console.log('[Chat] Ready');
}

// ============================================
// Model Loading
// ============================================

async function loadModels() {
    try {
        const response = await fetch(`${GATEWAY_URL}/v1/models`);
        const data = await response.json();
        
        models = data.data || [];
        populateModelSelect();
        
        console.log('[Chat] Loaded models:', models.length);
    } catch (error) {
        console.error('[Chat] Failed to load models:', error);
        elements.modelSelect.innerHTML = '<option value="">Failed to load models</option>';
    }
}

function populateModelSelect() {
    const chatModels = models.filter(m => m.type === 'chat' || !m.type);
    
    if (chatModels.length === 0) {
        elements.modelSelect.innerHTML = '<option value="">No chat models available</option>';
        return;
    }
    
    // Group by adapter/provider
    const byAdapter = new Map();
    for (const model of chatModels) {
        const adapter = model.owned_by || 'unknown';
        if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
        byAdapter.get(adapter).push(model);
    }
    
    let html = '<option value="">Select model...</option>';
    
    for (const [adapter, adapterModels] of byAdapter) {
        html += `<optgroup label="${adapter}">`;
        for (const model of adapterModels) {
            html += `<option value="${model.id}">${model.id}</option>`;
        }
        html += '</optgroup>';
    }
    
    elements.modelSelect.innerHTML = html;
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // Model selection
    elements.modelSelect?.addEventListener('change', (e) => {
        currentModel = e.target.value;
        console.log('[Chat] Selected model:', currentModel);
    });
    
    // Temperature slider
    elements.temperature?.addEventListener('input', (e) => {
        elements.tempValue.textContent = e.target.value;
    });
    
    // Send message
    elements.sendBtn?.addEventListener('click', sendMessage);
    elements.messageInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    
    // Auto-resize textarea
    elements.messageInput?.addEventListener('input', autoResizeTextarea);
    
    // File attachment
    elements.attachBtn?.addEventListener('click', () => {
        elements.fileInput?.click();
    });
    elements.fileInput?.addEventListener('change', handleFileSelect);
    
    // New chat
    elements.newChatBtn?.addEventListener('click', () => {
        elements.messages.innerHTML = `
            <div class="welcome-message">
                <h2>New Conversation</h2>
                <p>Select a model and start chatting</p>
            </div>
        `;
    });
    
    // Theme toggle
    elements.themeToggle?.addEventListener('click', toggleTheme);
    
    // Sidebar toggle (mobile)
    elements.sidebarToggle?.addEventListener('click', () => {
        elements.sidebar?.classList.remove('open');
    });
    elements.sidebarToggleMobile?.addEventListener('click', () => {
        elements.sidebar?.classList.add('open');
    });
    
    // Lightbox
    elements.lightboxClose?.addEventListener('click', closeLightbox);
    elements.lightbox?.addEventListener('click', (e) => {
        if (e.target === elements.lightbox || e.target.classList.contains('lightbox-backdrop')) {
            closeLightbox();
        }
    });
}

function autoResizeTextarea() {
    const textarea = elements.messageInput?.querySelector('textarea');
    if (!textarea) return;
    
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

// ============================================
// Message Sending (Placeholder)
// ============================================

async function sendMessage() {
    const textarea = elements.messageInput?.querySelector('textarea');
    const content = textarea?.value.trim();
    
    if (!content || isStreaming) return;
    if (!currentModel) {
        alert('Please select a model first');
        return;
    }
    
    // Clear welcome message if present
    const welcome = elements.messages?.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    
    // Add user message
    addMessage('user', content);
    
    // Clear input
    textarea.value = '';
    textarea.style.height = 'auto';
    
    // TODO: Implement actual streaming chat
    // For now, show a placeholder response
    addMessage('assistant', 'Chat functionality coming soon... This is a placeholder. The full implementation will include streaming responses, markdown rendering, and conversation history.');
}

function addMessage(role, content) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;
    
    const header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = role === 'user' ? 'You' : 'Assistant';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.textContent = content;
    
    messageDiv.appendChild(header);
    messageDiv.appendChild(contentDiv);
    elements.messages?.appendChild(messageDiv);
    
    // Scroll to bottom
    scrollToBottom();
}

function scrollToBottom() {
    if (elements.messages) {
        elements.messages.scrollTop = elements.messages.scrollHeight;
    }
}

// ============================================
// File Attachments
// ============================================

function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            addAttachmentPreview(event.target.result, file.name);
        };
        reader.readAsDataURL(file);
    }
}

function addAttachmentPreview(dataUrl, name) {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    item.innerHTML = `
        <img src="${dataUrl}" alt="${name}">
        <button class="remove" title="Remove">&times;</button>
    `;
    
    item.querySelector('.remove').addEventListener('click', () => {
        item.remove();
    });
    
    elements.attachmentPreview?.appendChild(item);
}

// ============================================
// Gateway Status
// ============================================

async function checkGatewayStatus() {
    try {
        const response = await fetch(`${GATEWAY_URL}/health`);
        const data = await response.json();
        
        if (data.status === 'ok') {
            elements.gatewayStatus?.classList.remove('offline');
        } else {
            elements.gatewayStatus?.classList.add('offline');
        }
    } catch (error) {
        console.error('[Chat] Gateway check failed:', error);
        elements.gatewayStatus?.classList.add('offline');
    }
}

// ============================================
// Theme Toggle
// ============================================

function toggleTheme() {
    const current = document.documentElement.style.colorScheme || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.style.colorScheme = next;
    localStorage.setItem('chat-theme', next);
}

// Restore theme
const savedTheme = localStorage.getItem('chat-theme');
if (savedTheme) {
    document.documentElement.style.colorScheme = savedTheme;
}

// ============================================
// Lightbox
// ============================================

function openLightbox(src) {
    elements.lightboxImage.src = src;
    elements.lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    elements.lightbox.setAttribute('aria-hidden', 'true');
    elements.lightboxImage.src = '';
    document.body.style.overflow = '';
}

// Make openLightbox available globally for message content
window.openLightbox = openLightbox;

// ============================================
// Start
// ============================================

init();
