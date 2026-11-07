# Homepage design audit

November 7, 2026 · Human Connection public demo

The previous homepage introduced the idea through posed host portraits and explanatory copy. The three experience choices appeared in a separate section. The revised homepage makes each experience a photograph visitors can select. A shared laugh leads the board, with an attentive listener and a card game alongside it.

| Finding on the previous homepage | Change | Check |
| --- | --- | --- |
| At 390 px, the mobile stylesheet hid both hero portraits. The first experience started at y=704 and the last ended at y=1183. | Show all three scenes on phones. The laugh spans the board above the listening and game tiles. | At 390 × 844, the board starts at y=359 and ends at y=675. All three choices fit before scrolling. |
| At 1440 px, the experience buttons started at y=807. The two introductory portraits had no action. | Put a labeled experience button on each scene next to the opening question. | At 1440 × 900, the board starts at y=210 and ends at y=670. Enter activated each tile and opened its corresponding style options. |
| General descriptions left visitors to imagine an actual conversation. | Show sample prompts from the session activity catalog. A visitor can draw another card or carry its style into matching. | Cycled through all three cards. Playful Banter carried through to a 15-minute audio preference and the existing fictional-match acknowledgement. |
| The mobile demo notice put its explanation link on a separate row, increasing the distance to the pictures. | Keep the disclosure beside its link in a compact, two-column layout. | Checked at 320 px and 390 px. The notice, labels and buttons fit without horizontal scrolling. |

## Visual references

Pinterest uses boards to organize related visual ideas. Its visual playbook shows a dominant rounded photo tile grouped with smaller, tightly cropped scenes. The site uses that size hierarchy for three distinct actions. The homepage scenes were created specifically for this demo with ImageGen. [Pinterest boards](https://help.pinterest.com/en/article/boards) · [Pinterest visual playbook](https://business.pinterest.com/pdf/pinterest-predicts/2026-marketing-playbook/) · [Image credits](../ASSETS.md)

## Browser checks

Coordinates are CSS pixels measured from the top of the homepage at its initial scroll position. The comparison used browser viewports and the public build.

| Viewport | First tile top | Last tile bottom | Three photos loaded | Page or label overflow |
| --- | ---: | ---: | --- | --- |
| 320 × 740 | 359 | 645 | Yes | None |
| 390 × 844 | 359 | 675 | Yes | None |
| 768 × 1024 | 186 | 526 | Yes | None |
| 1440 × 900 | 210 | 670 | Yes | None |

Inspected phone and desktop screenshots for facial crops, text legibility and navigation. Exercised the three photo choices by keyboard, both existing discovery buttons, the sample-card cycle, and the handoff to matching. The preview console recorded zero errors and warnings. These checks measure layout and interaction. Visitor preference and booking conversion were outside this audit.
