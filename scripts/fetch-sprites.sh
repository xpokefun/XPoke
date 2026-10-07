#!/usr/bin/env bash
# Downloads the Pokémon sprites (normal + shiny, generations 1-8 + the two mega forms the gym leaders use)
# from the PokeAPI sprites repository into web/public/sprites. They are not part of this repository:
# the artwork belongs to Nintendo / Creatures / GAME FREAK.
set -euo pipefail
cd "$(dirname "$0")/../web/public"
mkdir -p sprites/shiny
cd sprites
(for i in $(seq 1 905) 10043 10048; do echo "$i.png"; echo "shiny/$i.png"; done) |
  xargs -P 16 -I{} sh -c 'test -s {} || curl -sfL -o {} "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{}" || echo "failed: {}"'
echo "sprites: $(ls | grep -c png) normal, $(ls shiny | wc -l | tr -d ' ') shiny"
