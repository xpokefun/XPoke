# Builds src/data/pokemon.json + types.json from PokeAPI CSVs in data-src/.
import csv, json, os, sys
D = os.path.join(os.path.dirname(__file__), '..', 'data-src')
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'data')
rd = lambda f: list(csv.DictReader(open(os.path.join(D, f + '.csv'))))
sp = {int(r['id']): r for r in rd('pokemon_species')}
types = {int(r['id']): r['identifier'] for r in rd('types') if int(r['id']) < 1000}
pk = {int(r['id']): r for r in rd('pokemon')}
default_of = {int(r['species_id']): int(r['id']) for r in pk.values() if r['is_default'] == '1'}
stats = {}
for r in rd('pokemon_stats'):
    stats.setdefault(int(r['pokemon_id']), {})[int(r['stat_id'])] = int(r['base_stat'])
ptypes = {}
for r in sorted(rd('pokemon_types'), key=lambda r: int(r['slot'])):
    ptypes.setdefault(int(r['pokemon_id']), []).append(types[int(r['type_id'])])
evo = {}
for r in rd('pokemon_evolution'):
    s = int(r['evolved_species_id'])
    lvl = int(r['minimum_level']) if r['minimum_level'] else None
    if s not in evo or (evo[s] is None and lvl):
        evo[s] = lvl

def is_base(r):
    if r['is_baby'] == '1': return False
    e = r['evolves_from_species_id']
    return not e or sp[int(e)]['is_baby'] == '1'

def nice(ident):
    special = {'nidoran-f': 'Nidoran♀', 'nidoran-m': 'Nidoran♂', 'mr-mime': 'Mr. Mime', 'mime-jr': 'Mime Jr.',
               'farfetchd': "Farfetch'd", 'sirfetchd': "Sirfetch'd", 'type-null': 'Type: Null', 'ho-oh': 'Ho-Oh',
               'porygon-z': 'Porygon-Z', 'jangmo-o': 'Jangmo-o', 'hakamo-o': 'Hakamo-o', 'kommo-o': 'Kommo-o',
               'mr-rime': 'Mr. Rime', 'flabebe': 'Flabébé', 'tapu-koko': 'Tapu Koko', 'tapu-lele': 'Tapu Lele',
               'tapu-bulu': 'Tapu Bulu', 'tapu-fini': 'Tapu Fini'}
    return special.get(ident, ident.replace('-', ' ').title())

def mon(pid, sid, name=None, ident=None):
    s = stats[pid]
    return {'id': sid, 'form': pid if pid != sid else None, 'key': ident or sp[sid]['identifier'],
            'name': name or nice(sp[sid]['identifier']), 'types': ptypes[pid],
            'hp': s[1], 'atk': s[2], 'def': s[3], 'spa': s[4], 'spd': s[5], 'spe': s[6]}

species = {}
for sid, r in sp.items():
    if int(r['generation_id']) > 8: continue
    m = mon(default_of[sid], sid)
    m['gen'] = int(r['generation_id'])
    m['legendary'] = r['is_legendary'] == '1'
    m['mythical'] = r['is_mythical'] == '1'
    m['baby'] = r['is_baby'] == '1'
    m['base'] = is_base(r)
    m['captureRate'] = int(r['capture_rate'])
    m['from'] = int(r['evolves_from_species_id']) if r['evolves_from_species_id'] else None
    m['chain'] = int(r['evolution_chain_id'])
    species[sid] = m

# evolution edges; non-level triggers get a level so every evolution is reachable by battling
for sid, m in species.items():
    m['evolvesTo'] = []
for sid, m in sorted(species.items()):
    f = m['from']
    if f and f in species and not species[f]['baby']:
        species[f]['evolvesTo'].append(sid)
def stage(sid):
    m = species[sid]; n = 1
    while m['from'] and not species[m['from']]['baby']:
        n += 1; m = species[m['from']]
    return n
for sid, m in species.items():
    m['stage'] = stage(sid) if not m['baby'] else 0
    if m['from'] and not m['baby'] and not species[m['from']]['baby']:
        lvl = evo.get(sid)
        m['evolveLevel'] = lvl if lvl else (20 if m['stage'] == 2 else 36)
    else:
        m['evolveLevel'] = None

def rarity(m):
    if m['mythical']: return 'mythical'
    if m['legendary']: return 'legendary'
    c = m['captureRate']
    if c <= 45: return 'rare'
    if c <= 120: return 'uncommon'
    return 'common'
for m in species.values():
    m['rarity'] = rarity(m)
    m['bst'] = m['hp'] + m['atk'] + m['def'] + m['spa'] + m['spd'] + m['spe']
    for k in ('captureRate', 'chain'): del m[k]

# forms used by gym leaders
ident = {r['identifier']: int(r['id']) for r in pk.values()}
forms = {}
for key, name in (('houndoom-mega', 'Mega Houndoom'), ('mewtwo-mega-x', 'Mega Mewtwo X')):
    pid = ident[key]; m = mon(pid, int(pk[pid]['species_id']), name, key)
    m['rarity'] = species[m['id']]['rarity']; m['bst'] = sum(m[k] for k in ('hp','atk','def','spa','spd','spe'))
    forms[key] = m

eff = {}
for r in rd('type_efficacy'):
    a, b = types.get(int(r['damage_type_id'])), types.get(int(r['target_type_id']))
    if a and b and r['damage_factor'] != '100':
        eff.setdefault(a, {})[b] = int(r['damage_factor']) / 100

os.makedirs(OUT, exist_ok=True)
json.dump({'species': species, 'forms': forms}, open(os.path.join(OUT, 'pokemon.json'), 'w'), separators=(',', ':'))
json.dump(eff, open(os.path.join(OUT, 'types.json'), 'w'), separators=(',', ':'))
base = [m for m in species.values() if m['base']]
from collections import Counter
print(len(species), 'species,', len(base), 'catchable base forms', Counter(m['rarity'] for m in base))
for n in ('caterpie','bulbasaur','magikarp','pikachu','eevee','slowpoke','haunter'):
    m = next(x for x in species.values() if x['key'] == n)
    print(n, m['stage'], m['evolvesTo'], [species[t]['evolveLevel'] for t in m['evolvesTo']])
