# Phone numbers

For the administrator of a deployment. Covers buying numbers from Twilio,
adding numbers your Twilio account already holds, giving them to users and
departments, the reserve, and releasing a number.
Only admins see **Admin → Phone Numbers**.

A number is always in one of three places: with a **user**, with a
**department**, or in the **reserve**, where nobody holds it. It moves between
them as often as you like, and leaves only when you release it.

## The list

**Admin → Phone Numbers** lists every number the deployment holds. The search
box matches the number (typed with or without punctuation), its label, and the
name or email of the user or the name of the department that holds it. The
filters narrow it to numbers held by users, by departments, or in the reserve,
and to local or toll-free numbers. A number whose release did not finish is
not in the reserve any more; it shows only when no holder filter is chosen.

Each row's menu opens the number's page, assigns or moves it, moves it to the
reserve, or, for a number already in the reserve, releases it. A user's page
and a department's **Phone Numbers** tab list the numbers they hold, each
linking to its page here.

## Buying a number

**Buy a number** searches what Twilio has for sale. Searching is free. An area
code alone is enough: the search lists the numbers Twilio has in it, in number
order, to pick from.

- **Type**: local or toll-free. Only US numbers can be bought.
- **Area code**: local numbers only.
- **More filters**, for local numbers: **State** (two letters), **City**, and
  **Digits or letters**. Twilio can search by place for US and Canadian
  numbers only.
- **Digits or letters**: numbers containing them, anywhere or at the end.
  Letters stand for their keypad digits, so `PIZZA` finds a number spelling it.
  A toll-free search has only this filter.

Every number offered takes calls and texts. Numbers that Twilio sells only with
a registered address are left out, because a purchase here files no address.

Twilio answers a search with at most 30 numbers and no next page; each search
is a fresh sample of what it has. **Show more** asks again and adds the new
numbers to the list, in order, keeping the one already chosen; when nothing new
comes back, the list says so. **Change search** goes back to the filters.
Busy area codes sell out, and then the search finds nothing; a neighbouring or
overlay area code, or the state alone, usually does.

Choosing a number opens the confirmation. There you give it a label, decide who
gets it (a user, a department, or the reserve), and, for a department, whether
it becomes the department's primary number. The confirmation states:

- **The price**, read from Twilio's price list for the number's type. Twilio
  bills the first month in full the moment the number is bought; it is not
  prorated. If the price list cannot be read, the confirmation says so rather
  than guessing.
- **Texting**: calls work at once, but texts from a US local number need an
  approved A2P 10DLC registration, and texts from a toll-free number need
  toll-free verification. Both are done in the Twilio Console; see
  [Costs](../develop/costs.md).

**Buy** buys the number, adds it to the list, points its calls and texts at
this deployment, and reads its details (city, capabilities) back from Twilio.

- A number somebody else bought while you were deciding is refused with
  "That number is no longer available". Nothing is charged; search again.
  When this Twilio account got the number in the last few minutes (a
  purchase whose answer was lost, or one from another tab), Buy adds it to
  the list as bought without buying it again; the purchase that finds it
  listed already is told it is on your account.
- A number your Twilio account held before the purchase (one another system
  uses, or one bought in the Twilio Console more than a few minutes earlier)
  is refused with "Your Twilio account has had this number since …": nothing
  is charged, written or changed at Twilio. Use **Add a number you own** for
  it, which records how it is set up today before pointing it here.
- If Twilio cannot be asked whether your account already has the number,
  nothing is bought; try again in a moment.
- A number already in the list is refused before anything is bought.
- If Twilio sells the number but does not take its call and text settings, the
  dialog closes and a notice above the list says so: the number **was** bought
  and is in the list, but calls and texts to it will not arrive until you open
  it and choose **Reconnect**. Do not buy it again.
- If the purchase fails for any reason other than a refusal from this
  deployment (a server error, Twilio did not confirm it, or no answer arrived
  at all), Twilio may have sold the number anyway: **Buy** stays off for that
  number until you close the dialog. Look for it in the list and in the Twilio
  Console before buying again. When Twilio's answer is lost but the account
  lists the number as got in the last few minutes, it is added to the list as
  bought; a number the account held before is refused as above.
- Without the call controller's public address, a purchase is refused before
  anything is bought, since the number could not be pointed at it.
- A number whose release did not finish (listed as **Release unfinished**) is
  refused until you choose **Finish release** on it.
- A number released here earlier and bought back returns as the same number,
  listed as bought today, with its old history still with the owners it was
  written under.

## Adding a number you own

**Add a number you own** lists the numbers your Twilio account holds that are
not in this list: bought or restored in the Twilio Console, or serving another
system until now. A number released here earlier is listed too, marked
**Released here before**. Only US numbers are offered. Listing them is free.

Each number shows what Twilio reads for it, so you can tell it apart before
choosing it:

- its type, its friendly name in the Twilio Console, and what it can carry
  (voice, SMS, MMS, fax), as Twilio reports them;
- what takes its calls and texts today: the host its voice and messaging
  webhooks point at, or the TwiML App, the application or the SIP trunk that
  answers them instead;
- the messaging service it sends texts for, if it is in one.

Choosing a number opens the confirmation, with the same label, holder and
primary choices as a purchase. It states what adding the number does:

- **Its calls and texts move here at once.** Twilio points the number's voice,
  fallback, status and messaging webhooks at this deployment, exactly as for a
  number bought here, and detaches any TwiML App, application or SIP trunk on
  it. Whatever answered them before stops getting them.
- **What it had is kept in the audit log**, every webhook and every detached
  app or trunk, so it can be put back by hand in the Twilio Console.
- **Nothing is bought.** The number keeps costing what it costs on your Twilio
  account.
- **Its messaging service stays.** A messaging service carries the number's
  texting registration, so it is never changed here. If the service sends its
  senders' incoming texts to its own address, the confirmation says texts will
  not reach iziphone until the service is set to defer to the sender's
  webhook, or the number leaves it. A local number in no service can call but
  not text until it joins the messaging service of a registered A2P 10DLC
  campaign.
- **A number released here before comes back as the same number**, with its
  old history still with the owners it was written under.

**Move its calls and texts here** adds it to the list and sets it up:

- A number already in the list is refused with "This number is already in the
  list."; a number whose release did not finish is refused until you choose
  **Finish release** on it.
- A number your Twilio account does not hold (released or ported away while
  the dialog was open) is refused, and nothing is recorded.
- If Twilio does not take the number's call and text settings, the dialog
  closes and a notice above the list says so: the number **is** in the list,
  but calls and texts to it will not arrive until you open it and choose
  **Reconnect**.
- Without the call controller's public address, adding a number is refused
  before anything changes, since the number could not be pointed at it.

Removing an added number later (moving it to the reserve, or releasing it)
leaves its webhooks pointing here; nothing puts back what it had before. The
reasons are in
[0017. Adding a number the account holds takes it over](../decisions/0017-adding-a-number-the-account-holds-takes-it-over.md).

## Assigning and moving

**Assign to...** (for a number in the reserve) and **Move to...** (for a held
number), in the row menu or on the number's page, give the number to a user or
a department. **Move to reserve** takes it away from whoever holds it. The
confirmation says where calls and texts go from then on and what happens to
the conversations already on the number.

In short: calls and texts to the number go to its new holder at once, and the
conversations stay with whoever held the number when they happened. The
previous holder can still read theirs, but cannot send from the number any
more, and the new holder starts without them. The details are in
[When a number changes hands](departments-and-routing.md#when-a-number-changes-hands).

If another admin moved the same number after you opened it, your move or your
change to its primary switch is refused with "This number changed hands while
you were editing it"; reload and decide again. A label is saved whoever holds
the number. A release of a number somebody gave away meanwhile is refused with
"Move this number to the reserve before releasing it.", or, when they did so
in the same instant as your release, with "This number changed hands".

### A department's primary number

A department's primary number is the line its members call and text from
first. The first number a department gets, bought for it or assigned to it,
becomes its primary. A primary moved
into a department that already has one stops being primary there; moved within
the department, it stays primary. The **Primary number** switch on the
number's page changes it, and making one number primary takes the flag from
the department's other numbers.

Moving a department's primary number elsewhere, or switching it off, leaves
the department without a primary until you make another of its numbers
primary; nothing picks one for you.

## The reserve

A number in the reserve belongs to nobody. It stays on your Twilio account and
**keeps costing its monthly fee**. Callers hear that the number is not
configured, and texts to it are not shown to anybody. Nothing moves a number
out of the reserve or releases it on its own; that is always an admin's
decision.

Deleting a user or a department puts their numbers in the reserve.

## Releasing a number

Only a number in the reserve can be released: move it to the reserve first.
Taking a line away from the people who answer it is its own step, so a number
cannot go from someone's desk to gone in one click. The reasons are in
[0016. A number is released only from the reserve](../decisions/0016-a-number-is-released-only-from-the-reserve.md).

**Release number** gives it back to Twilio:

- It leaves your account at once, and calls and texts to it stop.
- Twilio stops charging for it. The month already billed is not refunded.
- It cannot be undone here. For about 10 days Twilio keeps the number for your
  account, and the Twilio Console can buy it back, as a new purchase. After
  that, anybody may get it. A number bought back in the Console is not added to
  this list on its own; **Add a number you own** brings it back.
- Its call and message history stays, with the owners it was written under.

A number this Twilio account no longer has (released in the Twilio Console, or
ported away) is removed from the list all the same. A notice then says that
nothing was cancelled at Twilio, and the audit log records it: if you are still
billed for the number, it is on another Twilio account, and has to be released
there. A number that came from the previous provider is released from Twilio if
Twilio has it; if Twilio does not, the notice says so, and you cancel it with
the previous provider to stop paying for it.

While the release runs, the number is marked as being released: it stays on
the list, and nobody can give it to someone, change it or buy it again until
the release is done. A second admin who releases it while the release runs,
from a list loaded before or by choosing **Finish release** on a list that
shows it as **Release unfinished**, asks Twilio a second time; the two settle
on one outcome, and only one of them takes the number off the list. Two
releases pressed in the same instant may instead be told that somebody else is
releasing it already. If Twilio refuses the release while it has the
number, the number goes back to the reserve, the error says why, and the audit
log records the refusal. If Twilio's answer is lost and the account does not
show the number gone, Twilio may or may not have let go of it, so it stays
listed as **Release unfinished** rather than going back to the reserve. A
release that stopped half-way (the server
restarted, or the list could not be updated after Twilio took the number back)
leaves the number listed as **Release unfinished**. Choose **Finish release**
on it: Twilio is asked again, and the number then leaves the list. If somebody
changed the number while Twilio was letting go of it, the release says that
Twilio no longer has it; move it to the reserve if it is not there, and release
it again to take it off the list.

## Connection and Reconnect

The **Connection** card on the number's page asks Twilio what it does with the
number's calls and texts, each time the page opens or you choose **Check
again**:

- **Connected**: Twilio sends them here.
- **Needs Reconnect**, with the reasons: a webhook points somewhere else or is
  called with GET (this deployment takes POST only, at the exact address with
  no trailing slash), or a TwiML App, an application or a SIP trunk is
  attached and takes the calls or texts instead. Somebody changed the number
  in the Twilio Console, the deployment moved, or a purchase or an import
  could not finish setting it up.
- **Not on the Twilio account**: the account does not hold the number any more,
  and Reconnect cannot point it here.
- A note on texting, under any of these: the number's messaging service keeps
  its senders' incoming texts and sends them to an address of its own that is
  not this deployment, naming the service; a local number is in no messaging
  service and cannot text until it joins a registered campaign's; or its
  service's campaign is missing, still in review or not approved, so carriers
  block its texts.

**Reconnect** tells Twilio again to send the number's calls and texts to this
deployment, and detaches a TwiML App, an application or a SIP trunk that would
take them instead. It does not change messaging services: those are changed in
the Twilio Console. It costs nothing. The audit log records what the number had
before Twilio is asked, so the record stays even when Reconnect then fails. If
Twilio takes the change but something still sends the number's calls or texts
elsewhere, Reconnect says so instead of reporting success.
[Twilio configuration](../operate/twilio.md) explains the webhooks involved.

## The audit log

Every purchase, addition of a number you own, assignment, move, move to the
reserve, label or primary change, reconnect and release is recorded in the
audit log with who did it, from where, and what changed. An addition and a
reconnect also record the number's settings before the change. So is a release
Twilio refused, with Twilio's reason and whether the number went back to the
reserve.

## Not covered

- Porting a number in or out, and numbers outside the US.
- A2P 10DLC and toll-free verification, and messaging services, which live in
  the Twilio Console.
- Putting back what an added number had before it was added. The audit log
  keeps it; the Twilio Console sets it.
