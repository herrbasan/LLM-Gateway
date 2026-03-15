# Chat Development Plan

> Consolidated development plan for the LLM Gateway Chat interface.  
> **Status:** Core functionality complete. Visual polish in progress.

---

## 1. Current State

### ✅ What's Working

| Feature | Status | Notes |
|---------|--------|-------|
| Streaming chat | ✅ Complete | SSE-based, real-time response display |
| Conversation history | ✅ Complete | localStorage persistence with auto-save |
| Chat history (multiple) | ✅ Complete | Create, recall, delete multiple chats |
| Model selection | ✅ Complete | NUI searchable dropdown, grouped by adapter |
| Image attachments | ✅ Complete | Vision models support, preview thumbnails |
| Temperature/max tokens/system prompt | ✅ Complete | Per-chat settings persisted to localStorage |
| New chat / clear conversation | ✅ Complete | Preserves model/settings, clears messages |
| Regenerate responses | ✅ Complete | Version control with prev/next navigation |
| Abort streaming | ✅ Complete | Send button becomes stop button during generation |
| Thinking block detection | ✅ Complete | Parses `<think>...</think>` from Gateway |
| Markdown rendering | ✅ Complete | markdown-it + DOMPurify + Prism highlighting |
| Code copy buttons | ✅ Complete | One-click copy for code blocks |
| Lightbox for images | ✅ Complete | Click to view full-size images |
| Theme toggle | ✅ Complete | Light/dark mode with system preference detection |
| Mobile sidebar | ✅ Complete | Collapsible sidebars on small screens |

### 📁 File Structure

```
WebAdmin/
├── routes/
│   └── chat.js              # Express route (serves index.html)
├── public/
│   ├── chat/
│   │   ├── index.html       # Page shell with NUI app layout
│   │   ├── css/
│   │   │   └── chat.css     # Chat-specific styles (NEEDS WORK)
│   │   └── js/
│   │       ├── chat.js      # Main controller (~1000 lines)
│   │       ├── conversation.js   # State management + localStorage
│   │       ├── streaming.js      # SSE handler for Gateway API
│   │       └── markdown.js       # Markdown rendering + thinking parser
│   └── shared/
│       └── vendor/          # Copied from LMChat reference
│           ├── markdown-it.js
│           ├── markdown-it-prism.js
│           ├── purify.js
│           ├── prism.js
│           └── prism.css
└── server.js                # Chat routes registered
```

### 🔌 API Integration

**Gateway Endpoints Used:**
```javascript
GET  /v1/models              # Populate model selector
POST /v1/chat/completions    # Streaming chat (SSE)
GET  /health                 # Gateway status indicator
```

**Request Format:**
```javascript
{
  model: "gemini-flash",
  messages: [...],
  temperature: 0.7,
  max_tokens: 2048,
  stream: true,
  image_processing: {      // If images attached
    resize: "auto",
    transcode: "webp",
    quality: 85
  }
}
```

---

## 2. Known Issues (Priority Order)

### 🟡 Medium: Auto-scroll

- Chat doesn't auto-scroll to bottom during streaming
- User has to manually scroll to see new content
- Should detect if user is at bottom and auto-scroll, or provide a "scroll to bottom" button

### 🟡 Medium: Version Counter UX

- Currently shows version numbers confusingly on first response
- Should only show version navigation after regeneration
- Regenerate button (↻) should always be visible

### 🔴 Critical: Dark Mode Styling

Multiple elements don't respect dark mode properly. The theme toggle sets `data-theme="dark"` on `<html>` element.

**Broken Elements:**

| Element | Problem | Fix |
|---------|---------|-----|
| Thinking blocks | Light background (`#f0f0f0`) in dark mode | Use NUI variables `--nui-shade5` |
| Code blocks | Light background in dark mode | Add `[data-theme="dark"]` rules |
| Table headers | Light background + white text = illegible | Fix contrast |
| Message bubbles | May need contrast adjustment | Verify with `--nui-shade` variables |
| Input fields | Check border/background colors | Ensure proper variable mapping |

> **Note:** Dark mode fixes are pending the nui_wc2 library update.

**CSS Pattern to Follow:**
```css
/* Light mode (default) */
.thinking-block {
  background: var(--nui-shade6, #f0f0f0);
  border: 1px solid var(--nui-shade3, #ddd);
}

/* Dark mode override */
[data-theme="dark"] .thinking-block {
  background: var(--nui-shade5);
  border-color: var(--nui-shade3);
}
```

### 🟢 Low: Emoji in Compaction Indicator

- Line 670 in `chat.js`: `innerHTML = '<span class="icon">📝</span> Compacting context...'`
- Replace with NUI icon or SVG

### 🟢 Low: Keyboard Shortcuts

Missing shortcuts:
- `Ctrl+Enter` - Send message
- `Escape` - Cancel streaming
- `Ctrl+N` - New chat

---

## 3. Architecture Reference

### Thinking Block Handling

Gateway normalizes all thinking formats to unified `<think>...</think>`:

```javascript
// From markdown.js
export function parseThinking(content) {
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

**UI Display:**
- Collapsible section above answer
- Shows "Thinking..." while streaming
- Click header to expand/collapse

### Version Control Logic

```javascript
// From conversation.js
exchange.assistant = {
  content: "...",
  versions: [
    { content: "...", timestamp: 123456 },
    { content: "...", timestamp: 123789 }
  ],
  currentVersion: 0,
  isComplete: true
};
```

**Rules:**
1. First response: Show regenerate button only
2. After regenerate: Show ← 2/3 → controls
3. `currentVersion` is 0-based index into `versions[]`

### Conversation State Shape

```javascript
{
  id: "msg-123456",
  user: {
    role: "user",
    content: "Hello",
    attachments: [
      { dataUrl: "...", name: "image.png", type: "image/png" }
    ]
  },
  assistant: {
    role: "assistant",
    content: "Hi there!",
    versions: [...],
    currentVersion: 0,
    isComplete: true
  }
}
```

---

## 4. Styling Guidelines

### NUI Variable Reference

```css
/* Backgrounds */
--nui-bg          /* Main background */
--nui-shade1      /* Lightest shade */
--nui-shade2      /* Light shade */
--nui-shade3      /* Border color */
--nui-shade4      /* Subtle backgrounds */
--nui-shade5      /* Elevated surfaces */
--nui-shade6      /* Card backgrounds */
--nui-shade7      /* Lightest surface */

/* Text */
--nui-fg          /* Primary text */
--nui-accent      /* Accent color (blue) */

/* Spacing */
--nui-space       /* 1rem base */
--nui-space-half  /* 0.5rem */
```

### Dark Mode Pattern

All dark mode overrides should use:
```css
[data-theme="dark"] .selector {
  /* override properties */
}
```

**Do NOT use:**
- Hardcoded colors like `#2a2a2a`, `#e0e0e0`
- `color-scheme: dark` alone (doesn't style custom elements)
- `@media (prefers-color-scheme: dark)` (we use manual toggle)

---

## 5. Testing Checklist

### Basic Functionality
- [ ] Page loads at `http://localhost:3401/chat`
- [ ] Model selector populates from Gateway
- [ ] Send message and receive streaming response
- [ ] Conversation persists across page refresh
- [ ] New chat clears messages (not settings)

### Markdown Rendering
- [ ] Headers render correctly
- [ ] Code blocks with syntax highlighting
- [ ] Copy button on code blocks works
- [ ] Tables render correctly
- [ ] Lists (ordered/unordered)
- [ ] Blockquotes
- [ ] Links clickable

### Dark Mode (Verify Each)
- [ ] Thinking blocks: dark background, readable text
- [ ] Code blocks: dark background, syntax highlighting visible
- [ ] Table headers: proper contrast
- [ ] User messages: visible against background
- [ ] Assistant messages: visible against background
- [ ] Input area: proper borders/background

### Advanced Features
- [ ] Image upload for vision models
- [ ] Image lightbox opens on click
- [ ] Thinking blocks collapsible
- [ ] Regenerate creates new version
- [ ] Version navigation (prev/next)
- [ ] Delete message/exchange
- [ ] Abort streaming mid-response

---

## 6. References

| Resource | Location |
|----------|----------|
| LMChat Reference | `Reference/LMChat/` (git submodule) |
| NUI Documentation | https://herrbasan.github.io/nui_wc2/ |
| NUI Patterns | `WebAdmin/docs/NUI_PATTERNS.md` |
| Gateway API | `docs/api_documentation.md` |
| WebAdmin Dev Plan | `WebAdmin/docs/DEV_PLAN.md` |

---

*Document Version: 2.0*  
*Consolidated: 2026-03-14*  
*Status: Core Complete, Polish In Progress*
