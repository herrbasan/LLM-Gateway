// Skip NUI auto-init to configure first
window.nuiInitialized = true;

import '/NUI/nui.js';
import { Dashboard } from './sections/Dashboard.js';
import { SettingsEditor } from './sections/SettingsEditor.js';
import { modelsService } from './services/models.js';

// Configure NUI to suppress a11y warnings, then init
nui.configure({
    a11y: {
        warnings: 'silent',  // Suppress icon-only button warnings
        autoLabel: true      // Still auto-generate labels silently
    }
});
nui.init();

// ============================================
// Navigation Configuration
// ============================================

const navigationData = [
    {
        label: 'Dashboard',
        icon: 'monitor',
        href: '#feature=dashboard'
    },
    {
        label: 'Models',
        icon: 'grid_on',
        items: [
            { label: 'Chat', href: '#page=models-chat' },
            { label: 'Image', href: '#page=models-image' },
            { label: 'Video', href: '#page=models-video' },
            { label: 'Audio', href: '#page=models-audio' }
        ]
    },
    {
        label: 'Test Tools',
        icon: 'extension',
        items: [
            { label: 'Chat', href: '#page=test-chat' },
            { label: 'Vision', href: '#page=test-vision' },
            { label: 'Embeddings', href: '#page=test-embeddings' },
            { label: 'Compaction', href: '#page=test-compaction' },
            { label: 'Image Generation', href: '#page=test-images' },
            { label: 'Audio Speech', href: '#page=test-audio' },
            { label: 'Video Generation', href: '#page=test-video' }
        ]
    },
    {
        label: 'Logs',
        icon: 'article',
        href: '#page=logs'
    },
    {
        label: 'Settings',
        icon: 'settings',
        href: '#feature=settings'
    }
];

// ============================================
// Feature Registration
// ============================================

function registerFeatures() {
    // Dashboard - Live monitoring with polling
    nui.registerFeature('dashboard', (element, params) => {
        const dashboard = new Dashboard(element);
        
        element.show = () => dashboard.start();
        element.hide = () => dashboard.stop();
        
        // Initial render
        dashboard.render();
    });
    
    // Settings - JSON config editor
    nui.registerFeature('settings', (element, params) => {
        const editor = new SettingsEditor(element);
        
        element.show = () => editor.load();
        element.hide = () => editor.saveIfDirty();
        
        editor.render();
    });
}

// ============================================
// Event Handlers
// ============================================

function setupEventHandlers() {
    // Direct toggle for sidebar button
    document.querySelector('[data-action="toggle-sidebar"]')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelector('nui-app')?.toggleSideNav();
    });
    
    // Declarative actions
    document.addEventListener('nui-action', (e) => {
        const { name, param, originalEvent } = e.detail;
        
        switch (name) {
            case 'toggle-theme':
                toggleTheme();
                break;
        }
    });
    
    // Route change handler
    document.addEventListener('nui-route-change', (e) => {
        const { type, id } = e.detail;
        console.log(`[Router] Navigated to ${type}=${id}`);
    });
}

function toggleTheme() {
    const html = document.documentElement;
    const current = html.style.colorScheme || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    
    html.style.colorScheme = next;
    localStorage.setItem('nui-theme', next);
}

// ============================================
// Initialization
// ============================================

function init() {
    // Load navigation
    const nav = document.getElementById('main-nav');
    if (nav) {
        nav.loadData(navigationData);
    }
    
    // Register features
    registerFeatures();
    
    // Setup event handlers
    setupEventHandlers();
    
    // Fetch models at startup
    modelsService.fetchAllModels();
    
    // Expose service globally for page scripts
    window.modelsService = modelsService;
    
    // Initialize router with hybrid approach
    // - Features handled by JS (dashboard, settings)
    // - Pages loaded as HTML fragments (test-chat, logs, etc.)
    const router = nui.enableContentLoading({
        container: 'nui-main',
        navigation: 'nui-side-nav',
        basePath: '/pages',
        defaultPage: null  // Use feature=dashboard as default instead
    });
    
    // Set default route to dashboard
    if (!location.hash) {
        location.hash = 'feature=dashboard';
    }
    
    console.log('[WebAdmin] Initialized');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
