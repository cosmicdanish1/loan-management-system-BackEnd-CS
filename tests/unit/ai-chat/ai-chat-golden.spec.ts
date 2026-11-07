import { KnowledgeService } from '../../../src/modules/ai-chat/knowledge.service';

// Golden question set (ES-438/ES-439): staff questions and the document that must be among the top 3
// passages found. Runs against the real docs, so a doc change or a ranking change that breaks a common
// question fails before release. Skipped on a machine that has no docs folder.
const GOLDEN: Array<[string, string]> = [
  ['how do I run day end', 'guide-day-end'],
  ['what happens if day end fails', 'day-end'],
  ['how to open a new RD account', 'rd-account'],
  ['what is the maximum regular loan limit', 'loan-application-documentation'],
  ['regular loan eligibility rules share value', 'loan-application-documentation'],
  ['how to change the loan surety', 'change-loan-surety-documentation'],
  ['member lost phone cannot sign in 2FA', 'lost_phone_recovery'],
  ['how to reset two factor for a user', 'two-factor-and-approvals-documentation'],
  ['how do I print the cash book', 'daily-reports-documentation'],
  ['defaulter list report', 'monthly-reports-documentation'],
  ['how to transfer balance between members', 'balance-transfer-documentation'],
  ['EMI chart calculation', 'emi-chart-documentation'],
  ['how to add a new member in member master', 'guide-member-master'],
  ['what is saakh score', 'saakh-score-documentation'],
  ['group insurance premium', 'group-insurance-documentation'],
  ['how to change my password', 'change-password-documentation'],
  ['login window license', 'login-window-documentation'],
  ['print vouchers', 'print-vouchers-documentation'],
  ['general ledger report', 'general-ledger-documentation'],
  ['member ledger report', 'member-ledger-report-documentation'],
  ['journal transfer entry', 'journal-transfer-entry-documentation'],
  ['compulsory deposit transaction', 'compulsory-deposit-transaction-documentation'],
  ['pass transactions approval', 'pass-transactions-documentation'],
  ['share certificate printing', 'share-certificate-printing-documentation'],
  ['passbook parameter setting', 'passbook-parameter-setting-documentation'],
  ['scan member signature', 'signature-scanning-documentation'],
  ['wing and office master', 'wing-office-master-documentation'],
  ['cast category master', 'cast-category-documentation'],
  ['designation master', 'designation-master-documentation'],
  ['communication hub send message', 'communication-hub-documentation'],
  ['modify FD account', 'modify-fd-account-documentation'],
  ['modify member balance', 'modify-member-balance-documentation'],
  ['create a new user and rights', 'create-modify-users-documentation'],
  ['role governance default rights', 'role-governance-documentation'],
  ['session timeout logout', 'session-logout-documentation'],
  ['where is the menu for Utility', 'fibe-menu-guide'],
  // staff task guides (ES-441)
  ['cannot perform day end unpass vouchers found', 'guide-day-end'],
  ['who can close the day', 'guide-day-end'],
  ['how to set the next working date', 'guide-day-end'],
  ['emergency loan limit how many times can a member take it', 'guide-loan-lifecycle'],
  ['rd shortfall withheld from loan disbursement', 'guide-loan-lifecycle'],
  ['cash disbursement refused', 'guide-loan-lifecycle'],
  ['how to reject a pending voucher', 'guide-pass-transactions'],
  ['how to edit an existing rd account', 'guide-rd-account-opening'],
];

const OFF_TOPIC = ['what is the weather in Mumbai', 'who won the cricket match', 'write me a poem about the moon', 'bitcoin price today'];

describe('golden question set', () => {
  const kb = new KnowledgeService({ get: () => undefined } as any);
  const loaded = kb.reload().chunks > 0;
  const run = loaded ? it : it.skip;

  run.each(GOLDEN)('"%s" finds %s in the top 3', (question, expected) => {
    const files = kb.search(question, 3).map((h) => h.source);
    expect(files.some((f) => f.includes(expected))).toBe(true);
  });

  run.each(OFF_TOPIC)('off-topic "%s" finds nothing', (question) => {
    expect(kb.search(question, 3)).toEqual([]);
  });
});

describe('staff guides rank first', () => {
  const kb = new KnowledgeService({ get: () => undefined } as any);
  const loaded = kb.reload().chunks > 0;
  const run = loaded ? it : it.skip;
  run.each([
    ['how do I close the day', 'guide-day-end'],
    ['how do I disburse a regular loan', 'guide-loan-lifecycle'],
    ['how do I pass a voucher', 'guide-pass-transactions'],
    ['how do I open an RD account', 'guide-rd-account-opening'],
    ['how do I add a new member in member master', 'guide-member-master'],
  ])('"%s" is answered first by %s', (q, expected) => {
    expect(kb.search(q, 3)[0].source).toContain(expected);
  });
});
