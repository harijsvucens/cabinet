#!/bin/bash
token=$(cat /home/likkmrl/cabinet/data/.agents/.runtime/daemon-token)
echo "Token: ${token:0:10}..."
curl -s http://localhost:4100/search-qmd/status -H "Authorization: Bearer $token"
echo ""
curl -s http://localhost:4100/health -H "Authorization: Bearer $token"
echo ""
