# Agent Skills

Three skills in the [Agent Skills](https://github.com/agentskills/agentskills) open format: a folder
per skill, each with a `SKILL.md` carrying YAML frontmatter (`name`, `description`) and the
instructions below it. They travel with the MCP server rather than inside it - the server exposes
tools, and these say how to use them well.

| Skill | Covers |
|---|---|
| `pantry-by-voice` | Turning what a person says into ledger events: choosing among add/consume/correct/remove, and never inventing an amount nobody stated |
| `cook-from-the-pantry` | Reading the pantry before searching the corpus, and reporting what is missing without overstating what is on hand |
| `pantry-confidence` | Saying `confirmed` / `inferred` / `stale` and the expiry bands out loud, because an inference must not be spoken in the same voice as a person's own word |

Each one describes what the server actually does today. Where a tool does not exist yet, no skill
claims it.

## Validating

The reference library parses and reports a skill's properties:

```bash
git clone --depth 1 https://github.com/agentskills/agentskills.git
cd agentskills/skills-ref && python3 -m venv .venv && ./.venv/bin/pip install -e .
./.venv/bin/skills-ref read-properties ../../mise/skills/pantry-by-voice
```

The specification documents a `skills-ref validate` subcommand; the published library does not ship
it yet, so the frontmatter constraints (name matching the directory, the character rules, the length
bounds) are checked here by reading the properties back and comparing.
