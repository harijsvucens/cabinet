#!/bin/bash
token=$(cat /home/likkmrl/cabinet/data/.agents/.runtime/daemon-token)
curl -s "http://localhost:4100/search-qmd?q=cups+copenhagen&limit=5" -H "Authorization: Bearer $token" | python3 -m json.tool
