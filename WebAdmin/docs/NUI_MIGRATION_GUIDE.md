# NUI WC2 Migration Guide: v1.x → v2.0

> **Breaking Change:** `<nui-side-nav>` renamed to `<nui-sidebar>`

## Summary of Changes

| v1.x | v2.0 |
|------|------|
| `<nui-side-nav>` | `<nui-sidebar>` |
| `<nui-top-nav>` + `<layout>`/`<item>` | `<nui-app-header>` with slots |
| `nui-action` custom event | Direct `click` event delegation |

---

## 1. Sidebar Component Rename

### HTML Changes

```html
<!-- v1.x -->
<nui-side-nav>
    <nui-link-list mode="fold" id="main-nav"></nui-link-list>
</nui-side-nav>

<!-- v2.0 -->
<nui-sidebar>
    <nui-link-list mode="fold" id="main-nav"></nui-link-list>
</nui-sidebar>
```

### Router Configuration

```javascript
// v1.x
nui.enableContentLoading({
    navigation: 'nui-side-nav',
    // ...
});

// v2.0
nui.enableContentLoading({
    navigation: 'nui-sidebar',  // ← changed
    // ...
});
```

### Toggle Method (UNCHANGED)

```javascript
// Both versions use the same API method name
app.toggleSideNav();        // ← unchanged
app.toggleSideNav('left');  // ← unchanged
app.toggleSideNav('right'); // ← unchanged
```

---

## 2. Header Component Restructure

### v1.x Pattern (Old)

```html
<nui-top-nav>
    <header>
        <layout>
            <item><!-- left content --></item>
            <item><!-- center content --></item>
            <item><!-- right content --></item>
        </layout>
    </header>
</nui-top-nav>
```

### v2.0 Pattern (New)

```html
<nui-app-header>
    <div slot="left">
        <nui-button data-action="toggle-sidebar">
            <button type="button" aria-label="Toggle navigation menu">
                <nui-icon name="menu"></nui-icon>
            </button>
        </nui-button>
        <h1>App Title</h1>
    </div>
    <div slot="center">
        <!-- center content -->
    </div>
    <div slot="right">
        <nui-button data-action="toggle-theme">
            <button type="button" aria-label="Toggle light/dark theme">
                <nui-icon name="brightness"></nui-icon>
            </button>
        </nui-button>
    </div>
</nui-app-header>
```

**Key differences:**
- Replace `<nui-top-nav>` → `<nui-app-header>`
- Replace `<layout>`/`<item>` → `<div slot="left|center|right">`
- Add `aria-label` to buttons (removes need for `class="icon-only"`)

---

## 3. Event Handling Pattern

### v1.x Pattern (Old - Less Reliable)

```javascript
document.addEventListener('nui-action', (e) => {
    const { name } = e.detail;
    if (name === 'toggle-theme') toggleTheme();
});
```

### v2.0 Pattern (New - Recommended)

```javascript
document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    
    const action = actionEl.dataset.action;
    
    switch (action) {
        case 'toggle-sidebar':
            e.preventDefault();
            document.querySelector('nui-app')?.toggleSideNav();
            break;
        case 'toggle-theme':
            e.preventDefault();
            toggleTheme();
            break;
    }
});
```

---

## Complete Before/After Example

### File: `index.html`

```html
<!-- BEFORE -->
<nui-top-nav>
    <header>
        <layout>
            <item>
                <nui-button data-action="toggle-sidebar" class="icon-only">
                    <button type="button"><nui-icon name="menu"></nui-icon></button>
                </nui-button>
            </item>
            <item><h1>My App</h1></item>
            <item>
                <nui-button data-action="toggle-theme" class="icon-only">
                    <button type="button"><nui-icon name="brightness"></nui-icon></button>
                </nui-button>
            </item>
        </layout>
    </header>
</nui-top-nav>

<nui-side-nav>
    <nui-link-list mode="fold" id="main-nav"></nui-link-list>
</nui-side-nav>
```

```html
<!-- AFTER -->
<nui-app-header>
    <div slot="left">
        <nui-button data-action="toggle-sidebar">
            <button type="button" aria-label="Toggle navigation menu">
                <nui-icon name="menu"></nui-icon>
            </button>
        </nui-button>
        <h1>My App</h1>
    </div>
    <div slot="center"></div>
    <div slot="right">
        <nui-button data-action="toggle-theme">
            <button type="button" aria-label="Toggle light/dark theme">
                <nui-icon name="brightness"></nui-icon>
            </button>
        </nui-button>
    </div>
</nui-app-header>

<nui-sidebar>
    <nui-link-list mode="fold" id="main-nav"></nui-link-list>
</nui-sidebar>
```

### File: `main.js`

```javascript
// BEFORE
nui.enableContentLoading({
    navigation: 'nui-side-nav',
    // ...
});

document.addEventListener('nui-action', (e) => {
    const { name } = e.detail;
    if (name === 'toggle-theme') toggleTheme();
});

document.querySelector('[data-action="toggle-sidebar"]')?.addEventListener('click', (e) => {
    document.querySelector('nui-app')?.toggleSideNav();
});

// AFTER
nui.enableContentLoading({
    navigation: 'nui-sidebar',  // ← changed
    // ...
});

document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    
    switch (actionEl.dataset.action) {
        case 'toggle-sidebar':
            e.preventDefault();
            document.querySelector('nui-app')?.toggleSideNav();  // ← unchanged method name
            break;
        case 'toggle-theme':
            e.preventDefault();
            toggleTheme();
            break;
    }
});
```

---

## Quick Checklist

- [ ] Replace `<nui-side-nav>` → `<nui-sidebar>` in HTML
- [ ] Update `navigation: 'nui-side-nav'` → `navigation: 'nui-sidebar'` in JS config
- [ ] Replace `<nui-top-nav>` → `<nui-app-header>` with slot structure
- [ ] Remove `class="icon-only"`, add `aria-label` to buttons
- [ ] Replace `nui-action` event listener with direct `click` handler
- [ ] **Keep** `toggleSideNav()` method name (it didn't change!)

---

## Common Pitfalls

1. **Don't rename `toggleSideNav()`** — The element is now `<nui-sidebar>`, but the API method remains `toggleSideNav()`.

2. **Remove `class="icon-only"`** — The new header pattern uses `aria-label` on buttons instead.

3. **Use event delegation** — The `nui-action` custom event is deprecated; use direct click handling with `e.target.closest('[data-action]')`.
