export interface Template {
  id: string;
  name: string;
  hint: string;
  /** Body markdown. The note title is kept in its own field and rendered as the H1. */
  build: () => string;
}

const today = () => new Date().toISOString().slice(0, 10);

export const TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: 'Blank note',
    hint: 'Empty page.',
    build: () => '',
  },
  {
    id: 'gs-topic',
    name: 'GS topic note',
    hint: 'Structured concept note for a GS syllabus topic.',
    build: () => `> **Syllabus link:** _tag this note from the toolbar_
> **Last revised:** ${today()}

## Why it matters
-

## Core concept
-

## Dimensions
### Constitutional / legal
-
### Political / administrative
-
### Economic
-
### Social
-

## Data & reports
| Source | Figure / finding | Year |
|---|---|---|
|  |  |  |

## Committees / judgments / schemes
-

## Way forward
-

## Prelims hooks
-
`,
  },
  {
    id: 'answer',
    name: 'Answer writing (Mains)',
    hint: 'Intro–Body–Conclusion frame with a word budget and keyword bank.',
    build: () => `_Question:_

**Directive:** Discuss / Examine / Critically analyse / Comment
**Marks:** 10 · **Word budget:** ~150 · **Time:** 7–8 min

---

## Introduction
_2–3 lines: definition / context / data hook._

## Body
### Dimension 1
-
### Dimension 2
-
### Counter-view / limitations
-

## Conclusion
_Forward-looking: committee, SDG, constitutional value._

---

**Keyword bank:**

**Diagram / flowchart idea:**

**Value addition (report, quote, example):**
`,
  },
  {
    id: 'pyq',
    name: 'PYQ log',
    hint: 'Track a previous-year question and your model approach.',
    build: () => `- **Year:**
- **Paper:**
- **Topic tag:**
- **Directive:**

## Question


## Decoding the demand
-

## Skeleton
- Intro:
- Body:
- Conclusion:

## Sources to enrich
-
`,
  },
  {
    id: 'current-affairs',
    name: 'Current affairs card',
    hint: 'One issue, linked back to the static syllabus.',
    build: () => `- **Date:** ${today()}
- **Source:**
- **Syllabus link:**

## What happened
-

## Background / why now
-

## Analysis
### Significance
-
### Concerns / challenges
-

## Static linkage
-

## How it could be asked
- Prelims:
- Mains:
`,
  },
  {
    id: 'optional',
    name: 'Optional subject note',
    hint: 'Thinker / theory / model answer note for an optional.',
    build: () => `- **Paper / section:**
- **Thinkers / schools:**

## Statement of the idea
-

## Key arguments
1.
2.

## Criticism / debates
-

## Indian / contemporary application
-

## Model answer snippets
-

## Diagram
\`\`\`mermaid
flowchart LR
  A[Concept] --> B[Implication]
\`\`\`
`,
  },
  {
    id: 'essay',
    name: 'Essay brainstorm',
    hint: 'Dimensions, quotes and examples for an essay theme.',
    build: () => `## Interpretations of the theme
-

## Dimensions
- Political:
- Economic:
- Social:
- Technological:
- Legal / Constitutional:
- Environmental:
- Ethical / Philosophical:
- Historical:
- International:

## Anchor examples
-

## Quotes
> "" —

## Possible structure
1. Anecdotal intro
2. Define & interpret
3. Dimensions with evidence
4. Counterpoint
5. Way forward
6. Hopeful close
`,
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
