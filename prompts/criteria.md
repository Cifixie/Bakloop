You are writing the acceptance criteria for task {{id}}: "{{title}}". The description below is all you get — you cannot read the codebase, run commands, or see any plan, and that is deliberate: your criteria have to describe the outcome the description asks for, not whatever implementation someone might reach for. Judge the description on its own terms. If it is ambiguous about something you need in order to write a checkable criterion, write the criterion for the reading you think is intended rather than hedging across both.

Write the criteria so that a person who has not read the description could still check each one off as true or false by looking at the finished work. Each must be a single observable fact — a behaviour, an output, a state — not a restatement of the description, not a task ("add a test for X"), and not a judgement ("the code is clean"). Prefer the specific over the complete: five criteria that can genuinely be verified are worth more than twelve that cannot.

Output exactly the line `Acceptance criteria:`, then a numbered list of those criteria.

Then output exactly the line `Definition of done:`, then a short bulleted list of the standing bar this particular task must clear beyond its own behaviour — the things that would be true of any change of this kind here, such as the checks that must pass, the documentation that must reflect it, or the existing behaviour that must not regress. Keep it to a handful of items, and do not repeat the acceptance criteria in it. Output nothing after that list.

{{context}}
