---
layout: post
title: A transfer is not income
chapter_title: transfers
show_contact_card: true
no_nav_bar: false
live: true
date: 2026-11-07
tldr: A personal finance dashboard showed a transfer between two of my own accounts, in different currencies, as income. The rule had been "a transfer counts wherever it changes net worth", and valuing both sides at today's exchange rate leaves a small change. I overruled the rule, and the money rules for every tab now live in one function, moneyFlow.
tags:
  - tag: TypeScript
  - tag: Software Architecture
  - tag: Testing
  - tag: Claude Code
---

<!-- Draft from blog/INTERLUDES.md entry G. Search for TODO before posting; delete this comment too. File: _posts/ivyk8/2026-11-07-a-transfer-is-not-income.md. Sorts after Interlude F (Nov 6) and before chapter `tags` (Nov 8). Times are local (UTC+3); the transcript stores UTC. -->

## TL;DR
- **Symptom:** the Projected tab showed a transfer between two of my own accounts, one in US dollars and one in the base currency, as income.
- **Cause:** a rule the agent had written: transfers count "wherever they change net worth". Both sides of a transfer are valued at today's exchange rate, so a transfer made at an older rate changes net worth by a little. That remainder was drawn as income.
- **Fix:** a transfer between two accounts that both count toward net worth is never income or expense. Twenty minutes later I set the rules for every tab, and they now live in one function, `moneyFlow`.

*The Projected tab had gained a forecast from recent averages that night. An hour earlier, its first screenshot had caught a double-counted salary (Interlude: The 18k that wasn't there).*

## Setup
- **Accounts can be excluded from net worth.** Ivy Wallet lets you leave an account out of the balance, for example a savings account you don't want mixed into spending money.
- **Accounts have their own currency.** Net worth converts every account to the base currency at today's rate, the way the Balances tab does.
- **The Projected tab** draws income above zero and expenses below, with a net worth line on top. The bars are supposed to explain the line.
- **No rule yet said what a transfer is.** The older tabs skipped transfers. The new forecast needed an answer.

## How the rule got there

At 23:23 I gave the first rule of the night: "Every transaction that is going in or out of an account that is marked to be included in the net balance should absolutely count."

Claude Code applied it, and at 23:37 its summary extended it:

> "**Transfers count wherever they change net worth.** Examples are a transfer to an account excluded from the balance, or between currencies that convert differently. These now feed the moving average as flows labelled by their accounts, e.g. 'Transfer Bank → Savings'. Because of that, this mode says 'Money in / Money out' instead of 'Income / Expense'."

The first example was what I meant. The second wasn't, and I didn't catch it. The next two rounds, at 00:03 and 00:32, refined the first example. A transfer to an excluded account is now filed under its category when it has one. The planned mode draws bars only for items that move net worth.

## The symptom

At 00:39, looking at the forecast, I saw a transfer between two included accounts in different currencies, drawn as income. My message quoted the agent's sentence back to it:

> "'Transfers count wherever they change net worth. Examples are a transfer to an account excluded from the balance, or between currencies that convert differently.' -> This from earlier is not correct. … Even though a conversion has happened if a transaction is from two net worth included accounts, it is neither expense or income so should not show up as so in the planned chart or anywhere else for that matter, such as trends tab."

A transfer between my own accounts moves money from one pocket to another. Calling it income was the kind of wrong that makes you stop trusting every other bar.

## The mechanism

Net worth counts each side of a transfer at today's rate. Here's the function that computes how much a transaction moves net worth:

```ts
export function netWorthDelta(ds: Dataset, t: Transaction, rates: RateTable, unconverted: Set<string>): number {
  const side = (accountId: string | null | undefined, amount: number): number => {
    if (!inBalance(ds, accountId)) return 0;
    …
    const v = toBase(amount, currency, ds.baseCurrency, rates);
    …
  };
  if (t.type === 'INCOME') return side(t.accountId, t.amount);
  if (t.type === 'EXPENSE') return -side(t.accountId, t.amount);
  return -side(t.accountId, t.amount) + (t.toAccountId ? side(t.toAccountId, t.toAmount ?? t.amount) : 0);
}
```

Take the case the regression test now uses. Pay 130 in the base currency for 1 USD. If 1 USD is worth 100 today, the transfer's net worth change is −130 + 100 = −30. If the dollar has gained since, the change is positive.

That's a correct number for the line. Net worth really is lower, or higher, because the dollars are worth a different amount today. But it isn't a flow of money in or out. The rule "a transfer counts wherever it changes net worth" turned a change in value into a cash flow, and a positive one was drawn as income.

## Only one tab had it

The agent checked the other reports before fixing anything. Trends, Income & expense and Budgets skipped every transfer, so they were already right about this case. The rule lived only in the Projected tab, and only since that night.

## The fix

A transfer between two included accounts is skipped before anything is drawn, whatever the currencies, and even when it has a category. The agent named the check `isInternalTransfer`. Today it's the first lines of `moneyFlow`, below.

The regression test is the case I saw: a categorized transfer from a base-currency cash account to a USD account, at a rate different from today's. The agent then switched the check off and ran the suite again. Three tests failed. With the check back on, all 90 passed.

A test that still passes without the fix doesn't guard anything, and this one was proven to.

The net worth *line* still moves by the −30, and the agent asked whether it should. It could ignore these transfers too, in one line, at the cost of the forecast disagreeing with the Balances tab whenever rates move. I didn't take that. The line stayed, so "net worth today" is the same number on every tab, and the question joined the open thread at the end of this post.

## One rule for every tab

The agent's summary ended with a question: should the other tabs follow the Projected tab's rules? They still counted income and expense on excluded accounts, and skipped transfers to them. At 00:58 I answered for all of them:

> "Yes, income and expense inside excluded account should always be ignored in any tab. Secondly, Transfers from or to excluded accounts should be considered as notable b/c they affect an included account one way or the other. So yes they should be considered in all tabs."

Four minutes later, the rules lived in one function that every report calls:

```ts
export function moneyFlow(ds: Dataset, t: Transaction, rates: RateTable, unconverted: Set<string>): MoneyFlow | null {
  if (t.type === 'TRANSFER') {
    const fromIn = inBalance(ds, t.accountId);
    if (fromIn === inBalance(ds, t.toAccountId)) return null;
    return fromIn
      ? flowOn(ds, 'out', t.accountId, t.amount, rates, unconverted)
      : flowOn(ds, 'in', t.toAccountId!, t.toAmount ?? t.amount, rates, unconverted);
  }
  if (!inBalance(ds, t.accountId)) return null;
  return flowOn(ds, t.type === 'INCOME' ? 'in' : 'out', t.accountId, t.amount, rates, unconverted);
}
```

In words, and in the plan as decision 11:

- **Income and expense on an excluded account never count.**
- **A transfer between two included accounts never counts,** whatever the currencies. Neither does a transfer between two excluded ones.
- **A transfer to or from an excluded account counts.** Leaving an included account is an expense, and arriving is income. It's filed under its category, or under "Transfer A → B" when it has none.

Income & expense, Trends, Budgets and Projected all call it. In Budgets, a categorized transfer to an excluded account counts as spending, and money coming back doesn't reduce spending.

On the synthetic backup, September changed in three ways. An uncategorized transfer to the excluded savings account appeared as a 6,000 expense. A 7,777 expense on the savings account itself disappeared. Transfers between two included accounts still didn't count.

## Who decided what

The agent wrote the code, the tests and most of the words. The rules are mine.

Its extension at 23:37 was reasonable on its face, since net worth really does change. But it answered an accounting question with an arithmetic one, and the answer was in a sentence I read past. Each later correction became a rule, and the last one became a function.

## Still open

- **The line still moves for internal transfers between currencies,** and no bar explains it.
- **How to value past conversions.** If I bought dollars at 130 and they're worth 100 today, is that a loss to show somewhere, or noise? My words at the time were "We will talk later about how currency conversion should be managed like past conversion and how they affect the current net worth." We haven't yet.

## Takeaways
- **Define the money rules once, in one function, and make every report call it.** Five tabs with five readings of "income" will disagree eventually.
- **A change in value is not a cash flow.** Revaluing a currency moves net worth, and it isn't income.
- **Write the regression test from the bug you saw, then turn the fix off and watch it fail.**
- **Read the agent's summary of the rules, not only of the code.** The wrong rule was stated plainly, one paragraph before the part I was checking.

---

Back to the story: *Looking forward: the Projected tab*. The previous interlude is *The 18k that wasn't there*, and the next chapter is *Tags: one total across categories*.

*Built with Claude Code as a pair. What I directed, checked and changed is in the story.*

Commits: [`96ac44c`](https://github.com/eyosias-k-negash/ivk8/commit/96ac44c) (the Projected tab's rules, committed Oct 12), [`4141e3f`](https://github.com/eyosias-k-negash/ivk8/commit/4141e3f) (`moneyFlow` and the rules for every tab, committed Oct 13).
