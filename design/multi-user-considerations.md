# Multi-User Considerations

Status: discussion notes, not yet an agreed design. Nothing here is implemented, and
`technical-design-and-implementation.md` remains authoritative until it is revised.

## Purpose and scope

The current design assumes one writer per project. This note records what has to change so that
several people can work on the same board through git.

The intended usage is narrow:

- Separate users work on **separate epics**, each on their own clone, synchronising through git.
- Coordination between users happens **outside the tool**, so two people are not expected to edit
  the same epic, story or task.
- Several agents writing to the same working tree is **out of scope**.

Under that model, each user only edits entity files inside their own epic. The clashes that remain
are in the files every user's mutations touch regardless of which epic they work on.

## Recommendation

Make two changes, landed together:

1. **Stop committing the generated indexes and graphs.** Git-ignore `index/` and `graphs/`, and
   have the server regenerate them locally. This removes the conflicts that occur on almost every
   merge. `.meta/` does not need to be in the ignore rule: its only content is `counters.json`,
   which the second change deletes. Details are under Proposal 2.
2. **Use ids of five Crockford base32 characters after the type prefix**, such as `T-7K3F9`, in
   place of the per-type counters. Ids can then be minted independently on each clone and
   `counters.json` is deleted. Five characters give about 33.5M values per entity type, so the
   chance of a clash in a merge with 50 new ids on each side is about 0.007%. Details are under
   Proposal 1.

Everything else in this note is the reasoning behind these two choices and the alternatives that
were considered.

## Where clashes come from under this model

| Source | Failure on merge |
| --- | --- |
| `.meta/counters.json` and sequential ids | Two branches both mint `T-104`. The counter file conflicts, and the merged store then fails validation with `DUPLICATE_ID`. |
| Project-wide generated files | Every mutation rewrites `INDEX.md`, `READY.md`, `BLOCKED.md` and `dependencies.mmd`, so almost every merge conflicts even though the users touched different epics. |

Cross-epic dependencies are a third possible source: each side's edit is valid alone and merges
cleanly as text, but the combined graph can contain a cycle (for example, one user makes `E-001`
depend on `E-002` while another makes `E-002` depend on `E-001`). This is treated the same way as
same-entity edits: users agree cross-epic dependencies through external coordination, so the tool
does not need a mechanism to prevent it.

Per-epic generated files (`index/E-NNN.md`, `graphs/E-NNN.mmd`) mostly stay within one user's
epic, but they can still change when another epic they depend on changes status.

## Proposal 1: replace the shared id counters

Replace the per-type monotonic counters with ids that can be minted independently on each clone.
The starting idea is short random ids; the alternatives further down keep ids more readable. Either
way, this removes the id collision and lets `counters.json` be deleted. The technical design already lists ULIDs as an open alternative
to counters, so this is a revision of an open question, not a contradiction of a settled decision.

Points to settle:

- **Keep the type prefix** (`E-`, `S-`, `T-`). Same-type dependency validation and the UI both
  rely on it.
- **Collision handling.** Check-on-allocate catches a collision within one working copy. The
  existing `DUPLICATE_ID` validation catches one that only appears after a merge, and the fix is
  to re-mint one of the two ids.
- **Length.** Because allocation checks the ids already present, a new id can only clash with one
  created concurrently on another unmerged branch. The chance of a clash in one merge is roughly
  (new ids on one side × new ids on the other) ÷ (number of possible ids), per entity type. With
  50 new tasks on each side, that is about 0.24% for four Crockford base32 characters (about 1M
  values) and about 0.007% for five (about 33M values). Eight characters are not needed; four or
  five are enough.
- **Readability cost.** `T-103` is easy to say and remember; a random id such as `T-7K3F` is
  shorter than a ULID but still not memorable. The alternatives below address this.
- **Ordering cost.** Sorting by id no longer reflects creation order. Generators that order by id
  stay deterministic, but should order by `created` and then id if creation order is meant to be
  visible.

### Alternatives that keep ids readable

Ordered from most readable to least. All of them remove the shared counter clash.

1. **Per-user namespaced counters.** Ids look like `T-AB-12`: type, a short user
   handle, then a per-user sequence number.
   - Ids stay sequential and sayable, and show who created the item.
   - The next number can be derived by scanning for the highest existing id in that namespace, so
     `counters.json` still goes away.
   - Each user needs a unique handle, set in local git-ignored config. That is one more thing to
     coordinate externally, which the usage model already assumes.
   - Two users picking the same handle produces duplicate ids, which `DUPLICATE_ID` validation
     reports.
   - Generators have to sort the numeric part as a number, so `T-AB-2` comes before `T-AB-12`.
2. **Per-epic keys.** Each epic gets a short agreed key, as Jira does: epic `AUTH`, story
   `AUTH-S3`, task `AUTH-T12`.
   - The most readable option, since the id says what the item belongs to.
   - It matches "separate users on separate epics", and only the epic key needs agreeing.
   - `move_entity` to another epic leaves a misleading id, since a move edits frontmatter only.
   - It changes the id grammar that validation and the UI parse.
3. **Shorter random ids.** Four or five Crockford base32 characters, such as `T-7K3F`, as
   described under "Length" above. Not memorable, but short enough to read aloud, and it needs no
   setup or agreement between users. This is the recommended option, at five characters.
4. **Word-based ids.** Two words of three to five letters from a fixed list, such as
   `T-amber-fox`. Easy to say and remember, but longer in tables and Mermaid nodes, and the word
   list becomes part of the format. See "Word list sizing" below.
5. **Unique-prefix abbreviation.** Store a longer random id, but let tools accept the shortest
   unique prefix, as git does with commit hashes. This only helps typing: a prefix can become
   ambiguous as the board grows, so it cannot be used in files or in conversation.

Rejected:

- **Local sequential aliases.** They would differ between clones, so two users could not refer to
  the same item by number.
- **Renumbering in CI on merge.** It rewrites ids that other entities and branches already
  reference.

### Crockford base32

This applies to the random id options above. Crockford base32 is an alphabet of 32 symbols,
designed by Douglas Crockford, for writing numbers in a form people can read aloud and type
without mistakes. Each character carries 5 bits. The details below are from memory and should be
checked against Crockford's specification before implementation.

The alphabet is the ten digits plus 22 letters:

```text
0 1 2 3 4 5 6 7 8 9 A B C D E F G H J K M N P Q R S T V W X Y Z
```

Four letters are left out:

- **`I` and `L`**, because they look like `1`.
- **`O`**, because it looks like `0`.
- **`U`**, to avoid accidentally spelling some obscenities.

Decoding is forgiving of human input:

- **Case-insensitive.** `t-7k3f` and `T-7K3F` are the same id.
- **Confusable characters are mapped.** On input, `O` is read as `0`, and `I` or `L` as `1`, so a
  mistyped id still resolves to the right one.
- **Hyphens are ignored.** They can be inserted for readability.

The specification also defines an optional check symbol to catch typos. It is not needed here,
since a mistyped id simply fails to resolve.

Compared with other encodings:

| Encoding | Bits per character | Drawback for ids |
| --- | --- | --- |
| Hex | 4 | Longer ids for the same number of values |
| Crockford base32 | 5 | None significant |
| RFC 4648 base32 | 5 | Keeps `I`, `L` and `O`; usually shown with `=` padding |
| Base64 | 6 | Case-sensitive, and includes punctuation characters |

Case-insensitivity matters for this project specifically. Ids appear in filenames, and Windows
and macOS filesystems are case-insensitive by default, so a case-sensitive encoding could produce
two ids that collide on disk. ULIDs use the same alphabet.

Points for this design:

- **Size.** Four characters give 32⁴ = 1,048,576 values and five give 32⁵ = 33,554,432, which are
  the figures used under "Length".
- **Canonical form.** Store and emit ids in uppercase, and apply the lenient mapping only when
  parsing input.
- **Accidental words.** Excluding `U` reduces them but does not eliminate them; a random id can
  still spell a word. If that matters, allocation can reject ids on a small blocklist and draw
  again.
- **Sorting.** The alphabet is in ASCII order, so a plain string sort matches numeric order. That
  only matters if ids encode a timestamp, as ULIDs do; for purely random ids the order is
  arbitrary either way.

### Word list sizing

This applies to the word-based option above. Two words from a list of N give N² possible ids per
entity type, and the clash chance per merge follows the same formula as under "Length".

| List size | Combinations | Clash chance, 50 new ids on each side |
| --- | --- | --- |
| 500 | 250,000 | about 1% |
| 1,024 | about 1M | about 0.24% (same as four base32 characters) |
| 1,296 | about 1.7M | about 0.15% |
| 2,048 | about 4.2M | about 0.06% |

A list of roughly 1,000 to 1,300 words is enough.

Allowing three to five letters, not exactly four, makes a list of that size easy to source:

- English has several thousand words in that length range, so there is plenty left after
  curation. Restricting to exactly four letters would also work for about 1,000 words, but leaves
  less room to be selective.
- The EFF short word list (1,296 words, none longer than five letters) is an existing vetted list
  in this range, which avoids doing the curation from scratch. Its exact contents and licence
  should be checked before adopting it.

Whatever the source, the list has to exclude:

- **Offensive words**, and words that form unfortunate phrases when paired.
- **Homophones and near-homophones**, such as `bare`/`bear` and `made`/`maid`, which defeat the
  purpose of an id that can be said aloud.
- **Obscure words** that people cannot spell on hearing them.

Costs compared with a short random id such as `T-7K3F`:

- **Length.** The id is seven to eleven characters after the type prefix, against four or five,
  for similar collision resistance.
- **Fixed format.** Once ids exist, words cannot be removed from the list or reordered without
  care, since existing ids must stay valid.
- **Language.** The list is English-only.

## Proposal 2: git-ignore the generated files

Stop committing the generated indexes and graphs. This is the larger win of the two, because the
project-wide generated files conflict on almost every merge.

The generated output already lives in its own folders (`index/` and `graphs/`). Folding them under
a single `.worktracker/generated/` folder would reduce the ignore rule to one line.

`.meta/` can be dropped from the ignore rule. It holds only `counters.json`, and Proposal 1 removes
that file, so the folder is no longer needed. Both changes land together, so there is no interim
state in which the counter file still exists.

Points to settle:

- **Lost browsability.** The design wants the indexes readable on GitHub without running the
  server. Ignoring them gives that up.
- **Mitigation.** Have CI regenerate and publish the artifacts on `main` only, so the browsable
  copy exists without anyone committing it from a branch.
- **Regeneration triggers.** The server has to regenerate on project registration and on external
  changes such as `git pull` or a branch checkout, not only after its own mutations. See "When to
  regenerate" below.
- **Relative links.** Mermaid `click` targets and index links use relative paths such as
  `../entities/`. Any folder move has to keep them valid.

### When to regenerate

Pulling the latest code can bring in new epics or updates to existing entities. While the
generated files are committed, a pull brings matching indexes with it. Once they are git-ignored,
a pull leaves them stale and a fresh clone has none at all, so the server has to rebuild them.

What the server does today:

- **MCP mutations.** `regenerateProject` runs after each successful write
  (`packages/server/src/mcp.ts`). This is its only caller.
- **External changes.** The watcher rebuilds the in-memory project state and broadcasts a reload
  to the viewer (`packages/server/src/watcher.ts`), but does not rewrite the index or graph files.
- **Startup.** Nothing regenerates when a project is discovered and registered.

Which reads depend on the generated files:

| Read | Source | Affected by missing or stale files |
| --- | --- | --- |
| MCP `index://{project}/board` | `.worktracker/index/INDEX.md` on disk | Yes |
| MCP `graph://{project}/dependencies` | `.worktracker/graphs/dependencies.mmd` on disk | Yes |
| MCP `graph://{project}/epic/{id}` | `.worktracker/graphs/<id>.mmd` on disk | Yes |
| HTTP `GET /api/:project/mermaid/:view` | The same `.mmd` files on disk | Yes |
| MCP `entity://{project}/{id}`, `project://list` | In-memory project state | No |
| MCP `requirements://{project}/source` | `.worktracker/requirements/source.md`, which stays committed | No |
| HTTP `GET /api/:project/board`, `/graph`, `/entity/:id` | In-memory project state | No |
| MCP query tools (`query_ready`, `query_blocked`, `critical_path`, `validate`) | In-memory project state | No |

The three MCP resources and the HTTP Mermaid endpoint read the file straight from disk
(`readMcpResource` in `packages/server/src/mcp.ts`, `getHttpMermaid` in
`packages/server/src/http.ts`). Neither regenerates on read. Two consequences once the files are
git-ignored:

- **Missing files.** On a fresh clone these reads return `NOT_FOUND` until regeneration has run.
- **Stale files.** After a pull they return the pre-pull content with no error, which is the worse
  case because nothing signals that the content is out of date.

The viewer is not affected. It builds the board and graph views from `/board` and `/graph`, which
come from in-memory state that the watcher already refreshes; the UI client defines a call for the
Mermaid endpoint but nothing in the UI uses it. The exposure is therefore agents reading the MCP
board and graph resources.

Triggers 1 and 2 below close both gaps. Rendering these four reads from in-memory state instead of
from disk would remove the dependency altogether, but it is a larger change to the resource
contract and is not needed if the triggers are in place.

Regenerate at these points:

1. **On project registration.** This covers server startup and a newly discovered marker, which
   handles a fresh clone and any pull made while the server was stopped. New behaviour.
2. **After the watcher refreshes a project.** This covers `git pull`, branch checkout, merge and
   hand edits while the server is running. A pull touches many files at once, so regenerate once
   after the burst of events goes quiet (a few hundred milliseconds), not once per file. New
   behaviour.
3. **After every MCP mutation.** Existing behaviour, unchanged.
4. **On explicit request.** A `regenerate` command that runs without the server, for CI publishing
   and for anyone browsing the files with no server running. New behaviour.

Rules that apply to all of them:

- **Skip invalid state.** If a merge leaves conflict markers or a duplicate id, the registry
  already keeps the last good state. Regeneration is skipped in that case and runs once the files
  are valid again, so indexes are never built from a half-merged store.
- **No feedback loop.** The watcher only watches `.worktracker/entities` and
  `.worktracker/requirements`, so writes to `index/` and `graphs/` do not trigger another refresh.
  Regeneration writes also go through the existing write-suppression set.
- **Cost.** Regeneration is deterministic and skips unchanged files, so running it eagerly is
  cheap.

Git hooks (`post-merge`, `post-checkout`) are not used as the main mechanism. They have to be
installed in every clone and are easy to miss, and triggers 1 and 2 cover the same cases.

## Not needed under this model

These would matter if two users edited the same entity or made conflicting cross-epic links.
External coordination rules that out, so they are recorded here only as things to revisit if the usage model widens:

- Dropping the `updated` timestamp from frontmatter to avoid same-line conflicts.
- Writing `dependsOn` and `tags` as block-style lists, one item per line.
- Id-only filenames, so a title change never renames a file.
- An `assignee` field and claim detection.
- Serialising writes or file locking for several agents in one working tree.
- Running `validate` in CI on merges to `main`, to catch a cross-epic cycle or a dependency on an
  entity another user archived. Coordination is expected to prevent these; if one slips through,
  the existing `validate` tool still reports it once the merged project is loaded.

## Impact on the existing design

Both recommended changes alter rules that the technical design (§8, generated artifacts) and
`AGENTS.md` currently state as invariants: that generated `index/` and `graphs/` files are
committed, and that ids come from per-project counters. The design document has to be revised
before any board tasks are created for this work.
