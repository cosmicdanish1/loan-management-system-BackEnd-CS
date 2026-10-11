import json,re,sys,io
from collections import Counter,defaultdict
sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')
label=sys.argv[1]; flaglog=sys.argv[2]
sys.argv=['x']; sys.path.insert(0,'..')
import _cause_scan as cs
cs.d=json.load(open(f'pattern-scan-{label}.json'))
S=set(open('sample50-members.txt').read().split())
rows={}
for r in cs.d:
    if r['member_no'] in S and float(r['ledger_balance'])>100: rows[(r['member_no'],r['loan_type'])]=r
flags=defaultdict(list)
t=open(flaglog,encoding='utf8').read(); i=t.find('--- Flags')
for l in t[i:].splitlines():
    m=re.match(r'^\[(\d+)\]\s+(.*)$',l.strip())
    if m and 'invalid loan_amt' not in m.group(2): flags[m.group(1)].append(m.group(2))
ks=[k for k in cs.d[0] if k[:1]=='p' and k[1:3].isdigit()]
print('ACTIVE LOANS IN SAMPLE',len(rows),'members',len({k[0] for k in rows}))
print('--- by pattern (match / total)')
for k in ks:
    rr=[r for r in rows.values() if r[k]]
    print(k[:3],sum(1 for r in rr if cs.cause(r)[0]=='0'),'/',len(rr), dict(Counter(cs.cause(r)[0] for r in rr if cs.cause(r)[0]!='0')))
print('--- not matching')
for k,r in sorted(rows.items()):
    ca=cs.cause(r)
    if ca[0] not in '01':
        fl=[re.sub(r'\s+',' ',f)[:70] for f in flags[k[0]]][:1]
        print(k,r['loan_case'],ca[:2],'led',r['ledger_balance'],'rec',r['record_balance'],'lag',r['lag_principal'],fl)
