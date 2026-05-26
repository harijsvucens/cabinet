#!/bin/bash
set -euo pipefail

echo "==> Installing QMD globally via npm..."
npm install -g @tobilu/qmd

echo "==> Adding Cabinet directories as QMD collections..."
qmd collection add ~/cabinet/data --name cabinet
qmd collection add ~/cabinet/data/.agents --name cabinet-agents
qmd collection add ~/cabinet/data/.global-agents --name cabinet-global

echo "==> Adding context..."
qmd context add qmd://cabinet "Cabinet knowledge base — user notes, documentation, and home/dashboard pages"
qmd context add qmd://cabinet-global "Global agent persona definitions"
qmd context add qmd://cabinet-agents "Per-cabinet agent configs and conversations"

echo "==> Generating vector embeddings (may download GGUF models on first run)..."
qmd embed

echo ""
echo "==> Verifying..."
qmd status
qmd search "getting started" -n 3

echo ""
echo "QMD setup complete. Restart the Cabinet daemon to enable semantic search."
