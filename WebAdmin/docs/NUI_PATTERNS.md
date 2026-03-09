# NUI Patterns Quick Reference

> **Note:** This project follows the **Deterministic Mind** coding philosophy. See `DEV_PLAN.md` Section 2 for core principles including: design failures away, no defensive programming, code as primary truth, and abstraction from evidence.

---

## Essential Imports

```html
<!-- In index.html head -->
<link rel="stylesheet" href="lib/nui_wc2/NUI/css/nui-theme.css">
<link rel="stylesheet" href="css/styles.css">
<style>
  body { margin: 0; overflow: hidden; }
  nui-app:not(.nui-ready) { display: none; }
</style>
```

```javascript
// In main.js
import { nui } from './lib/nui_wc2/NUI/nui.js';
import './lib/nui_wc2/NUI/lib/modules/nui-list.js';  // Optional addon
```

---

## Layout Template (App Mode)

```html
<nui-app nui-vars-sidebar_width="16rem">
  <nui-top-nav>
    <header>
      <layout>
        <item>
          <nui-button data-action="toggle-sidebar">
            <button type="button" aria-label="Toggle menu">
              <nui-icon name="menu">☰</nui-icon>
            </button>
          </nui-button>
        </item>
        <item><h1>LLM Gateway Admin</h1></item>
        <item>
          <nui-button data-action="toggle-theme">
            <button type="button" aria-label="Toggle theme">
              <nui-icon name="brightness">⛭</nui-icon>
            </button>
          </nui-button>
        </item>
      </layout>
    </header>
  </nui-top-nav>

  <nui-side-nav>
    <nui-link-list mode="fold"></nui-link-list>
  </nui-side-nav>

  <nui-content>
    <nui-main><!-- Content loads here --></nui-main>
  </nui-content>
</nui-app>
```

---

## Navigation Data Structure

```javascript
const navigationData = [
  {
    label: 'Dashboard',
    icon: 'monitor',
    items: [
      { label: 'Monitor', href: '#feature=dashboard' },
      { label: 'Providers', href: '#page=providers' }
    ]
  },
  {
    label: 'Test Tools',
    icon: 'extension',
    items: [
      { label: 'Chat', href: '#page=test-chat' },
      { label: 'Embeddings', href: '#page=test-embeddings' },
      { label: 'Images', href: '#page=test-images' }
    ]
  },
  {
    label: 'System',
    icon: 'settings',
    items: [
      { label: 'Logs', href: '#page=logs' },
      { label: 'Settings', href: '#feature=settings' }
    ]
  }
];

// Load into sidebar
const sideNav = document.querySelector('nui-link-list');
sideNav.loadData(navigationData);
```

---

## Hybrid Routing Setup

```javascript
// In main.js

// 1. Register JS Features (Pattern 1)
nui.registerFeature('dashboard', (element, params) => {
  element.innerHTML = `
    <header><h2>Dashboard</h2></header>
    <div id="task-list">Loading...</div>
  `;
  
  let interval = null;
  
  element.show = () => {
    loadTasks();
    interval = setInterval(loadTasks, 2000);
  };
  
  element.hide = () => {
    if (interval) clearInterval(interval);
  };
  
  async function loadTasks() {
    const tasks = await api.get('/api/tasks');
    element.querySelector('#task-list').innerHTML = renderTasks(tasks);
  }
});

nui.registerFeature('settings', (element, params) => {
  element.innerHTML = `
    <header>
      <h2>Settings</h2>
      <nui-button data-action="save-settings">
        <button type="button">Save</button>
      </nui-button>
    </header>
    <textarea id="config-editor"></textarea>
  `;
  
  // Load config
  api.get('/api/config').then(config => {
    element.querySelector('#config-editor').value = JSON.stringify(config, null, 2);
  });
});

// 2. Enable Content Loading for HTML Fragments (Pattern 2)
nui.enableContentLoading({
  container: 'nui-main',
  navigation: 'nui-side-nav',
  basePath: 'pages',
  defaultPage: 'welcome'
});

// 3. Action Handling
document.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  
  const action = actionEl.dataset.action;
  
  switch(action) {
    case 'toggle-sidebar':
      document.querySelector('nui-app')?.toggleSideNav();
      break;
    case 'toggle-theme':
      const current = document.documentElement.style.colorScheme || 'light';
      document.documentElement.style.colorScheme = current === 'dark' ? 'light' : 'dark';
      break;
    case 'save-settings':
      saveSettings();
      break;
  }
});
```

---

## HTML Fragment with Init Script

```html
<!-- pages/test-chat.html -->
<div class="page-test-chat">
  <header>
    <h2>Test Chat Completion</h2>
  </header>
  
  <nui-tabs>
    <nav>
      <button data-tab="form">Request</button>
      <button data-tab="response">Response</button>
    </nav>
    <section data-panel="form">
      <form id="chat-form">
        <nui-select>
          <label>Provider</label>
          <select name="provider">
            <option value="lmstudio">LM Studio</option>
            <option value="gemini">Gemini</option>
          </select>
        </nui-select>
        
        <nui-input>
          <label>Message</label>
          <textarea name="message" rows="4"></textarea>
        </nui-input>
        
        <nui-button>
          <button type="submit">Send</button>
        </nui-button>
      </form>
    </section>
    <section data-panel="response">
      <nui-code>
        <pre><code id="response-display">// Response will appear here</code></pre>
      </nui-code>
    </section>
  </nui-tabs>
</div>

<script type="nui/page">
function init(element, params) {
  const form = element.querySelector('#chat-form');
  const responseDisplay = element.querySelector('#response-display');
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const data = new FormData(form);
    const body = {
      model: data.get('provider'),
      messages: [{ role: 'user', content: data.get('message') }]
    };
    
    try {
      const response = await fetch('/api/proxy/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      const result = await response.json();
      responseDisplay.textContent = JSON.stringify(result, null, 2);
      
      // Switch to response tab
      element.querySelector('nui-tabs').setActiveTab('response');
    } catch (err) {
      responseDisplay.textContent = 'Error: ' + err.message;
    }
  });
  
  // Optional: cleanup when page is hidden
  element.hide = () => {
    console.log('Chat page hidden');
  };
}
</script>
```

---

## Using Dialogs and Banners

```javascript
// Alert dialog
await nui.components.dialog.alert('Success', 'Settings saved successfully');

// Confirm dialog
const confirmed = await nui.components.dialog.confirm(
  'Delete Provider?',
  'This will remove the provider configuration.'
);
if (confirmed) {
  // Proceed with deletion
}

// Banner notification
nui.components.banner.show({
  content: 'Configuration saved',
  priority: 'info',
  placement: 'bottom',
  autoClose: 3000
});

// Error banner
nui.components.banner.show({
  content: 'Failed to save: Invalid JSON',
  priority: 'alert',
  placement: 'top'
});
```

---

## Common Components

### Button with Icon
```html
<nui-button>
  <button type="button">
    <nui-icon name="save"></nui-icon>
    Save Changes
  </button>
</nui-button>

<nui-button class="icon-only">
  <button type="button" aria-label="Refresh">
    <nui-icon name="sync"></nui-icon>
  </button>
</nui-button>
```

### Form Inputs
```html
<nui-input>
  <label for="name">Name</label>
  <input type="text" id="name" name="name">
</nui-input>

<nui-input>
  <label for="desc">Description</label>
  <textarea id="desc" name="desc" rows="3"></textarea>
</nui-input>
```

### Select Dropdown
```html
<nui-select>
  <label for="provider">Provider</label>
  <select id="provider" name="provider">
    <option value="lmstudio">LM Studio</option>
    <option value="gemini">Gemini</option>
  </select>
</nui-select>
```

### Table
```html
<nui-table>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Provider</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>task-1</td>
        <td>lmstudio</td>
        <td><span class="badge active">Running</span></td>
      </tr>
    </tbody>
  </table>
</nui-table>
```

### Accordion
```html
<nui-accordion>
  <details>
    <summary>Section 1</summary>
    <p>Content for section 1</p>
  </details>
  <details>
    <summary>Section 2</summary>
    <p>Content for section 2</p>
  </details>
</nui-accordion>
```

### Code Block
```html
<nui-code>
  <pre><code data-lang="json">{
  "port": 3400,
  "providers": {}
}</code></pre>
</nui-code>
```

---

## API Client Pattern

```javascript
// js/api-client.js
const API_BASE = '/api';

export const api = {
  async get(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  
  async post(endpoint, data) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  
  // Gateway proxy methods
  async chatCompletion(body) {
    return this.post('/proxy/chat/completions', body);
  },
  
  async getEmbeddings(body) {
    return this.post('/proxy/embeddings', body);
  }
};
```

---

## Utility Functions

```javascript
// Format duration (seconds to mm:ss)
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format timestamp
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

// Status badge helper
function statusBadge(status) {
  const classes = {
    running: 'badge active',
    pending: 'badge pending',
    completed: 'badge success',
    failed: 'badge error'
  };
  return `<span class="${classes[status] || 'badge'}">${status}</span>`;
}
```

---

## CSS Variables Reference

```css
/* Layout */
--nui-sidebar-width: 16rem;
--nui-topnav-height: 3.5rem;

/* Colors (auto-adapts to light/dark) */
--nui-bg: /* background */
--nui-fg: /* foreground text */
--nui-accent: /* accent color */
--nui-border: /* borders */

/* Spacing */
--nui-space: 1rem;
--nui-space-sm: 0.5rem;
--nui-space-lg: 1.5rem;

/* Misc */
--nui-radius: 6px;
```

---

## Event Naming Convention

| Event | When Fired | Detail |
|-------|------------|--------|
| `nui-click` | Button clicked | `{ source: element }` |
| `nui-tab-change` | Tab switched | `{ tab: 'tabId' }` |
| `nui-action` | Custom action | `{ name, param, target }` |
| `nui-active-change` | Nav item selected | `{ element, href }` |

---

*This is a living document - update as patterns evolve*
