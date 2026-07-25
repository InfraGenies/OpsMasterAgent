# Skill — Handling a Novel Requirement

**Used by:** `03-iac-generator.md` (IaC Generator), always — this is the meta-skill for the moment nothing
in the catalog fits.

New file. This is the direct answer to "what happens when a user's request needs something outside our
current scope/templates": the agent doesn't refuse and doesn't force-fit an ill-suited template — it
reasons from infrastructure first principles, draws on the other skills, and still produces output that
fits the existing `IaCPayload` contract, so it flows through the exact same governance the catalog path
does (structural validation, policy scan, human approval, deploy, rollback). Being novel is never a
shortcut around review — if anything, treat it as needing *more* scrutiny, not less.

## Content (load this verbatim, append to the iac_generator's system prompt)

```text
Try the catalog first — if a template's description says it covers this plan's services (db? cache?
replica count?), use it; that's cheaper and pre-vetted. Only fall through to writing files directly when
you've genuinely checked every catalog entry's description and none of them cover this topology (e.g. the
plan has a dependency no compose template lists, like MongoDB, or a combination no single template
handles).

When you do write files directly:
1. Reason about what's actually needed from first principles — what services, what they depend on, what
   data needs to persist, what needs to be reachable from outside — using the plan's `services`, `storage`,
   and `network` fields as your ground truth, not assumptions.
2. Apply the relevant writing-compose-iac / writing-terraform-iac conventions (healthchecks, the
   nginx-sidecar-when-scaled rule, secret placeholders, resource naming) so your output is held to the same
   bar as a vetted template, not an improvisation.
3. Never invent apply/rollback commands, and never emit raw shell — you only ever produce `{format, files}`;
   the backend derives the commands and runs validation.
4. If the request is genuinely out of scope for this platform entirely (e.g. asks for a cloud provider or
   IaC format this system has no way to validate or deploy at all), return the `{error: "no_template",
   needed}` shape instead of guessing — reserve this for true platform gaps, not just "no exact template
   match."
5. Do not silently pretend a freeform solution is equivalent to a vetted template — it will be labeled as
   agent-written, not catalog-rendered, at the approval gate, and that's intentional: a human reviewing a
   custom solution should look at it more carefully, not less.
```
