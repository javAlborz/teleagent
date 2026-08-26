# Feature: Prerequisite Checks with Auto-Fix

## Overview
Add intelligent prerequisite checking at the start of `claude-phone setup` that detects missing or outdated dependencies and offers to automatically install/upgrade them with user consent.

## User Story
As a user installing claude-phone, I want the setup to check all prerequisites BEFORE asking me configuration questions, so I don't waste time on setup only to have it fail due to missing dependencies.

## Requirements

### Minimum Versions
- **Node.js**: 18.0.0 (LTS)
- **Docker**: 20.0.0
- **Docker Compose**: 1.29.0 (standalone) or 2.0.0 (plugin)
- **Disk Space**: 2GB free minimum

### Checks to Perform
1. **Node.js version** - Must be >= 18
2. **Docker installed** - Command must exist
3. **Docker running** - Daemon must be responsive
4. **Docker Compose** - Plugin or standalone must be available
5. **Disk space** - At least 2GB free
6. **CPU Architecture** - x86_64, arm64, armv7l (for image compatibility)
7. **Network connectivity** - Can reach package registries (for auto-fix)

### Platform Detection
Detect and provide platform-specific instructions/commands for:
- **Ubuntu/Debian** (apt)
- **RHEL/CentOS/Fedora** (dnf/yum)
- **Arch Linux** (pacman)
- **macOS** (brew + Docker Desktop)
- **Raspberry Pi / ARM** (apt, ARM-aware)
- **Generic Linux** (manual instructions)

## Acceptance Criteria

### AC1: Pre-flight Check Runs First
- [ ] `claude-phone setup` runs prerequisite checks BEFORE any prompts
- [ ] All checks complete before user sees first question
- [ ] Progress shown: "Checking prerequisites..."

### AC2: Node.js Version Check
- [ ] Detects current Node.js version
- [ ] Fails if < 18.0.0
- [ ] Shows current version vs required version
- [ ] Handles "command not found" gracefully
- [ ] Parses version strings correctly (v20.11.0 vs 20.11.0)

### AC3: Docker Check
- [ ] Verifies `docker` command exists
- [ ] Verifies Docker daemon is running (`docker ps`)
- [ ] Clear error if Docker not installed vs not running
- [ ] Distinguishes "not installed" from "permission denied"

### AC4: Docker Compose Check
- [ ] Checks for `docker compose` (plugin) FIRST - preferred
- [ ] Falls back to `docker-compose` (standalone) if plugin missing
- [ ] Reports which version is available
- [ ] Works correctly if BOTH are installed (prefer plugin)

### AC5: Platform and Architecture Detection
- [ ] Correctly identifies OS (darwin, linux)
- [ ] On Linux, detects distro family (debian, rhel, arch, etc.)
- [ ] Reads `/etc/os-release` on Linux for distro info
- [ ] Detects CPU architecture (x86_64, arm64, armv7l)
- [ ] Validates Docker base images support detected architecture
- [ ] Detects package manager (apt, dnf, yum, pacman, brew)

### AC6: Disk Space Check
- [ ] Check available disk space before proceeding
- [ ] Require at least 2GB free (1GB install + 1GB overhead)
- [ ] Check space in Docker data directory if Docker exists
- [ ] Clear error if insufficient: "Need 2GB free, have 500MB"

### AC7: Network Connectivity Check
- [ ] Check connectivity to: npmjs.org, docker.io, nodesource.com
- [ ] Use HTTP HEAD requests (don't download anything)
- [ ] Timeout after 5 seconds per host
- [ ] If any fails: Disable auto-fix for that component
- [ ] Clear message: "Network: ✓ npm ✓ docker ✗ nodesource"

### AC8: Secure Auto-Fix Offer
- [ ] When prereq fails, offers to install/upgrade automatically
- [ ] Downloads install script to temp file first (NOT curl | bash)
- [ ] Shows script preview (first 50 lines) before execution
- [ ] Shows exact command that will be run with sudo
- [ ] Requires explicit confirmation: "Run this as root? (y/N)"
- [ ] Default is NO - user must type 'y' to proceed

### AC9: Sudo Permission Flow
- [ ] BEFORE asking to install: Check if sudo is needed
- [ ] Explain WHY sudo is needed ("Need admin to install system package")
- [ ] Show EXACT commands that will use sudo
- [ ] Cache sudo credentials upfront: `sudo -v` before multi-step installs
- [ ] If sudo fails (wrong password): Clear error, exit cleanly
- [ ] If user not in sudoers: Detect and show manual instructions instead

### AC10: Node.js Auto-Install
- [ ] Ubuntu/Debian: NodeSource setup + apt install
- [ ] RHEL/Fedora: NodeSource setup + dnf install
- [ ] Arch Linux: pacman -S nodejs npm
- [ ] macOS: `brew install node@20`
- [ ] ARM/Pi: NodeSource ARM setup
- [ ] Download script to temp file, preview, then execute
- [ ] Verify installation succeeded after running

### AC11: Docker Auto-Install
- [ ] Ubuntu/Debian: Official Docker apt repo setup
- [ ] RHEL/Fedora: Official Docker dnf repo setup
- [ ] Arch Linux: pacman -S docker
- [ ] After install: Add user to docker group
- [ ] After install: Start Docker daemon
- [ ] macOS: Special handling (see AC12)

### AC12: Docker Desktop Flow (macOS)
- [ ] Detect if Docker Desktop is INSTALLED but not RUNNING
- [ ] If installed but stopped: Offer to launch (`open -a Docker`)
- [ ] If not installed: Provide download URL + wait option
- [ ] Show instructions: "Install Docker Desktop, then press Enter"
- [ ] Wait-and-retry loop: Re-check Docker every 5 seconds
- [ ] Timeout after 5 minutes with clear exit message
- [ ] Can also use `brew install --cask docker` if brew available

### AC13: Success Path
- [ ] All checks pass: Show green checkmarks, continue to setup
- [ ] Format: `✓ Node.js v20.11.0 (requires ≥18)`
- [ ] Format: `✓ Docker v24.0.7`
- [ ] Format: `✓ Disk space 50GB free (requires ≥2GB)`

### AC14: Failure Path (No Auto-Fix)
- [ ] User declines auto-fix: Show manual instructions
- [ ] Instructions are platform-specific and copy-pasteable
- [ ] Exit with clear message to re-run setup after fixing

### AC15: Failure Path (Auto-Fix Fails)
- [ ] Auto-fix command fails: Show error output
- [ ] Provide fallback manual instructions
- [ ] Log full error to ~/.claude-phone/prereq-install.log
- [ ] Offer rollback if partial install occurred

### AC16: Rollback on Failure
- [ ] Before making changes: Record current state (versions installed)
- [ ] If auto-fix fails mid-process: Offer to rollback
- [ ] Rollback restores previous package versions where possible
- [ ] Clear message: "Install failed. Rollback changes? (y/N)"
- [ ] If user declines rollback: Save state file for manual recovery

### AC17: Skip Option
- [ ] `claude-phone setup --skip-prereqs` bypasses all checks
- [ ] Shows warning that this may cause issues
- [ ] Useful for advanced users who know what they're doing

### AC18: Idempotent
- [ ] Running setup multiple times doesn't break anything
- [ ] Auto-fix doesn't reinstall if already satisfied
- [ ] Re-running after partial failure recovers gracefully

### AC19: Offline Handling
- [ ] Detect if offline before offering auto-fix
- [ ] If offline, only show manual instructions
- [ ] Clear message: "Auto-fix unavailable (no network)"

## UI/UX Flow

### All Prerequisites Met
```
$ claude-phone setup

🔍 Checking prerequisites...

  ✓ Node.js v20.11.0 (requires ≥18)
  ✓ Docker v24.0.7
  ✓ Docker Compose v2.21.0 (plugin)
  ✓ Disk space 45GB free (requires ≥2GB)
  ✓ Architecture x86_64

✅ All prerequisites met!

📦 Installation Type
? What are you installing?
```

### Node.js Outdated - Auto-Fix Offered
```
$ claude-phone setup

🔍 Checking prerequisites...

  ✗ Node.js v22.22.0 (requires ≥24)
  ✓ Docker v24.0.7
  ✓ Docker Compose v2.21.0 (plugin)
  ✓ Disk space 45GB free (requires ≥2GB)

❌ Prerequisites not met.

Node.js 22.22.0 is below the deployed-service minimum version 24.

? Install Node.js 24 automatically? (y/N) y

The following commands will run with sudo:

  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  # Script preview (first 50 lines):
  # #!/bin/bash
  # ... (script content) ...

  sudo bash /tmp/nodesource_setup.sh
  sudo apt-get install -y nodejs

? Run these commands as root? (y/N) y

[sudo] password for chuck:
Installing Node.js 24...
  ✓ NodeSource repository added
  ✓ Node.js 24.13.0 installed

✅ All prerequisites now met!
```

### macOS Docker Desktop Not Running
```
$ claude-phone setup

🔍 Checking prerequisites...

  ✓ Node.js v24.13.0 (requires ≥24)
  ✗ Docker not running (installed but daemon stopped)

Docker Desktop is installed but not running.

? Launch Docker Desktop? (Y/n) y

Launching Docker Desktop...
Waiting for Docker daemon (timeout 5m)...
  ⠋ Waiting for Docker... (15s)
  ✓ Docker daemon ready!

✅ All prerequisites now met!
```

### macOS Docker Desktop Not Installed
```
$ claude-phone setup

🔍 Checking prerequisites...

  ✓ Node.js v20.11.0 (requires ≥18)
  ✗ Docker not installed

Docker is required but not installed.

? Install Docker Desktop via Homebrew? (y/N) y

Running: brew install --cask docker

  ✓ Docker Desktop installed

? Launch Docker Desktop? (Y/n) y

Launching Docker Desktop...
Waiting for Docker daemon (timeout 5m)...
  ✓ Docker daemon ready!

✅ All prerequisites now met!
```

### User Declines Auto-Fix
```
$ claude-phone setup

🔍 Checking prerequisites...

  ✗ Node.js v22.22.0 (requires ≥24)

? Install Node.js 24 automatically? (y/N) n

To install Node.js 24 manually on Ubuntu/Debian:

  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs

After installing, run 'claude-phone setup' again.
```

## Technical Notes

### File Structure
```
cli/lib/
├── prereqs.js           # Main prerequisite logic
├── prereqs/
│   ├── node.js          # Node.js detection and install
│   ├── docker.js        # Docker detection and install
│   ├── platform.js      # OS/distro/arch detection
│   ├── network.js       # Connectivity checks
│   └── disk.js          # Disk space checks
```

### Key Implementation Details
- Platform detection via `os.platform()`, `os.arch()`, and `/etc/os-release`
- Use `execSync` for version checks (fast, synchronous)
- Use `spawn` for auto-fix with real-time output streaming
- Download scripts to `/tmp/` before executing
- Log all install commands to `~/.claude-phone/prereq-install.log`
- Store pre-install state in `~/.claude-phone/prereq-state.json`

### Security Measures
- NEVER pipe curl directly to bash
- Download install scripts to temp file first
- Show script preview before execution
- Require explicit "y" confirmation (not default yes)
- Double confirmation for sudo operations
- Log all commands executed for audit trail

## Out of Scope
- Windows support (not a target platform)
- Snap/Flatpak package managers
- Version pinning (always install latest LTS)
- Automatic uninstall/downgrade of existing packages
