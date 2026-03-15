# Chat Development Handover

> **Status:** In Progress - Layout broken after nui_wc2 update  
> **Date:** 2026-03-14  
> **Context:** Nearly full, needs fresh session

---

## What Was Completed

### ✅ Chat History Feature (Working)
- **File:** `public/chat/js/chat-history.js` - New multi-conversation management
- Can create, save, recall, delete multiple chats
- Auto-saves after each response
- Stores in localStorage with metadata + conversation data

### ✅ nui_wc2 Submodule Updated
- Updated from old commit to `ebad984` (14 new commits)
- Breaking changes in component names and layout system

---

## What Broke

### Breaking Changes in nui_wc2
| Old Name | New Name | Notes |
|----------|----------|-------|
| `nui-top-nav` | `nui-app-header` | New semantic structure |
| `nui-side-nav` | `nui-sidebar` | `position="left"`/`"right"` attributes |
| `nui-main` | `<main>` | No custom element wrapper |
| `layout`/`item` | `nui-layout`/`nui-layout-item` | Layout system changed |

### Layout System Changes
- **Old:** Manual positioning with `--side-nav-width` offsets
- **New:** CSS Grid system with automatic content offset
- When `nui-sidebar` is present, `nui-content` automatically adjusts
- Classes like `sidenav-forced`, `sidenav-open` control visibility

### Current Broken State
- Chat page loads but layout is wrong
- "New Chat" button not visible (likely pushed out of viewport)
- Sidebar structure needs complete rebuild

---

## What Needs to Be Done

### 1. Fix Chat Layout (Priority 1)
**Reference:** `lib/nui_wc2/Playground/pages/components/app-layout.html`

New structure should be:
```html
<nui-app>
  <nui-app-header>
    <header>...</header>
  </nui-app-header>
  
  <nui-sidebar position="left">
    <nav>Chat History + New Chat Button</nav>
  </nui-sidebar>
  
  <nui-content>
    <main>Messages Area</main>
  </nui-content>
  
  <nui-sidebar position="right">
    <nav>Model Settings</nav>
  </nui-sidebar>
  
  <nui-app-footer>
    <footer>Input Area</footer>
  </nui-app-footer>
</nui-app>
```

**Key:** Footer inside `<nui-app-footer><footer>...</footer></nui-app-footer>`

### 2. Fix Sidebar Toggle Actions
```javascript
// Use nui-app's toggleSideNav method
const app = document.querySelector('nui-app');
app.toggleSideNav('left');  // or 'right'
```

### 3. Fix WebAdmin Main App
WebAdmin also uses old component names - needs same updates.

---

## Working Files to Keep

| File | Status | Notes |
|------|--------|-------|
| `chat-history.js` | ✅ Keep | Multi-chat management working |
| `conversation.js` | ✅ Keep | No changes needed |
| `streaming.js` | ✅ Keep | No changes needed |
| `markdown.js` | ✅ Keep | No changes needed |
| `chat.js` | ⚠️ Partial | Keep logic, fix layout integration |
| `chat.css` | ❌ Scrap | Start fresh with NUI variables |
| `index.html` | ❌ Scrap | Complete rewrite needed |

---

## Key Technical Details

### NUI Layout CSS Variables
```css
--nui-sidebar-width: 15rem;        /* Default sidebar width */
--app-header-height: 3.5rem;       /* Top nav height */
--footer-height: auto;             /* Footer height */
```

### Auto-Layout Behavior
When `nui-sidebar[position="left"]` is inside `nui-app`:
- Sidebar is positioned automatically
- Content gets left offset automatically
- No manual CSS needed for positioning

### Content Structure
- `nui-content > main` - Scrollable content area
- Use `<main>` element, not `nui-main`

---

## Next Steps

1. **Start fresh session** - Clear context
2. **Read nui_wc2 docs** - Check `lib/nui_wc2/Playground/pages/components/app-layout.html`
3. **Rewrite chat/index.html** - Minimal working layout first
4. **Test incrementally** - One component at a time
5. **Then fix WebAdmin** - Same pattern

---

## Reference URLs

- Local Playground: `http://localhost:3401` (when WebAdmin running)
- App Layout Docs: `lib/nui_wc2/Playground/pages/components/app-layout.html`
- NUI Agents Guide: `lib/nui_wc2/Agents.md`

---

**End this session. Start fresh with clean context.**
