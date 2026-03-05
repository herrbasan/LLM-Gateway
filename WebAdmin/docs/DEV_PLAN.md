# WebAdmin Development Plan

## 1. Overview

A monitoring and administration interface for the LLM Gateway, built with Node.js/Express backend and NUI Web Components frontend.

### Goals
- Monitor live tasks and gateway health
- Test all gateway features via interactive UI
- Edit configuration with validation
- View errors and warnings

---

## 2. Coding Philosophy

This project follows the **Deterministic Mind** philosophy - code that prioritizes reliability, performance, and clarity over inherited patterns designed for human constraints.

### Core Principles

| Principle | Application |
|-----------|-------------|
| **Design Failures Away** | Prevention over error handling. Every eliminated failure condition is a state that can never occur. Verify preconditions instead of wrapping in try/catch. |
| **No Defensive Programming** | For code we control, defensive patterns hide bugs. Fail fast and visibly. Silent fallbacks are for external boundaries only (network, user input). |
| **Disposal is Mandatory** | Every resource created must have a proven disposal path. Cleanup must be explicit, verifiable, and confirmed - not assumed. |
| **Block Until Truth** | UI reflects actual state, not intent. During transitions, inputs are blocked so race conditions are structurally impossible. |
| **Single Responsibility** | Describe functions without "and" or "or". If you need "and," the function has multiple responsibilities. |
| **Code is Primary Truth** | Comments and docs inform, but code executes. Self-explanatory code over comments. No JSDoc type theater. |
| **Measure Before Optimizing** | Write clear code first. Measure with realistic data. Optimize proven bottlenecks only. |
| **Abstraction From Evidence** | First use case: write directly. Second: copy and modify. Third: now abstract. Wrong abstraction is harder to remove than no abstraction. |

### Language & Stack Constraints

- **Vanilla JavaScript only** - ES modules, no TypeScript (adds debugging layer)
- **Zero frontend frameworks** - NUI Web Components provides structure without framework overhead
- **Minimal dependencies** - Use NUI library (submodule) and extend it when needed
- **Platform features over libraries** - Native DOM APIs, CustomEvents, Web Components

### Code Quality Rules

1. **Fail Fast** - External boundaries (gateway API, file system) fail loudly. Internal code assumes valid state.
2. **Explicit Dependencies** - Pass dependencies as parameters. No globals, no hidden registries.
3. **Immutability by Default** - Convert temporal reasoning to spatial. Mutation only when measured and justified.
4. **Functional Purity** - Isolate I/O and side effects at boundaries. Core logic should permit local reasoning.
5. **Composition Over Inheritance** - Build from discrete pieces that can be verified independently.

### Anti-Patterns to Avoid

- **God Objects** - Verification requires understanding the entire class
- **Manager Classes** - Vague names hiding multiple responsibilities  
- **Utility Dumps** - Unrelated functions sharing modules create false coupling
- **Stringly-Typed Code** - Use proper data structures, not magic strings
- **Documentation That Lies** - False confidence from stale comments

### References

- **NUI Playground**: https://herrbasan.github.io/nui_wc2/Playground/index.html#page=documentation/introduction
- **Deterministic Mind**: Full philosophy document in MCP Orchestrator (`read_document({name: "coding-philosophy"})`)

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (SPA)                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  NUI Web Components                                  │   │
│  │  - App Layout (sidebar + main content)              │   │
│  │  - Hybrid Routing (JS features + HTML fragments)    │   │
│  │  - Live Dashboard (polling)                         │   │
│  │  - JSON Editor for Settings                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│                     HTTP/WebSocket                         │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│  WebAdmin Server (3401)  │                                  │
│  ┌───────────────────────┼──────────────────────────────┐  │
│  │  Express App          │                              │  │
│  │  - Static files (SPA) │  - API routes (proxy)        │  │
│  └───────────────────────┼──────────────────────────────┘  │
│                          │                                  │
│                     HTTP (localhost)                        │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│  LLM Gateway (3400)      │                                  │
│  - /health               │  - /tasks                       │
│  - /models               │  - /chat/*                      │
│  - /embeddings           │  - /sessions/*                  │
└──────────────────────────┴──────────────────────────────────┘
```

---

## 4. Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| **Backend** | Node.js + Express | Uses parent's node_modules |
| **Frontend** | NUI Web Components (submodule) | Zero framework overhead. See [NUI Playground](https://herrbasan.github.io/nui_wc2/Playground/index.html#page=documentation/introduction) for docs |
| **Routing** | NUI Hash Router | `#feature=x` or `#page=y` |
| **Styling** | NUI Theme CSS | Light/dark mode built-in |
| **Icons** | Material Icons | Via NUI sprite |
| **Config** | dotenv | Port from .env file |

> **Note**: The [NUI Playground](https://herrbasan.github.io/nui_wc2/Playground/index.html#page=documentation/introduction) is a Single Page Application that requires JavaScript rendering. Use `browser_fetch` (headless browser) if accessing programmatically, as the content is dynamically loaded via the NUI router.

---

## 5. File Structure

```
WebAdmin/
├── docs/
│   └── DEV_PLAN.md              # This document
├── server.js                    # Express entry point
├── package.json                 # Scripts and metadata
├── .env                         # Port configuration (PORT=3401)
├── lib/
│   └── nui_wc2/                 # Git submodule (UI library)
│       └── NUI/
│           ├── nui.js
│           ├── css/nui-theme.css
│           └── lib/modules/
├── public/
│   ├── index.html               # App shell (nui-app layout)
│   ├── css/
│   │   ├── styles.css           # App-specific styles
│   │   └── pages/               # Page-scoped styles
│   ├── js/
│   │   ├── main.js              # App init, nav, routing
│   │   ├── api-client.js        # Gateway API wrapper
│   │   └── sections/
│   │       ├── Dashboard.js     # Live monitoring feature
│   │       ├── TestTools.js     # API testing interface
│   │       └── SettingsEditor.js # JSON config editor
│   └── pages/
│       ├── welcome.html         # Overview/welcome
│       ├── providers.html       # Provider status
│       ├── test-chat.html       # Chat completion tests
│       ├── test-embeddings.html # Embedding tests
│       ├── test-sessions.html   # Session tests
│       └── logs.html            # Error/warning logs
└── routes/
    └── api.js                   # WebAdmin backend API
```

---

## 6. Configuration

### Environment Variables (.env)
```env
# WebAdmin Server
PORT=3401
HOST=0.0.0.0

# Gateway Connection
GATEWAY_URL=http://localhost:3400

# Optional: Authentication
# ADMIN_TOKEN=secret_token_for_simple_auth
```

### Gateway Config Access
- WebAdmin can read/write `../config.json` (relative to WebAdmin folder)
- Writes include JSON validation and backup creation

---

## 7. API Endpoints

### WebAdmin Backend (`/api/*`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Gateway health status |
| GET | `/api/tasks` | Active and queued tasks |
| GET | `/api/models` | Available models |
| GET | `/api/config` | Current gateway config |
| POST | `/api/config` | Update gateway config |
| GET | `/api/logs` | Recent errors/warnings |
| POST | `/api/proxy/*` | Proxy to gateway |

### Gateway Proxy
All gateway endpoints accessible via proxy for CORS handling.

---

## 8. Frontend Routes

### Navigation Structure

```
Dashboard              → #feature=dashboard
  ├─ Monitor           → #feature=dashboard (same)
  └─ Providers         → #page=providers

Test Tools             → #page=test-chat (default)
  ├─ Chat              → #page=test-chat
  ├─ Embeddings        → #page=test-embeddings
  └─ Sessions          → #page=test-sessions

Logs                   → #page=logs

Settings               → #feature=settings
```

### Route Types

| Pattern | URL Format | Best For | Notes |
|---------|------------|----------|-------|
| **JS Feature** | `#feature=x` | Live views, dashboards, polling data | Logic stays in `main.js`; element has `show()`/`hide()` lifecycle hooks |
| **HTML Fragment** | `#page=x` | Static content, forms, documentation | Fetches HTML file; use `<script type="nui/page">` for scoped init |

### Choosing the Right Pattern

**Use JS Features (`#feature=x`) when:**
- The view has **live/polling data** (Dashboard, real-time stats)
- You need **persistent state** across navigation
- You need **proper cleanup** (stop polling, cancel requests on `hide()`)
- The logic is complex and benefits from centralized code

```javascript
// main.js
nui.registerFeature('dashboard', (element, params) => {
    let pollInterval;
    
    element.innerHTML = `...`;
    
    element.show = () => {
        pollInterval = setInterval(fetchData, 2000);
    };
    
    element.hide = () => {
        clearInterval(pollInterval);  // Cleanup guaranteed
    };
});
```

**Use HTML Fragments (`#page=x`) when:**
- The content is **static** (help pages, docs, terms)
- It's a **simple form** that doesn't need shared state
- You want to write content in HTML, not JS
- The content is large and rarely accessed (lazy load)

```html
<!-- pages/help.html -->
<section>
    <h2>Help</h2>
    <p>Static content...</p>
</section>
<script type="nui/page">
function init(element, params) {
    // Optional: scoped init for this fragment only
}
</script>
```

> **Rule of Thumb**: Default to JS Features for application views. Use HTML Fragments only for truly static content or when HTML authoring is preferred.

---

## 9. Components Specification

### 8.1 Dashboard (JS Feature)

**Purpose**: Compact live display of currently running tasks

**Layout**:
```
┌─────────────────────────────────────────┐
│  Dashboard                    [Refresh] │
├─────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────────┐  │
│  │ Active      │  │ Queue Stats     │  │
│  │ Tasks: 3    │  │ Pending: 5      │  │
│  │             │  │ Completed: 42   │  │
│  │ Providers:  │  │ Failed: 1       │  │
│  │ ● 4 online  │  │                 │  │
│  └─────────────┘  └─────────────────┘  │
├─────────────────────────────────────────┤
│  Active Tasks                           │
│  ┌─────────────────────────────────────┐│
│  │ ID      Provider  Model       Time  ││
│  │ abc-12  lmstudio  qwen-30b    2:34  ││
│  │ def-34  gemini    flash       0:12  ││
│  │ ghi-56  ollama    gemma3      5:01  ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

**Data Displayed**:
- Active task count
- Queue depth (pending/completed/failed)
- Online provider count with status indicators
- Task table: ID, provider, model, elapsed time
- Auto-refresh: 2 seconds when visible

**API Polling**:
- `/api/tasks` every 2 seconds
- Pause polling when tab hidden (via `element.hide()` lifecycle)

### 8.2 Settings Editor (JS Feature)

**Purpose**: Simple JSON editor for gateway configuration

**Features**:
- Monaco-like simple editor (or textarea with validation)
- Syntax highlighting via NUI's nui-code
- Validate JSON structure on save
- Show save/cancel buttons
- Backup creation on save
- Error display for invalid JSON

**Layout**:
```
┌─────────────────────────────────────────┐
│  Settings                    [Save] [↩] │
├─────────────────────────────────────────┤
│  ┌─────────────────────────────────────┐│
│  │ {                                   ││
│  │   "port": 3400,                    ││
│  │   "providers": {                   ││
│  │     "lmstudio": {                  ││
│  │       "endpoint": "http://..."     ││
│  │     }                              ││
│  │   }                                ││
│  │ }                                   ││
│  └─────────────────────────────────────┘│
│  [✓] Valid JSON                         │
└─────────────────────────────────────────┘
```

### 8.3 Test Tools (HTML Fragments)

**Chat Test Page** (`pages/test-chat.html`):
- Form with: provider select, model select, message textarea
- Stream toggle checkbox
- Response display area (formatted)
- Request/response JSON viewers

**Embeddings Test Page** (`pages/test-embeddings.html`):
- Text input area
- Provider/model selection
- Show embedding vector (truncated) + dimensions

**Sessions Test Page** (`pages/test-sessions.html`):
- List active sessions
- Create new session
- View session messages
- Delete session

---

## 10. Implementation Phases

### Phase 1: Foundation
- [ ] Create folder structure
- [ ] Setup Express server with static files
- [ ] Create .env configuration
- [ ] Basic HTML shell with NUI layout
- [ ] Navigation sidebar with links

### Phase 2: Backend API
- [ ] Implement `/api/health` proxy
- [ ] Implement `/api/tasks` proxy
- [ ] Implement `/api/models` proxy
- [ ] Implement `/api/config` read/write
- [ ] Config validation middleware

### Phase 3: Dashboard
- [ ] Create Dashboard JS feature
- [ ] Task polling mechanism
- [ ] Compact task table display
- [ ] Provider status indicators
- [ ] Stats cards (active, queue, providers)

### Phase 4: Test Tools
- [ ] Chat test form page
- [ ] Embeddings test form page
- [ ] Sessions test page
- [ ] API client for gateway calls

### Phase 5: Settings & Logs
- [ ] JSON editor for config
- [ ] Save with validation
- [ ] Logs viewer page
- [ ] Error/warning display

### Phase 6: Polish
- [ ] Error handling
- [ ] Loading states
- [ ] Responsive fixes
- [ ] Documentation

---

## 11. NUI Patterns to Follow

### Event Handling
```javascript
// Declarative actions in HTML
// <nui-button data-action="refresh-tasks">

// Handle in main.js
document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    
    switch(action) {
        case 'refresh-tasks':
            dashboard.refresh();
            break;
        // ...
    }
});
```

### JS Feature Registration
```javascript
// In main.js
nui.registerFeature('dashboard', (element, params) => {
    // Build UI
    element.innerHTML = `...`;
    
    // Lifecycle hooks
    element.show = () => { /* start polling */ };
    element.hide = () => { /* stop polling */ };
});
```

### HTML Fragment with Init
```html
<!-- pages/test-chat.html -->
<section>
    <h2>Test Chat Completion</h2>
    <form id="chat-form">...</form>
    <div id="response"></div>
</section>

<script type="nui/page">
function init(element, params) {
    const form = element.querySelector('#chat-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        // Handle form submission
    });
}
</script>
```

---

## 12. Styling Guidelines

### CSS Variables (NUI)
Use NUI's built-in variables:
```css
.my-component {
    background: var(--nui-bg);
    color: var(--nui-fg);
    padding: var(--nui-space);
    border-radius: var(--nui-radius);
}
```

### Custom Styles Location
- Global styles: `public/css/styles.css`
- Page-specific: `public/css/pages/test-chat.css`
- Component-scoped: Inline in JS features

---

## 13. Security Considerations

1. **CORS**: WebAdmin backend proxies to gateway to avoid CORS issues
2. **Config Access**: Validate JSON before saving
3. **File Access**: Restrict to `../config.json` only
4. **Optional**: Simple token-based auth via `ADMIN_TOKEN` env var

---

## 14. Development Commands

```bash
# From WebAdmin directory
cd WebAdmin

# Install (uses parent node_modules, but register own scripts)
npm init -y

# Run development server
npm run dev

# Or with node directly
node server.js
```

### package.json scripts
```json
{
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  }
}
```

---

## 15. Testing Checklist

- [ ] Server starts on configured port
- [ ] NUI components render correctly
- [ ] Navigation works (sidebar, routing)
- [ ] Dashboard shows live tasks
- [ ] Polling pauses when tab hidden
- [ ] Config loads and saves correctly
- [ ] Invalid JSON shows error
- [ ] Chat test form works
- [ ] Embeddings test form works
- [ ] Sessions test form works
- [ ] Responsive on mobile/tablet

---

*Document Version: 1.0*
*Last Updated: 2026-03-03*
