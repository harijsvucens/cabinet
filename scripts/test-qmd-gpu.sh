#!/bin/bash
TOKEN_FILE="/home/likkmrl/cabinet/data/.agents/.runtime/daemon-token"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE")
else
  echo "No token found"
  exit 1
fi
echo "Token: ${TOKEN:0:8}..."
echo "---"
echo "Querying QMD search..."
curl -v -s --max-time 90 -H "Authorization: Bearer $TOKEN" 'http://localhost:4100/search-qmd?q=concrete+villa&limit=5&rerank=false'
echo ""
echo "--- Done ---"
