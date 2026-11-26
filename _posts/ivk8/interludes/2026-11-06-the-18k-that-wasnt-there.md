---
layout: post
title: The 18k that wasn't there
chapter_title: the-18k
show_contact_card: true
no_nav_bar: false
live: true
date: 2026-11-06
tldr: A net-worth forecast based on a moving average passed all 89 tests, and its first screenshot showed a month with far too much salary. Salary and rent for the current month had already been paid, and the forecast added two-thirds of a month's average on top. The fix tops each category up to its average, never below what has already happened.
tags:
  - tag: TypeScript
  - tag: Data Visualization
  - tag: Testing
  - tag: Claude Code
---

## TL;DR
- **Symptom:** a new forecast of net worth passed every test. Its first screenshot showed the current month with far too much salary, and every later month too high, by about 18,000 at the end.
- **Cause:** the current, partial month got two-thirds of each category's monthly average, because two-thirds of the month was left. But salary and rent arrive once, early in the month, and they were already in. The forecast counted most of them twice.
- **Fix:** top each category up to its average for the current month, never below what has already happened. Salary and rent add nothing more. Food and transport add what's left.

*That night, the Projected tab gained a second mode: a forecast from the average of recent months (chapter: Looking forward: the Projected tab). This is what its first picture showed.*

All numbers below come from the synthetic backup the tests use, not from my own data.

## Setup
- **The forecast** starts from today's net worth. It averages each category's income and expense over the last 4 complete months and carries that average forward, month by month, to a chosen end date.
- **I specified it** in one paragraph. Before writing code, Claude Code asked four questions, and I took its recommendation each time:
  - ignore scheduled items, since recurring ones are already in the history;
  - average the last 4 *complete* months;
  - show history and forecast on one chart;
  - make the window a selector, with 4 as the default.
- **The current month is the hard part.** On Oct 11, about a third of October is over. The first version gave the rest of October a share of the average in proportion to the time left:

  ```ts
  const share = (Math.min(end, to) - Math.max(start, asOf)) / (end - start);
  ```

- **The synthetic backup** has a salary on the 1st of each month, rent on the 2nd, and food and transport spread through the month.

## Green tests

The backend report, its tests and the chart came together in under half an hour. All 89 analytics tests passed, and every package typechecked.

The tests checked what they were written to check: the window, the bucket boundaries and the proration arithmetic. Each was right. None of them asked whether proration was the right idea.

## The first picture

The agent then went further than the tests. The dashboard needs a Google sign-in, and there was no recorded way around it. So it put a fake `/api` in front of the real analytics service, loaded the synthetic backup and drove headless Chrome to the Projected tab. The chapter tells that part.

The summary sentence under the chart gave these figures:

| Figure | Value |
|---|---|
| Average monthly income, Jun–Sep | 60,325.00 |
| Average monthly expense, Jun–Sep | 47,537.50 |
| Average monthly net | 12,787.50 |
| Net worth today | 251,550.00 |
| Forecast for 2027-10-10 | 404,606.05 |

Nothing in that table looks wrong on its own. The chart did. October showed about 87,000 of salary, in a month that pays one.

## The mechanism

On Oct 11 at 15:00, about 66% of October was still ahead. The first version gave each category 66% of its monthly average for that remainder.

That's fine for a category that trickles in. Food spent evenly over a month really does have two-thirds of its spending still ahead.

It's wrong for a lump. The salary for October had arrived on the 1st and was already in the month's actual income. Adding 66% of an average salary on top counted most of a second one. Rent did the same on the expense side.

The error didn't stay in October. The net worth line is cumulative, so every later month started from a value that was too high. By the end of the range the forecast was about 18,000 above where it should have been.

## The fix

A category's forecast for the current month is now a top-up to its average, never below what has already happened:

```ts
const topUp = (avg: Amounts, done: Amounts) =>
  Object.fromEntries(Object.entries(avg).map(([id, v]) => [id, Math.max(0, v - (done[id] ?? 0)) * share]));
const rest = { income: topUp(avgIncome, f.income), expense: topUp(avgExpense, f.expense) };
```

- **Salary** already matched its average, so it adds nothing more.
- **Food and transport** add whatever is left between what's happened and their average.
- **A category already over its average** adds zero, not a negative amount. The forecast never takes back money that has moved.
- **`share` is now 1** for every month, the current one included. It only shrinks when the end date cuts a month short, which is the one place time-based proration still makes sense.

The forecast for 2027-10-10 went from 404,606 to 386,875, about 17,700 lower.

## A failing test where the engine was right

The agent wrote new tests for the top-up, and one failed. It was the test for a forecast whose end date falls inside the current month:

```
FAIL  tests/projection.test.ts > projectionReport > cuts the top-up by time when `to` ends inside the current bucket
AssertionError: expected { uncategorized: 198.77 } to deeply equal { uncategorized: 196.32 }
```

The agent checked the test's arithmetic before touching the code. The test ran from Oct 11 15:00 to Oct 21 18:00 and called that 10 days. It's 10.125, and 198.77 is 196.32 × 1.0125.

The engine was right and the test was wrong. It moved the test's end date to exactly 10 days later, and all 89 passed.

## Who caught what

I specified the feature and approved the design. The agent found the flaw, in its own screenshot, before I'd seen anything.

Its summary had a section headed "One change from what we agreed". It described the bug, the fix and the size of the error, in that order.

It could have folded the fix in silently, since nobody else had seen the first version. Saying so let me check the reasoning instead of trusting it. I kept the change.

## A limit it named

About an hour later, after transfers to excluded accounts started counting under their categories, the agent added a caveat. Each flow is averaged on its own. If the same recurring transfer has a category in some months and not in others, it becomes two flows. The current month then gets topped up for both. In the synthetic data that overstated October by about 3,000.

The code still averages flows separately, so that limit is still there. Giving a recurring transfer the same category every month avoids it.

## Takeaways
- **Look at the output, not only the tests.** The tests checked the arithmetic of a wrong idea, and passed.
- **Prorating an average double-counts lumpy flows.** Salary and rent land once, early in the month. Top up to the average instead.
- **A forecast must never forget what has already happened.** Start from the actuals, and only add what's still missing.
- **When a test fails, check the test's arithmetic first.** 10.125 days is not 10.

---

Back to the story: *Looking forward: the Projected tab*. The next interlude, from the same night, is *A transfer is not income*.

*Built with Claude Code as a pair. What I directed, checked and changed is in the story.*

Commits: [`96ac44c`](https://github.com/eyosias-k-negash/ivk8/commit/96ac44c) (the moving-average mode, with the top-up), [`4141e3f`](https://github.com/eyosias-k-negash/ivk8/commit/4141e3f) (the rest of that night's work).
