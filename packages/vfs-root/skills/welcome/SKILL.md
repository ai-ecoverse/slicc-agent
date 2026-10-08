---
name: welcome
description: Use this when you receive a <lick channel="sprinkle" source="sprinkle:welcome"> with the action onboarding-complete, sent once when the user finishes the welcome card. Covers the reply it expects.
---

# Welcome

The welcome card in the first chat asks the user who they are and what they want to do. When they finish it, you get one lick: channel `sprinkle`, source `sprinkle:welcome`, text `onboarding-complete`. Its body is their profile:

```json
{
  "purpose": "work",
  "role": "developer",
  "tasks": ["build-websites"],
  "name": "Paolo",
  "company": "Example Inc.",
  "apps": ["github"]
}
```

Any field may be empty. Provider and key are set in Settings, not in this card.

Send one short reply, six sentences at most:

1. Greet the user by name, or warmly without one, and react to what they said they want to do.
2. Close with exactly three concrete next steps as a bulleted list, one short imperative each, grounded in their profile and in what this SLICC can do now (its shell, files, licks, scoops, skills and sprinkles):
   - one obvious: the natural first thing someone like them would try;
   - one obligatory: a setup step worth doing first, such as `git config --global user.email …` or telling you about their project folder;
   - one outrageous: a bold, slightly cheeky use that shows what's possible beyond their stated profile.

Don't list capabilities, don't install anything, and don't edit memory files. The card already marks onboarding as done.
