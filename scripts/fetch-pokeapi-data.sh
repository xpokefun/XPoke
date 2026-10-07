#!/usr/bin/env bash
# Only needed to REBUILD server/src/data/pokemon.json (it is committed). Downloads PokeAPI's CSVs into
# server/data-src, then: python3 server/scripts/build-data.py
set -euo pipefail
mkdir -p "$(dirname "$0")/../server/data-src" && cd "$(dirname "$0")/../server/data-src"
for f in pokemon_species pokemon_evolution pokemon pokemon_stats pokemon_types types type_efficacy; do
  curl -sfLO "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/$f.csv"
done
echo "now run: python3 server/scripts/build-data.py"
