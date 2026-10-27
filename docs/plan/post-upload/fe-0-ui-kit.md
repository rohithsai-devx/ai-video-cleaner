# FE-0: UI kit

Generic primitives the four screen lanes share. Small and fast: it gates wave 3, so ship it first. No backend dependency, no `@/api` import.

## Rules

- Files in `frontend/src/ui/` (props only, no `@/api`, no feature imports) and `frontend/src/lib/` (pure functions).
- Style with the existing tokens in `src/app/globals.css` (`canvas, surface, sunken, line, line-strong, ink, ink-2, muted, faint, accent, accent-soft, success(-soft), warning(-soft), danger(-soft), flag(-soft), player`), radii `rounded-xl` (12), `rounded-2xl` (16), `rounded-3xl` (24). Match `ui/button.tsx` and `ui/badge.tsx` in shape: a function component, `cx`, spread of native props.
- One token added to `globals.css` `@theme`: `--color-link: #5b3fc4;` (the prototype's link colour; 7.2:1 on white). Do not change other tokens.
- Native elements first. Touch targets at least 44 px (`min-h-11`). Keep the global `:focus-visible` outline. Colour is never the only signal.
- Each primitive gets a jsdom test (`*.test.tsx` beside it) covering its role, keyboard and states.

## Components

### `ui/checkbox.tsx`

```
[x] Remove filler words
    um, uh, so, you know
```
`<Checkbox label hint? checked onChange disabled? />`: a `<label>` wrapping a native `<input type="checkbox">` (18 px, `accent-color: var(--color-ink)`), label 15 px `font-medium`, hint 13 px `text-muted` tied with `aria-describedby`. Row padding `py-2.5`, gap 12 px.

### `ui/switch.tsx`

```
+--------------------------------------------------+   bg accent-soft, rounded-2xl, p-3.5
| (o  ) Show me before it renders                  |
|       You get the editor with every change ...   |   hint text changes with state (prop)
+--------------------------------------------------+
```
`<Switch label hint checked onChange />`: native `<input type="checkbox" role="switch">` visually styled as a 36x20 track with a 16 px knob (ink when on, line-strong when off), label and hint as in Checkbox. Space toggles. Test: `role="switch"`, `aria-checked` follows state, hint is the accessible description.

### `ui/segmented-control.tsx`

```
+-------------------------------------+   bg sunken, rounded-xl, p-1
| [ Keep my voice ] |   AI voice      |   selected: bg surface, shadow-sm, ink
+-------------------------------------+
```
`<SegmentedControl name legend options={[{value,label}]} value onChange size="md"|"sm" />`. Native radio group (`sr-only` inputs inside labels), so arrow keys move the choice. `md`: items `min-h-11`, 14 px; `sm`: `min-h-9`, 13 px (editor and done-screen Cleaned / Original switch). Focus ring on the item via `has-[:focus-visible]:outline`.

### `ui/radio-group.tsx` (radio row with a side action)

```
+------------------------------------------------+   border ink when picked, line otherwise
| (o) Coral                       [ Play sample ] |   rounded-xl, px-3 py-2.5
|     Warm, calm                                  |
+------------------------------------------------+
```
`<RadioGroup name legend options={[{value,label,hint,action?: ReactNode}]} value onChange />`. The action is a sibling of the label (a real button, not inside the label).

### `ui/stepper.tsx`

```
(✓) Listening to your narration
 |   Found what you said and when you said it.
(✓) Watching your screen
 |   Found 4 chapters: ...
(●) Planning the cuts                 <- current: accent dot
 |   Working on it.
( ) Getting it ready for you          <- next: hollow dot, muted label
     Next
```
`<Stepper steps={[{label, detail, state: "done"|"current"|"failed"|"next"}]} />`: `<ol>`, 24 px dots (done: ink with a check icon; current: accent; failed: danger with "!"; next: 2 px line-strong ring), 2 px connector (ink after a done step, line otherwise), label 15 px `font-medium` (muted when next), detail 13 px muted. `aria-current="step"` on the current item. State is also in text for screen readers (visually hidden "done", "in progress", "failed", "next").

### `ui/banner.tsx`

```
+-----------------------------------------------------------+
| 18 changes ready. 15 are applied already. ... [ Action ]   |   info: accent-soft; danger: danger-soft + danger text
+-----------------------------------------------------------+
```
`<Banner tone="info"|"success"|"warning"|"danger" action?: ReactNode>children</Banner>`. `role="alert"` for danger, `role="status"` otherwise. `rounded-2xl px-5 py-4`, flex-wrap with the action on the right.

### `ui/empty-state.tsx`

`<EmptyState action?>{text}</EmptyState>`: centred 14 px muted text in a `p`, optional action under it.

### `ui/tabs.tsx` (custom, no dependency)

```
| Needs you 3 | Done by AI 15 | Script |      selected: ink text + 2 px ink underline
```
`<Tabs label tabs={[{id,label,count?}]} value onChange>{panels by id}</Tabs>`. `role="tablist"`, roving `tabIndex`, Left/Right/Home/End move and select, `aria-controls` / `aria-labelledby`, inactive panels stay mounted but `hidden`. Count is a `Badge` (warning tone for the first tab's count when > 0, neutral otherwise; the caller passes the tone).

### `lib/clock.ts`

`formatClock(seconds)` (same behaviour as the one in `features/review/review-model.ts`; do not edit that file, FE-3 switches it to this one), `formatLength(seconds)` (same format), `formatSpan([a,b])` ("0:42 to 0:46"), `formatShorter(before, after)` ("2:07 shorter"). Tests for rounding and hours-free output up to 15 minutes.

## Exit

- `npm run check` green (layout, lint, types, unit tests).
- No screen uses the new primitives yet. Screens adopt them in their own lanes.
