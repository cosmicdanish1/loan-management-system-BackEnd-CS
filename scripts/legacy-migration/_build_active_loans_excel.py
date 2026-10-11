"""
Adds / refreshes two sheets in THE one workbook (Migration_Pattern_Register_current.xlsx):
  'Active loans'          - every active loan account of the legacy MSSQL, its verdict BEFORE migration, whether it was migrated, and the
                            result of the check AFTER migration (PERFECT / PROBLEM)
  'Active loans summary'  - counts
Usage: python _build_active_loans_excel.py [final-label]      (final-label = active-final-<label>.json written by _active_final_check.js)
"""
import json, os, sys
from collections import Counter
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, 'reports')
XLSX = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'docs', 'final-documentation', 'loan_slot_consolidation', 'Migration_Pattern_Register_current.xlsx'))
label = sys.argv[1] if len(sys.argv) > 1 else None

cls = json.load(open(os.path.join(R, 'active-classification.json'), encoding='utf8'))
migrated = set()
mf = os.path.join(R, 'active-members-migrated.txt')
if os.path.exists(mf):
    migrated = {l.strip() for l in open(mf) if l.strip()}
fin = {}
for lb in (label.split(',') if label else []):          # later labels override earlier ones (re-checks after a fix)
    fp = os.path.join(R, f'active-final-{lb}.json')
    if os.path.exists(fp):
        for x in json.load(open(fp, encoding='utf8')):
            fin[(x['member'], x['head'])] = x

# outcome sanity test (closure amount etc.) - worst loan per member + loan type
sanity = {}
sf = os.path.join(R, 'outcome-sanity-active-clean.json')
if os.path.exists(sf):
    for x in json.load(open(sf, encoding='utf8')):
        k = (x['member'], x['loanType'])
        if k not in sanity or (x.get('verdict') == 'REVIEW' and sanity[k].get('verdict') != 'REVIEW') or (x.get('closure') or 0) > (sanity[k].get('closure') or 0) and x.get('verdict') == sanity[k].get('verdict'):
            sanity[k] = x

wb = load_workbook(XLSX)
for n in ('Active loans', 'Active loans summary'):
    if n in wb.sheetnames:
        del wb[n]
ws = wb.create_sheet('Active loans', 0)
hdr = ['Member ID', 'Member name', 'Loan type', 'Latest loan case', 'Ledger closing (legacy MSSQL)', 'Ledger rows', 'Last ledger entry',
       'Verdict before migration', 'Reasons (before migration)', 'Migrated?', 'Result after migration', 'Loan record balance (new)', 'Details after migration',
       'Outcome sanity test', 'Early-closure amount today', 'Closure / principal', 'Instalments behind', 'Months since last payment', 'Sanity reasons']
ws.append(hdr)
HF = PatternFill('solid', fgColor='1F3864')
for c in ws[1]:
    c.fill, c.font = HF, Font(bold=True, color='FFFFFF')
    c.alignment = Alignment(wrap_text=True, vertical='center')
FILL = {'CLEAN': 'C6EFCE', 'TO CONFIRM': 'FFEB9C', 'MANUAL': 'FFC7CE', 'PERFECT': 'C6EFCE', 'PROBLEM': 'FFC7CE', 'OK': 'C6EFCE', 'REVIEW': 'FFEB9C', 'ERROR': 'FFC7CE'}
for a in cls:
    k = (a['member'], a['head'])
    f = fin.get(k)
    mig = 'Yes' if a['member'] in migrated else 'No'
    res = ''
    if mig == 'Yes':
        res = f['status'] if f else 'NOT CHECKED'
    ws.append([int(a['member']), a['name'], a['head'], a['latestCase'], a['closing'], a['ledgerRows'], a['lastEntry'], a['verdict'], '; '.join(a['reasons']),
               mig, res, f['recordBalance'] if f and mig == 'Yes' else '', '; '.join(f['issues']) if f and mig == 'Yes' else '',
               *((lambda z: [z.get('verdict', ''), z.get('closure', ''), z.get('ratio', ''), z.get('instalmentsBehind', ''), z.get('silentMonths', ''), '; '.join(z.get('reasons', []))])(sanity.get(k, {})) if mig == 'Yes' else ['', '', '', '', '', ''])])
for row in ws.iter_rows(min_row=2):
    for idx in (7, 10, 13):
        v = row[idx].value
        if v in FILL:
            row[idx].fill = PatternFill('solid', fgColor=FILL[v])
    row[8].alignment = Alignment(wrap_text=True, vertical='top')
    row[12].alignment = Alignment(wrap_text=True, vertical='top')
    row[18].alignment = Alignment(wrap_text=True, vertical='top')
for i, w in enumerate([12, 26, 9, 12, 16, 9, 13, 16, 70, 10, 16, 16, 70, 14, 16, 12, 12, 14, 60], 1):
    ws.column_dimensions[get_column_letter(i)].width = w
ws.freeze_panes = 'A2'
ws.auto_filter.ref = ws.dimensions

sm = wb.create_sheet('Active loans summary', 1)
vc = Counter(a['verdict'] for a in cls)
members = {}
for a in cls:
    members.setdefault(a['member'], a['verdict'])
mv = Counter(members.values())
rows = [['Active loan accounts in the legacy MSSQL (ledger closing balance above Rs 100, opening balance counted once)', len(cls)],
        ['Members with an active loan', len(members)],
        ['Emergency loans (ALN)', sum(1 for a in cls if a['head'] == 'ALN')], ['Regular loans (RLN)', sum(1 for a in cls if a['head'] == 'RLN')], [],
        ['VERDICT BEFORE MIGRATION (accounts)', ''], ['CLEAN', vc['CLEAN']], ['TO CONFIRM', vc['TO CONFIRM']], ['MANUAL', vc['MANUAL']], [],
        ['VERDICT BEFORE MIGRATION (members)', ''], ['CLEAN', mv['CLEAN']], ['TO CONFIRM', mv['TO CONFIRM']], ['MANUAL', mv['MANUAL']], []]
if migrated:
    mig_acc = [a for a in cls if a['member'] in migrated]
    rc = Counter((fin.get((a['member'], a['head'])) or {}).get('status', 'NOT CHECKED') for a in mig_acc)
    rows += [['MIGRATED CLEAN LOANS - RESULT AFTER MIGRATION (accounts)', ''], ['Accounts migrated', len(mig_acc)], ['PERFECT', rc['PERFECT']], ['PROBLEM', rc['PROBLEM']], ['NOT CHECKED', rc['NOT CHECKED']], []]
    kinds = Counter()
    for a in mig_acc:
        f = fin.get((a['member'], a['head']))
        if f:
            for i in f['issues']:
                kinds[i.split(':')[0][:70]] += 1
    if sanity:
        sc = Counter(v.get('verdict') for k, v in sanity.items() if k[0] in migrated)
        rows += [['OUTCOME SANITY TEST ON MIGRATED CLEAN LOANS (member + loan type)', ''], ['OK', sc['OK']], ['REVIEW (closure > 1.5 x principal, 6+ instalments behind, 12+ months silent, penalty > principal)', sc['REVIEW']], ['ERROR', sc['ERROR']], []]
    if kinds:
        rows.append(['Problems found after migration (what)', 'Accounts'])
        rows += [[k, n] for k, n in kinds.most_common()]
        rows.append([])
reasons = Counter()
for a in cls:
    if a['verdict'] != 'CLEAN':
        for r in a['reasons']:
            import re
            reasons[re.sub(r'\d+(, \d+)*', '#', r)[:100]] += 1
rows += [['REASONS A LOAN IS NOT CLEAN (accounts, a loan can have several)', 'Accounts']] + [[k, n] for k, n in reasons.most_common()]
for r in rows:
    sm.append(r)
sm.column_dimensions['A'].width = 110
sm.column_dimensions['B'].width = 12
for row in sm.iter_rows():
    if row[0].value and str(row[0].value).isupper() or (row[0].value and str(row[0].value).startswith(('VERDICT', 'MIGRATED', 'REASONS'))):
        row[0].font = Font(bold=True)
wb.save(os.environ.get('XLSX_OUT', XLSX))
print('saved', XLSX, 'accounts', len(cls), dict(vc), 'migrated members', len(migrated))
