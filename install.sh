#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# ContextVolt — One-line installer for macOS / Linux
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Rithvickkr/ContextVolt/master/install.sh | bash
#
# What it does:
#   1. Checks prerequisites (Python 3, git)
#   2. Clones the repo to ~/.contextvolt
#   3. Runs start.sh (creates venv, installs deps, sets up Ollama)
#   4. Creates a 'contextvolt' command so you can launch anytime
# ═══════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

INSTALL_DIR="$HOME/.contextvolt"
REPO_URL="https://github.com/Rithvickkr/ContextVolt.git"

echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║     ${BOLD}ContextVolt Installer${NC}${CYAN}                  ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════╝${NC}"
echo ""

# ─── Step 1: Check Python 3 ─────────────────────────────────────
echo -e "${YELLOW}  [1/4] Checking prerequisites...${NC}"

if ! command -v python3 &> /dev/null; then
    echo -e "${RED}  ✗ Python 3 not found${NC}"
    echo ""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo -e "  Install with Homebrew:"
        echo -e "  ${BOLD}brew install python${NC}"
    else
        echo -e "  Install with:"
        echo -e "  ${BOLD}sudo apt install python3 python3-venv python3-pip${NC}"
    fi
    echo ""
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1)
echo -e "${GREEN}  ✓ $PYTHON_VERSION${NC}"

# Check git
if ! command -v git &> /dev/null; then
    echo -e "${RED}  ✗ git not found${NC}"
    echo ""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo -e "  Install with: ${BOLD}xcode-select --install${NC}"
    else
        echo -e "  Install with: ${BOLD}sudo apt install git${NC}"
    fi
    echo ""
    exit 1
fi
echo -e "${GREEN}  ✓ git$(git --version | sed 's/git version/ /')${NC}"

# ─── Step 2: Clone or update repo ────────────────────────────────
echo ""
echo -e "${YELLOW}  [2/4] Setting up ContextVolt...${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "  Found existing installation at ${BOLD}$INSTALL_DIR${NC}"
    echo -e "  Updating..."
    cd "$INSTALL_DIR"
    git pull --quiet 2>/dev/null || true
else
    echo -e "  Cloning to ${BOLD}$INSTALL_DIR${NC}..."
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo -e "${GREEN}  ✓ ContextVolt files ready${NC}"

# ─── Step 3: Create the 'contextvolt' command ─────────────────────────
echo ""
echo -e "${YELLOW}  [3/4] Creating launch command...${NC}"

# Create a launcher script in a standard bin location
LAUNCHER_SCRIPT="$HOME/.local/bin/contextvolt"
mkdir -p "$HOME/.local/bin"

cat > "$LAUNCHER_SCRIPT" << 'LAUNCHER'
#!/bin/bash
# ContextVolt Launcher
cd "$HOME/.contextvolt"
bash start.sh
LAUNCHER

chmod +x "$LAUNCHER_SCRIPT"
chmod +x "$INSTALL_DIR/start.sh"

# Make sure ~/.local/bin is in PATH
SHELL_PROFILE=""
if [ -f "$HOME/.zshrc" ]; then
    SHELL_PROFILE="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_PROFILE="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_PROFILE="$HOME/.bash_profile"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    # Fresh macOS account: zsh is the default shell since Catalina but no
    # profile exists yet. Create one so the PATH export actually lands.
    touch "$HOME/.zshrc"
    SHELL_PROFILE="$HOME/.zshrc"
fi

if [ -n "$SHELL_PROFILE" ]; then
    if ! grep -q '\.local/bin' "$SHELL_PROFILE" 2>/dev/null; then
        echo '' >> "$SHELL_PROFILE"
        echo '# ContextVolt' >> "$SHELL_PROFILE"
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_PROFILE"
        echo -e "${GREEN}  ✓ Added ~/.local/bin to PATH in $(basename $SHELL_PROFILE)${NC}"
    else
        echo -e "${GREEN}  ✓ ~/.local/bin already in PATH${NC}"
    fi
fi

echo -e "${GREEN}  ✓ 'contextvolt' command created${NC}"

# ─── Step 4: Run first-time setup ────────────────────────────────
echo ""
echo -e "${YELLOW}  [4/4] Running first-time setup...${NC}"
echo ""
echo -e "  ${BOLD}This will:${NC}"
echo -e "  • Create a Python virtual environment"
echo -e "  • Install dependencies (fastapi, pywebview, etc.)"
echo -e "  • Check/install Ollama"
echo -e "  • Download the AI model (~4.7GB)"
echo ""
if [ "${CONTEXTVOLT_CI:-}" = "1" ]; then
    echo -e "  ${CYAN}CONTEXTVOLT_CI=1 — running headless setup${NC}"
else
    echo -e "  ${CYAN}Starting in 3 seconds... (Ctrl+C to skip, run 'contextvolt' later)${NC}"
    sleep 3
fi

cd "$INSTALL_DIR"
bash start.sh

# ─── Done ────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}  ═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ ContextVolt installed successfully!${NC}"
echo ""
echo -e "  ${BOLD}To launch anytime:${NC}"
echo -e "    ${CYAN}contextvolt${NC}"
echo ""
echo -e "  ${BOLD}Or manually:${NC}"
echo -e "    ${CYAN}cd ~/.contextvolt && bash start.sh${NC}"
echo ""
echo -e "  ${BOLD}To update:${NC}"
echo -e "    ${CYAN}cd ~/.contextvolt && git pull${NC}"
echo -e "${GREEN}  ═══════════════════════════════════════════${NC}"
echo ""
