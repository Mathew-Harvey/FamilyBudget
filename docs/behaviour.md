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

### A residue is not a category

The biggest optional figure in the app is the allowance, and for a long time it
was one number under a caption reading "takeaway, clothes, whatever is not a
bill". It is not a category anybody chose. It is what is left of the money going
out once the transfers, the refunds, the one offs, the repeating costs and
everything judged must pay or could trim have been taken out of it, and anything
nothing has judged goes in by default, because counting unassessed spending as
optional shortens the runway rather than flattering it. The default is the right
one for a projection. The caption was describing it as a decision.

That is the second kind of technique, the kind this document exists to refuse: a
default you did not notice agreeing to, dressed as a judgement you made. On the
household the app was built for it came to **$2,482 a month**, and the honest
sentence about most of it is not "this is what you chose to spend on things you
did not have to buy" but "nobody has ever looked at this".

So the row opens into the places it came from, and says of each one whether
anybody has judged it. Nothing about the projection changes: the same money is
counted the same way, because the default really is the safer one. What changes
is that the page stops claiming a judgement that has not been made, and the
person can go and make it. Naming the parts is the first kind of technique,
making a true thing vivid, and it is the only kind available here.

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

Today, Forecast, Lasting, alerts and analysis all use the same household plan.
That plan is recurring essentials, the discretionary allowance, active
commitments and configured income. Historical optional spending remains useful
evidence on the Spending and allowance pages, but it is not a second hidden
forecast input.

The allowance is the one input, and for a long time it started at zero. That is
not a neutral default, it is a claim: that the household buys nothing it does not
have to. On this one it was wrong by $3,825 a month, and every page downstream
inherited the error while reporting the resulting surplus as money. Nothing about
the page said so, because a figure nobody has entered looks exactly like a figure
somebody chose.

So the default is now what that spending has actually been. The rule is the pay
cycle's rule: history is the suggestion, the figure someone sets always wins,
and a saved zero is honoured because a person saying zero is a decision. The
honest default errs toward projecting more spending rather than less, which
shortens the runway rather than flattering it.

`/allowance` is the only screen in the app that asks for a decision rather than
reporting one, and it is built accordingly. It leads with twelve months as
columns and draws the allowance across them as a line, because one number cannot
say whether $3,200 a month is every month or the average of a quiet one and a bad
one, and that is the difference between a figure someone can argue with and one
they can only accept. Whether the line sits above or below the life you have
actually had is the whole decision, and it moves as you pick. The two anchors
offered beside it, a usual month and the quietest one, are months the household
has already lived: an allowance that has been met before is a different
proposition from one that has not.

What a choice would do is worked out by the real projection and printed as it
comes back, never recomputed on the page. A trial says it is a trial: a figure
nothing has been saved at is never labelled as one somebody chose.

Ordering is a behavioural decision too. The Today page is arranged so that
closing it after the first screen still leaves you with the thing that matters:

1. **The date the money runs out**, and the gap per month, with the curve that
   date sits on. The headline is a point on that curve: a runway date is where
   it crosses zero, a balance is where it starts. Drawing it says the same thing
   in the one dimension a figure cannot carry, which is time, and the slope
   answers "are we building up or running down" without a word. The curve
   carries both its axes, dollars up the side and months along the bottom
   starting at today, because a shape you cannot read an amount or a date off is
   a mood rather than a claim, and every other figure on this page can be
   checked against something.
2. **This pay period**, which is the horizon anything can be done about today.
   The runway is a date months out and the gap is a fact about a shape; neither
   changes what happens this afternoon. The pay lands every fortnight and has to
   last, and that is measured rather than converted: a month divided by 2.17
   describes no particular fortnight. Being ahead or behind an even spend is
   drawn as a mark on the bar rather than stated, so it is a length and not a
   sum somebody has to trust.
3. **Did it stick**, which is the feedback on the last decision.
4. **What grew**, naming places rather than categories, because a category
   cannot be cancelled and a place can.
5. **What each one is really costing**, priced by the year.
6. **Decisions**, which is the only part that asks for anything.

Today is also the front door, at `/`. A page you have to navigate to is a page
you look at when you already intended to, which is exactly when it is least
needed.

## The shape of it

Thirteen tabs, and eight of them were the workshop rather than the budget:
Transactions, Categories, Rules, Buckets, Transfers, Sync, Alerts and Insights
are a person teaching the app what things are. Two people share this and only
one of them maintains it, so a nav bar that puts Rules beside Today asks the
other one to step over the machinery every time she opens it.

Four places now, in a bar at the bottom of the phone where every other app she
uses keeps them: Home, Spending, Plan, Set up. The eight live under the last,
grouped by why you would go there. This is not tidying. A page that looks like
an admin console gets opened by the person who likes admin consoles, and a
budget only works if both people open it.

**The hero is the runway date whenever there is one.** When the projection never
reaches zero, which is the ordinary case for a household that is slightly short
with cash in the bank, there is no date to show and the page falls back to the
spendable balance with the direction beside it. Both of those used to print the
word "null" under a heading that was not a date. The fallback is the figure the
runway would have been computed from, so it is the same number the rest of the
app would give, and the state line above it carries the direction so a balance
is never read as good news on its own.

**Colour carries meaning or it is not used.** One blue for anything that is a
quantity, orange only where a second series genuinely exists, and the four
status colours reserved for state with a word always beside them, never colour
alone. The tile next to a recurring cost is one hue in three ordered steps, and
what it encodes is the tier `src/costs.js` already assigns: dark is a bill you
must pay, pale is a choice. That classification has always existed and was never
visible. No per category rainbow: past about eight hues they stop being
distinguishable, and a colour that means nothing is a colour that teaches the
reader to ignore colour.

**A diagram instead of a paragraph, wherever one will do.** The page had grown
a paragraph under most headings explaining why the thing above it was built that
way. That is the author talking to the next author, and to the person who just
wants to know where the money went it is wallpaper: it sits in the position
where information should be, so it teaches the reader to skip that position.

Two replaced outright. "X comes in, the plan includes Y of recurring essentials,
Z discretionary and active commitments" is four figures in a sentence; it is now
two bars on one scale, in against out, where the gap is a length. And the
Spending page opens with the window split three ways by how hard each thing
would be to stop, with a key under it in the same three colours in the same
order, so the one picture answers "how much of this can we even change" and
teaches what the tile beside every row below means. It replaced the two
sentences that used to say the same thing in words.

What stayed is the caveat that changes what a number means: "assumes the current
payment, ignores interest" earns its line because without it the payoff dates
read as promises. The rule is that an explanation of the DESIGN goes, and a
qualification of the FIGURE stays.

**The Lasting page leads with the gap as a track.** It is as long as what the
household is short, each step fills part of it from the left, and what is left
unfilled is hatched rather than coloured, because it is the absence of a saving
rather than another kind of one. Whether cutting is enough is then a length: on
a gap of 2,317 with 675 of cuts available, two thirds of the track stays empty
and nobody has to read a sentence to know it. This is the rule about not
pretending the small stuff is the answer, drawn instead of written.

**A bar length means one thing at a time.** The Spending list shows a monthly
rate for places paid on three or more days and a window total for the rest,
because a place paid twice a year has no monthly rate. Those are two different
measures, so they get two lists and two scales. Plotted against one maximum, an
11,000 dollar engine rebuild took the full width and squashed every monthly rate
to a stub.

**Light is the default and dark is a choice.** Not an automatic flip from the
operating system, which is usually a preference about a phone at night rather
than about a budget looked at in daylight.

## The rule for anyone changing this

Every number on this page must be true, and must be the same number the rest of
the app would give. If a presentation idea needs a figure rounded in its favour,
a window chosen to flatter, a comparison that would not survive being explained,
or a person blamed, it does not go in. The techniques here are worth using
precisely because they do not need any of that.
