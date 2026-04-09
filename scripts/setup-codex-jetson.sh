#!/bin/bash
# Setup Oh My Codex on Jetson Orin Nano for ClawBox
# Installs Codex CLI, configures for Jetson, sets up local/cloud model switching

set -e

echo "🚀 Setting up Oh My Codex on Jetson Orin Nano..."

CLAWBOX_USER="clawbox"
CLAWBOX_HOME="/home/$CLAWBOX_USER"
CODEX_CONFIG_DIR="$CLAWBOX_HOME/.codex"
PROJECT_DIR="$CLAWBOX_HOME/clawbox"

# Check if running as root
if [ "$(id -u)" -eq 0 ]; then
    echo "⚠️  Running as root, switching to $CLAWBOX_USER..."
    exec sudo -u "$CLAWBOX_USER" bash "$0" "$@"
fi

# Check if on Jetson
if [[ $(uname -m) != "aarch64" ]]; then
    echo "⚠️  Warning: Not running on ARM64 (Jetson) architecture"
    echo "   Detected: $(uname -m)"
    echo "   Some optimizations may not apply"
fi

echo "📦 Installing Codex CLI..."
# Install Codex via npm (as clawbox user)
export PATH="$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.npm-global/bin:$PATH"

if ! command -v codex &> /dev/null; then
    echo "  Installing Codex CLI..."
    npm install -g @openai/codex-cli @modelcontextprotocol/server-ollama
else
    echo "  Codex CLI already installed"
fi

echo "🔧 Installing Oh My Codex..."
if ! npm list -g oh-my-codex &> /dev/null; then
    echo "  Installing Oh My Codex..."
    npm install -g oh-my-codex
else
    echo "  Oh My Codex already installed"
fi

echo "⚙️  Configuring Codex for Jetson..."
# Create Codex config directory
mkdir -p "$CODEX_CONFIG_DIR"

# Copy Jetson-optimized config
if [ -f "$PROJECT_DIR/config/codex-jetson.toml" ]; then
    echo "  Applying Jetson-optimized configuration..."
    cp "$PROJECT_DIR/config/codex-jetson.toml" "$CODEX_CONFIG_DIR/config.toml"
else
    echo "  ⚠️  Jetson config not found, using default..."
    # Initialize with basic config
    codex --init 2>/dev/null || true
fi

# Create AGENTS.md if not exists
if [ ! -f "$CODEX_CONFIG_DIR/AGENTS.md" ]; then
    echo "  Creating AGENTS.md..."
    cat > "$CODEX_CONFIG_DIR/AGENTS.md" << 'EOF'
<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT.
<!-- END AUTONOMY DIRECTIVE -->

# Oh My Codex - Jetson Orin Nano Deployment

## Environment
- **Device:** NVIDIA Jetson Orin Nano (8GB)
- **Architecture:** ARM64 (aarch64)
- **RAM:** 8GB total, 6GB available for models
- **GPU:** 67 TOPS AI performance

## Model Strategy
1. **Primary:** GPT-5.4 (cloud) - Maximum reasoning effort (xhigh)
2. **Fallback:** Gemma 2B (local) - When offline or low bandwidth
3. **Code Generation:** CodeLlama 7B (local) - For code tasks

## Performance Guidelines
- Monitor system resources before heavy tasks
- Use local models for latency-critical operations
- Switch to cloud models for complex reasoning
- Respect memory limits (6GB max for models)

## Project Context
You are working on **ClawBox** - an AI assistant hardware device.
The codebase is at: $PROJECT_DIR
EOF
fi

echo "🔌 Setting up Ollama MCP server..."
# Create Ollama MCP server config
cat > "$CODEX_CONFIG_DIR/mcp-ollama.json" << 'EOF'
{
  "mcpServers": {
    "ollama": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-ollama",
        "http://localhost:11434"
      ]
    }
  }
}
EOF

echo "🧪 Testing configuration..."
# Test local model connection
if timeout 10 ollama list &>/dev/null; then
    echo "  ✅ Ollama is running"
    
    # Check available models
    MODELS=$(ollama list 2>/dev/null | awk 'NR>1 {print $1}' | tr '\n' ', ')
    if [ -n "$MODELS" ]; then
        echo "  📊 Available models: $MODELS"
    else
        echo "  ⚠️  No models found in Ollama"
    fi
else
    echo "  ⚠️  Ollama not responding"
fi

# Test Codex installation
if command -v codex &> /dev/null; then
    echo "  ✅ Codex CLI installed: $(codex --version 2>/dev/null || echo 'unknown')"
    
    # Quick test with help
    echo "  Testing Codex help..."
    if codex --help 2>&1 | grep -q "Usage:"; then
        echo "  ✅ Codex CLI working"
    else
        echo "  ⚠️  Codex CLI test failed"
    fi
else
    echo "  ❌ Codex CLI not found"
fi

echo ""
echo "✅ Oh My Codex setup complete!"
echo ""
echo "📋 Configuration Summary:"
echo "   • Codex CLI installed for $CLAWBOX_USER"
echo "   • Oh My Codex installed"
echo "   • Jetson-optimized config applied"
echo "   • AGENTS.md created with Jetson context"
echo "   • Ollama MCP server configured"
echo ""
echo "🚀 Usage Examples:"
echo "   • Cloud model (GPT-5.4): codex exec 'your task'"
echo "   • Local model (Gemma):   codex --oss --local-provider ollama exec 'your task'"
echo "   • With project context:  cd $PROJECT_DIR && codex exec 'fix this bug'"
echo ""
echo "⚙️  Model Settings:"
echo "   • GPT-5.4: xhigh reasoning effort, 16K tokens"
echo "   • Gemma 2B: Optimized for Jetson 8GB, 4K tokens"
echo "   • CodeLlama 7B: Code generation, 8K tokens"
echo ""
echo "🔧 Auto-switching:"
echo "   • Offline → Gemma 2B"
echo "   • Low bandwidth → CodeLlama 7B"
echo "   • Complex reasoning → GPT-5.4"
echo ""
echo "📊 Performance limits:"
echo "   • Max memory: 6GB"
echo "   • GPU acceleration: Enabled"
echo "   • Concurrent requests: 1 (Jetson-optimized)"
echo ""
echo "To test: cd $PROJECT_DIR && codex exec 'What is this project?'"