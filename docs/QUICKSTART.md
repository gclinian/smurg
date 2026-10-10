# Quick start: your first topic

The shortest way from nothing to a first topic (a feature or a task): you share a project folder from your own
computer, a teammate joins in a browser, and an agent does a piece of work that you review and merge. This guide in
[繁體中文](zh-TW/QUICKSTART.md).

- **You (the host)** need macOS or Linux, Claude Code installed and logged in, and a project folder that is a git
  repository with at least one commit (which versions: [host guide](HOSTING.md#1-install), §1).
- **Everyone** needs a Google account and Chrome on a computer. Teammates install nothing.

## Share your folder with your team

1. **Install smurg**:

   ```sh
   curl -fsSL https://smurg.ai/install.sh | sh
   ```

   If the installer says `~/.local/bin` is not on your `PATH`, add the line it prints to the file it names and
   open a new terminal. Then `smurg --version` prints a version.

2. **Share the folder** (use your own project's path):

   ```sh
   smurg host ~/projects/my-app
   ```

   If it asks you to log in first: open the address it prints, log in with Google, enter the code, press "Next",
   then "Allow". Then it prints two links and keeps running; leave this terminal open:

   ```
   smurg is sharing "my-app"

   Your link (for you only):
     https://app.smurg.ai/join/ws_…#k=…&s=…

   Link for your teammates (send it to them privately; valid for 7 days):
     https://app.smurg.ai/join/ws_…#k=…&s=…

   Press Ctrl-C to stop sharing.
   ```

3. **Open "Your link"** in Chrome: choose "Log in with Google" if it asks, then "Join". The top bar says
   "Connected", and the page says "Start with a topic".

> **Before you send the link.** Agents are Claude Code: they run on your computer as you, with no sandbox, on your
> Claude account, even when they work for a teammate. A personal Pro or Max subscription is for your own use: a
> group needs an API key or a Team or Enterprise plan. Give Agent access only to people you fully trust. Read
> [Before you share](HOSTING.md#4-before-you-share) first.

4. **Send "Link for your teammates"** in a private message: the part after `#` is the secret. Whoever joins with it
   is an Editor: they see and edit the files in the folder, vote on the agent's questions and review results with
   you. Trying it alone first? Go on at step 6.
5. **Your teammate opens the link** in Chrome and chooses "Log in with Google", then "Join": nothing to install, no
   Claude account. Their top bar says "Connected" too.

## Your first topic

6. **Start a topic.** Press "New topic", give it a name, say what you want to build, and press "Start discussion".
   From here on you press the buttons; Editors vote, comment, edit the spec and send suggestions to the agent.
7. **Decide together.** The agent asks with cards titled "Question from Claude". Everyone clicks an option; you
   press "Submit answer" ("Submit answers" if the card asks several questions).
8. **Get the spec.** The agent writes `SPEC.md` when the decisions are settled (or press "Write the spec now" when
   it is idle) and says so in the discussion; "Open spec" shows it.
9. **Get the plan.** Press "Generate plan". The agent writes `PLAN.md`: a list of work items.
10. **Start the work.** Press "Start 3 items" (the number comes from your plan), read the dialog, then press
    "Start". Before almost every command, an agent asks with a card in your inbox (top left),
    "Claude asks for permission to run a command". Read the command, then press "Allow once" or "Deny".
11. **Review.** When a work item is done, its result report comes to your inbox. Read it, then press
    "I've reviewed this".
12. **Merge.** The change comes to your inbox as "Reviewed, ready to merge". Open it, press "Merge…", read the
    diff, then press "Merge into the main workspace", then "Confirm merge". The plan shows the item as
    "Reviewed · merged": its changes are in your folder.

## Where to go next

- Something does not work: [Troubleshooting](HOSTING.md#8-troubleshooting). Watch your first topic: this flow was
  verified against a scripted stand-in for the model, not with a real Claude account
  ([what was verified](HOSTING.md#108-what-was-verified-and-what-was-not)).
- Who may do what: [Roles](JOINING.md#2-roles-what-you-can-do), in the guide for teammates.
- What agents do by themselves, and what they ask first: the
  [host guide](HOSTING.md#52-what-agents-do-by-themselves-and-what-they-ask-first), §5.2.
- Stopping (Ctrl-C or `smurg stop`) and updating (`smurg update`): host guide,
  [§7](HOSTING.md#7-status-and-stopping) and [§9](HOSTING.md#9-updating-and-removing).
