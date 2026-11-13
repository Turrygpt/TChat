# Arena sprite sheets

Five user-supplied sheets, three evolution tiers and five poses each: idle,
windup, strike, hurt, dead. Transparent alpha was produced with the built-in
image editor using background extraction, preserving original characters,
positions and clothing. Prompt: remove only the brown background, keep all
15 complete characters and weapons, three rows by five columns, no text.

`frames.json` stores tight alpha bounds as `[x,y,width,height]` in pose order.
Do not split the sheets into equal cells: the original column widths vary.
The renderer anchors every frame to the floor and scales a tier consistently.
