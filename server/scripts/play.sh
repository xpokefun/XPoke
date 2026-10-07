#!/bin/bash
# usage: play.sh handle "text"
curl -s localhost:${PORT:-5340}/api/dev/mention -H 'content-type: application/json' -d "$(jq -n --arg h "$1" --arg t "$2" '{handle:$h,text:$t}')" | jq -r '"[\(.status)] @'"$1"': '"$2"' → \(.reply)"'
