#!/bin/bash
set -e
echo "=== QMD CLI ==="
which qmd
qmd --version
echo ""
echo "=== MCP Server Tools List ==="
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | timeout 10 qmd mcp
EXIT=$?
echo ""
echo "=== Exit code: $EXIT ==="
