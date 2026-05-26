#!/bin/bash
set -euo pipefail

echo "==> Installing QMD globally via npm..."
npm install -g @tobilu/qmd

echo "==> Adding Cabinet data directory as QMD collection..."
qmd collection add ~/cabinet/data --name cabinet --mask "**/*.md"

echo "==> Adding context..."
qmd context add qmd://cabinet "Cabinet knowledge base — user notes, documentation, agent configs, conversations"
qmd context add qmd://cabinet/.global-agents "Global agent persona definitions"
qmd context add qmd://cabinet/.agents "Per-cabinet agent configs and conversations"
qmd context add qmd://cabinet/.home "Home/dashboard pages"

echo "==> Generating vector embeddings (may download GGUF models on first run)..."
qmd embed

echo ""
echo "==> Verifying..."
qmd status
qmd search "getting started" -n 3

echo ""
echo "QMD setup complete. Restart the Cabinet daemon to enable semantic search."
