# Security Guidelines

## Preventing Secret Leaks

This repository has safeguards to prevent accidentally committing sensitive data like API keys.

### Active Protections

1. **`.gitignore`** - Ignores sensitive files:
   - `config.json` (local config with API keys)
   - `config.json.backup-*` (backup files)
   - `.env` (environment variables)
   - `*.log`, `logs/` (may contain debug output)

2. **Pre-commit Hook** - Blocks commits containing:
   - Backup files (`config.json.backup-*`)
   - Environment files (`.env`)
   - Cryptographic keys (`.pem`, `.key`)

3. **Pre-push Hook** - Scans history before push

### If the Hook Blocks Your Commit

```bash
# 1. Check what was blocked
git status

# 2. Unstage the sensitive file
git reset HEAD config.json.backup-1234567890

# 3. Delete it if not needed
rm config.json.backup-1234567890

# 4. Commit your other changes
git commit -m "your message"
```

### Emergency: Bypassing the Hook

**⚠️ DANGEROUS - Only if you're certain the file is safe:**

```bash
git commit --no-verify  # Bypasses pre-commit hook
git push --no-verify     # Bypasses pre-push hook
```

### API Key Management

1. **Never commit keys** - Use `.env` or environment variables
2. **Rotate keys regularly** - Especially if accidentally exposed
3. **Use different keys per environment** - Dev/staging/prod

### What To Do If Keys Are Leaked

1. **Rotate immediately** at the provider console
2. **Purge from git history** (see emergency procedure)
3. **Notify team members** to re-clone the repo

### Emergency History Rewrite

If secrets were committed:

```bash
# Remove sensitive files from ALL history
git filter-branch --force --index-filter \
'git rm --cached --ignore-unmatch config.json.backup-* .env *.pem' \
--prune-empty --tag-name-filter cat -- --all

# Clean up
rm -rf .git/refs/original/
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# Force push (DESTRUCTIVE)
git push origin --force --all
```

**⚠️ This rewrites history. All team members must re-clone.**
