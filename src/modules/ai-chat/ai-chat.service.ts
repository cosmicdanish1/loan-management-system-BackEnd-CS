import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const SYSTEM_PROMPT = `You are FIBE Assistant — the ONLY AI helper for the FIBE Credit Society Management System, developed by Paper White Technology (PWT).

## STRICT RULES
1. You MUST ONLY answer questions about this FIBE application, its features, menus, and how to use them.
2. You MUST ONLY talk about Paper White Technology (PWT) as the company/developer.
3. If someone asks about ANYTHING unrelated to this app or PWT — politics, general knowledge, coding help, other software, personal questions, jokes, stories, math, science, history, weather, news — you MUST politely refuse and say: "I can only help with FIBE Credit Society application and Paper White Technology related queries. Please ask me about how to use a feature, find a menu, or any app-related question!"
4. NEVER answer general AI questions. NEVER act as a general chatbot. You are ONLY the FIBE app assistant.
5. If asked "who made you" or "who are you" — say you were created by Paper White Technology for the FIBE Credit Society Management System.

## About Paper White Technology (PWT)
- Full name: Paper White Technology
- Product: FIBE — Credit Society Management System
- Platform: Desktop application (Electron)
- Purpose: Complete management of Credit Cooperative Societies — members, loans, deposits, accounting, regulatory reporting

## Application Overview
Desktop application for managing a Credit Cooperative Society — members, loans, deposits (FD/RD/SB), accounting, and regulatory reporting.

## Main Menu Structure

### File Menu
Save (Ctrl+S), Cancel (Ctrl+C), Delete (Ctrl+D), Refresh (Ctrl+R), Print (Ctrl+P), Find (Ctrl+F), Exit (Ctrl+X)

### Administration
- Loan: Loan Application, Change Loan Surety, Interest Calculation/Posting
- DayEnd Processing, Interest Calculation
- Deposit/Loan Slab Configuration
- Head Addition/Modification, Head Opening Balance
- Security: Create/Modify Users, UserLevel Default Rights, Change Password, Logout User
- Financial Year: Transfer Entries for Closing, Financial Year Closing, Balance Transfer
- Saakh Score (Member Health), Modify Business Rules
- Certificate Setting: Certificate Parameter, FD Certificate Printing, Share Certificate Printing, Passbook Parameter

### Masters
- Member Master (add/edit member details), Signature Scanning
- RD Account: Opening, Pass RD A/C
- Saving A/c Opening, Wing/Office Master
- Modify FD Account, Modify Member Balance
- Cast Category, Designation Master
- Data Entry: FD/RD/SB Entry, Loan Entry

### Transaction
- Receipt & Payment: Payment Voucher, Voucher Payment, Receipt, Dividend Payment
- Fixed Deposit: FD Receipt, FD/Interest Voucher Posting, FD Withdrawal/Interest Payment
- Saving (Receipt/Payment), Journal/Transfer Entry
- Loan Payment, Loan Repayment, Compulsory Deposit Transaction
- Pass Transactions
- Demand/Recovery: Import Demand List, Generate, Updation/Ledger Posting, Print Members Demand, Change Member Office, Modify Short Recovery

### Reports
- Daily: Cash-Book, Day-Book, Day-Book [SB], Consolidation of Daily A/c
- Member Ledger Report, General Ledger
- Monthly: Print Vouchers, Cash Book Monthly, Detail Ledger, Bank Detail Ledger, Defaulter List, New Loan Disbursed, Member Loan Ledger
- Yearly: P&L/Balance Sheet, Voters/Withdrawal List, Interest List, Member Loan Detail, Share Warrant, Annual Member Statement
- Member Detail Ledger, Account Balance
- Member Statement: Saving/RD/FD Statement, New Share Certificate, Interest Certificate, Loan Nil Certificate
- Surety Register, Deposit Due Date Register
- Account Reports: Account Closing Register, FD Certificate, Share Certificate, Recurring Details, Recovery Details, Loan Contributions Register, Lien Account Information
- Pass Book Printing

### Utility
- Premature Information (RD/SB), Calculator, Find (F2), Member Balance (F3)
- EMI Chart, Database Backup, Update Saving Interest
- Interest Receivable/Received Statement, Communication Hub

### Keyboard Shortcuts
F2: Find & Search, F3: Member Balance

## How to Answer
- Answer in clear, concise Hindi-English mix language (the way Indian office staff speak)
- Keep answers under 150 words unless detailed steps are needed
- Always tell WHERE to find the feature: Menu > Submenu > Option
- For financial questions, give general guidance but remind to verify with their accountant
- Be friendly, professional, and helpful
- If you don't know something specific to their society's data, say so
- Always sign off responses about PWT with pride — "Powered by Paper White Technology"`;

// API keys come ONLY from .env (GEMINI_API_KEYS, GROQ_API_KEY, TOGETHER_API_KEY).
// Never hardcode keys here — this file is committed to git, and any key that
// lands in history must be treated as leaked and rotated.

const FALLBACK_MESSAGES = [
  'Even AI needs a chai break sometimes! Please try again in a moment. ☕ — Paper White Technology',
  'All our AI assistants are busy counting society deposits. Try again shortly! — PWT',
  'The AI went to check the ledger and got lost in the numbers. Try again! — Paper White Technology',
  'Our digital assistant is currently attending a society meeting. Back soon! — PWT',
  'Error 418: I\'m a teapot, not a calculator. (But seriously, try again!) — Paper White Technology',
  'The AI is currently on a lunch break. Even bots need to recharge! — PWT',
  'Looks like all the servers are busy processing loan applications. Try again! — Paper White Technology',
  'The AI got confused between debit and credit. Give it a moment! — PWT',
  'Our assistant is updating its passbook. Will be back in a jiffy! — Paper White Technology',
  'Server is on strike — demands better bandwidth and more RAM! — PWT',
  'Error 402: Danish\'s daily pocket money ran out. Server is on strike... — Paper White Technology',
  'AI assistant is busy filing annual returns. Please hold! — PWT',
];

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private geminiKeys: string[];
  private geminiKeyIndex = 0;
  private groqKey: string;
  private togetherKey: string;

  constructor(private configService: ConfigService) {
    this.geminiKeys = (configService.get<string>('GEMINI_API_KEYS') || '').split(',').map(k => k.trim()).filter(Boolean);
    this.groqKey = configService.get<string>('GROQ_API_KEY') || '';
    this.togetherKey = configService.get<string>('TOGETHER_API_KEY') || '';
    if (this.geminiKeys.length === 0 && !this.groqKey && !this.togetherKey) {
      this.logger.warn('No AI provider keys configured — AI chat will reply with a "not configured" message.');
    }
  }

  async chat(messages: Array<{ role: string; content: string }>): Promise<{ reply: string; provider: string }> {
    // No keys configured (e.g. fresh install) — answer gracefully instead of erroring
    if (this.geminiKeys.length === 0 && !this.groqKey && !this.togetherKey) {
      return {
        reply: 'The AI assistant is not configured on this server yet. Ask your administrator to add AI provider keys in the backend .env file. — Paper White Technology',
        provider: 'none',
      };
    }

    const trimmed = messages.slice(-15);

    // Stage 1: Gemini (rotate keys)
    for (let i = 0; i < this.geminiKeys.length; i++) {
      try {
        const keyIdx = (this.geminiKeyIndex + i) % this.geminiKeys.length;
        const reply = await this.tryGemini(trimmed, this.geminiKeys[keyIdx]);
        this.geminiKeyIndex = (keyIdx + 1) % this.geminiKeys.length;
        return { reply, provider: 'gemini' };
      } catch (err) {
        this.logger.warn(`Gemini key ${i + 1} failed: ${err.message}`);
      }
    }

    // Stage 2: Groq (Llama 3.3 70B)
    if (this.groqKey) {
      try {
        const reply = await this.tryOpenAICompatible(
          'https://api.groq.com/openai/v1/chat/completions',
          this.groqKey,
          'llama-3.3-70b-versatile',
          trimmed,
        );
        return { reply, provider: 'groq' };
      } catch (err) {
        this.logger.warn(`Groq failed: ${err.message}`);
      }
    }

    // Stage 3: Together AI (Llama 3.3 70B Instruct Turbo)
    if (this.togetherKey) {
      try {
        const reply = await this.tryOpenAICompatible(
          'https://api.together.xyz/v1/chat/completions',
          this.togetherKey,
          'meta-llama/Llama-3.3-70B-Instruct-Turbo',
          trimmed,
        );
        return { reply, provider: 'together' };
      } catch (err) {
        this.logger.warn(`Together AI failed: ${err.message}`);
      }
    }

    // Stage 4: Funny fallback
    const fallback = FALLBACK_MESSAGES[Math.floor(Math.random() * FALLBACK_MESSAGES.length)];
    return { reply: fallback, provider: 'fallback' };
  }

  private async tryGemini(messages: Array<{ role: string; content: string }>, apiKey: string): Promise<string> {
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty Gemini response');
    return text;
  }

  private async tryOpenAICompatible(
    url: string,
    apiKey: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        temperature: 0.7,
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) throw new Error(`${model} ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response');
    return text;
  }
}
