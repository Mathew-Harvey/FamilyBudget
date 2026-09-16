# Changing what we do, not just knowing what we did

This app got good at working out what is true before it got any good at making
anyone act on it. Those are different problems. This document is the reasoning
behind `src/behaviour.js` and the Today page, including the things deliberately
not built, so that a later session does not "improve" this into something worse.

The brief for it was blunt: marketers manipulate people for a living, so work
out how that is done and point it the other way. That is a fair question and it
has a real answer, but it needs one distinction made first, because the
distinction is what decides which techniques are usable here.

## The distinction that matters

Persuasion techniques divide into two kinds by their mechanism.

**Some work by making a true thing vivid.** A cost you had not noticed, a
consequence you had not pictured, a deadline that is genuinely coming. These
work because you were missing information or missing its weight, and afterwards
you are better informed. If you saw exactly how the technique worked, it would
still work, and you would be glad it was used.

**Others work by making a false thing feel true.** Invented scarcity, a
countdown to nothing, a discount from a price nobody paid, a default you did not
notice agreeing to. These work because you were misled, and they stop working the
moment you see the mechanism.

Marketers use both. Only the first kind is available here, and not mainly for
reasons of principle. This app's entire value is that its numbers can be
trusted. A budget you suspect of shading the figures to get a reaction out of
you is worth less than no budget, because you would then have to go and check
the bank anyway. The first false number would cost more than every behavioural
gain put together. Honesty here is the self interested choice as well as the
right one.

So: every technique below works by making something true land harder. None of
them require a number to be bent, and if one ever does, it goes.

## What is actually used

### A date, not a number of days

The runway used to read "68 days". It now reads **23 November**, in the largest
type on the page, with the day count underneath as a footnote.

"68 days" is an abstraction that requires you to do arithmetic before it means
anything. "23 November" lands against a calendar you already have in your head:
it is after Mat's birthday, before Christmas, three weeks after the school
holidays. It collides with plans that already exist. That collision is the whole
point, and nothing about it is untrue: it is the same number, expressed in the
units a person actually thinks in.

### The year, next to the month

Subscriptions are priced monthly because a small monthly number is easy to agree
to. That framing is not an accident and it is not neutral: it is the single most
effective piece of consumer persuasion in routine use, and it works on everyone.

So the Today page prints the **annual** cost in the loud position and the monthly
cost in the quiet one. Not new information, just the same fact in the frame that
was being kept from you.

This household is paying for twenty two separate things at under sixty dollars a
month each. Individually every one of them is obviously fine. Together they are
**$5,083 a year**.

### The price of things in days

With more going out than coming in, the scarce resource is time, not money. So
every recurring cost also shows what stopping it buys back: Cursor is $3,871 a
year, which is **3.3 days**.

The arithmetic matters here and the first version got it wrong. The gain is not
linear:

    days gained = balance / (gap - saving) - balance / gap

Small economies do very little on their own, and several of them together do
considerably more than the sum of their parts, because the saving is being
subtracted from the denominator. That is the true shape of it and it is worth
seeing rather than being told, which is why the page lets you tick several
things and watch the date move rather than printing a league table of savings.

### Credit before criticism

The "Did it stick?" section leads with what was cut, then with what came back.

This is not softening the blow, and it is not a trick. On this household the
cuts were the larger number: $3,601 a month came out of discretionary spending
after the second income stopped, and $744 a month came back, almost all of it at
Bunnings. Leading with the failure would have been a **less accurate** summary
as well as a more discouraging one.

It is also the only version that gets read twice. A page that opens by telling
someone their effort failed is a page they stop opening, and a budgeting tool
nobody opens has no effect on anything at all. Any behavioural design that
ignores whether the thing gets used again is measuring the wrong thing.

### Measuring the decision, not the intention

Everyone who decides to spend less believes they subsequently spent less. This
is close to universal and it is not dishonesty, it is that the decision is
memorable and the hundred small departures from it are not.

So the app compares the rate before and after the date the household changed
shape, and reports the answer whichever way it falls. The comparison excludes
regular commitments, for a reason worth keeping: a fortnightly mortgage falls a
different number of times per day in a 56 day window than in a 180 day one, so
comparing the two windows raw made the mortgage appear to rise by over a
thousand a month when nothing about it had changed. A single annual insurance
payment did the same thing to "health spending". Both are now excluded and
listed separately as what they are, which is money that really left, but not
evidence of a change in habit.

That correction was not a nicety. A page that told this household their mortgage
had gone up by $1,289 a month would have been wrong, would have been obviously
wrong to them, and would have cost the page its credibility permanently.

### A decision with a "when" attached

"We should spend less on takeaway" changes nothing. A decision paired with the
specific situation that triggers it is acted on far more often than the same
decision on its own, and the difference is large enough to be worth building
around.

So the Decisions box asks for two things: what will change, and **when exactly**.
"No delivery on weeknights, we cook what is in the fridge" is a plan. "Spend
less on takeaway" is a mood.

### Checking the decision against the bank, not against a tick box

An intention can name a merchant. If it does, the app reports whether the
charges actually stopped, by looking at the transactions. If it does not, the
app says "nothing to check it against" rather than showing a green tick.

A tick box records what someone intended. The transactions record what happened.
Presenting the first as though it were the second would be the exact failure
this document exists to prevent.

## What is deliberately not built

**Nothing is ever attributed to a person.** The data would easily support "Skye
spent $340 on X" and the app will not do it. Two people share this. The instant
it becomes evidence in an argument it stops being a budget, and one of them
stops opening it. Spending is attributed to categories and to places, which is
also where the decisions actually live.

**No variable rewards.** No streaks that reset, no surprise congratulations, no
mechanic borrowed from a slot machine. These work, which is the problem: they
work by attaching compulsion to the app rather than attention to the money, and
the failure mode is someone opening a budgeting app forty times a day while
their spending does not change.

**No invented urgency.** Every date on the Today page is a real date computed
from the real balance. No countdowns to nothing, no artificial deadlines, no
"act now".

**No shame, and no punishment for a bad month.** Shame reliably produces
avoidance, and avoidance of a budgeting app is the precise outcome to design
against.

**No pretending the small stuff is the answer.** This is the one most likely to
be broken by someone trying to be encouraging. Cancelling $300 a month of
subscriptions moves the runway from 23 November to 24 November: **one day**. The
$5,083 a year of small subscriptions is real and worth having, and it is about
six percent of a gap of $7,655 a month. A tool that let someone cancel Netflix
and feel the problem was handled would have done them active harm. The page
shows what each change actually buys, including when the honest answer is "not
much on its own".

## The order of the page

Ordering is a behavioural decision too. The Today page is arranged so that
closing it after the first screen still leaves you with the thing that matters:

1. **The date the money runs out**, and the gap per month.
2. **Did it stick**, which is the feedback on the last decision.
3. **What grew**, naming places rather than categories, because a category
   cannot be cancelled and a place can.
4. **What each one is really costing**, priced by the year.
5. **Decisions**, which is the only part that asks for anything.

Today is also the front door, at `/`. A page you have to navigate to is a page
you look at when you already intended to, which is exactly when it is least
needed.

## The rule for anyone changing this

Every number on this page must be true, and must be the same number the rest of
the app would give. If a presentation idea needs a figure rounded in its favour,
a window chosen to flatter, a comparison that would not survive being explained,
or a person blamed, it does not go in. The techniques here are worth using
precisely because they do not need any of that.
