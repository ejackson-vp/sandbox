# Getting the first stranger to pay

The goal in this document is one settled payment from someone who is not the
operator. Not traffic, not stars, not signups: one row in the ledger with a
`source` of `x402` and a wallet nobody here has met.

That changes the work. A launch is a spike, and a spike is only useful if the
people in it can pay. So the order is: make the thing visible where buyers
already are, make paying possible from where they are standing, then post.

## Who can pay today

Someone with USDC on Base and a terminal. That is a narrow audience, and it is
the audience to aim at for the first payment: the x402 builders, the agents with
funded wallets, the people who already run something that spends.

Everyone else needs an exchange account before they can spend two cents, which
is a conversion problem no post fixes. Do not measure those readers.

## The 90-minute version

1. Deploy the discovery change (`docs/launch.md`, step 6) and confirm the 402
   carries `extensions.bazaar`.
2. Make one paid session yourself, from a different wallet than `PAY_TO`, and
   check the settle lands. A stranger's first attempt should not be the test.
3. Post the x402 channel message below, in the Slack and the Telegram, where the
   wallets already exist.
4. Send the three DMs. Direct asks beat broadcast for the first one.
5. Then post to HN and Reddit. Do it after, not first: those readers arrive in
   the thousands and most of them cannot pay.

## Posts

### Show HN

Title: `Show HN: Sixty seconds of Linux for two cents, no account`

Body:

> The pitch is a sandbox that does not want a relationship. Post a spec, get a
> 402 with a price, pay in USDC on Base, get a machine. When the lease ends the
> pod is deleted and the workspace goes with it. No suspend, no resume, nothing
> to clean up.
>
> I built it because every sandbox API I tried wanted an account before it would
> run a line of code, and that is the wrong shape for an agent. An agent should
> be able to buy compute the way it reads a URL.
>
> Prices are 2 cents for 60 seconds, 5 cents for 5 minutes. Sessions are a Kata
> microVM on Kubernetes, and the control plane routes ciphertext only: the API,
> the controller and the relay hold no key to what you run.
>
> The caveats, because they are on the site in the same size type: one operator,
> one region, one control-plane node, no SLA. The isolation boundary is tested
> for the properties in the suite and nobody has tried to escape it. The security
> review is mine, not an independent one. If you need a hostile-tenant guarantee,
> this beta does not sell one yet.
>
> MIT, self-hostable, and the whole protocol is documented for agents at
> `throwbox.dev/llms.txt`.
>
> What I would like to know: is "destroyed, never paused" a feature or a
> limitation for your workload? I have gone back and forth.

### r/LocalLLaMA project showcase

Post in the bi-weekly showcase thread, not as a new submission.

> Disposable Linux for local agents. If your agent generates shell commands and
> you would rather not run them on the machine with your SSH keys on it, this
> rents a box per command: 60 seconds for 2 cents, 5 minutes for 5. No account,
> no API key. Payment is a header.
>
> The part that might be interesting here: the client seals commands to the
> guest's key, so the relay and the API see ciphertext. It is a Kata microVM, not
> a container.
>
> Caveats are honest on the site: one operator, no SLA, no GPU, no persistence.
> It is an MIT repo, so `make up` gives you the same thing locally.

### X

> 60 seconds of linux for 2 cents, bought with a payment header. no signup, no
> api key, no dashboard. the box is deleted when the lease ends, files and all.
>
> `sandbox run --json -- python3 -c "print(1)"`
>
> api.throwbox.dev

Then reply to your own post with the receipt: the tx hash and the session id.
A payment nobody can verify is a claim.

### x402 Slack and Telegram

Short. These are builders, not an audience.

> I put a sandbox behind x402: pay a header, get a Linux box for 60s, no account.
> `POST api.throwbox.dev/v1/sessions` quotes in USDC on Base.
>
> Two things I would find useful from this group:
> - anyone whose agent needs somewhere to run generated code,
> - anyone who has had a Bazaar listing rejected, because I am about to find out
>   what the metadata screen dislikes.

## Direct messages

Three, each one specific. No mail merge.

**To an x402 seller near the top of the Bazaar.** Their agent has a funded
wallet and no compute.

> You are doing ~10k calls a month on <endpoint>, so your agents are already
> spending. Do they have anywhere to run code, or do you refuse that class of
> request? I run a sandbox that takes x402 directly: 60s for $0.02, no account.
> Happy to give you an allowlisted key so you can wire it up without spending
> anything.

**To a framework maintainer with a bring-your-own-sandbox hook.**

> You take a sandbox provider in <framework>. I have one that pays per session in
> USDC with no account, and an MCP server for it. Would an adapter be welcome, or
> is the provider list closed? I would do the work and keep it passing.

**To a builder whose agent needs a body.**

> Saw you are running <agent> that writes and executes code. I have a disposable
> Linux box per session, 2 cents for 60 seconds, no signup, and the commands stay
> sealed to the guest key. Want a free key to try it on one real task? If it is
> useless, tell me why and I will stop asking.

## What to measure

One number: settled payments from wallets that are not yours. Everything else,
stars and visits and retweets, is a proxy that has been wrong before.

After a post, check the ledger for `source=x402` and a new payer. If the visits
did not convert, the post is not the problem: the payment path is. Look at
whether the reader had to install anything before they could spend.

## What not to do

- Do not post to HN and Reddit first. The audience cannot pay and the traffic
  buries the thing you wanted to learn.
- Do not add a free tier to fix conversion. A free tier converts a reader into a
  user of the free tier. Fix the payment path instead.
- Do not write a launch thread with no artefact. The receipt for a machine an
  agent bought for itself is the only content here nobody else can publish.
