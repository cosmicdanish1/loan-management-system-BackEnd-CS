import json,sys
from collections import Counter
label=sys.argv[1] if len(sys.argv)>1 else 'after-all2'
d=json.load(open(f'pattern-scan-{label}.json'))
act={}
for r in d:
    if float(r['ledger_balance'])>100: act[(r['member_no'],r['loan_type'])]=r
def cause(r):
    led=float(r['ledger_balance']);rec=float(r['record_balance']);lag=float(r['lag_principal'])
    if abs(led-rec)<=10: return '0 match'
    if lag>0 and abs(led-(rec-lag))<=10: return '1 match after netting old-EMI (by design)'
    if rec==0: return '2 record closed, ledger owes'
    if not r['has_schedule']: return '3 no schedule built (flagged/not replayable)'
    if int(r['topups'])>0: return '4 top-up/consolidation amounts differ'
    if int(r['journals'])>0: return '5 journal entries in ledger'
    return '6 other (schedule present)'
if __name__=='__main__':
    tot=Counter(cause(r) for r in act.values())
    for k,v in sorted(tot.items()): print(v,k)
    ks=[k for k in d[0] if k[:1]=='p' and k[1:3].isdigit()]
    for k in ks:
        c=Counter(cause(r)[0] for r in act.values() if r[k])
        print(k[:3],dict(sorted(c.items())), sum(c.values()))
