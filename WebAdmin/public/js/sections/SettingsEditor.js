// ============================================
// Settings Editor - JSON config editor
// ============================================

export class SettingsEditor {
    constructor(element) {
        this.element = element;
        this.originalConfig = null;
        this.currentConfig = null;
        this.isDirty = false;
        this.isValid = true;
        this.backups = [];
    }
    
    render() {
        this.element.innerHTML = `
            <div class="settings-container">
                <div class="settings-header">
                    <h2>Settings</h2>
                    <div class="editor-actions">
                        <nui-button data-action="settings-backups" type="outline">
                            <nui-icon name="folder"></nui-icon>
                            <span>Backups</span>
                        </nui-button>
                        <nui-button data-action="settings-reset" type="outline">
                            <span>Reset</span>
                        </nui-button>
                        <nui-button data-action="settings-save" type="primary">
                            <nui-icon name="save"></nui-icon>
                            <span>Save</span>
                        </nui-button>
                    </div>
                </div>
                
                <div class="code-editor">
                    <textarea id="config-editor" spellcheck="false"></textarea>
                    <div class="editor-status valid" id="editor-status">
                        <nui-icon name="done"></nui-icon>
                        <span>Valid JSON</span>
                    </div>
                </div>
            </div>
        `;
        
        this.bindEvents();
    }
    
    bindEvents() {
        const textarea = this.element.querySelector('#config-editor');
        const saveBtn = this.element.querySelector('[data-action="settings-save"]');
        const resetBtn = this.element.querySelector('[data-action="settings-reset"]');
        const backupsBtn = this.element.querySelector('[data-action="settings-backups"]');
        
        textarea?.addEventListener('input', () => {
            this.validate();
            this.isDirty = true;
        });
        
        // Handle tab key in textarea
        textarea?.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
                textarea.selectionStart = textarea.selectionEnd = start + 2;
            }
        });
        
        saveBtn?.addEventListener('click', () => this.save());
        resetBtn?.addEventListener('click', () => this.reset());
        backupsBtn?.addEventListener('click', () => this.showBackups());
    }
    
    async load() {
        try {
            const [configRes, backupsRes] = await Promise.all([
                fetch('/api/config'),
                fetch('/api/config/backups')
            ]);
            
            if (!configRes.ok) throw new Error('Failed to load config');
            
            const config = await configRes.json();
            const backupsData = await backupsRes.json().catch(() => ({ backups: [] }));
            
            this.originalConfig = JSON.stringify(config, null, 2);
            this.currentConfig = this.originalConfig;
            this.backups = backupsData.backups || [];
            this.isDirty = false;
            
            const textarea = this.element.querySelector('#config-editor');
            if (textarea) {
                textarea.value = this.originalConfig;
            }
            
            this.updateStatus(true);
            
        } catch (error) {
            console.error('[Settings] Failed to load:', error);
            this.showError('Failed to load configuration');
        }
    }
    
    validate() {
        const textarea = this.element.querySelector('#config-editor');
        if (!textarea) return false;
        
        const content = textarea.value;
        
        try {
            JSON.parse(content);
            this.isValid = true;
            this.updateStatus(true);
            return true;
        } catch (error) {
            this.isValid = false;
            this.updateStatus(false, error.message);
            return false;
        }
    }
    
    updateStatus(valid, message = '') {
        const status = this.element.querySelector('#editor-status');
        if (!status) return;
        
        status.className = `editor-status ${valid ? 'valid' : 'invalid'}`;
        status.innerHTML = valid 
            ? '<nui-icon name="done"></nui-icon><span>Valid JSON</span>'
            : `<nui-icon name="warning"></nui-icon><span>${message || 'Invalid JSON'}</span>`;
    }
    
    async save() {
        if (!this.isValid) {
            nui.components.banner.show({
                content: 'Cannot save: Invalid JSON',
                priority: 'error',
                autoClose: 3000
            });
            return;
        }
        
        const textarea = this.element.querySelector('#config-editor');
        const content = textarea?.value;
        
        if (!content) return;
        
        try {
            const config = JSON.parse(content);
            
            const response = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Save failed');
            }
            
            const result = await response.json();
            this.originalConfig = content;
            this.isDirty = false;
            
            // Reload backups list
            this.loadBackups();
            
            nui.components.banner.show({
                content: 'Configuration saved successfully',
                priority: 'success',
                autoClose: 2000
            });
            
        } catch (error) {
            console.error('[Settings] Save failed:', error);
            nui.components.banner.show({
                content: error.message || 'Failed to save configuration',
                priority: 'error',
                autoClose: 3000
            });
        }
    }
    
    reset() {
        if (this.isDirty) {
            nui.components.dialog.confirm(
                'Discard Changes?',
                'You have unsaved changes. Are you sure you want to reset?'
            ).then((confirmed) => {
                if (confirmed) this.doReset();
            });
        } else {
            this.doReset();
        }
    }
    
    doReset() {
        const textarea = this.element.querySelector('#config-editor');
        if (textarea && this.originalConfig) {
            textarea.value = this.originalConfig;
            this.validate();
            this.isDirty = false;
        }
    }
    
    async loadBackups() {
        try {
            const response = await fetch('/api/config/backups');
            const data = await response.json();
            this.backups = data.backups || [];
        } catch (error) {
            console.error('[Settings] Failed to load backups:', error);
        }
    }
    
    showBackups() {
        if (this.backups.length === 0) {
            nui.components.dialog.alert('Backups', 'No backups available yet.');
            return;
        }
        
        const backupsHtml = this.backups.slice(0, 10).map(b => {
            const date = new Date(b.timestamp).toLocaleString();
            return `
                <div class="backup-item">
                    <span>${date}</span>
                    <nui-button data-backup="${b.filename}" data-action="restore-backup">
                        <span>Restore</span>
                    </nui-button>
                </div>
            `;
        }).join('');
        
        nui.components.dialog._show(`
            <div class="backups-dialog">
                <h3>Available Backups</h3>
                <div class="backups-list">
                    ${backupsHtml}
                </div>
            </div>
        `, { classes: ['backups-dialog'] });
        
        // Handle restore clicks
        document.querySelectorAll('[data-action="restore-backup"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const filename = btn.dataset.backup;
                await this.restoreBackup(filename);
            });
        });
    }
    
    async restoreBackup(filename) {
        try {
            const confirmed = await nui.components.dialog.confirm(
                'Restore Backup?',
                `This will replace the current configuration with ${filename}. Continue?`
            );
            
            if (!confirmed) return;
            
            const response = await fetch('/api/config/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ backupFilename: filename })
            });
            
            if (!response.ok) throw new Error('Restore failed');
            
            // Reload config
            await this.load();
            
            nui.components.banner.show({
                content: 'Configuration restored successfully',
                priority: 'success',
                autoClose: 2000
            });
            
        } catch (error) {
            nui.components.banner.show({
                content: `Restore failed: ${error.message}`,
                priority: 'error',
                autoClose: 3000
            });
        }
    }
    
    saveIfDirty() {
        if (this.isDirty) {
            console.log('[Settings] Unsaved changes exist');
        }
    }
    
    showError(message) {
        this.element.innerHTML = `
            <div class="error-message">
                <nui-icon name="warning"></nui-icon>
                ${message}
            </div>
        `;
    }
}
