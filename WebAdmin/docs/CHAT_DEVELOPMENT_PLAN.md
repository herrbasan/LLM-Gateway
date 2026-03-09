# Chat Development Plan

> Development plan for a fully-featured standalone chat interface for the LLM Gateway.

---

## 1. Overview

### 1.1 Goals
- Create a standalone chat page at `/chat`, independent of WebAdmin SPA
- Use LMChat's rendering engine (markdown-it, DOMPurify, Prism) for message display
- Use nui_wc2 component library for UI consistency
- Talk directly to LLM Gateway API (stateless, model-centric v2.0)
- Support streaming responses, image uploads (vision), and conversation history

### 1.2 Constraints
- **Standalone Page**: Served at `ip:port/chat`, not within WebAdmin SPA
- **LMChat as Reference**: Added as git submodule to `Reference/` folder (gitignored, not tracked)
- **nui_wc2 Integration**: Uses NUI components and CSS variables
- **Statelessness**: Client maintains full conversation history (no server-side sessions)
- **Direct Gateway Communication**: Chat talks to Gateway directly (not through WebAdmin proxy)

### 1.3 Reference: LMChat Project
**GitHub:** https://github.com/herrbasan/LMChat

**Setup:** LMChat will be added as a git submodule in the `Reference/` folder for local development reference. The folder is gitignored so reference files aren't tracked in the main repo.

```bash
# Add LMChat as submodule
git submodule add https://github.com/herrbasan/LMChat.git Reference/LMChat

# Add to .gitignore (so reference files aren't tracked)
echo "Reference/" >> .gitignore

# Un-index if previously tracked
git rm -r --cached Reference/ 2>/dev/null || true
```

**File:** `.gitignore`
```
# Reference projects (submodules for local dev only)
Reference/
```

The LMChat project serves as the primary reference for rendering and chat functionality. Key files to reference:

| File | Purpose | Port to Chat? |
|------|---------|---------------|
| `public/js/utils/markdown.js` | Markdown rendering with Prism highlighting, copy buttons | Yes - adapt |
| `public/css/style.css` | Message styling, layout patterns | Yes - adapt to NUI |
| `public/js/app.js` | Streaming logic, conversation state management | Partial - patterns only |
| `public/js/components/attachments.js` | File upload handling | Yes - adapt |
| `public/js/utils/lightbox.js` | Image viewer | Yes - copy |
| `public/js/utils/scroll.js` | Auto-scroll behavior | Yes - adapt |
| `public/index.html` | Page structure | Reference - adapt to sidebar layout |

**Note:** LMChat is used as a reference only. Code will be adapted to use nui_wc2 components and integrated with LLM Gateway API.

**Additional References:**
| Source | Purpose |
|--------|---------|
| WebAdmin `test-chat.html` | Gateway API integration patterns |
| NUI Patterns doc | Component usage, styling |

### 1.4 Gateway Thinking Block Standardization
The LLM Gateway will consolidate thinking portions from various models into a unified format:

**Gateway Unified Format:**
```xml
<think>
Reasoning content here...
Can span multiple lines
</think>

Actual response content follows...
```

**Model-Specific Formats Normalized by Gateway:**
| Model | Native Format | Gateway Output |
|-------|---------------|----------------|
| DeepSeek | `<think>...</think>` | `<think>...</think>` (passthrough) |
| Claude | `thinking` block in API | `<think>...</think>` |
| Gemini | `thinking` role in stream | `<think>...</think>` |
| Others | Various patterns | Normalized to `<think>...</think>` |

**Benefits:**
- Chat UI only parses one reliable pattern
- No model-specific logic in client
- Easy to disable/enable via Gateway config
- Consistent UX across all models

---

## 2. Architecture

### 2.1 File Structure
```
WebAdmin/
├── public/
│   ├── chat/                      # Standalone chat directory
│   │   ├── index.html             # Main chat page (served at /chat)
│   │   ├── css/
│   │   │   └── chat.css           # Chat-specific styles
│   │   └── js/
│   │       ├── chat.js            # Main chat application
│   │       ├── markdown.js        # Adapted from LMChat
│   │       ├── conversation.js    # State management
│   │       ├── streaming.js       # SSE handler
│   │       ├── attachments.js     # Image uploads
│   │       └── components/        # UI components
│   │           ├── message-list.js
│   │           ├── input-area.js
│   │           └── model-selector.js
│   └── shared/                    # Shared assets
│       └── vendor/                # Copied from LMChat
│           ├── markdown-it.js
│           ├── purify.js
│           ├── markdown-it-prism.js
│           └── prism.js + prism.css
├── routes/
│   └── chat.js                    # Route handler for /chat
└── docs/
    └── CHAT_DEVELOPMENT_PLAN.md   # This document
```

### 2.2 Component Architecture
```
Chat Page (/chat/index.html) - Sidebar for Controls
├── Container (full viewport, flex row)
│   ├── Sidebar (collapsible, left side)
│   │   ├── Header (Chat title)
│   │   ├── Model Selector (nui-select)
│   │   ├── Options Panel
│   │   │   ├── Temperature (nui-slider)
│   │   │   ├── Max Tokens (nui-input)
│   │   │   └── System Prompt (nui-textarea)
│   │   ├── Actions
│   │   │   ├── New Chat Button
│   │   │   └── Theme Toggle
│   │   └── Footer (Gateway status)
│   └── Main Area (flex: 1, flex column)
│       ├── Messages Container (scrollable, flex: 1)
│       │   ├── User Messages
│       │   ├── Assistant Messages (markdown)
│       │   ├── Thinking Indicators
│       │   └── Loading States
│       └── Input Area (fixed at bottom)
│           ├── Attachment Preview
│           ├── Text Input (nui-textarea)
│           └── Send Controls
└── Lightbox Modal (for images)
```

**Layout:**
- Left sidebar: Model & options (collapsible on mobile)
- Right main area: Messages + input
- Clean, focused chat interface

### 2.3 Data Flow
```
User Input → Conversation State → Gateway API → Streaming Response → Markdown Render → DOM Update
     ↑                                                                            ↓
     └────────────────────────── Conversation History (localStorage) ←────────────┘

Note: Chat is standalone - no WebAdmin SPA state sharing
```

---

## 3. Implementation Phases

### Phase 1: Foundation (Core Infrastructure)

#### 3.1.1 Server Route Setup
**File:** `routes/chat.js`
```javascript
const express = require('express');
const router = express.Router();
const path = require('path');

// Serve chat page at /chat and /chat/
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/chat/index.html'));
});

module.exports = router;
```

**File:** `server.js` - Add route
```javascript
// Before SPA fallback, add chat route
app.use('/chat', require('./routes/chat'));

// Static files for chat assets
app.use('/chat', express.static(path.join(__dirname, 'public/chat')));
```

#### 3.1.2 Vendor Library Setup
**Files to Create:**
- `public/shared/vendor/markdown-it.js` - Copy from LMChat
- `public/shared/vendor/purify.js` - Copy from LMChat  
- `public/shared/vendor/markdown-it-prism.js` - Copy from LMChat
- `public/shared/vendor/prism.js` - Copy from LMChat
- `public/shared/vendor/prism.css` - Copy from LMChat

#### 3.1.3 Base Styles
**File:** `public/chat/css/chat.css`

**Key Styles to Port from LMChat:**
- Full-page layout (not fragment)
- Message container layout with scrollable area
- User vs Assistant message styling (adapt to NUI shade variables)
- Code block styling with copy buttons
- Attachment preview styling
- Thinking block styling
- Responsive behavior
- Input area fixed at bottom

**NUI Variable Mapping:**
```css
/* Map LMChat variables to NUI equivalents */
--chat-user-bg: var(--nui-accent-soft, rgba(24, 106, 195, 0.15));
--chat-assistant-bg: var(--nui-bg-elevated, var(--nui-shade5));
--chat-border: var(--nui-border-color, var(--nui-shade3));
```

#### 3.1.4 Standalone Page Shell (Sidebar Layout)
**File:** `public/chat/index.html`

**Structure:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light dark">
    <title>LLM Gateway Chat</title>
    
    <!-- NUI Theme -->
    <link rel="stylesheet" href="/NUI/css/nui-theme.css">
    <link rel="stylesheet" href="/NUI/css/modules/nui-syntax-highlight.css">
    
    <!-- Vendor -->
    <link rel="stylesheet" href="/shared/vendor/prism.css">
    
    <!-- Chat Styles -->
    <link rel="stylesheet" href="/chat/css/chat.css">
    
    <style>
        /* Full viewport */
        body { margin: 0; padding: 0; overflow: hidden; height: 100vh; }
    </style>
</head>
<body>
    <div class="chat-layout">
        <!-- Sidebar (Model & Options) -->
        <aside class="chat-sidebar" id="sidebar">
            <div class="sidebar-header">
                <span class="chat-title">Chat</span>
                <nui-button id="sidebar-toggle" class="icon-only mobile-only">
                    <button type="button"><nui-icon name="close"></nui-icon></button>
                </nui-button>
            </div>
            
            <div class="sidebar-content">
                <!-- Model Selection -->
                <section class="sidebar-section">
                    <label>Model</label>
                    <nui-select id="model-select">
                        <select>
                            <option value="">Loading models...</option>
                        </select>
                    </nui-select>
                </section>
                
                <!-- Options -->
                <section class="sidebar-section">
                    <label>Temperature</label>
                    <nui-slider id="temperature" min="0" max="2" step="0.1" value="0.7">
                        <input type="range">
                    </nui-slider>
                    <span class="value-display">0.7</span>
                </section>
                
                <section class="sidebar-section">
                    <label>Max Tokens</label>
                    <nui-input id="max-tokens">
                        <input type="number" min="1" max="8192" value="2048">
                    </nui-input>
                </section>
                
                <section class="sidebar-section">
                    <label>System Prompt</label>
                    <nui-textarea id="system-prompt">
                        <textarea rows="3" placeholder="Optional system instructions..."></textarea>
                    </nui-textarea>
                </section>
            </div>
            
            <div class="sidebar-footer">
                <nui-button id="new-chat-btn" type="secondary">
                    <button type="button"><nui-icon name="add"></nui-icon> New Chat</button>
                </nui-button>
                <nui-button id="theme-toggle" class="icon-only">
                    <button type="button"><nui-icon name="brightness"></nui-icon></button>
                </nui-button>
                <div class="gateway-status" id="gateway-status">
                    <span class="status-dot"></span> Gateway
                </div>
            </div>
        </aside>
        
        <!-- Main Chat Area -->
        <main class="chat-main">
            <!-- Mobile Sidebar Toggle -->
            <button class="sidebar-toggle-mobile" id="sidebar-toggle-mobile">
                <nui-icon name="menu"></nui-icon>
            </button>
            
            <!-- Messages Area -->
            <div class="chat-messages" id="messages"></div>
            
            <!-- Input Area -->
            <footer class="chat-input-area">
                <div class="attachment-preview" id="attachment-preview"></div>
                <div class="input-row">
                    <nui-textarea id="message-input" class="chat-input">
                        <textarea rows="1" placeholder="Type a message... (Shift+Enter for new line)"></textarea>
                    </nui-textarea>
                    <nui-button id="attach-btn" class="icon-only" title="Attach Image">
                        <button type="button"><nui-icon name="image"></nui-icon></button>
                    </nui-button>
                    <nui-button id="send-btn" type="primary" title="Send">
                        <button type="button"><nui-icon name="send"></nui-icon></button>
                    </nui-button>
                </div>
                <input type="file" id="file-input" accept="image/*" multiple hidden>
            </footer>
        </main>
    </div>
    
    <!-- Lightbox -->
    <div id="lightbox" class="lightbox" aria-hidden="true">
        <div class="lightbox-backdrop"></div>
        <div class="lightbox-content">
            <img id="lightbox-image" src="" alt="">
            <button id="lightbox-close" class="lightbox-close">&times;</button>
        </div>
    </div>
    
    <!-- Scripts -->
    <script src="/shared/vendor/prism.js"></script>
    <script src="/shared/vendor/markdown-it.js"></script>
    <script src="/shared/vendor/purify.js"></script>
    <script src="/shared/vendor/markdown-it-prism.js"></script>
    <script src="/NUI/nui.js" type="module"></script>
    <script src="/chat/js/chat.js" type="module"></script>
</body>
</html>
```

---

### Phase 2: Core Functionality

#### 3.2.1 Conversation State Management
**File:** `public/js/chat/conversation.js`

**Interface:**
```javascript
export class Conversation {
  constructor(storageKey = 'chat-conversation') {
    this.exchanges = []; // {id, user: {role, content}, assistant: {role, content, versions: [], currentVersion}}
    this.storageKey = storageKey;
    this.load();
  }
  
  addExchange(userContent) { /* returns exchangeId */ }
  addAssistantResponse(exchangeId, content) {}
  updateAssistantResponse(exchangeId, delta) {}
  regenerateResponse(exchangeId) {}
  switchVersion(exchangeId, direction) {}
  deleteExchange(exchangeId) {}
  clear() {}
  getMessagesForApi() { /* returns array for Gateway API */ }
  save() { /* to localStorage */ }
  load() { /* from localStorage */ }
}
```

#### 3.2.2 Streaming Handler
**File:** `public/js/chat/streaming.js`

**Interface:**
```javascript
export class StreamingHandler {
  constructor(gatewayUrl) {
    this.gatewayUrl = gatewayUrl;
    this.abortController = null;
  }
  
  async *streamChat(requestBody) {
    // Yields: {type: 'delta', content} | {type: 'done'} | {type: 'error', error}
    // Handles SSE parsing, compaction events
  }
  
  abort() {
    this.abortController?.abort();
  }
}
```

#### 3.2.3 Main Controller
**File:** `public/js/chat/chat-controller.js`

**Responsibilities:**
- Initialize all components
- Handle user input (keyboard shortcuts, send button)
- Manage streaming state
- Update DOM from conversation state
- Handle model selection, temperature
- Manage attachments

**Key Methods:**
```javascript
export class ChatController {
  constructor(element) {
    this.element = element;
    this.conversation = new Conversation();
    this.streamer = new StreamingHandler(this.getGatewayUrl());
    this.isStreaming = false;
  }
  
  init() {
    // Setup event listeners
    // Load models
    // Restore conversation
  }
  
  async sendMessage() {
    // 1. Get input content
    // 2. Add to conversation
    // 3. Render user message
    // 4. Start streaming
    // 5. Update assistant message as chunks arrive
  }
  
  renderExchange(exchange) {
    // Use markdown.js for assistant content
    // Create message DOM elements
  }
  
  getGatewayUrl() {
    // window.location.origin.replace(':3401', ':3400')
  }
}
```

---

### Phase 3: Advanced Features

#### 3.3.1 Image Attachments (Vision)
**File:** `public/js/chat/attachments.js`

**Features:**
- File input handling
- Image preview
- Check model vision capability before allowing upload
- Convert to base64 for API

**API Format:**
```javascript
{
  role: 'user',
  content: [
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } },
    { type: 'text', text: 'What is in this image?' }
  ]
}
```

**Image Processing Options:**
For optimal performance, include `image_processing` in the request:
```javascript
{
  model: "gemini-flash",
  messages: [...],
  image_processing: {
    resize: "auto",      // 'auto' | 'low' (512px) | 'high' (2048px) | number
    transcode: "webp",   // 'jpg' | 'png' | 'webp'
    quality: 85          // 1-100, default: 85 (high) or 70 (low)
  }
}
```

> **Note:** Images are always fetched (remote URLs → base64). Processing (resize/transcode) only happens when `image_processing` is specified and MediaService is enabled.

#### 3.3.2 Message Features
From LMChat, port:
- **Copy button** on code blocks
- **Thinking blocks** parsing (Gateway-standardized `<think>...</think>`)
- **Version control** (regenerate, prev/next version)
- **Lightbox** for image viewing
- **Auto-scroll** with user scroll detection

**Thinking Block Handling:**
```javascript
// Gateway guarantees unified <think>...</think> format
function parseThinking(content) {
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    return {
      thinking: thinkMatch[1].trim(),
      answer: content.replace(/<think>[\s\S]*?<\/think>/, '').trim()
    };
  }
  return { thinking: null, answer: content };
}
```

#### 3.3.3 Keyboard Shortcuts
- `Enter` - Send message
- `Shift+Enter` - New line
- `Ctrl+N` - New chat
- `Escape` - Cancel streaming

---

### Phase 4: Integration

#### 3.4.1 WebAdmin Link (Optional)
To open chat from WebAdmin, add a simple link:

**File:** `public/js/main.js` (navigation)
```javascript
const navigationData = [
  // ... existing items
  {
    label: 'Open Chat',
    icon: 'open_in_full',
    href: '/chat',
    external: true  // Indicates full page navigation
  },
];
```

Or in Dashboard as a prominent card/button.

#### 3.4.2 Static Asset Serving
**File:** `server.js`

Ensure chat assets are served:
```javascript
// Shared vendor libraries
app.use('/shared/vendor', express.static(path.join(__dirname, 'public/shared/vendor')));

// Chat-specific routes
app.use('/chat', require('./routes/chat'));
app.use('/chat', express.static(path.join(__dirname, 'public/chat')));

// NUI library (shared)
app.use('/NUI', express.static(path.join(__dirname, 'lib/nui_wc2/NUI')));
```

### 3.4.3 API Proxy (Optional)
If needed for CORS, add proxy route to `routes/api.js`:
```javascript
// POST /api/chat/completions - Proxy to Gateway
router.post('/chat/completions', async (req, res) => {
  // Stream proxy implementation
});
```

**Note:** Gateway has CORS enabled, so direct communication works.

#### 3.4.3 Model Capability Detection
Check `/v1/models` response for `capabilities.vision` to enable/disable image upload.

---

## 4. API Integration Details

### 4.1 Gateway Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /v1/models` | Populate model selector, check capabilities |
| `POST /v1/chat/completions` | Send messages, receive streaming responses |

### 4.2 Request Format
```javascript
{
  model: "gemini-flash",  // or empty for default
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "<think>Planning response...</think>\nHi there!" },
    { role: "user", content: "How are you?" }
  ],
  temperature: 0.7,
  stream: true
}
```

**Note:** The Gateway normalizes all thinking formats to `<think>...</think>` in the content.

### 4.3 Response Handling

**Streaming SSE Events:**
```
data: {"choices":[{"delta":{"content":"<think>Let me think"}}]}
data: {"choices":[{"delta":{"content":" about this...</think>"}}]}
data: {"choices":[{"delta":{"content":"The answer is 42."}}]}
event: compaction.progress
data: {"chunk":1,"total":3}
data: [DONE]
```

**Parsing Logic:**
1. Split by double newlines
2. Lines starting with `data:` contain JSON
3. Lines starting with `event:` indicate event type (e.g., `compaction.progress`)
4. `[DONE]` marks end of stream
5. `event: compaction.*` are progress indicators (optional display)
6. Heartbeat comments (`: heartbeat`) can be ignored

**Thinking Block Assembly:**
Since Gateway normalizes to `<think>...</think>`, the client:
1. Buffers streaming content
2. Detects `<think>` opening tag
3. Renders thinking content in collapsible section
4. On `</think>`, switches to rendering answer
5. If `</think>` not yet received, shows "Thinking..." indicator

---

## 5. Styling Guidelines

### 5.1 Use NUI Variables
```css
/* Backgrounds */
background: var(--nui-shade6);  /* Main background */
background: var(--nui-shade5);  /* Elevated surfaces */

/* Text */
color: var(--nui-shade1);       /* Primary text */
color: var(--nui-shade2);       /* Secondary text */

/* Accents */
background: var(--nui-accent);  /* Primary buttons */
border-color: var(--nui-shade3); /* Borders */

/* Dark mode support */
color-scheme: light dark;       /* Already in NUI */
```

### 5.2 Message Styling Pattern
```css
.chat-message {
  border-radius: var(--nui-border-radius, 6px);
  padding: var(--nui-space, 1rem);
  margin-bottom: var(--nui-space, 1rem);
}

.chat-message.user {
  background: var(--nui-accent-soft, rgba(24, 106, 195, 0.1));
  margin-left: 2rem;
}

.chat-message.assistant {
  background: var(--nui-shade5);
  margin-right: 2rem;
}
```

---

## 6. Testing Checklist

### 6.1 Basic Functionality
- [ ] Page loads and displays correctly
- [ ] Model selector populates from Gateway
- [ ] Send message and receive response
- [ ] Streaming shows content progressively
- [ ] Conversation history persists in localStorage

### 6.2 Markdown Rendering
- [ ] Headers render correctly
- [ ] Code blocks with syntax highlighting
- [ ] Copy button on code blocks works
- [ ] Inline code styling
- [ ] Lists (ordered/unordered)
- [ ] Tables
- [ ] Blockquotes
- [ ] Links (clickable)

### 6.2a Thinking Block Rendering (Gateway Standardized)
- [ ] `<think>` blocks render as collapsible sections
- [ ] Thinking indicator shows while incomplete
- [ ] Answer content renders below thinking
- [ ] Toggle expands/collapses thinking
- [ ] Works with streaming (chunks arrive progressively)

### 6.3 Advanced Features
- [ ] Image upload (vision models)
- [ ] Image lightbox
- [ ] Thinking block parsing
- [ ] Message regeneration
- [ ] Version switching (prev/next)
- [ ] Delete message/exchange
- [ ] New chat clears history

### 6.4 Edge Cases
- [ ] Empty message handling
- [ ] Very long messages (scrolling)
- [ ] Network errors (graceful failure)
- [ ] Abort streaming mid-response
- [ ] Switch models mid-conversation
- [ ] Large conversation history (performance)

---

## 7. Development Order

### Week 1: Foundation
1. Copy vendor libraries from LMChat
2. Create `chat.css` with base styles
3. Create `markdown.js` adapted from LMChat
4. Create `pages/chat.html` shell

### Week 2: Core Chat
1. Implement `conversation.js` state management
2. Implement `streaming.js` handler
3. Create `chat-controller.js` main logic
4. Basic send/receive working

### Week 3: Polish
1. Add markdown rendering to messages
2. Implement code copy buttons
3. Add thinking block support
4. Style refinement

### Week 4: Advanced Features
1. Image attachments
2. Lightbox
3. Version control (regenerate, switch)
4. Keyboard shortcuts

### Week 5: Integration & Testing
1. Navigation integration
2. localStorage persistence
3. Error handling
4. Testing and bug fixes

---

## 8. Notes & Decisions

### 8.1 Architectural Decisions

**Why standalone page instead of WebAdmin fragment?**
- Chat needs full viewport (no sidebar constraints)
- Different use case (focused chat vs admin dashboard)
- Can be bookmarked directly at `/chat`
- Simpler routing (no SPA state management)
- Can be opened in separate tab/window

**Why is LMChat a gitignored submodule?**
- LMChat is **reference-only** - we don't depend on it at runtime
- Added as submodule for convenient local access to source code
- Gitignored so reference files don't clutter the main repo
- We adapt specific parts (rendering engine) to our architecture
- LMChat is tightly coupled to LM Studio SDK; we need Gateway API integration

**Why stateless conversation?**
- Matches Gateway v2.0 architecture
- No session management complexity
- Full client control over history

**Why localStorage?**
- Simple persistence across page refreshes
- No server-side storage needed
- User can clear via "New Chat"

### 8.2 Gateway Thinking Block Configuration
The Gateway exposes global configuration for thinking block handling:

```json
{
  "models": {
    "deepseek-r1": {
      "type": "chat",
      "adapter": "openai",
      "capabilities": {
        "contextWindow": 8192,
        "streaming": true
      }
    }
  },
  "thinking": {
    "enabled": true,
    "stripFromContext": false,
    "maxTokens": 32768
  }
}
```

**Gateway Responsibilities:**
1. Detect model-native thinking format (from adapter response)
2. Transform to unified `<think>...</think>` XML format
3. Stream thinking content as it arrives (don't buffer)
4. Include/exclude thinking blocks from context based on global config
5. Strip thinking blocks entirely if `enabled: false`

### 8.3 Known Limitations
- No server-side conversation history (by design)
- Image attachments limited by base64 size
- No real-time collaboration
- localStorage has size limits (~5MB)

### 8.4 Future Enhancements (Out of Scope)
- IndexedDB for larger history
- Export conversation to file
- Conversation folders/categories
- Search through history
- Multiple concurrent chats (tabs)
- Gateway-side thinking block summarization

---

## 9. Appendix

### 9.1 LMChat Files Reference
**Source:** https://github.com/herrbasan/LMChat

See Section 1.3 for detailed reference mapping. Summary:

| Category | Files | Action |
|----------|-------|--------|
| **Rendering** | `markdown.js`, vendor libs | Copy & adapt to NUI |
| **Styling** | `style.css` | Port styles, use NUI variables |
| **Logic** | `app.js` | Reference patterns, rewrite for Gateway |
| **Features** | `attachments.js`, `lightbox.js`, `scroll.js` | Adapt as needed |
| **Utils** | `storage.js`, `code-detection.js` | Use as reference |

### 9.2 NUI Components to Use
| Component | Usage |
|-----------|-------|
| `nui-select` | Model selector |
| `nui-slider` | Temperature control |
| `nui-textarea` | Message input |
| `nui-button` | Send, attach, actions |
| `nui-icon` | Button icons |
| `nui-banner` | Error notifications |
| `nui-loading` | Streaming indicator |

### 9.3 Gateway API Reference
See: `docs/api_documentation.md`

Key endpoints:
- `GET /v1/models` - List available models
- `POST /v1/chat/completions` - Chat with streaming

---

*Document Version: 1.0*
*Last Updated: 2026-03-09*
