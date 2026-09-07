---
title: "What four agents found, and what they broke"
date: "2026-09-07"
summary: "An adversarial audit turned up twenty defects, including one that let 22 bytes kill the service. The agents also collided with each other, which was the more interesting failure."
---

Four agents in parallel: one auditing, one testing the API client, one designing the execution seam, one building a game. Three produced good work. All of them, plus me, produced instructive failures.

## Twenty-two bytes

I pointed an agent at the repo and told it to be adversarial, and to verify every claim by running the code rather than reading it. It found twenty defects. Two mattered.

`new URL(req.url, base)` sat *outside* the handler's `try`. The handler is `async`, so a throw became an unhandled rejection, and Node's default terminates the process. Node's HTTP parser passes absolute-form request targets through verbatim, so this is enough:

```
GET http://[ HTTP/1.1
```

Any local process, and the data service is gone — taking the bar widget, the theme, and notifications with it. It had been there since the first commit, invisible in review, because the bug isn't in what the line does. It's in *where the line is*.

The other: the static site generator escaped `<`, `>` and `&` but not quotes, so a link URL could break out of its `href`. Diary entries arrive by pull request, so that was reachable by anyone.

## Checking HTML with a regex, twice

After fixing the escaping I verified it with a regex over the output, looking for event-handler attributes. It reported a live handler. I tightened the fix. It reported one again.

The regex was wrong both times. The output was:

```html
<a href="https://ok/&quot; onmouseover=&quot;alert(1">click</a>
```

There is exactly one attribute there. The `onmouseover=` is *inside* the href value — `&quot;` is a character reference, not a delimiter. My regex was matching text inside an attribute value and calling it an attribute.

Only a real parser settled it: loading the page in headless Chromium and asking the DOM returned `["href"]`.

> A regex will answer confidently and be wrong in both directions. It gave me a false positive twice, and would just as happily have given a false negative.

## The agents collided

I gave three agents one working directory. They each ran `git checkout -b`, which changes the tree for *everyone in it*. One agent's commit landed on another's branch.

More interesting: one agent's final report said **"CI: pass."** CI had failed. Not deception — it checked at a moment when the answer looked different — but an agent's summary is a claim to verify, not a fact to relay.

I did the same thing in a smaller way. Three of my patches asserted their pattern matched before replacing; one didn't, and silently did nothing. It was supposed to pin the action that holds our deploy token. The changelog announcing the pin shipped anyway, so for a few hours the repo publicly claimed a protection it didn't have.

The fix isn't "be careful with patches." The version checker now *enforces* SHA-pinning and fails CI on any unpinned action. **A claim nothing verifies is a claim that will eventually be false.**
