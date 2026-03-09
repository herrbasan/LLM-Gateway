# Chat Implementation - Handover Document

> Current state of the LLM Gateway Chat interface for transfer to another developer.

---

## ✅ What's Working

### Core Functionality
- **Streaming chat** with Gateway API via SSE
- **Conversation history** persisted to localStorage
- **Model selection** with NUI searchable dropdown
- **Image attachments** for vision models
- **Temperature/max tokens/system prompt** configuration
- **New chat / clear conversation**
- **Regenerate responses** with version control (prev/next)
- **Abort streaming** mid-generation
- **Thinking block detection** and display

### Components
| File | Purpose |
|------|---------|
| `chat.js` | Main controller, event handling, streaming logic |
| `conversation.js` | State management with localStorage persistence |
| `streaming.js` | SSE handler for Gateway API |
| `markdown.js` | Markdown rendering (markdown-it + DOMPurify) |
| `chat.css` | Styling (needs dark mode fixes) |
| `index.html` | Page shell with sidebar layout |

---

## 🐛 Known Issues (Need Fixing)

### 1. Dark Mode Theming (CRITICAL)
Multiple elements don't respect dark mode:
- **Thinking blocks** - Light background in dark mode
- **Code blocks** - Light background (should match dark theme)
- **Table headers** - Light background with white text (illegible)
- **Message bubbles** - May need adjustment for contrast
- **Input fields** - Check border/background colors

The theme toggle sets `data-theme="dark"` on `<html>` element. CSS uses `[data-theme="dark"]` selectors.

### 2. UTF-8 Emoji
- Remove `🧠` emoji from thinking blocks
- Use NUI icons or SVG instead

### 3. Version Counter UX
- Currently shows "1/2" confusingly on first response
- Should only show version numbers after regeneration
- Regenerate button (↻) should always be visible

### 4. Auto-scroll
- Chat doesn't auto-scroll to bottom during streaming
- User has to manually scroll to see new content

### 5. Code Block Styling
- Copy button works but styling is basic
- Syntax highlighting works via Prism
- Need better dark mode colors for code

---

## 📁 File Structure

```
WebAdmin/
├── routes/
│   └── chat.js              # Express route (serves index.html)
├── public/
│   ├── chat/
│   │   ├── index.html       # Page shell
│   │   ├── css/
│   │   │   └── chat.css     # Styles (NEEDS WORK)
│   │   └── js/
│   │       ├── chat.js      # Main controller (~750 lines)
│   │       ├── conversation.js   # State management
│   │       ├── streaming.js      # SSE handler
│   │       └── markdown.js       # Markdown rendering
│   └── shared/
│       └── vendor/          # Copied from LMChat
│           ├── markdown-it.js
│           ├── markdown-it-prism.js
│           ├── purify.js
│           ├── prism.js
│           └── prism.css
└── server.js                # Updated with chat routes
```

---

## 🔌 API Integration

### Gateway Endpoints Used
```javascript
GET  /v1/models              # Populate model selector
POST /v1/chat/completions    # Streaming chat (SSE)
GET  /health                 # Gateway status indicator
```

### Request Format
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

### Response Handling
- SSE events: `data: {...}`, `event: compaction.*`
- Thinking blocks: `<think>...</think>` normalized by Gateway
- Stream ends with: `data: [DONE]`

---

## 🎨 Styling Notes

### NUI Integration
- Uses NUI components: `nui-select`, `nui-slider`, `nui-input`, `nui-textarea`, `nui-button`
- Theme variables: `--nui-bg`, `--nui-fg`, `--nui-shade1-7`, `--nui-accent`
- NUI theme file: `/NUI/css/nui-theme.css`

### Current CSS Issues
1. Dark mode uses hardcoded colors (`#2a2a2a`, `#e0e0e0`) instead of NUI variables
2. Missing dark mode rules for:
   - `.thinking-block`
   - `.code-block` / `.code-header`
   - `.message-content table th`
   - Various text colors

### Layout
- Sidebar: 300px fixed width on left
- Main area: Flexible, contains messages + input
- Mobile: Sidebar slides in from left (transform translate)

---

## 🧠 Key Logic

### Thinking Blocks
```javascript
// Parsed from streaming content
<think>reasoning here...</think>

// Displayed as collapsible section above answer
// Click header to toggle open/closed
```

### Version Control
- First response: Show only regenerate button
- After regenerate: Show ← 2/3 → controls
- Versions stored in conversation.assistant.versions[]

### Markdown Rendering
```javascript
// markdown.js exports:
renderMarkdown(content)     // Returns sanitized HTML
parseThinking(content)      // Returns {thinking, answer}
renderThinking(thinking)    // Returns thinking block HTML
```

---

## 🚧 TODO List

### High Priority
- [ ] Fix all dark mode styling issues
- [ ] Remove UTF-8 emoji (🧠) from thinking blocks
- [ ] Fix auto-scroll during streaming
- [ ] Improve code block styling in dark mode
- [ ] Fix table header contrast in dark mode

### Medium Priority
- [ ] Add keyboard shortcuts (Ctrl+Enter to send, Escape to cancel)
- [ ] Add loading state for model selector
- [ ] Add error retry functionality
- [ ] Improve mobile experience

### Low Priority
- [ ] Export conversation to file
- [ ] Multiple concurrent chats (tabs)
- [ ] Message search
- [ ] Image preview in lightbox (currently just opens image)

---

## 🚀 Testing

```bash
# Start Gateway
cd "d:\DEV\LLM Gateway"
npm start

# Start WebAdmin (different terminal)
cd "d:\DEV\LLM Gateway\WebAdmin"
npm start

# Open chat
http://localhost:3401/chat
```

---

## 💡 Tips for Next Developer

1. **NUI Components**: Check `/NUI/nui.js` for component APIs
2. **Theme Toggle**: Look at `toggleTheme()` and `setTheme()` in chat.js
3. **Dark Mode CSS**: Search for `[data-theme="dark"]` in chat.css
4. **SSE Handling**: See `StreamingHandler.streamChat()` in streaming.js
5. **State Management**: `Conversation` class handles localStorage

---

## 📚 References

- **LMChat Reference**: `Reference/LMChat/` (git submodule)
- **NUI Docs**: https://herrbasan.github.io/nui_wc2/
- **API Docs**: `docs/api_documentation.md`
- **Dev Plan**: `WebAdmin/docs/CHAT_DEVELOPMENT_PLAN.md`

---

*Last Updated: 2026-03-09*
*Status: Core functionality complete, needs visual polish*
